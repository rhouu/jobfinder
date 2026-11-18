"""
AI — every feature that uses Google Gemini.

  chat_reply()            career assistant chatbot
  generate_cv()           CV as HTML, optionally tailored to an offer
  generate_portfolio()    personal website content
  generate_cover_letter() cover letter text
  read_cv_pdf()           uploaded PDF CV -> profile fields
  interview_questions()   mock interview: questions for an offer
  interview_feedback()    mock interview: score + advice for the answers

Put GEMINI_API_KEY in .env to turn AI on. Without a key (or if Gemini fails) every function
falls back to a simple built-in version, so the website always works.
"""
import io
import json
import logging
import re
import unicodedata
from html import escape

import requests

from .database import GEMINI_API_KEY, GEMINI_MODEL, Job, StudentProfile, User
from .helpers import clean_html

log = logging.getLogger("jobfinder.ai")
LANGUAGES = {"en": "English", "fr": "French", "ar": "Arabic"}
HTML_RULES = ("Return ONLY an HTML fragment (no <html>/<body>, no markdown fences, no comments). Allowed tags: h1 h2 h3 h4 p ul ol li "
              "strong em span div section header a small hr br. Only the class attribute (and href on links). "
              "Never invent employers, dates, grades or numbers that are not in the data; you may rephrase and organise it.")


def ai_available() -> bool:
    return bool(GEMINI_API_KEY)


CHAT_SECONDS = 20       # the chatbot answers live: past this, show the matching offers instead
CHAT_MAX_TOKENS = 2048  # answers are under 180 words; room left for the model's short thinking
last_error = ""         # why the latest Gemini call failed ("timeout", "http 429"...), never the key


def thinking_config(model: str = GEMINI_MODEL) -> dict | None:
    """Short thinking, for quick answers. Gemini 3 and later take a thinking level (MINIMAL is not accepted by
    every model, LOW is); Gemini 2.5 takes a token budget (0 turns it off on Flash, Pro needs at least 128)."""
    found = re.match(r"gemini-(\d+)(?:\.(\d+))?", model or "")
    if not found:
        return None
    major, minor = int(found.group(1)), int(found.group(2) or 0)
    if major >= 3:
        return {"thinkingLevel": "LOW"}
    if (major, minor) == (2, 5):
        return {"thinkingBudget": 128 if "pro" in model else 0}
    return None


def build_body(system: str, messages: list[dict], as_json: bool = False, fast: bool = False, max_tokens: int | None = None,
               thinking: bool = True) -> dict:
    """The generateContent request. `fast` (the chatbot) limits thinking so the answer comes in seconds."""
    body = {
        "system_instruction": {"parts": [{"text": system}]},
        "contents": [{"role": m["role"], "parts": [{"text": m["text"]}]} for m in messages],
    }
    config = {}
    if as_json:
        config["responseMimeType"] = "application/json"
    if max_tokens:
        config["maxOutputTokens"] = max_tokens
    if fast and thinking and thinking_config():
        config["thinkingConfig"] = thinking_config()
    if config:
        body["generationConfig"] = config
    return body


def ask_gemini(system: str, messages: list[dict], as_json: bool = False, timeout: int = 90, fast: bool = False,
               max_tokens: int | None = None) -> str | None:
    """messages = [{"role": "user"|"model", "text": "..."}]. Returns the text answer, or None on failure
    (also when Gemini takes longer than `timeout` seconds: the caller then uses its fallback)."""
    global last_error
    if not ai_available():
        last_error = "no key"
        return None
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
    body = build_body(system, messages, as_json, fast, max_tokens)
    try:
        r = requests.post(url, headers={"x-goog-api-key": GEMINI_API_KEY}, json=body, timeout=timeout)
        if r.status_code == 400 and "thinkingConfig" in body.get("generationConfig", {}):
            # this model refuses the thinking setting: ask again without it
            log.warning("Gemini refused the thinking setting for %s, retrying without it", GEMINI_MODEL)
            body = build_body(system, messages, as_json, fast, max_tokens, thinking=False)
            r = requests.post(url, headers={"x-goog-api-key": GEMINI_API_KEY}, json=body, timeout=timeout)
        r.raise_for_status()
        parts = r.json()["candidates"][0]["content"]["parts"]
    except requests.Timeout:
        last_error = "timeout"
        log.warning("Gemini took more than %s s, using fallback", timeout)
        return None
    except requests.HTTPError as exc:
        last_error = f"http {exc.response.status_code}"
        try:  # Google's own error message (it never contains the key, which is sent in a header)
            detail = exc.response.json().get("error", {}).get("message", "")[:200]
        except ValueError:
            detail = ""
        log.warning("Gemini request failed (%s %s), using fallback", last_error, detail)
        return None
    except (requests.RequestException, KeyError, IndexError, ValueError) as exc:
        last_error = type(exc).__name__
        log.warning("Gemini request failed (%s), using fallback", last_error)
        return None
    text = "".join(p.get("text", "") for p in parts if not p.get("thought")).strip()
    last_error = "" if text else "empty answer"
    return re.sub(r"^```(?:html|json)?\s*|\s*```$", "", text) or None


