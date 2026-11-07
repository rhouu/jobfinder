"""
DATA PIPELINE: collects every dataset the site uses, keeps it raw, then cleans it.

    python -m backend.data_pipeline collect   # 1. data/raw/   : the sources exactly as they came (nothing changed)
    python -m backend.data_pipeline clean     # 2. data/clean/ : cleaned files + cleaning_log.csv + rejected_rows.csv

Sources
  jooble_offers_raw.csv          Jooble job search, Morocco (collected with the leadfinder scraper)
  google_maps_marrakech_raw.csv  Google Maps Places, Marrakech companies (leadfinder scraper, with AI scoring columns)
  osm_<city>_raw.json            OpenStreetMap Overpass API, one file per city (offices, hotels, factories, coworking)
  remotive_raw.json              Remotive public API, every remote job it lists

data/raw holds phone numbers and emails: it stays on this computer (excluded from git) and is never published.
"""
import csv
import html
import json
import re
import shutil
import sys
from collections import Counter
from datetime import datetime

import requests

from .database import BASE_DIR
from .fetch_osm_directory import CITIES, NOT_A_NAME, category, overpass, query

RAW = BASE_DIR / "data" / "raw"
CLEAN = BASE_DIR / "data" / "clean"
LEADFINDER = BASE_DIR.parent / "leadfinder"  # where the scraper wrote its files
REMOTIVE = "https://remotive.com/api/remote-jobs"
REMOTE_PLACES = ("worldwide", "anywhere", "africa", "morocco", "maroc", "emea")
REMOTE_TYPES = {"full_time": "CDI", "contract": "CDD", "part_time": "CDD", "freelance": "Freelance", "internship": "Stage"}
MOROCCO_BOX = (20.5, 36.1, -17.2, -0.9)  # lat min, lat max, lon min, lon max (Western Sahara included)


def slug(city: str) -> str:
    return city.lower().replace("è", "e").replace("é", "e")


# ---------------------------------------------------------------- 1. collect
def collect() -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    for src, dst in (("offres_jooble.csv", "jooble_offers_raw.csv"),
                     ("entreprises_Marrakech_FINAL.csv", "google_maps_marrakech_raw.csv")):
        shutil.copyfile(LEADFINDER / src, RAW / dst)
        print(f"  {dst}: copied from {LEADFINDER / src}")

    r = requests.get(REMOTIVE, headers={"User-Agent": "JobFinder.ma data pipeline"}, timeout=40)
    r.raise_for_status()
    (RAW / "remotive_raw.json").write_text(r.text, encoding="utf-8")
    print(f"  remotive_raw.json: {len(r.json().get('jobs', []))} jobs")

    for city in CITIES:
        try:
            data = overpass(query(city))
        except RuntimeError as exc:
            print(f"  osm_{slug(city)}_raw.json: skipped ({exc}), run collect again later")
            continue
        (RAW / f"osm_{slug(city)}_raw.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        print(f"  osm_{slug(city)}_raw.json: {len(data.get('elements', []))} elements")
    (RAW / "collected_at.txt").write_text(datetime.now().isoformat(timespec="seconds"), encoding="utf-8")


# ---------------------------------------------------------------- 2. clean
def text(s) -> str:
    """HTML entities decoded, non-breaking spaces, repeated spaces and empty lines removed."""
    s = html.unescape(s or "").replace("\xa0", " ").replace("\r", "")
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r"\n\s*\n+", "\n", s)
    return "\n".join(line.strip() for line in s.split("\n")).strip()


def no_tags(s) -> str:
    s = re.sub(r"<(br|/p|/li|/h\d)[^>]*>", "\n", s or "", flags=re.I)
    return text(re.sub(r"<[^>]+>", " ", s))


class Log:
    """Counts every row removed and why, for cleaning_log.csv and rejected_rows.csv."""

    def __init__(self):
        self.steps, self.rejected = [], []

    def step(self, source, name, before, after):
        self.steps.append({"source": source, "step": name, "rows_before": before,
                           "rows_removed": before - after, "rows_after": after})

    def reject(self, source, reason, label):
        self.rejected.append({"source": source, "reason": reason, "row": label[:150]})


def write(name, rows, fields):
    with (CLEAN / name).open("w", newline="", encoding="utf-8-sig") as f:  # -sig: Excel shows accents correctly
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)


