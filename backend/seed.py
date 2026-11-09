"""
SEED — runs on every start, but only fills empty tables (so it never duplicates anything):
  1. the admin account (ADMIN_EMAIL / ADMIN_PASSWORD from .env)
  2. data/offers.csv     real offers collected from Jooble. They are shown as external offers:
                         students apply on the original website ("Apply on Jooble").
  3. data/companies.csv  the public company directory (Marrakech). Public business info only, no contacts.
     data/companies_osm.csv  employers in other cities from OpenStreetMap (backend/fetch_osm_directory.py);
                         its new rows are added on every start, so re-running the script grows the directory.
  4. data/company_emails.csv  private emails of some directory companies (maps_url, email), used only to
                         send them spontaneous applications. Never shown on the site.

FRESH OFFERS — refresh_offers() runs once a day (started by app.py): it asks Jooble's official API for new offers
in Morocco (with JOOBLE_API_KEY) and Remotive's public API for remote jobs open worldwide (no key needed), adds the
ones we don't have yet, and closes job-board offers older than OFFER_MAX_DAYS.
"""
import csv
import json
import html
import logging
import re
import zlib
from datetime import datetime, timedelta

import requests

from sqlalchemy import func, select

from .database import (ADMIN_EMAIL, ADMIN_PASSWORD, BASE_DIR, JOOBLE_API_KEY, JOOBLE_HOST, JOOBLE_KEYWORDS, JOOBLE_LOCATION,
                       OFFER_MAX_DAYS, Company, CompanyContact, DirectoryCompany, Job, SessionLocal, Setting, User, utcnow)
from .helpers import directory_sector, guess_sector, hash_password

log = logging.getLogger("jobfinder.seed")
DATA_DIR = BASE_DIR / "data"
PALETTE = ["#2e9e74", "#5b8def", "#f2a33a", "#9b7ede", "#e8836b", "#4fb8c9", "#d97ab0", "#7a9e3e"]

# Skills recognised in offer texts: (regular expression, label shown on the card)
SKILLS = [(r"\bpython\b", "Python"), (r"\bjava\b(?!\s*script)", "Java"), (r"\bjee\b", "Java EE"), (r"javascript", "JavaScript"),
          (r"\bphp\b", "PHP"), (r"laravel", "Laravel"), (r"node\.?js", "Node.js"), (r"\.net\b", ".NET"), (r"c#", "C#"),
          (r"\bsql\b", "SQL"), (r"\bdb2\b", "DB2"), (r"\baws\b", "AWS"), (r"azure", "Azure"), (r"docker", "Docker"),
          (r"kubernetes", "Kubernetes"), (r"\blinux\b", "Linux"), (r"\bios\b", "iOS"), (r"objective-c", "Objective-C"),
          (r"\bswift\b", "Swift"), (r"\breact\b", "React"), (r"angular", "Angular"), (r"datastage", "DataStage"),
          (r"microservice", "Microservices"), (r"\bcloud\b", "Cloud"), (r"r[ée]seau|network", "Networking"),
          (r"\bqa\b|test", "Testing"), (r"excel", "Excel"), (r"power ?bi", "Power BI"), (r"\bsap\b", "SAP"),
          (r"\bcrm\b", "CRM"), (r"restful|\bapi", "APIs"), (r"marketing", "Marketing"), (r"n[ée]gociation", "Negotiation"),
          (r"germanophone|allemand|german", "German"), (r"bilingue|anglais|english", "English"),
          (r"commercial|vente|télévente", "Sales"), (r"recrutement|recruit", "Recruitment"), (r"formation|training", "Training")]


def _color(name: str) -> str:
    return PALETTE[zlib.crc32(name.encode()) % len(PALETTE)]  # same company -> same colour every time


def _contract(text: str) -> str:
    t = text.lower()
    for words, kind in ((("stage", "stagiaire", "intern"), "Stage"), (("pfe", "fin d'études", "fin d'etudes"), "PFE"),
                        (("alternance", "apprenti"), "Alternance"), (("freelance",), "Freelance"), ((" cdd",), "CDD")):
        if any(w in t for w in words):
            return kind
    return "CDI"


def _work_mode(text: str) -> str:
    t = text.lower()
    if any(w in t for w in ("télétravail", "teletravail", "remote", "à distance", "a distance")):
        return "Remote"
    return "Hybrid" if any(w in t for w in ("hybride", "hybrid")) else "On-site"