def _ask_json(system: str, prompt: str, timeout: int = 90):
    text = ask_gemini(system, [{"role": "user", "text": prompt}], as_json=True, timeout=timeout)
    try:
        return json.loads(text) if text else None
    except json.JSONDecodeError:
        return None


def _profile_json(user: User, p: StudentProfile) -> str:
    data = {"name": user.name, "email": user.email, **p.to_dict()}
    for key in ("has_cv", "has_portfolio", "portfolio_theme", "portfolio_public", "completion"):
        data.pop(key, None)
    return json.dumps(data, ensure_ascii=False)


def _job_json(job: Job) -> str:
    return json.dumps({"id": job.id, "title": job.title, "company": job.company.name, "type": job.type, "city": job.city,
                       "work_mode": job.work_mode, "skills": job.skills, "level": job.level,
                       "salary_mad": [job.salary_min, job.salary_max], "description": job.description[:500],
                       "requirements": job.requirements[:400]}, ensure_ascii=False)


# ================================================================ Chatbot
def chat_reply(message: str, history: list[dict], language: str, user: User | None, jobs: list[Job]) -> str | None:
    system = (
        "You are 'JobFinder Assistant', the career assistant of JobFinder.ma, a Moroccan platform where students, trainees "
        "and young graduates find jobs, internships (Stage), PFE (end-of-studies projects), alternance and freelance missions. "
        "Features: smart job matching, AI CV builder, portfolio generator, cover letters, mock interviews, application "
        "tracking, messaging with companies, internship reviews. Companies verify their profile with ICE and RC numbers.\n"
        "Rules: be warm, concise (under 180 words) and practical. Reply in the language the user writes in "
        "(English, French, Arabic or Moroccan Darija); if unclear use " + LANGUAGES.get(language, "English") + ". "
        "When you recommend an offer from the list below, write its tag exactly like [job:12] so the website shows a card. "
        "Only recommend offers from the list; never invent offers, companies, salaries or links. "
        "Use simple formatting: short paragraphs and '-' bullet points, no tables."
    )
    context = "Offers currently relevant (JSON):\n" + "\n".join(_job_json(j) for j in jobs) if jobs else "No matching offers found."
    if user and user.role == "student" and user.profile:
        context += "\n\nThe user is a signed-in student. Their profile:\n" + _profile_json(user, user.profile)
    elif user:
        context += f"\n\nThe user is signed in as a {user.role}."
    turns = [m for m in history[-10:] if m.get("role") in ("user", "model") and m.get("text")]
    return ask_gemini(system + "\n\n" + context, turns + [{"role": "user", "text": message}],
                      timeout=CHAT_SECONDS, fast=True, max_tokens=CHAT_MAX_TOKENS)


