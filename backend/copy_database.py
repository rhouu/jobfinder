"""
COPY DATABASE — moves every table from one database to another, e.g. from Render's PostgreSQL to Neon.

Run it on your computer (the two addresses stay on your computer, never in the code). Either set them in the shell:

    PowerShell:  $env:OLD_DATABASE_URL="postgresql://...render..."; $env:NEW_DATABASE_URL="postgresql://...neon..."
                 python -m backend.copy_database

or write them in a file named .migrate.env in this folder (kept out of git), one per line:
    OLD_DATABASE_URL=postgresql://...render...
    NEW_DATABASE_URL=postgresql://...neon...

    python -m backend.copy_database --check   compares the row counts of both databases, copies nothing

It creates the tables in the new database, copies the rows in an order that respects the links between tables,
then sets each id counter so new rows continue after the copied ones. It refuses to run if the new database
already has accounts, so it can never overwrite real data.
"""
import os
import re
import sys

from sqlalchemy import create_engine, func, inspect, select, text

from .database import BASE_DIR, Base

SECRETS = BASE_DIR / ".migrate.env"


def _from_file(name: str) -> str:
    if SECRETS.exists():
        for line in SECRETS.read_text(encoding="utf-8").splitlines():
            key, _, value = line.partition("=")
            if key.strip() == name:  # keep only the address, even if it was pasted inside the <...> hint
                found = re.search(r"postgres(?:ql)?://[^\s<>\"']+", value)
                return found.group(0) if found else ""
    return ""


def _url(name: str) -> str:
    url = os.getenv(name, "").strip() or _from_file(name)
    if not url or "..." in url or url.startswith("<"):
        sys.exit(f"Set {name} first (see the top of backend/copy_database.py).")
    for prefix in ("postgres://", "postgresql://"):  # same driver as the site
        if url.startswith(prefix):
            url = "postgresql+psycopg://" + url[len(prefix):]
    return url


def check(old, new) -> None:
    """Row counts side by side (only numbers and host names are printed, never the passwords)."""
    print(f"  old: {old.url.host}   new: {new.url.host}")
    names_old, names_new = set(inspect(old).get_table_names()), set(inspect(new).get_table_names())
    same = True
    with old.connect() as a, new.connect() as b:
        for table in Base.metadata.sorted_tables:
            n_old = a.scalar(select(func.count()).select_from(table)) if table.name in names_old else 0
            n_new = b.scalar(select(func.count()).select_from(table)) if table.name in names_new else 0
            same &= n_old == n_new
            print(f"  {table.name:28} {n_old:>6} {n_new:>6}{'' if n_old == n_new else '   DIFFERENT'}")
    print("Everything matches." if same else "Some tables differ.")


def main() -> None:
    old, new = create_engine(_url("OLD_DATABASE_URL")), create_engine(_url("NEW_DATABASE_URL"))
    if old.url == new.url:
        sys.exit("OLD_DATABASE_URL and NEW_DATABASE_URL are the same database.")
    if "--check" in sys.argv:
        return check(old, new)
    Base.metadata.create_all(new)
    existing = set(inspect(old).get_table_names())
    with old.connect() as src, new.begin() as dst:
        if dst.scalar(select(func.count()).select_from(Base.metadata.tables["users"])):
            sys.exit("The new database already has accounts. Nothing was copied.")
        for table in Base.metadata.sorted_tables:  # parents before children
            if table.name not in existing:
                print(f"  {table.name}: not in the old database yet, skipped")
                continue
            rows = [dict(r._mapping) for r in src.execute(table.select())]
            for i in range(0, len(rows), 500):
                dst.execute(table.insert(), rows[i:i + 500])
            print(f"  {table.name}: {len(rows)} rows")
        if new.dialect.name == "postgresql":  # next id = biggest copied id + 1
            for table in Base.metadata.sorted_tables:
                if "id" in table.c and table.c.id.autoincrement in (True, "auto") and table.c.id.primary_key:
                    dst.execute(text(f"SELECT setval(pg_get_serial_sequence('{table.name}', 'id'), "
                                     f"COALESCE((SELECT MAX(id) FROM {table.name}), 0) + 1, false)"))
    print("Done. Now put NEW_DATABASE_URL in Render as DATABASE_URL.")


if __name__ == "__main__":
    main()