def _level(text: str) -> str:
    t = text.lower().replace(" ", "")
    if any(w in t for w in ("bac+5", "ingénieur", "ingenieur", "master")):
        return "Bac+5"
    if any(w in t for w in ("bac+3", "licence", "bachelor")):
        return "Bac+3"
    return "Bac+2" if any(w in t for w in ("bac+2", "bts", "dut")) else ""


def _skills(text: str) -> list[str]:
    t = text.lower()
    return [label for pattern, label in SKILLS if re.search(pattern, t)][:8]


def clean_text(text: str) -> str:
    """Job boards send HTML snippets and escaped characters ("& amp;", "<b>"): keep plain text."""
    text = (text or "").replace("& amp;", "&amp;")
    text = re.sub(r"<[^>]+>", "", re.sub(r"<br\s*/?>|</p>|</li>", " ", text, flags=re.I))
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def _job(company: Company, title: str, extract: str, city: str, url: str, source: str, published: datetime | None) -> Job:
    title, extract = clean_text(title), clean_text(extract)
    text = f"{title} {extract}"
    return Job(company=company, title=title[:200], type=_contract(text), city=city, work_mode=_work_mode(text),
               description=extract, skills=_skills(text), level=_level(text), status="open",
               sector=guess_sector(f"{title} {company.name} {extract}"), source=source or "Jooble", external_url=url[:500],
               **({"created_at": published} if published else {}))


def import_offers(db) -> int:
    path = DATA_DIR / "offers.csv"
    if not path.exists():
        return 0
    companies: dict[str, Company] = {}
    rows = list(csv.DictReader(open(path, encoding="utf-8", newline="")))
    for r in rows:
        name = r["company"].strip() or "Confidentiel"
        if name not in companies:
            titles = " ".join(x["title"] for x in rows if x["company"] == r["company"])
            companies[name] = Company(name=name, is_external=True, city=r["city"], logo_color=_color(name),
                                      sector=guess_sector(f"{name} {titles}"))
            db.add(companies[name])
        published = datetime.strptime(r["published"], "%Y-%m-%d") if r["published"] else None
        db.add(_job(companies[name], r["title"], r["extract"], r["city"], r["url"], r["source"], published))
    return len(rows)


# ---------------------------------------------------------------- fresh offers (daily)
CITIES = ["Casablanca", "Rabat", "Marrakech", "Tanger", "Fès", "Agadir", "Meknès", "Oujda", "Kénitra", "Tétouan",
          "Ouarzazate", "El Jadida", "Berrechid", "Mohammedia", "Salé", "Témara", "Settat", "Nador", "Safi", "Béni Mellal"]
_PLAIN = str.maketrans("éèêëàâîïôûüç", "eeeeaaiiouuc")


def _city(location: str) -> str:
    plain = (location or "").lower().translate(_PLAIN)
    for c in CITIES:
        if c.lower().translate(_PLAIN) in plain:
            return c
    return (location or "Maroc").split(",")[0].strip()[:80] or "Maroc"


def _link_key(url: str) -> str:
    return (url or "").split("?")[0].rstrip("/").lower()  # same offer even if the tracking part of the link changes


def fetch_jooble(keywords: str, report: dict | None = None, host: str = "", location: str | None = None) -> list[dict]:
    """One search on Jooble's REST API. Returns its "jobs" list ([] on any problem).
    `report` gets, per search word, the number of offers returned or the error (saved for the admin)."""
    try:
        host, location = host or JOOBLE_HOST, JOOBLE_LOCATION if location is None else location
        r = requests.post(f"https://{host}/api/{JOOBLE_API_KEY}", json={"keywords": keywords, "location": location}, timeout=25)
        r.raise_for_status()
        jobs = r.json().get("jobs") or []
        if report is not None:
            report[keywords] = len(jobs)
        return jobs
    except (requests.RequestException, ValueError) as exc:
        status = getattr(getattr(exc, "response", None), "status_code", "")
        problem = f"error {status} {type(exc).__name__}".strip()  # never the exception text: it holds the URL, so the key
        log.warning("Jooble search %r failed: %s", keywords, problem)
        if report is not None:
            report[keywords] = problem
        return []



