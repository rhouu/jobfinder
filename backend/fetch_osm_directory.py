"""
FETCH OSM DIRECTORY — builds data/companies_osm.csv: employers in other Moroccan cities, from OpenStreetMap.

    python -m backend.fetch_osm_directory

Asks the public Overpass API for named businesses (offices, hotels, coworking spaces, factories) in each city of CITIES,
keeps the kinds of places that hire students, and writes them in the same columns as data/companies.csv.
The site adds new rows to the directory on its next start (seed.import_directory_extra), never twice.
Data © OpenStreetMap contributors, ODbL licence: the companies page credits it.
"""
import csv
import time

import requests

from .database import BASE_DIR

CITIES = ["Casablanca", "Rabat", "Tanger", "Fès", "Agadir", "Meknès"]  # Marrakech comes from data/companies.csv
SERVERS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter"]
OUT = BASE_DIR / "data" / "companies_osm.csv"

# OpenStreetMap tag value -> category shown on the site (its words also choose the sector, see helpers.directory_sector)
OFFICES = {
    "company": "Entreprise", "insurance": "Assurance", "financial": "Finance", "accountant": "Cabinet comptable",
    "estate_agent": "Agence immobilière", "consulting": "Cabinet de conseil", "lawyer": "Cabinet d'avocat",
    "it": "Informatique", "employment_agency": "Agence de recrutement", "advertising_agency": "Agence de publicité",
    "architect": "Cabinet d'architecte", "engineer": "Bureau d'études", "research": "Recherche",
    "educational_institution": "Établissement d'enseignement", "travel_agent": "Agence de voyage",
    "logistics": "Logistique", "newspaper": "Médias", "telecommunication_company": "Télécommunications",
    "ngo": "Association", "coworking": "Coworking", "financial_advisor": "Conseil financier",
}
SPECIALTY = {"it": "Software/IT"}
# A name that only says the place is gone or unknown is not a company
NOT_A_NAME = ("abandon", "fermé", "ferme définitivement", "désaffect", "closed", "en construction", "inconnu", "unknown")


def real_name(name: str) -> bool:
    return len(name) >= 2 and not any(w in name.lower() for w in NOT_A_NAME)


def query(city: str) -> str:
    offices = "|".join(OFFICES)
    return f"""[out:json][timeout:180];
area["name:fr"="{city}"]["boundary"="administrative"]->.a;
(
  nwr["office"~"^({offices})$"]["name"](area.a);
  nwr["tourism"="hotel"]["name"](area.a);
  nwr["amenity"="coworking_space"]["name"](area.a);
  nwr["man_made"="works"]["name"](area.a);
);
out center tags;"""


def category(tags: dict) -> tuple[str, str]:
    if tags.get("office") in OFFICES:
        return OFFICES[tags["office"]], SPECIALTY.get(tags["office"], "")
    if tags.get("tourism") == "hotel":
        return "Hôtel", ""
    if tags.get("amenity") == "coworking_space":
        return "Coworking", ""
    return "Usine (fabricant)", ""


def overpass(q: str) -> dict:
    """The free servers are often busy (429/502/504): wait and try again, then try the next server."""
    for attempt in range(6):
        url = SERVERS[attempt % len(SERVERS)]
        try:
            r = requests.post(url, data={"data": q}, headers={"User-Agent": "JobFinder.ma directory import"}, timeout=240)
            if r.status_code == 200:
                return r.json()
        except requests.RequestException:
            pass
        time.sleep(15 * (attempt + 1))
    raise RuntimeError("OpenStreetMap servers are busy, try again later")


def rows_for(city: str) -> list[dict]:
    data = overpass(query(city))
    out, seen = [], set()
    for e in data.get("elements", []):
        t = e.get("tags", {})
        name = (t.get("name:fr") or t.get("name") or "").strip()
        if not real_name(name) or name.lower() in seen or any(k.startswith(("disused", "abandoned")) for k in t):
            continue
        seen.add(name.lower())
        lat, lon = (e["lat"], e["lon"]) if "lat" in e else (e.get("center", {}).get("lat"), e.get("center", {}).get("lon"))
        street = " ".join(x for x in (t.get("addr:housenumber"), t.get("addr:street")) if x)
        cat, spec = category(t)
        out.append({"name": name[:200], "category": cat, "specialty": spec, "city": city,
                    "area": ", ".join(x for x in (street, t.get("addr:suburb"), city) if x)[:300],
                    "website": (t.get("website") or t.get("contact:website") or "")[:300],
                    "maps_url": f"https://www.openstreetmap.org/{e['type']}/{e['id']}",
                    "rating": "", "reviews": "", "latitude": lat or "", "longitude": lon or ""})
    return out


def main() -> None:
    rows = []
    for city in CITIES:
        try:
            found = rows_for(city)
        except RuntimeError as exc:  # keep the other cities; run the script again later for this one
            print(f"  {city}: skipped ({exc})")
            continue
        print(f"  {city}: {len(found)}")
        rows += found
        time.sleep(5)  # be gentle with the free Overpass server
    with OUT.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["name", "category", "specialty", "city", "area", "website", "maps_url",
                                          "rating", "reviews", "latitude", "longitude"])
        w.writeheader()
        w.writerows(rows)
    print(f"{len(rows)} companies written to {OUT}")


if __name__ == "__main__":
    main()
