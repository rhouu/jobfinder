"""
DATA EXPLORATION: the figures behind the analysis slides, computed from data/raw and data/clean.

    python -m backend.data_pipeline clean      # first
    python -m backend.data_exploration          # prints the figures and writes data/clean/exploration.json
"""
import csv
import json
import statistics
import sys
from collections import Counter

from .data_pipeline import CLEAN, RAW
from .helpers import directory_sector, guess_sector


def read(path):
    with path.open(encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def explore() -> dict:
    raw_jobs = read(RAW / "jooble_offers_raw.csv")
    offers, remote = read(CLEAN / "offers_jooble.csv"), read(CLEAN / "offers_remote.csv")
    google, osm = read(CLEAN / "companies_marrakech.csv"), read(CLEAN / "companies_osm.csv")
    companies = google + osm
    copies = Counter((r["poste"].lower(), r["entreprise"].lower(), r["localisation"]) for r in raw_jobs)
    ratings = [float(r["rating"]) for r in google if r["rating"]]
    reviews = [int(r["reviews"]) for r in google if r["reviews"]]
    band = lambda v: "< 3" if v < 3 else "3 - 3,9" if v < 4 else "4 - 4,4" if v < 4.5 else "4,5 - 5"
    copies_band = lambda n: "1-9" if n < 10 else "10-19" if n < 20 else "20-29" if n < 30 else "30-39" if n < 40 else "40-49" if n < 50 else "50+"
    return {
        "raw_offers": len(raw_jobs), "unique_offers": len(copies), "mean_copies": round(len(raw_jobs) / len(copies), 1),
        "raw_offers_by_city": Counter(r["localisation"] for r in raw_jobs).most_common(),
        "copies_per_offer": Counter(copies_band(n) for n in copies.values()),
        "offers_by_city": Counter(r["city"] for r in offers).most_common(),
        "offers_by_sector": Counter(guess_sector(f"{r['title']} {r['extract']}") for r in offers).most_common(),
        "offers_by_month": sorted(Counter(r["published"][:7] for r in offers).items()),
        "top_recruiters": Counter(r["company"] for r in offers).most_common(5),
        "remote_by_type": Counter(r["type"] for r in remote).most_common(),
        "companies": len(companies),
        "companies_by_city": Counter(r["city"] for r in companies).most_common(),
        "companies_by_sector": Counter(directory_sector(r["category"], r["specialty"]) for r in companies).most_common(),
        "website_share": {"google": round(100 * sum(bool(r["website"]) for r in google) / len(google)),
                          "osm": round(100 * sum(bool(r["website"]) for r in osm) / len(osm))},
        "ratings": {"count": len(ratings), "mean": round(statistics.mean(ratings), 2), "median": statistics.median(ratings),
                    "bands": Counter(band(v) for v in ratings)},
        "reviews": {"median": statistics.median(reviews), "max": max(reviews)},
        "google_categories_empty": sum(not r["category"] for r in google),
    }


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    result = explore()
    (CLEAN / "exploration.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    for key, value in result.items():
        print(f"{key}: {value}")