# ================================================================ CV
def generate_cv(user: User, p: StudentProfile, job: Job | None, language: str) -> tuple[str, str]:
    target = f"\nTailor it to this offer (put the most relevant skills and experience first):\n{_job_json(job)}" if job else ""
    prompt = (f"Write a polished one-page CV in {LANGUAGES.get(language, 'English')}.\n"
              'Structure: <header class="cv-header"> with h1 name, p.cv-title, p.cv-contact; then <section class="cv-section"> '
              "blocks with h2: Profile (3-4 sentences), Education, Experience (h3 role — org, small dates, ul of achievements "
              "with action verbs), Projects, Skills (span.cv-chip each), Languages.\nProfile:\n" + _profile_json(user, p) + target)
    html = ask_gemini("You are an expert CV writer for the Moroccan job market. " + HTML_RULES, [{"role": "user", "text": prompt}])
    if html:
        return clean_html(html), "ai"
    return clean_html(cv_template(user, p, job)), "template"


def cv_template(user: User, p: StudentProfile, job: Job | None = None) -> str:
    e, links = escape, p.links or {}
    contact = " · ".join(e(x) for x in (user.email, p.phone, p.city) if x)
    for name in ("linkedin", "github", "website"):
        if links.get(name):
            contact += f' · <a href="{e(links[name])}">{name.capitalize()}</a>'
    skills = list(p.skills or [])
    if job:
        wanted = {s.lower() for s in job.skills or []}
        skills.sort(key=lambda s: s.lower() not in wanted)
    summary = p.bio or f"{p.level} student in {p.field} at {p.school}."
    if job:
        summary += f" Applying for the {job.title} opportunity at {job.company.name}."

    out = [f'<header class="cv-header"><h1>{e(user.name)}</h1><p class="cv-title">{e(p.headline or p.field)}</p>'
           f'<p class="cv-contact">{contact}</p></header>',
           f'<section class="cv-section"><h2>Profile</h2><p>{e(summary)}</p></section>']
    if p.education:
        out.append('<section class="cv-section"><h2>Education</h2>' + "".join(
            f"<h3>{e(x.get('degree', ''))} — {e(x.get('school', ''))}</h3><small>{e(x.get('start', ''))} – {e(x.get('end', ''))}</small>"
            for x in p.education) + "</section>")
    if p.experience:
        out.append('<section class="cv-section"><h2>Experience</h2>')
        for x in p.experience:
            bullets = [b.strip(" -•") for b in re.split(r"[\n.;]+", x.get("description", "")) if b.strip(" -•")]
            out.append(f"<h3>{e(x.get('title', ''))} — {e(x.get('org', ''))}</h3>"
                       f"<small>{e(x.get('start', ''))} – {e(x.get('end', '') or 'Present')}</small>"
                       + ("<ul>" + "".join(f"<li>{e(b)}</li>" for b in bullets) + "</ul>" if bullets else ""))
        out.append("</section>")
    if p.projects:
        out.append('<section class="cv-section"><h2>Projects</h2>' + "".join(
            f"<h3>{e(x.get('name', ''))}" + (f" <small>({e(x['tech'])})</small>" if x.get("tech") else "")
            + f"</h3><p>{e(x.get('description', ''))}</p>" for x in p.projects) + "</section>")
    if skills:
        out.append('<section class="cv-section"><h2>Skills</h2><p>' + "".join(f'<span class="cv-chip">{e(s)}</span>' for s in skills) + "</p></section>")
    if p.languages:
        out.append(f'<section class="cv-section"><h2>Languages</h2><p>{e(" · ".join(p.languages))}</p></section>')
    return "".join(out)


# ================================================================ Portfolio
def generate_portfolio(user: User, p: StudentProfile) -> tuple[str, str]:
    prompt = ("Create the content of a modern personal portfolio website.\n"
              'Structure: <section class="pf-hero"> (h1 name, p.pf-tagline catchy one-liner, p.pf-intro); '
              '<section class="pf-section"> About (h2 + 2 short paragraphs); <section class="pf-section"> Projects with '
              "div.pf-grid > div.pf-card (h3, p, p.pf-tech, optional a); <section class=\"pf-section\"> Experience with "
              'div.pf-timeline > div.pf-item (h3, small, p); <section class="pf-section"> Skills (span.pf-chip each); '
              '<section class="pf-section pf-contact"> Contact (h2, p, links).\nProfile:\n' + _profile_json(user, p))
    html = ask_gemini("You are a creative personal-branding copywriter. " + HTML_RULES, [{"role": "user", "text": prompt}])
    if html:
        return clean_html(html), "ai"
    return clean_html(_portfolio_template(user, p)), "template"


