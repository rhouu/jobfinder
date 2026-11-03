"""
COPY DATABASE — moves every table from one database to another, e.g. from Render's PostgreSQL to Neon.

Run it on your computer (the two addresses stay on your computer, never in the code):

    PowerShell:  $env:OLD_DATABASE_URL="postgresql://...render..."; $env:NEW_DATABASE_URL="postgresql://...neon..."
                 python -m backend.copy_database

It creates the tables in the new database, copies the rows in an order that respects the links between tables,
then sets each id counter so new rows continue after the copied ones. It refuses to run if the new database
already has accounts, so it can never overwrite real data.
"""
import os
import sys

from sqlalchemy import create_engine, func, inspect, select, text

from .database import Base


def _url(name: str) -> str:
    url = os.getenv(name, "").strip()
    if not url:
        sys.exit(f"Set {name} first (see the top of backend/copy_database.py).")
    for prefix in ("postgres://", "postgresql://"):  # same driver as the site
        if url.startswith(prefix):
            url = "postgresql+psycopg://" + url[len(prefix):]
    return url


def main() -> None:
    old, new = create_engine(_url("OLD_DATABASE_URL")), create_engine(_url("NEW_DATABASE_URL"))
    if old.url == new.url:
        sys.exit("OLD_DATABASE_URL and NEW_DATABASE_URL are the same database.")
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
