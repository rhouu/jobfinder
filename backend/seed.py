"""
SEED — runs on every start, but only fills empty tables (so it never duplicates anything):
  1. the admin account (ADMIN_EMAIL / ADMIN_PASSWORD from .env)
  2. data/offers.csv     real offers collected from Jooble. They are shown as external offers:
                         students apply on the original website ("Apply on Jooble").
  3. data/companies.csv  the public company directory (Marrakech). Public business info only, no contacts.
"""
import csv
import logging
import re
import zlib
from datetime import datetime

from sqlalchemy import func, select

from .database import ADMIN_EMAIL, ADMIN_PASSWORD, BASE_DIR, Company, DirectoryCompany, Job, SessionLocal, User
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
        text = f"{r['title']} {r['extract']}"
        published = datetime.strptime(r["published"], "%Y-%m-%d") if r["published"] else None
        db.add(Job(company=companies[name], title=r["title"], type=_contract(text), city=r["city"], work_mode=_work_mode(text),
                   description=r["extract"], skills=_skills(text), level=_level(text), status="open",
                   sector=guess_sector(f"{r['title']} {name} {r['extract']}"), source=r["source"] or "Jooble",
                   external_url=r["url"], **({"created_at": published} if published else {})))
    return len(rows)


def import_directory(db) -> int:
    path = DATA_DIR / "companies.csv"
    if not path.exists():
        return 0
    rows = list(csv.DictReader(open(path, encoding="utf-8", newline="")))
    as_float = lambda v: float(v) if v else None
    for r in rows:
        db.add(DirectoryCompany(name=r["name"], sector=directory_sector(r["category"], r["specialty"], r["name"]), category=r["category"],
                                city=r["city"], area=r["area"], website=r["website"], maps_url=r["maps_url"],
                                rating=as_float(r["rating"]), reviews=int(r["reviews"] or 0),
                                latitude=as_float(r["latitude"]), longitude=as_float(r["longitude"])))
    return len(rows)


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
        db.commit()
    finally:
        db.close()