def _portfolio_template(user: User, p: StudentProfile) -> str:
    e, links = escape, p.links or {}
    out = [f'<section class="pf-hero"><h1>{e(user.name)}</h1><p class="pf-tagline">{e(p.headline or p.field)}</p>'
           f'<p class="pf-intro">{e(" · ".join(x for x in (p.level, p.school, p.city) if x))}</p></section>',
           f'<section class="pf-section"><h2>About me</h2><p>{e(p.bio or "Curious, motivated and ready for new challenges.")}</p></section>']
    if p.projects:
        out.append('<section class="pf-section"><h2>Projects</h2><div class="pf-grid">' + "".join(
            f'<div class="pf-card"><h3>{e(x.get("name", ""))}</h3><p>{e(x.get("description", ""))}</p><p class="pf-tech">{e(x.get("tech", ""))}</p>'
            + (f'<a href="{e(x["link"])}">View project</a>' if x.get("link") else "") + "</div>" for x in p.projects) + "</div></section>")
    if p.experience:
        out.append('<section class="pf-section"><h2>Experience</h2><div class="pf-timeline">' + "".join(
            f'<div class="pf-item"><h3>{e(x.get("title", ""))} · {e(x.get("org", ""))}</h3><small>{e(x.get("start", ""))} – '
            f'{e(x.get("end", "") or "Present")}</small><p>{e(x.get("description", ""))}</p></div>' for x in p.experience) + "</div></section>")
    if p.skills:
        out.append('<section class="pf-section"><h2>Skills</h2><p>' + "".join(f'<span class="pf-chip">{e(s)}</span>' for s in p.skills) + "</p></section>")
    contact = [f'<a href="mailto:{e(user.email)}">{e(user.email)}</a>'] + [
        f'<a href="{e(links[k])}">{k.capitalize()}</a>' for k in ("linkedin", "github", "website") if links.get(k)]
    out.append(f'<section class="pf-section pf-contact"><h2>Contact</h2><p>{" · ".join(contact)}</p></section>')
    return "".join(out)


# ================================================================ Cover letter
def generate_cover_letter(user: User, p: StudentProfile, job: Job, language: str) -> tuple[str, str]:
    prompt = (f"Write a sincere cover letter in {LANGUAGES.get(language, 'English')} (180-250 words, plain text, no placeholders) "
              f"to the {job.company.name} recruitment team, signed with the candidate's name.\n"
              f"Candidate:\n{_profile_json(user, p)}\nOffer:\n{_job_json(job)}")
    text = ask_gemini("You are a career coach. Never invent experience the candidate does not have.", [{"role": "user", "text": prompt}])
    if text:
        return text, "ai"
    return cover_letter_template(user, p, job, language), "template"