def jooble_best_setup(probe: dict) -> tuple[str, str]:
    """One test search ("stage") per address and place; keeps the pair that returns the most offers.
    A Jooble key can be tied to a country site, and the place has to be written the way that site expects."""
    hosts = list(dict.fromkeys([JOOBLE_HOST, "ma.jooble.org", "jooble.org"]))
    places = list(dict.fromkeys([JOOBLE_LOCATION, "Maroc", "Morocco", "Casablanca", ""]))
    best, best_n = (JOOBLE_HOST, JOOBLE_LOCATION), -1
    for host in hosts:
        for place in places:
            found: dict = {}
            n = len(fetch_jooble("stage", found, host, place))
            probe[f"{host} / {place or '(no place)'}"] = found.get("stage", n)
            if n > best_n:
                best, best_n = (host, place), n
    probe["chosen"] = f"{best[0]} / {best[1] or '(no place)'}"
    return best

# Remotive's public API: remote jobs, about a day old (https://remotive.com/api/remote-jobs). Its terms ask to name
# Remotive as the source and link to its page for each job (the offer page shows "via Remotive" and "Apply on Remotive"),
# and to call it at most a few times a day (the refresh runs once a day).
REMOTE_PLACES = ("worldwide", "anywhere", "africa", "morocco", "maroc", "emea")
REMOTE_TYPES = {"full_time": "CDI", "contract": "CDD", "part_time": "CDD", "freelance": "Freelance", "internship": "Stage"}


def fetch_remotive() -> list[dict]:
    """Remote jobs open to candidates in Morocco (worldwide, Africa, EMEA). [] on any problem."""
    try:
        r = requests.get("https://remotive.com/api/remote-jobs", headers={"User-Agent": "JobFinder.ma"}, timeout=25)
        r.raise_for_status()
        jobs = r.json().get("jobs") or []
    except (requests.RequestException, ValueError) as exc:
        log.warning("Remotive request failed: %s", exc)
        return []
    return [j for j in jobs if any(p in (j.get("candidate_required_location") or "").lower() for p in REMOTE_PLACES)]


def refresh_offers(db) -> dict:
    """Adds new Jooble and Remotive offers we don't have yet and closes job-board offers that are too old."""
    added = []
    known = {_link_key(u) for u in db.scalars(select(Job.external_url).where(Job.external_url != ""))}
    known_titles = {(t.lower(), c.lower()) for t, c in db.execute(select(Job.title, Company.name).join(Company))}
    companies = {c.name.lower(): c for c in db.scalars(select(Company))}

    def company_for(name: str, city: str, title: str) -> Company:
        company = companies.get(name.lower())
        if not company:
            company = companies[name.lower()] = Company(name=name[:200], is_external=True, city=city,
                                                        logo_color=_color(name), sector=guess_sector(f"{name} {title}"))
            db.add(company)
        return company

    remote = fetch_remotive()
    for item in remote:
        url, title = item.get("url") or "", clean_text(item.get("title"))
        name = clean_text(item.get("company_name")) or "Confidentiel"
        if not url or not title or _link_key(url) in known or (title.lower(), name.lower()) in known_titles:
            continue
        try:
            published = datetime.fromisoformat((item.get("publication_date") or "")[:19])
        except ValueError:
            published = None
        text = clean_text(item.get("description"))
        extract = text[:600] + ("..." if len(text) > 600 else "")
        job = _job(company_for(name, "Télétravail", title), title, extract, "Télétravail", url, "Remotive", published)
        job.work_mode, job.type = "Remote", REMOTE_TYPES.get(item.get("job_type"), "CDI")
        db.add(job)
        added.append(job)
        known.add(_link_key(url))
        known_titles.add((title.lower(), name.lower()))

    jooble_report: dict = {}
    jooble_setup: dict = {}
    if JOOBLE_API_KEY:
        host, place = jooble_best_setup(jooble_setup)
        for kw in JOOBLE_KEYWORDS:
            for item in fetch_jooble(kw, jooble_report, host, place):
                url, title = item.get("link") or "", clean_text(item.get("title"))
                name = clean_text(item.get("company")) or "Confidentiel"
                if not url or not title or _link_key(url) in known or (title.lower(), name.lower()) in known_titles:
                    continue
                company = company_for(name, _city(item.get("location")), title)
                try:
                    published = datetime.fromisoformat((item.get("updated") or "")[:19])
                except ValueError:
                    published = None
                job = _job(company, title, item.get("snippet"), _city(item.get("location")), url, "Jooble", published)
                db.add(job)
                added.append(job)
                known.add(_link_key(url))
                known_titles.add((title.lower(), name.lower()))
    # Job-board offers older than OFFER_MAX_DAYS are most likely filled and their links dead: close them.
    # (Jooble refuses automated visits, so a link can't be tested; the publication date is the only signal.)
    limit = utcnow() - timedelta(days=OFFER_MAX_DAYS)
    old = db.scalars(select(Job).where(Job.status == "open", Job.external_url != "", Job.created_at < limit)).all()
    for job in old:
        job.status = "closed"
    row = db.get(Setting, "offers_refreshed_at") or Setting(key="offers_refreshed_at")
    row.value = utcnow().isoformat()
    db.merge(row)
    # What each source sent, so a problem (wrong key, no results) shows up without reading the server logs
    report = db.get(Setting, "offers_refresh_report") or Setting(key="offers_refresh_report")
    report.value = json.dumps({"jooble_key": bool(JOOBLE_API_KEY), "jooble_location": JOOBLE_LOCATION, "jooble_probe": jooble_setup, "jooble": jooble_report,
                               "remotive": len(remote), "added": len(added), "closed": len(old)}, ensure_ascii=False)
    db.merge(report)
    db.commit()
    log.info("Offers refreshed: %d added, %d closed", len(added), len(old))
    return {"added": added, "closed": len(old)}


