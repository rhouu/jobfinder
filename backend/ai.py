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


def ask_gemini(system: str, messages: list[dict], as_json: bool = False) -> str | None:
    """messages = [{"role": "user"|"model", "text": "..."}]. Returns the text answer, or None on failure."""
    if not ai_available():
        return None
    body = {
        "system_instruction": {"parts": [{"text": system}]},
        "contents": [{"role": m["role"], "parts": [{"text": m["text"]}]} for m in messages],
    }
    if as_json:
        body["generationConfig"] = {"responseMimeType": "application/json"}
    try:
        r = requests.post(f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent",
                          headers={"x-goog-api-key": GEMINI_API_KEY}, json=body, timeout=90)
        r.raise_for_status()
        parts = r.json()["candidates"][0]["content"]["parts"]
    except (requests.RequestException, KeyError, IndexError, ValueError) as exc:
        log.warning("Gemini request failed, using fallback: %s", exc)
        return None
    text = "".join(p.get("text", "") for p in parts).strip()
    return re.sub(r"^```(?:html|json)?\s*|\s*```$", "", text) or None


def _ask_json(system: str, prompt: str):
    text = ask_gemini(system, [{"role": "user", "text": prompt}], as_json=True)
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
    return ask_gemini(system + "\n\n" + context, turns + [{"role": "user", "text": message}])


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
    mine = {s.lower() for s in p.skills or []}
    skills = ", ".join([s for s in job.skills or [] if s.lower() in mine][:4] or (p.skills or [])[:4]) or "my skills"
    return (f"Dear {job.company.name} recruitment team,\n\nI am applying for the {job.title} position ({job.type}) in {job.city}. "
            f"I am a {p.level} student in {p.field} at {p.school}, and this opportunity matches my goals.\n\n"
            f"Through my studies and projects I developed solid skills in {skills}. I am eager to learn from your team "
            f"and contribute from day one.\n\nThank you for your time and consideration.\n\nBest regards,\n{user.name}"), "template"


# ================================================================ CV upload (PDF -> profile)
def read_cv_pdf(pdf_bytes: bytes, known_skills: list[str]) -> tuple[dict, str]:
    from pypdf import PdfReader  # imported here: only needed for this feature
    try:
        text = "\n".join(page.extract_text() or "" for page in PdfReader(io.BytesIO(pdf_bytes)).pages)[:15000]
    except Exception as exc:  # pypdf raises many different errors for broken files
        raise ValueError("This PDF could not be read.") from exc
    if len(text.strip()) < 40:
        raise ValueError("No text found in this PDF (is it a scanned image?).")

    data = _ask_json("You extract structured data from CVs. Answer with JSON only.",
                     "Extract this CV into JSON with keys: headline, phone, city, school, field, level (one of Bac+1..Bac+5, "
                     "Doctorat or empty), bio (2-3 sentences), skills (list of short strings), languages (list), "
                     "experience (list of {title, org, start, end, description}), education (list of {degree, school, start, end}), "
                     "projects (list of {name, description, tech, link}), links ({linkedin, github, website}). "
                     "Use empty strings/lists when unknown. Do not invent anything.\n\nCV TEXT:\n" + text)
    if isinstance(data, dict):
        return data, "ai"

    # Simple fallback: find known skills, phone, links and Moroccan cities in the text
    low = text.lower()
    phone = re.search(r"(\+212|0)[\s.-]?[5-7](?:[\s.-]?\d{2}){4}", text)
    cities = ["Casablanca", "Rabat", "Marrakech", "Tanger", "Fès", "Agadir", "Meknès", "Oujda", "Kénitra", "Tétouan", "Salé", "El Jadida"]
    links = {}
    for key, pattern in (("linkedin", r"https?://[^\s]*linkedin\.com[^\s]*"), ("github", r"https?://[^\s]*github\.com[^\s]*")):
        found = re.search(pattern, text)
        if found:
            links[key] = found.group(0)
    return {
        "phone": phone.group(0) if phone else "",
        "city": next((c for c in cities if c.lower() in low), ""),
        "skills": [s for s in known_skills if re.search(rf"(?<!\w){re.escape(s.lower())}(?!\w)", low)][:25],
        "links": links,
    }, "template"


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