def cover_letter_template(user: User, p: StudentProfile, job: Job, language: str) -> str:
    """The letter used when Gemini is not available, in the language the student chose (English, French or Arabic).
    Profile fields that are empty are simply left out of the sentence."""
    mine = {s.lower() for s in p.skills or []}
    skills = ", ".join([s for s in job.skills or [] if s.lower() in mine][:4] or (p.skills or [])[:4])
    c, title, kind, city = job.company.name, job.title, job.type, job.city
    if language == "fr":
        studies = " ".join(x for x in (f"en {p.field}" if p.field else "", f"à {p.school}" if p.school else "") if x)
        who = f"Étudiant(e) {p.level} {studies}".replace("  ", " ").strip() if (p.level or studies) else ""
        return (f"Madame, Monsieur,\n\nJe vous adresse ma candidature pour le poste de {title} ({kind}) à {city}. "
                + (f"{who}, je" if who else "Je") + " vois dans cette offre une vraie occasion de progresser.\n\n"
                f"Au fil de mes études et de mes projets, j'ai développé des compétences en {skills or 'travail d’équipe et en apprentissage rapide'}. "
                f"Je serais heureux(se) d'apprendre aux côtés de votre équipe et de contribuer dès le premier jour.\n\n"
                f"Je vous remercie pour l'attention portée à ma candidature.\n\nCordialement,\n{user.name}")
    if language == "ar":
        studies = " ".join(x for x in (f"في تخصص {p.field}" if p.field else "", f"بـ{p.school}" if p.school else "") if x)
        who = f"بصفتي طالبًا ({p.level}) {studies}".strip() if (p.level or studies) else ""
        return (f"السادة فريق التوظيف في {c}،\n\nأتقدم بطلبي لشغل منصب {title} ({kind}) في {city}. "
                + (f"{who}، أرى" if who else "أرى") + " في هذه الفرصة خطوة مهمة في مساري.\n\n"
                f"خلال دراستي ومشاريعي اكتسبت مهارات في {skills or 'العمل الجماعي وسرعة التعلم'}، "
                f"وأتطلع إلى التعلم مع فريقكم والمساهمة منذ اليوم الأول.\n\nشكرًا لوقتكم واهتمامكم.\n\nمع خالص التحية،\n{user.name}")
    studies = " ".join(x for x in (f"in {p.field}" if p.field else "", f"at {p.school}" if p.school else "") if x)
    who = f"I am a {p.level} student {studies}".replace("  ", " ").strip() if (p.level or studies) else ""
    return (f"Dear {c} recruitment team,\n\nI am applying for the {title} position ({kind}) in {city}. "
            + (f"{who}, and this" if who else "This") + " opportunity matches my goals.\n\n"
            f"Through my studies and projects I developed solid skills in {skills or 'teamwork and learning fast'}. "
            f"I am eager to learn from your team and contribute from day one.\n\n"
            f"Thank you for your time and consideration.\n\nBest regards,\n{user.name}")


# ================================================================ CV upload (PDF -> profile)
CV_READ_SECONDS = 40  # the student is waiting on the profile page: past this, use the simple reading below


def read_cv_pdf(pdf_bytes: bytes, known_skills: list[str]) -> tuple[dict, str]:
    from pypdf import PdfReader  # imported here: only needed for this feature
    try:
        text = "\n".join(page.extract_text() or "" for page in PdfReader(io.BytesIO(pdf_bytes)).pages)[:15000]
    except Exception as exc:  # pypdf raises many different errors for broken files
        raise ValueError("This PDF could not be read.") from exc
    if len(text.strip()) < 40:
        raise ValueError("No text found in this PDF (is it a scanned image?).")

    simple = _simple_cv_read(text, known_skills)
    data = _ask_json("You extract structured data from CVs. Answer with JSON only.",
                     "Extract this CV into JSON with keys: headline, phone, city, school, field, level (one of Bac+1..Bac+5, "
                     "Doctorat or empty), bio (2-3 sentences), skills (list of short strings), languages (list), "
                     "experience (list of {title, org, start, end, description}), education (list of {degree, school, start, end}), "
                     "projects (list of {name, description, tech, link}), links ({linkedin, github, website}). "
                     "Use empty strings/lists when unknown. Do not invent anything.\n\nCV TEXT:\n" + text, timeout=CV_READ_SECONDS)
    fields = _clean_cv_fields(data)
    if not fields:
        return simple, "template"
    # Gemini sometimes misses the basics: complete them with what the simple reading found
    for key in ("phone", "city"):
        fields[key] = fields.get(key) or simple[key]
    fields["skills"] = list(dict.fromkeys(fields.get("skills", []) + simple["skills"]))[:30]
    fields["links"] = {**simple["links"], **fields.get("links", {})}
    return fields, "ai"


CV_CITIES = ["Casablanca", "Rabat", "Marrakech", "Tanger", "Fès", "Agadir", "Meknès", "Oujda", "Kénitra", "Tétouan", "Salé",
             "El Jadida", "Ouarzazate", "Béni Mellal", "Nador", "Safi", "Mohammedia", "Khouribga", "Settat", "Laâyoune", "Essaouira"]
CV_LEVELS = ["Bac+1", "Bac+2", "Bac+3", "Bac+4", "Bac+5", "Doctorat"]


def _plain(word: str) -> str:
    """Lower case without accents, to compare city names written in different ways (Fès / Fes)."""
    return unicodedata.normalize("NFKD", word).encode("ascii", "ignore").decode().lower()