def refresh_due(db) -> bool:
    row = db.get(Setting, "offers_refreshed_at")
    return not row or utcnow() - datetime.fromisoformat(row.value) > timedelta(hours=24)


def import_directory(db, file: str = "companies.csv") -> int:
    """Adds the companies of a data/ file to the directory, skipping the ones already there (same maps_url)."""
    path = DATA_DIR / file
    if not path.exists():
        return 0
    known = set(db.scalars(select(DirectoryCompany.maps_url)))
    rows = [r for r in csv.DictReader(open(path, encoding="utf-8", newline="")) if r["maps_url"] not in known]
    as_float = lambda v: float(v) if v else None
    for r in rows:
        db.add(DirectoryCompany(name=r["name"], sector=directory_sector(r["category"], r["specialty"], r["name"]), category=r["category"],
                                city=r["city"], area=r["area"], website=r["website"], maps_url=r["maps_url"],
                                rating=as_float(r["rating"]), reviews=int(r["reviews"] or 0),
                                latitude=as_float(r["latitude"]), longitude=as_float(r["longitude"])))
    return len(rows)


def import_contacts(db) -> int:
    path = DATA_DIR / "company_emails.csv"
    if not path.exists():
        return 0
    ids = dict(db.execute(select(DirectoryCompany.maps_url, DirectoryCompany.id)).all())
    n = 0
    for r in csv.DictReader(open(path, encoding="utf-8", newline="")):
        if r["maps_url"] in ids and "@" in r["email"]:
            db.add(CompanyContact(directory_id=ids[r["maps_url"]], email=r["email"].strip().lower()))
            n += 1
    return n


def seed() -> None:
    db = SessionLocal()
    try:
        if not db.scalar(select(User).where(User.role == "admin")):
            db.add(User(email=ADMIN_EMAIL.lower(), name="Platform Admin", role="admin", email_verified=True,
                        password_hash=hash_password(ADMIN_PASSWORD)))
            log.info("Admin account created: %s", ADMIN_EMAIL)
        if not db.scalar(select(func.count(Job.id))):
            log.info("Imported %d offers from data/offers.csv", import_offers(db))
        if not db.scalar(select(func.count(DirectoryCompany.id))):
            log.info("Imported %d companies from data/companies.csv", import_directory(db))
            db.flush()
        added = import_directory(db, "companies_osm.csv")  # other cities, from OpenStreetMap; new rows only
        if added:
            log.info("Added %d companies from data/companies_osm.csv", added)
            db.flush()
        for job in db.scalars(select(Job).where(Job.title.contains("amp;") | Job.description.contains("amp;"))):
            job.title, job.description = clean_text(job.title), clean_text(job.description)
        if not db.scalar(select(func.count(CompanyContact.id))):
            log.info("Imported %d company emails from data/company_emails.csv", import_contacts(db))
        db.commit()
    finally:
        db.close()