def read_csv(name):
    with (RAW / name).open(encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def clean_jooble(log: Log) -> list[dict]:
    src, raw = "Jooble", read_csv("jooble_offers_raw.csv")
    log.step(src, "read raw file", len(raw), len(raw))
    rows = [r for r in raw if text(r["poste"])]
    log.step(src, "remove rows without a job title", len(raw), len(rows))
    seen, out = set(), []
    for r in rows:
        title, company = text(r["poste"]), text(r["entreprise"]) or "Confidentiel"
        city = r["localisation"].strip()
        city = "Tanger" if city.startswith("Tanger-") else city  # region name -> city
        key = (title.lower(), company.lower(), city.lower())
        if key in seen:
            log.reject(src, "duplicate (same title, company and city)", f"{title} | {company} | {city}")
            continue
        seen.add(key)
        out.append({"title": title, "company": company, "city": city, "extract": text(r["description"]),
                    "published": r["date_publication"][:10],  # 2026-10-05T00:00:00.0000000 -> 2026-10-05
                    "url": r["url"].split("&")[0],  # tracking parameters removed
                    "source": r["source"].strip() or "Jooble"})
    log.step(src, "remove duplicates (same offer collected under several keywords)", len(rows), len(out))
    write("offers_jooble.csv", out, ["title", "company", "city", "extract", "published", "url", "source"])
    return out


COMPANY_FIELDS = ["name", "category", "specialty", "city", "area", "website", "maps_url", "rating", "reviews",
                  "latitude", "longitude"]
MARRAKECH = {"marrakech", "marrakesh", "مراكش", "majorelle", "guéliz", "gueliz", "p2009"}
EMAIL = re.compile(r"^[\w.+-]+@[\w-]+(\.[\w-]+)+$")
EMAIL_IN_TEXT = re.compile(r"[\w.+-]+@[\w-]+(\.[\w-]+)+")
PHONE_IN_TEXT = re.compile(r"(\+?212|0)[5-7]\d{8}")


def in_morocco(lat, lon) -> bool:
    try:
        lat, lon = float(lat), float(lon)
    except (TypeError, ValueError):
        return False
    return MOROCCO_BOX[0] <= lat <= MOROCCO_BOX[1] and MOROCCO_BOX[2] <= lon <= MOROCCO_BOX[3]


def clean_google(log: Log) -> list[dict]:
    src, raw = "Google Maps (Marrakech)", read_csv("google_maps_marrakech_raw.csv")
    log.step(src, f"read raw file ({len(raw[0])} columns)", len(raw), len(raw))
    rows = []
    for r in raw:
        if r["business_status"] != "OPERATIONAL":
            log.reject(src, f"business status {r['business_status'] or 'unknown'}", r["nom"])
        else:
            rows.append(r)
    log.step(src, "keep only businesses Google lists as operational", len(raw), len(rows))
    names, unique = set(), []
    for r in rows:
        name = text(r["nom"]).lower()
        if name in names:
            log.reject(src, "duplicate name", r["nom"])
            continue
        names.add(name)
        unique.append(r)
    log.step(src, "remove duplicate company names", len(rows), len(unique))
    placed = []
    for r in unique:
        if in_morocco(r["latitude"], r["longitude"]):
            placed.append(r)
        else:
            log.reject(src, "coordinates missing or outside Morocco", r["nom"])
    log.step(src, "remove rows without valid coordinates in Morocco", len(unique), len(placed))

    out, emails, hidden = [], [], 0
    for r in placed:
        ville = r["ville"].strip().strip("،").strip()
        area = EMAIL_IN_TEXT.sub("", text(r["adresse_courte"])).strip(" ,") or "Marrakech"
        website = r["site_web"].strip()
        if PHONE_IN_TEXT.search(website) or EMAIL_IN_TEXT.search(website):  # e.g. instagram.com/shop_0698xxxxxx
            website = ""
        hidden += area != text(r["adresse_courte"]) or website != r["site_web"].strip()
        out.append({"name": text(r["nom"]), "category": text(r["categorie"]), "specialty": r["specialisation_ia"].strip(),
                    "city": "Marrakech" if ville.lower() in MARRAKECH else ville, "area": area,
                    "website": website, "maps_url": r["google_maps_url"].split("&")[0],
                    "rating": r["rating"].strip(),
                    "reviews": str(int(float(r["nombre_avis"]))) if r["nombre_avis"].strip() else "",
                    "latitude": r["latitude"].strip(), "longitude": r["longitude"].strip()})
        email = next((e for e in re.split(r"[;,\s]+", r["email"].lower()) if EMAIL.match(e)), "")  # "x@y.com;"
        if email:  # kept apart, never shown on the site (spontaneous applications only)
            emails.append({"maps_url": out[-1]["maps_url"], "email": email})
    log.step(src, f"keep {len(COMPANY_FIELDS)} public columns (phones, emails and AI scores dropped)", len(placed), len(out))
    log.step(src, f"contact details hidden in public fields removed ({hidden} rows fixed, none dropped)", len(out), len(out))
    write("companies_marrakech.csv", out, COMPANY_FIELDS)
    write("company_emails_PRIVATE.csv", emails, ["maps_url", "email"])
    log.step("Company emails (private)", "valid email address found for a kept company", len(out), len(emails))
    return out


def clean_osm(log: Log) -> list[dict]:
    out = []
    for city in CITIES:
        src, path = f"OpenStreetMap ({city})", RAW / f"osm_{slug(city)}_raw.json"
        if not path.exists():
            print(f"  {path.name} missing: run collect first")
            continue
        elements = json.loads(path.read_text(encoding="utf-8")).get("elements", [])
        log.step(src, "read raw file", len(elements), len(elements))
        stage = {"no name": 0, "not a real name": 0, "closed place": 0, "duplicate name": 0, "no coordinates": 0}
        seen = set()
        for e in elements:
            t = e.get("tags", {})
            name = text(t.get("name:fr") or t.get("name"))
            reason = ("no name" if not name else
                      "not a real name" if len(name) < 2 or any(w in name.lower() for w in NOT_A_NAME) else
                      "closed place" if any(k.startswith(("disused", "abandoned")) for k in t) else
                      "duplicate name" if name.lower() in seen else "")
            lat, lon = (e.get("lat"), e.get("lon")) if "lat" in e else (e.get("center", {}).get("lat"), e.get("center", {}).get("lon"))
            if not reason and not in_morocco(lat, lon):
                reason = "no coordinates"
            if reason:
                stage[reason] += 1
                log.reject(src, reason, name or f"{e['type']}/{e['id']}")
                continue
            seen.add(name.lower())
            street = " ".join(x for x in (t.get("addr:housenumber"), t.get("addr:street")) if x)
            cat, spec = category(t)
            out.append({"name": name[:200], "category": cat, "specialty": spec, "city": city,
                        "area": ", ".join(x for x in (street, t.get("addr:suburb"), city) if x)[:300],
                        "website": (t.get("website") or t.get("contact:website") or "")[:300],
                        "maps_url": f"https://www.openstreetmap.org/{e['type']}/{e['id']}",
                        "rating": "", "reviews": "", "latitude": lat, "longitude": lon})
        n = len(elements)
        for reason, removed in stage.items():
            log.step(src, f"remove: {reason}", n, n - removed)
            n -= removed
    write("companies_osm.csv", out, COMPANY_FIELDS)
    return out


def clean_remotive(log: Log) -> list[dict]:
    src, path = "Remotive", RAW / "remotive_raw.json"
    if not path.exists():
        return []
    jobs = json.loads(path.read_text(encoding="utf-8")).get("jobs", [])
    log.step(src, "read raw file", len(jobs), len(jobs))
    open_here = []
    for j in jobs:
        where = (j.get("candidate_required_location") or "").lower()
        if any(p in where for p in REMOTE_PLACES):
            open_here.append(j)
        else:
            log.reject(src, f"not open to Morocco ({j.get('candidate_required_location') or 'no location'})", j.get("title") or "")
    log.step(src, "keep jobs open to candidates in Morocco (worldwide, Africa, EMEA)", len(jobs), len(open_here))
    seen, out = set(), []
    for j in open_here:
        title, company = text(j.get("title")), text(j.get("company_name")) or "Confidentiel"
        if not title or not j.get("url") or (title.lower(), company.lower()) in seen:
            log.reject(src, "missing title or link, or duplicate", title)
            continue
        seen.add((title.lower(), company.lower()))
        out.append({"title": title, "company": company, "city": "Télétravail",
                    "type": REMOTE_TYPES.get(j.get("job_type"), "CDI"), "category": j.get("category") or "",
                    "extract": no_tags(j.get("description"))[:600], "published": (j.get("publication_date") or "")[:10],
                    "url": j["url"], "source": "Remotive"})
    log.step(src, "remove rows without title or link, and duplicates; HTML removed from descriptions", len(open_here), len(out))
    write("offers_remote.csv", out, ["title", "company", "city", "type", "category", "extract", "published", "url", "source"])
    return out


def clean() -> None:
    CLEAN.mkdir(parents=True, exist_ok=True)
    log = Log()
    results = {"offers_jooble.csv": clean_jooble(log), "companies_marrakech.csv": clean_google(log),
               "companies_osm.csv": clean_osm(log), "offers_remote.csv": clean_remotive(log)}
    write("cleaning_log.csv", log.steps, ["source", "step", "rows_before", "rows_removed", "rows_after"])
    write("rejected_rows.csv", log.rejected, ["source", "reason", "row"])
    for name, rows in results.items():
        print(f"  {name}: {len(rows)} rows")
    print(f"  rejected_rows.csv: {len(log.rejected)} rows, by reason:")
    for (src, reason), n in Counter((r["source"].split(" (")[0], r["reason"].split(" (")[0]) for r in log.rejected).most_common():
        print(f"    {n:>5}  {src}: {reason}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    {"collect": collect, "clean": clean}.get(sys.argv[1] if len(sys.argv) > 1 else "", lambda: print(__doc__))()