def _cv_city(value: str) -> str:
    """'Marrakech, Maroc' -> 'Marrakech'. Unknown cities are kept as written."""
    plain = _plain(value)
    return next((c for c in CV_CITIES if _plain(c) in plain), value.strip()[:60])


def _simple_cv_read(text: str, known_skills: list[str]) -> dict:
    """Reading without AI: phone, Moroccan city, known skills and LinkedIn / GitHub links found in the text."""
    low = text.lower()
    phone = re.search(r"(\+212|0)[\s.-]?[5-7](?:[\s.-]?\d{2}){4}", text)
    city = next((c for c in CV_CITIES if re.search(rf"(?<!\w){re.escape(_plain(c))}(?!\w)", _plain(text))), "")
    links = {}
    for key, site in (("linkedin", r"linkedin\.com/[^\s,;)]+"), ("github", r"github\.com/[^\s,;)]+")):
        found = re.search(rf"(?:https?://)?(?:www\.)?{site}", text, re.I)  # CVs often omit "https://"
        if found:
            links[key] = found.group(0) if found.group(0).lower().startswith("http") else "https://" + found.group(0)
    return {"phone": phone.group(0) if phone else "", "city": city, "links": links,
            "skills": [s for s in known_skills if re.search(rf"(?<!\w){re.escape(s.lower())}(?!\w)", low)][:25]}


def _clean_cv_fields(data) -> dict:
    """Puts Gemini's answer into the exact shape the profile form expects, whatever small variations it uses
    (whole answer inside one key, skills as one text, entries as plain strings...). Returns {} if unusable."""
    if isinstance(data, list) and data and isinstance(data[0], dict):
        data = data[0]
    if not isinstance(data, dict):
        return {}
    expected = {"headline", "phone", "city", "school", "field", "level", "bio", "skills", "languages", "experience", "education", "projects", "links"}
    if not expected & set(data) and len(data) == 1 and isinstance(next(iter(data.values())), dict):
        data = next(iter(data.values()))  # e.g. {"cv": {...}}
    data = {str(k).strip().lower(): v for k, v in data.items()}

    def text(v) -> str:
        if isinstance(v, list):
            v = ", ".join(text(x) for x in v if x)
        elif isinstance(v, dict):
            v = ", ".join(text(x) for x in v.values() if x)
        return "" if v is None else str(v).strip()

    def words(v) -> list[str]:
        items = re.split(r"[,;|\n•]+", v) if isinstance(v, str) else v if isinstance(v, list) else []
        out = [text(x.get("name") or x.get("skill") or x.get("label") or x.get("language") or next(iter(x.values()), "")) if isinstance(x, dict) else text(x)
               for x in items]
        return [w[:60] for w in out if w][:30]

    def entries(v, main: str, keys: tuple) -> list[dict]:
        rows = v if isinstance(v, list) else [v] if v else []
        return [{k: text(r.get(k, "")) for k in keys} if isinstance(r, dict) else {**{k: "" for k in keys}, main: text(r)}
                for r in rows if r][:15]

    fields = {k: text(data.get(k, ""))[:300] for k in ("headline", "phone", "school", "field")}
    fields["bio"] = text(data.get("bio", ""))[:1500]
    fields["city"] = _cv_city(text(data.get("city", ""))) if data.get("city") else ""
    level = text(data.get("level", "")).replace(" ", "").lower()
    fields["level"] = next((lv for lv in CV_LEVELS if lv.lower() == level), "")
    fields["skills"], fields["languages"] = words(data.get("skills")), words(data.get("languages"))
    fields["experience"] = entries(data.get("experience"), "title", ("title", "org", "start", "end", "description"))
    fields["education"] = entries(data.get("education"), "degree", ("degree", "school", "start", "end"))
    fields["projects"] = entries(data.get("projects"), "name", ("name", "description", "tech", "link"))
    links = data.get("links") or {}
    if isinstance(links, list):  # a list of URLs: sort them by site
        links = {("linkedin" if "linkedin" in u.lower() else "github" if "github" in u.lower() else "website"): u
                 for u in (text(x) for x in links) if u}
    fields["links"] = {k: text(links.get(k, "")) for k in ("linkedin", "github", "website") if isinstance(links, dict) and links.get(k)}
    return fields if any(fields.values()) else {}


# ================================================================ Mock interview
def interview_questions(job: Job, p: StudentProfile | None, language: str) -> tuple[list[str], str]:
    data = _ask_json("You are an experienced Moroccan recruiter preparing interview questions. Answer with JSON only.",
                     f"Write 5 interview questions in {LANGUAGES.get(language, 'English')} for this offer: 1 motivation, "
                     "2 technical about the required skills, 1 behavioural (situation), 1 about the company/role. "
                     'JSON: {"questions": ["..."]}\nOffer:\n' + _job_json(job)
                     + (f"\nCandidate profile:\n{json.dumps(p.to_dict(), ensure_ascii=False)}" if p else ""))
    if isinstance(data, dict) and isinstance(data.get("questions"), list) and data["questions"]:
        return [str(q) for q in data["questions"][:6]], "ai"
    skills = job.skills or ["your main skill"]
    templates = {
        "en": [f"Why do you want this {job.type} at {job.company.name}?", f"Tell us about a project where you used {skills[0]}.",
               f"How would you explain {skills[min(1, len(skills) - 1)]} to a non-technical person?",
               "Describe a time you faced a difficult problem in a team. What did you do?",
               f"What would you like to achieve in your first months as {job.title}?"],
        "fr": [f"Pourquoi voulez-vous ce poste ({job.type}) chez {job.company.name} ?", f"Parlez-nous d'un projet où vous avez utilisé {skills[0]}.",
               f"Comment expliqueriez-vous {skills[min(1, len(skills) - 1)]} à une personne non technique ?",
               "Décrivez une situation difficile vécue en équipe. Qu'avez-vous fait ?",
               f"Que souhaitez-vous accomplir durant vos premiers mois en tant que {job.title} ?"],
        "ar": [f"لماذا ترغب في هذه الفرصة ({job.type}) لدى {job.company.name}؟", f"حدّثنا عن مشروع استخدمت فيه {skills[0]}.",
               f"كيف تشرح {skills[min(1, len(skills) - 1)]} لشخص غير تقني؟",
               "صِف موقفًا صعبًا واجهته ضمن فريق. ماذا فعلت؟", f"ماذا تريد أن تحقق في أشهرك الأولى في منصب {job.title}؟"],
    }
    return templates.get(language, templates["en"]), "template"


def interview_feedback(job: Job, answers: list[dict], language: str) -> tuple[dict, str]:
    data = _ask_json("You are a kind but honest interview coach. Answer with JSON only.",
                     f"Evaluate these interview answers for the offer below. Write in {LANGUAGES.get(language, 'English')}. "
                     'JSON: {"score": 0-100, "summary": "2-3 sentences", "items": [{"score": 0-10, "feedback": "what was good '
                     'or missing", "tip": "one concrete improvement"}]} — one item per answer, same order.\n'
                     f"Offer:\n{_job_json(job)}\nAnswers:\n{json.dumps(answers, ensure_ascii=False)}")
    if isinstance(data, dict) and isinstance(data.get("items"), list):
        return data, "ai"

    # Fallback: reward complete answers that mention skills and concrete examples
    tips = {"en": ("Good level of detail.", "Add a concrete example with a result (STAR method).", "Your answer is too short."),
            "fr": ("Bon niveau de détail.", "Ajoutez un exemple concret avec un résultat (méthode STAR).", "Votre réponse est trop courte."),
            "ar": ("مستوى جيد من التفاصيل.", "أضف مثالًا ملموسًا مع نتيجة (طريقة STAR).", "إجابتك قصيرة جدًا.")}
    good, example, short = tips.get(language, tips["en"])
    items = []
    for a in answers:
        text = str(a.get("answer", ""))
        words = len(text.split())
        score = min(10, words // 12 + sum(2 for s in job.skills or [] if s.lower() in text.lower())
                    + (2 if re.search(r"\d", text) else 0))
        items.append({"score": score, "feedback": good if words >= 40 else short, "tip": example})
    total = round(10 * sum(i["score"] for i in items) / max(1, len(items)))
    return {"score": total, "summary": example, "items": items}, "template"
