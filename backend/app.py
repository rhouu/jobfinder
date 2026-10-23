"""
JOBFINDER.MA — the web server (FastAPI).   Run:  python -m uvicorn backend.app:app --reload

Every URL of the API lives in this file, grouped in sections:
  1. Setup              app, startup, public portfolio page
  2. Accounts           register, login, Google, email verification, password reset, settings
  3. Public job board   offers, companies, reviews, stats
  4. Chatbot            Gemini career assistant
  5. Notifications      bell icon
  6. Messages           company <-> candidate chat
  7. Students           profile, CV upload, AI tools, applications, saved offers, mock interview, reviews
  8. Companies          profile, verification, offers, applicants, interviews
  9. Admin              analytics and moderation
"""
import base64
import json
import logging
import re
import secrets
import threading
import time
from collections import Counter
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from html import escape

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import String, cast, func, or_, select
from sqlalchemy.orm import Session, selectinload

from . import ai
from .database import (CONTACT_EMAIL, FRONTEND_DIR, GOOGLE_CLIENT_ID, JOOBLE_API_KEY, OFFER_MAX_DAYS, SITE_URL, Application, Base, Company, DirectoryCompany, EmailCode,
                       Job, Message, Notification, Review, SessionLocal, Setting, SpontaneousApplication, StudentCV,
                       SavedJob, SavedSearch, StudentProfile, User, engine, get_db, utcnow)
from .helpers import (check_signature, current_user, guess_sector, hash_password, login_response, mail_enabled, make_token,
                      match_job, notify, optional_user, read_token, require_role, send_email, send_mail, sign, verify_password)
from .seed import refresh_due, refresh_offers, seed

logging.basicConfig(level=logging.INFO)
JOB_TYPES = ["CDI", "CDD", "Stage", "PFE", "Alternance", "Freelance"]
STATUSES = ["submitted", "reviewing", "interview", "accepted", "rejected"]
student_only, company_only, admin_only = require_role("student"), require_role("company"), require_role("admin")
log = logging.getLogger("jobfinder")


# ============================================================================ 1. SETUP
@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(engine)  # creates missing tables
    seed()                            # admin account + real data on first start
    threading.Thread(target=_daily_offers, daemon=True).start()
    yield


def _refresh_and_alert(db: Session) -> dict:
    """Fetches new offers, then sends job alerts for them (like offers posted by companies)."""
    result = refresh_offers(db)
    for job in result["added"][:60]:
        _alert_matching_students(job, db)
    db.commit()
    return {"added": len(result["added"]), "closed": result["closed"]}


def _daily_offers():
    """Background loop: once a day, new offers from Jooble come in and old job-board offers close.
    (On a free host that sleeps, this runs the next time the site wakes up.)"""
    time.sleep(20)  # let the site finish starting
    while True:
        try:
            with SessionLocal() as db:
                if refresh_due(db):
                    _refresh_and_alert(db)
        except Exception:  # never let the loop die
            log.exception("Daily offers refresh failed")
        time.sleep(3600)


app = FastAPI(title="JobFinder.ma API", lifespan=lifespan)


@app.middleware("http")
async def no_stale_files(request: Request, call_next):
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers.setdefault("Cache-Control", "no-cache")  # browser re-checks files, so updates show at once
    return response


@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    return RedirectResponse("/favicon.svg")


@app.get("/api/config")
def public_config():
    return {"google_client_id": GOOGLE_CLIENT_ID, "ai_enabled": ai.ai_available(), "mail_enabled": mail_enabled(),
            "contact_email": CONTACT_EMAIL}


THEMES = {"emerald": ("#10b981", "#06b6d4", "#06100d"), "sunset": ("#f97316", "#ec4899", "#140a0b"),
          "ocean": ("#3b82f6", "#8b5cf6", "#080b18"), "mono": ("#e5e7eb", "#9ca3af", "#0a0a0a")}


@app.get("/p/{user_id}", response_class=HTMLResponse)
def public_portfolio(user_id: int, db: Session = Depends(get_db)):
    user = db.get(User, user_id)
    p = user.profile if user else None
    if not p or not p.portfolio_public or not p.portfolio_html or not user.is_active:
        raise HTTPException(404, "Portfolio not found")
    a, b, bg = THEMES.get(p.portfolio_theme, THEMES["emerald"])
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{escape(user.name)} — Portfolio</title><link rel="icon" href="/favicon.svg">
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/css/portfolio.css"><style>:root{{--a:{a};--b:{b};--bg:{bg}}}</style></head>
<body><div class="pf-glow"></div><main class="pf">{p.portfolio_html}</main>
<footer class="pf-footer">Built with <a href="/">JobFinder.ma</a></footer><script src="/js/portfolio.js"></script></body></html>"""


# ============================================================================ 2. ACCOUNTS
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class RegisterIn(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    email: str
    password: str = Field(min_length=8, max_length=128)
    role: str = "student"
    company_name: str | None = None
    language: str = "en"

    @field_validator("email")
    @classmethod
    def check_email(cls, v):
        v = v.strip().lower()
        if not EMAIL_RE.match(v):
            raise ValueError("Invalid email address")
        return v


def _new_account_records(user: User, company_name: str | None = None):
    if user.role == "student":
        user.profile = StudentProfile()
    elif user.role == "company":
        user.company = Company(name=company_name or user.name)


def _send_verification(user: User):
    send_email(user, "verify", {"link": f"/auth.html?verify={make_token(user, 'verify', 48)}"})


# Email accounts confirm their address with a 6-digit code (only when the site can send emails).
# Until then they can't sign in. Google accounts skip this: Google already checked the address.
CODE_MINUTES = 15


def _needs_code(user: User) -> bool:
    return not user.email_verified and mail_enabled()


def _send_code(user: User, db: Session) -> None:
    row, now = user.email_code, utcnow()
    if row and (now - row.sent_at).total_seconds() < 60:
        return  # at most one email per minute
    code = f"{secrets.randbelow(10 ** 6):06d}"
    if not row:
        row = user.email_code = EmailCode(user_id=user.id)
    row.code_hash, row.attempts = sign(f"code:{user.id}:{code}"), 0
    row.sent_at, row.expires_at = now, now + timedelta(minutes=CODE_MINUTES)
    db.commit()
    send_email(user, "code", {"code": code, "minutes": CODE_MINUTES})


def _code_step(user: User, db: Session) -> dict:
    _send_code(user, db)
    return {"needs_code": True, "email": user.email}


@app.post("/api/auth/register")
def register(data: RegisterIn, db: Session = Depends(get_db)):
    if data.role not in ("student", "company"):
        raise HTTPException(400, "Role must be student or company.")
    if db.scalar(select(User).where(User.email == data.email)):
        raise HTTPException(400, "An account with this email already exists.")
    user = User(email=data.email, name=data.name.strip(), password_hash=hash_password(data.password), role=data.role,
                language=data.language if data.language in ("en", "fr", "ar") else "en", last_login=utcnow())
    _new_account_records(user, data.company_name)
    db.add(user)
    db.commit()
    if _needs_code(user):
        return _code_step(user, db)
    _send_verification(user)
    return login_response(user)


class LoginIn(BaseModel):
    email: str
    password: str


@app.post("/api/auth/login")
def login(data: LoginIn, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(User.email == data.email.strip().lower()))
    if not user or not verify_password(data.password, user.password_hash):
        raise HTTPException(401, "Incorrect email or password.")
    if not user.is_active:
        raise HTTPException(403, "This account has been suspended. Contact support.")
    if _needs_code(user):
        return _code_step(user, db)
    user.last_login = utcnow()
    db.commit()
    return login_response(user)


class CodeIn(BaseModel):
    email: str
    password: str  # asked again so that nobody can confirm (and open) an account by guessing codes
    code: str = ""


def _code_user(data: CodeIn, db: Session) -> User:
    user = db.scalar(select(User).where(User.email == data.email.strip().lower()))
    if not user or not verify_password(data.password, user.password_hash):
        raise HTTPException(401, "Incorrect email or password.")
    if not user.is_active:
        raise HTTPException(403, "This account has been suspended. Contact support.")
    return user


@app.post("/api/auth/verify-code")
def verify_code(data: CodeIn, db: Session = Depends(get_db)):
    user = _code_user(data, db)
    if user.email_verified:
        return login_response(user)
    row = user.email_code
    if not row or row.expires_at < utcnow():
        raise HTTPException(400, "This code has expired. Ask for a new one.")
    if row.attempts >= 5:
        raise HTTPException(400, "Too many wrong codes. Ask for a new one.")
    if not check_signature(f"code:{user.id}:{data.code.strip()}", row.code_hash):
        row.attempts += 1
        db.commit()
        raise HTTPException(400, f"Wrong code. {5 - row.attempts} tries left.")
    user.email_verified, user.last_login = True, utcnow()
    db.delete(row)
    db.commit()
    return login_response(user)


@app.post("/api/auth/resend-code")
def resend_code(data: CodeIn, db: Session = Depends(get_db)):
    user = _code_user(data, db)
    if _needs_code(user):
        _send_code(user, db)
    return {"ok": True}


class GoogleIn(BaseModel):
    credential: str
    role: str = "student"


@app.post("/api/auth/google")
def google_login(data: GoogleIn, db: Session = Depends(get_db)):
    if not GOOGLE_CLIENT_ID:
        raise HTTPException(503, "Google sign-in is not configured on this server.")
    from google.auth.transport import requests as google_requests
    from google.oauth2 import id_token
    try:
        info = id_token.verify_oauth2_token(data.credential, google_requests.Request(), GOOGLE_CLIENT_ID)
    except ValueError:
        raise HTTPException(401, "Google sign-in failed. Please try again.")
    if not info.get("email_verified"):
        raise HTTPException(401, "Your Google email is not verified.")
    email = info["email"].lower()
    user = db.scalar(select(User).where(or_(User.google_id == info["sub"], User.email == email)))
    if user:
        if not user.is_active:
            raise HTTPException(403, "This account has been suspended. Contact support.")
        user.google_id = user.google_id or info["sub"]
        user.avatar_url = user.avatar_url or info.get("picture")
    else:
        user = User(email=email, name=info.get("name") or email.split("@")[0], google_id=info["sub"],
                    avatar_url=info.get("picture"), role=data.role if data.role in ("student", "company") else "student")
        _new_account_records(user)
        db.add(user)
    user.email_verified = True  # Google already checked the email
    user.last_login = utcnow()
    db.commit()
    return login_response(user)


@app.get("/api/auth/me")
def me(user: User = Depends(current_user)):
    data = user.public()
    if user.role == "company" and user.company:
        data["company"] = user.company.to_dict(private=True)
    if user.role == "student" and user.profile:
        data["completion"] = user.profile.completion()
    return data


class SettingsIn(BaseModel):
    language: str


@app.put("/api/auth/settings")
def update_settings(data: SettingsIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if data.language in ("en", "fr", "ar"):
        user.language = data.language
        db.commit()
    return user.public()


@app.post("/api/auth/resend-verification")
def resend_verification(user: User = Depends(current_user)):
    if not user.email_verified:
        _send_verification(user)
    return {"ok": True}


class TokenIn(BaseModel):
    token: str


@app.post("/api/auth/verify")
def verify_email(data: TokenIn, db: Session = Depends(get_db)):
    user = read_token(data.token, "verify", db)
    if not user:
        raise HTTPException(400, "This verification link is invalid or has expired.")
    user.email_verified = True
    db.commit()
    return {"ok": True}


class ForgotIn(BaseModel):
    email: str


@app.post("/api/auth/forgot")
def forgot_password(data: ForgotIn, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(User.email == data.email.strip().lower()))
    if user and user.is_active:
        send_email(user, "reset", {"link": f"/auth.html?reset={make_token(user, 'reset', 1)}"})
    return {"ok": True}  # same answer either way, so nobody can test which emails exist


class ResetIn(BaseModel):
    token: str
    password: str = Field(min_length=8, max_length=128)


@app.post("/api/auth/reset")
def reset_password(data: ResetIn, db: Session = Depends(get_db)):
    user = read_token(data.token, "reset", db)
    if not user:
        raise HTTPException(400, "This reset link is invalid, expired or already used.")
    user.password_hash = hash_password(data.password)
    user.email_verified = True  # they proved they own the inbox
    db.commit()
    return login_response(user)


# ============================================================================ 3. PUBLIC JOB BOARD
def _student_marks(user: User | None, db: Session) -> tuple[set, set]:
    if not user or user.role != "student":
        return set(), set()
    return (set(db.scalars(select(Application.job_id).where(Application.student_id == user.id))),
            set(db.scalars(select(SavedJob.job_id).where(SavedJob.user_id == user.id))))


def _search_jobs(db: Session, q: str = ""):
    stmt = (select(Job).join(Company).where(Job.status == "open")
            .options(selectinload(Job.company).selectinload(Company.reviews), selectinload(Job.applications)))
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(Job.title.ilike(like), Job.description.ilike(like), Company.name.ilike(like),
                              cast(Job.skills, String).ilike(like)))
    return stmt


@app.get("/api/jobs")
def list_jobs(q: str = "", city: str = "", type: str = "", mode: str = "", level: str = "", company_id: int | None = None,
              sort: str = "recent", page: int = 1, per_page: int = 12,
              user: User | None = Depends(optional_user), db: Session = Depends(get_db)):
    per_page, page = max(1, min(per_page, 200)), max(1, page)  # the map asks for up to 200 at once
    stmt = _search_jobs(db, q)
    if city:
        stmt = stmt.where(Job.city == city)
    if type:
        stmt = stmt.where(Job.type.in_(type.split(",")))
    if mode:
        stmt = stmt.where(Job.work_mode.in_(mode.split(",")))
    if level:
        stmt = stmt.where(Job.level == level)
    if company_id:
        stmt = stmt.where(Job.company_id == company_id)
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    profile = user.profile if user and user.role == "student" else None

    if sort == "match" and profile:
        scored = sorted(((match_job(profile, j), j) for j in db.scalars(stmt)), key=lambda x: -x[0]["score"])
        rows = scored[(page - 1) * per_page: page * per_page]
    else:
        order = Job.salary_max.desc().nulls_last() if sort == "salary" else Job.created_at.desc()
        jobs = db.scalars(stmt.order_by(order).offset((page - 1) * per_page).limit(per_page))
        rows = [(match_job(profile, j) if profile else None, j) for j in jobs]

    applied, saved = _student_marks(user, db)
    items = [{**j.to_dict(), "match": m, "applied": j.id in applied, "saved": j.id in saved} for m, j in rows]
    return {"items": items, "total": total, "page": page, "pages": max(1, -(-total // per_page))}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: int, user: User | None = Depends(optional_user), db: Session = Depends(get_db)):
    job = db.get(Job, job_id)
    owner = user and (user.role == "admin" or (user.company and user.company.id == job.company_id)) if job else False
    if not job or (job.status != "open" and not owner):
        raise HTTPException(404, "This offer no longer exists.")
    job.views += 1
    db.commit()
    applied, saved = _student_marks(user, db)
    similar = db.scalars(select(Job).where(Job.status == "open", Job.id != job.id, or_(Job.type == job.type, Job.city == job.city))
                         .order_by(Job.created_at.desc()).limit(3))
    return {**job.to_dict(), "applied": job.id in applied, "saved": job.id in saved,
            "match": match_job(user.profile, job) if user and user.role == "student" else None,
            "reviews": [r.to_dict() for r in sorted(job.company.reviews, key=lambda r: r.created_at, reverse=True)[:5]],
            "similar": [s.to_dict() for s in similar]}


@app.get("/api/stats")
def public_stats(db: Session = Depends(get_db)):
    return {"jobs": db.scalar(select(func.count(Job.id)).where(Job.status == "open")),
            "internships": db.scalar(select(func.count(Job.id)).where(Job.status == "open", Job.type.in_(["Stage", "PFE"]))),
            "companies": db.scalar(select(func.count(Company.id))),
            "directory": db.scalar(select(func.count(DirectoryCompany.id))),
            "students": db.scalar(select(func.count(User.id)).where(User.role == "student")),
            "cities": db.scalar(select(func.count(func.distinct(Job.city))).where(Job.status == "open"))}


@app.get("/api/companies")
def list_companies(db: Session = Depends(get_db)):
    """Companies hiring now: every company (with an account or external) that has at least one open offer."""
    companies = db.scalars(select(Company).options(selectinload(Company.jobs), selectinload(Company.reviews)))
    hiring = [{**c.to_dict(), "open_jobs": sum(1 for j in c.jobs if j.status == "open")} for c in companies
              if c.verification_status != "rejected"]
    return sorted([c for c in hiring if c["open_jobs"]], key=lambda c: (-c["open_jobs"], c["name"].lower()))


@app.get("/api/directory")
def company_directory(q: str = "", sector: str = "", page: int = 1, per_page: int = 24, db: Session = Depends(get_db)):
    """Public company directory, searchable by name / category / area and filterable by sector."""
    per_page, page = max(1, min(per_page, 60)), max(1, page)
    stmt = select(DirectoryCompany)
    if q.strip():
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(DirectoryCompany.name.ilike(like), DirectoryCompany.category.ilike(like),
                              DirectoryCompany.area.ilike(like)))
    found = stmt.subquery()  # sector counts follow the search text (shown on the filter buttons)
    sectors = dict(db.execute(select(found.c.sector, func.count()).group_by(found.c.sector)).all())
    if sector:
        stmt = stmt.where(DirectoryCompany.sector == sector)
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    # Best known first: rating weighted by number of reviews, then name
    rows = db.scalars(stmt.order_by(DirectoryCompany.reviews.desc(), DirectoryCompany.name).offset((page - 1) * per_page).limit(per_page))
    return {"items": [c.to_dict() for c in rows], "total": total, "page": page, "pages": max(1, -(-total // per_page)),
            "sectors": sectors}


# --------------------------------------------------------- spontaneous applications (email + CV)
class SpontaneousIn(BaseModel):
    message: str = Field(min_length=30, max_length=3000)
    cv_name: str = Field(default="CV.pdf", max_length=120)
    cv_base64: str = ""  # empty: use the CV saved in the profile


SPONTANEOUS_PER_DAY = 5  # limits abuse: a student can't use the site to spam companies


@app.post("/api/directory/{company_id}/apply")
def spontaneous_apply(company_id: int, data: SpontaneousIn, user: User = Depends(student_only), db: Session = Depends(get_db)):
    """Emails the student's message + CV to a directory company. Answers go straight to the student (Reply-To)."""
    company = db.get(DirectoryCompany, company_id)
    if not company or not company.can_apply:
        raise HTTPException(404, "This company can't receive applications through JobFinder.")
    if not mail_enabled():
        raise HTTPException(503, "Sending emails isn't set up on this site yet. Please try again later.")
    if not user.email_verified:
        raise HTTPException(400, "Confirm your email address first (check your inbox), so the company can reply to you.")
    if db.scalar(select(SpontaneousApplication.id).where(SpontaneousApplication.student_id == user.id,
                                                          SpontaneousApplication.directory_id == company.id)):
        raise HTTPException(400, "You already sent your application to this company.")
    today = utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    if db.scalar(select(func.count(SpontaneousApplication.id)).where(SpontaneousApplication.student_id == user.id,
                                                                     SpontaneousApplication.created_at >= today)) >= SPONTANEOUS_PER_DAY:
        raise HTTPException(429, f"You can send {SPONTANEOUS_PER_DAY} applications per day. Try again tomorrow.")
    if data.cv_base64:
        pdf, file_name = _decode_pdf(data.cv_base64, CV_MAX_MB), _pdf_name(data.cv_name)
    elif user.cv_file:
        pdf, file_name = user.cv_file.data, user.cv_file.file_name
    else:
        raise HTTPException(400, "Attach your CV as a PDF file under 2 MB.")

    optout = f"{SITE_URL}/api/directory/{company.id}/optout?sig={sign(f'optout:{company.id}')}"
    body = (f"{data.message.strip()}\n\n{user.name}\n{user.email}\n\n"
            f"----\n"
            f"Candidature envoyée via JobFinder.ma par {user.name}. Répondez à cet e-mail pour contacter directement le candidat. CV en pièce jointe.\n"
            f"Application sent through JobFinder.ma by {user.name}. Reply to this email to contact the candidate directly. CV attached.\n"
            f"Ne plus recevoir de candidatures via JobFinder.ma / Stop receiving applications: {optout}")
    if not send_mail(company.contact.email, f"Candidature spontanée – {user.name}", body, reply_to=user.email,
                     attachment=(file_name, pdf)):
        raise HTTPException(502, "The email couldn't be sent. Please try again in a few minutes.")
    row = SpontaneousApplication(student_id=user.id, directory_id=company.id, message=data.message.strip())
    db.add(row)
    send_email(user, "spontaneous_sent", {"company": company.name, "message": data.message.strip(), "link": "/dashboard.html#applications"})
    db.commit()
    return row.to_dict()


@app.get("/api/directory/{company_id}/optout", response_class=HTMLResponse)
def spontaneous_optout(company_id: int, sig: str = "", db: Session = Depends(get_db)):
    """Link at the bottom of every application email: the company stops receiving them."""
    company = db.get(DirectoryCompany, company_id)
    if not company or not company.contact or not check_signature(f"optout:{company_id}", sig):
        raise HTTPException(404, "Invalid link.")
    company.contact.opted_out = True
    db.commit()
    return (f"<!doctype html><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>"
            f"<title>JobFinder.ma</title><body style='font-family:system-ui;max-width:560px;margin:60px auto;padding:0 16px;line-height:1.6'>"
            f"<h2>{escape(company.name)}</h2><p>Vous ne recevrez plus de candidatures via JobFinder.ma.</p>"
            f"<p>You will no longer receive applications through JobFinder.ma.</p><p><a href='/'>JobFinder.ma</a></p></body>")


@app.get("/api/student/spontaneous")
def my_spontaneous(user: User = Depends(student_only), db: Session = Depends(get_db)):
    rows = db.scalars(select(SpontaneousApplication).where(SpontaneousApplication.student_id == user.id)
                      .order_by(SpontaneousApplication.created_at.desc()))
    return [r.to_dict() for r in rows]


@app.get("/api/companies/{company_id}/logo")
def company_logo(company_id: int, db: Session = Depends(get_db)):
    company = db.get(Company, company_id)
    if not company or not company.logo:
        raise HTTPException(404, "No logo.")
    return Response(company.logo, media_type=company.logo_type, headers={"Cache-Control": "public, max-age=604800"})


@app.get("/api/companies/{company_id}/reviews")
def company_reviews(company_id: int, db: Session = Depends(get_db)):
    company = db.get(Company, company_id)
    if not company:
        raise HTTPException(404, "Company not found.")
    return {"rating": company.rating(), "reviews": [r.to_dict() for r in sorted(company.reviews, key=lambda r: r.created_at, reverse=True)]}


# ============================================================================ 4. CHATBOT
class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=2000)
    history: list[dict] = []
    language: str = "en"


STOP_WORDS = {"the", "and", "for", "with", "job", "jobs", "offer", "offers", "find", "want", "need", "looking", "any", "are",
              "les", "des", "une", "pour", "avec", "dans", "stage", "emploi", "offre", "offres", "cherche", "je", "un", "en",
              "show", "me", "in", "a", "an", "is", "there", "what", "which", "can", "you", "help", "please", "how"}
CITY_NAMES = ["Casablanca", "Rabat", "Marrakech", "Tanger", "Fès", "Agadir", "Meknès", "Oujda", "Kénitra", "Tétouan", "Ouarzazate"]


def _jobs_for_chat(message: str, user: User | None, db: Session) -> list[Job]:
    """Finds offers related to the message (keywords, city, contract type) to give the AI real data."""
    text = message.lower()
    stmt = _search_jobs(db)
    city = next((c for c in CITY_NAMES if c.lower() in text or c.lower().replace("è", "e").replace("é", "e") in text), None)
    if city:
        stmt = stmt.where(Job.city == city)
    types = [t for t in JOB_TYPES if t.lower() in text] + (["Stage"] if re.search(r"intern|stage|تدريب", text) else [])
    if types:
        stmt = stmt.where(Job.type.in_(set(types)))
    words = [w for w in re.findall(r"[\w+#.]{3,}", text) if w not in STOP_WORDS and w.capitalize() not in CITY_NAMES]
    jobs = list(db.scalars(stmt))
    if words:
        def hits(j: Job) -> int:
            blob = f"{j.title} {' '.join(j.skills or [])} {j.company.name} {j.description}".lower()
            return sum(1 for w in words if w in blob)
        keyword_jobs = [j for j in jobs if hits(j)]
        jobs = sorted(keyword_jobs, key=hits, reverse=True) if keyword_jobs else jobs
    if user and user.role == "student" and user.profile:
        jobs.sort(key=lambda j: -match_job(user.profile, j)["score"])
    return jobs[:8]


@app.post("/api/chat")
def chat(data: ChatIn, user: User | None = Depends(optional_user), db: Session = Depends(get_db)):
    jobs = _jobs_for_chat(data.message, user, db)
    reply = ai.chat_reply(data.message, data.history, data.language, user, jobs)
    if reply is None:  # no Gemini key (or Gemini is down): show matching offers instead
        return {"reply": None, "offline": True, "jobs": [j.to_dict() for j in jobs[:4]]}
    ids = {int(x) for x in re.findall(r"\[job:(\d+)\]", reply)}
    return {"reply": reply, "offline": False, "jobs": [j.to_dict() for j in jobs if j.id in ids]}


# ============================================================================ 5. NOTIFICATIONS
@app.get("/api/notifications")
def my_notifications(user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.scalars(select(Notification).where(Notification.user_id == user.id).order_by(Notification.created_at.desc()).limit(30))
    unread = db.scalar(select(func.count(Notification.id)).where(Notification.user_id == user.id, Notification.is_read.is_(False)))
    return {"unread": unread, "items": [n.to_dict() for n in rows]}


class ReadIn(BaseModel):
    ids: list[int] = []  # empty = mark everything as read


@app.post("/api/notifications/read")
def read_notifications(data: ReadIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    stmt = select(Notification).where(Notification.user_id == user.id, Notification.is_read.is_(False))
    if data.ids:
        stmt = stmt.where(Notification.id.in_(data.ids))
    for n in db.scalars(stmt):
        n.is_read = True
    db.commit()
    return {"ok": True}


# ============================================================================ 6. MESSAGES
def _conversation(app_id: int, user: User, db: Session) -> Application:
    """Only the candidate and the company that owns the offer can read an application's messages."""
    a = db.get(Application, app_id)
    if not a or not (a.student_id == user.id or (user.company and a.job.company_id == user.company.id)):
        raise HTTPException(404, "Conversation not found.")
    return a


@app.get("/api/messages")
def conversations(user: User = Depends(require_role("student", "company")), db: Session = Depends(get_db)):
    stmt = select(Application).options(selectinload(Application.messages), selectinload(Application.job).selectinload(Job.company),
                                       selectinload(Application.student))
    stmt = stmt.where(Application.student_id == user.id) if user.role == "student" else \
        stmt.join(Job).where(Job.company_id == _company(user, db).id)
    out = []
    for a in db.scalars(stmt):
        if not a.messages:
            continue
        last = a.messages[-1]
        other = a.job.company.to_dict() if user.role == "student" else {"name": a.student.name, "avatar_url": a.student.avatar_url}
        out.append({"application_id": a.id, "job": {"id": a.job.id, "title": a.job.title}, "other": other,
                    "last": last.to_dict(), "unread": sum(1 for m in a.messages if not m.is_read and m.sender_id != user.id)})
    return sorted(out, key=lambda c: c["last"]["created_at"], reverse=True)


@app.get("/api/messages/{app_id}")
def read_conversation(app_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    a = _conversation(app_id, user, db)
    for m in a.messages:
        if m.sender_id != user.id:
            m.is_read = True
    db.commit()
    return {"application_id": a.id, "job": {"id": a.job.id, "title": a.job.title}, "company": a.job.company.to_dict(),
            "student": {"id": a.student.id, "name": a.student.name, "avatar_url": a.student.avatar_url},
            "status": a.status, "interview": a.interview(), "messages": [m.to_dict() for m in a.messages]}


class MessageIn(BaseModel):
    body: str = Field(min_length=1, max_length=4000)


@app.post("/api/messages/{app_id}")
def send_message(app_id: int, data: MessageIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    a = _conversation(app_id, user, db)
    receiver = a.job.company.owner if user.id == a.student_id else a.student
    if not receiver:
        raise HTTPException(400, "This company hasn't joined JobFinder yet. You can message them once they do.")
    msg = Message(application_id=a.id, sender_id=user.id, body=data.body.strip())
    db.add(msg)
    link = "/company.html#messages" if receiver.role == "company" else "/dashboard.html#messages"
    already_told = db.scalar(select(Notification).where(Notification.user_id == receiver.id, Notification.kind == "message",
                                                        Notification.is_read.is_(False), Notification.link == f"{link}/{a.id}"))
    if not already_told:  # one alert per conversation until it is read, to avoid spam
        sender = a.job.company.name if user.id != a.student_id else user.name
        notify(db, receiver, "message", {"sender": sender, "job": a.job.title}, f"{link}/{a.id}", email=True)
    db.commit()
    return msg.to_dict()


# ============================================================================ 7. STUDENTS
def _profile(user: User, db: Session) -> StudentProfile:
    if not user.profile:
        user.profile = StudentProfile()
        db.commit()
    return user.profile


def _unique(values: list, limit: int) -> list[str]:
    seen, out = set(), []
    for v in values:
        v = str(v).strip()[:60]
        if v and v.lower() not in seen:
            seen.add(v.lower())
            out.append(v)
    return out[:limit]


class ProfileIn(BaseModel):
    name: str | None = None
    headline: str = ""
    phone: str = ""
    city: str = ""
    school: str = ""
    field: str = ""
    level: str = ""
    bio: str = ""
    skills: list[str] = []
    languages: list[str] = []
    desired_types: list[str] = []
    experience: list[dict] = []
    education: list[dict] = []
    projects: list[dict] = []
    links: dict = {}


@app.get("/api/student/profile")
def get_profile(user: User = Depends(student_only), db: Session = Depends(get_db)):
    return {"user": user.public(), "profile": _profile(user, db).to_dict()}


@app.put("/api/student/profile")
def update_profile(data: ProfileIn, user: User = Depends(student_only), db: Session = Depends(get_db)):
    p = _profile(user, db)
    if data.name and data.name.strip():
        user.name = data.name.strip()[:120]
    for f in ("headline", "phone", "city", "school", "field", "level", "bio"):
        setattr(p, f, getattr(data, f).strip())
    p.skills, p.languages, p.desired_types = _unique(data.skills, 40), _unique(data.languages, 10), _unique(data.desired_types, 6)
    p.experience, p.education, p.projects = data.experience[:15], data.education[:10], data.projects[:15]
    p.links = {k: str(v).strip() for k, v in data.links.items() if k in ("linkedin", "github", "website") and v}
    db.commit()
    return {"user": user.public(), "profile": p.to_dict()}


class UploadIn(BaseModel):
    file_base64: str
    file_name: str = Field(default="CV.pdf", max_length=120)


COMMON_SKILLS = ["Python", "Java", "JavaScript", "TypeScript", "C", "C++", "C#", "PHP", "SQL", "HTML", "CSS", "React", "Angular",
                 "Vue.js", "Node.js", "Django", "Flask", "FastAPI", "Spring Boot", "Laravel", "Git", "Docker", "Kubernetes",
                 "Linux", "AWS", "Azure", "Excel", "Power BI", "Tableau", "Machine Learning", "Deep Learning", "Pandas",
                 "Figma", "Photoshop", "Illustrator", "SAP", "AutoCAD", "Marketing", "SEO", "Communication", "Leadership"]


@app.post("/api/student/cv-upload")
def upload_cv(data: UploadIn, user: User = Depends(student_only), db: Session = Depends(get_db)):
    """Reads a PDF CV and returns profile fields (the student reviews them before saving the profile).
    The PDF itself is kept as the student's saved CV when it is under 2 MB."""
    pdf = _decode_pdf(data.file_base64, 5)
    job_skills = {s for skills in db.scalars(select(Job.skills)) for s in skills or []}
    try:
        fields, source = ai.read_cv_pdf(pdf, sorted(job_skills | set(COMMON_SKILLS), key=len, reverse=True))
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    saved = len(pdf) <= CV_MAX_MB * 1024 * 1024
    if saved:
        _store_cv(user, data.file_name or "CV.pdf", pdf, db)
    return {"fields": fields, "source": source, "cv_saved": saved}


# --------------------------------------------------------- saved CV file (reused for spontaneous applications)
CV_MAX_MB = 2


def _decode_pdf(file_base64: str, max_mb: int) -> bytes:
    try:
        pdf = base64.b64decode(file_base64.split(",")[-1], validate=True)
    except ValueError:
        raise HTTPException(400, "Invalid file.")
    if len(pdf) > max_mb * 1024 * 1024 or not pdf.startswith(b"%PDF"):
        raise HTTPException(400, f"Please upload a PDF file under {max_mb} MB.")
    return pdf


def _pdf_name(name: str) -> str:
    name = re.sub(r"[^\w.\- ]", "", name or "").strip()[:100] or "CV.pdf"
    return name if name.lower().endswith(".pdf") else name + ".pdf"


def _store_cv(user: User, name: str, pdf: bytes, db: Session) -> StudentCV:
    cv = user.cv_file or StudentCV(user_id=user.id)
    cv.file_name, cv.data, cv.uploaded_at = _pdf_name(name), pdf, utcnow()
    user.cv_file = cv
    db.commit()
    return cv


class CvFileIn(BaseModel):
    file_name: str = Field(default="CV.pdf", max_length=120)
    file_base64: str


@app.get("/api/student/cv-file")
def get_cv_file(user: User = Depends(student_only)):
    return user.cv_file.to_dict() if user.cv_file else None


@app.get("/api/student/cv-file/download")
def download_cv_file(user: User = Depends(student_only)):
    if not user.cv_file:
        raise HTTPException(404, "No CV saved yet.")
    return Response(user.cv_file.data, media_type="application/pdf",
                    headers={"Content-Disposition": f'inline; filename="{user.cv_file.file_name}"'})


@app.post("/api/student/cv-file")
def save_cv_file(data: CvFileIn, user: User = Depends(student_only), db: Session = Depends(get_db)):
    return _store_cv(user, data.file_name, _decode_pdf(data.file_base64, CV_MAX_MB), db).to_dict()


@app.delete("/api/student/cv-file")
def delete_cv_file(user: User = Depends(student_only), db: Session = Depends(get_db)):
    if user.cv_file:
        db.delete(user.cv_file)
        db.commit()
    return {"ok": True}


@app.get("/api/student/overview")
def student_overview(user: User = Depends(student_only), db: Session = Depends(get_db)):
    p = _profile(user, db)
    by_status = Counter(a.status for a in user.applications)
    applied = {a.job_id for a in user.applications}
    jobs = db.scalars(_search_jobs(db))
    scored = sorted(((match_job(p, j), j) for j in jobs if j.id not in applied), key=lambda x: -x[0]["score"])
    missing = Counter(s for m, _ in scored[:10] for s in m["missing"])  # skills asked by your best matches
    upcoming = [{"application_id": a.id, "job": a.job.title, "company": a.job.company.name, **a.interview()}
                for a in user.applications if a.interview_at and a.interview_at >= utcnow() - timedelta(hours=2)]
    return {"completion": p.completion(), "applications": len(user.applications),
            "by_status": {s: by_status.get(s, 0) for s in STATUSES}, "saved": len(user.saved),
            "matches": [{**j.to_dict(), "match": m} for m, j in scored[:6]],
            "skill_gaps": [s for s, _ in missing.most_common(6)], "interviews": sorted(upcoming, key=lambda x: x["at"]),
            "has_cv": bool(p.cv_html), "has_portfolio": bool(p.portfolio_html), "email_verified": user.email_verified}


class ApplyIn(BaseModel):
    job_id: int
    cover_letter: str = Field(default="", max_length=6000)


@app.post("/api/student/applications")
def apply(data: ApplyIn, user: User = Depends(student_only), db: Session = Depends(get_db)):
    job = db.get(Job, data.job_id)
    if not job or job.status != "open":
        raise HTTPException(404, "This offer is no longer accepting applications.")
    if db.scalar(select(Application).where(Application.job_id == job.id, Application.student_id == user.id)):
        raise HTTPException(400, "You already applied to this offer.")
    a = Application(job_id=job.id, student_id=user.id, cover_letter=data.cover_letter.strip(),
                    match_score=match_job(_profile(user, db), job)["score"])
    db.add(a)
    if job.company.owner:  # companies from job boards have no account yet: the application waits for them
        notify(db, job.company.owner, "new_application", {"name": user.name, "job": job.title}, "/company.html#applicants")
    db.commit()
    return a.to_dict()


@app.get("/api/student/applications")
def my_applications(user: User = Depends(student_only), db: Session = Depends(get_db)):
    apps = db.scalars(select(Application).where(Application.student_id == user.id)
                      .options(selectinload(Application.job).selectinload(Job.company)).order_by(Application.created_at.desc()))
    reviewed = {r.company_id for r in user.reviews}
    return [{**a.to_dict(), "job": a.job.to_dict(), "messages": len(a.messages),
             "can_review": a.status == "accepted" and a.job.company_id not in reviewed} for a in apps]


@app.delete("/api/student/applications/{app_id}")
def withdraw(app_id: int, user: User = Depends(student_only), db: Session = Depends(get_db)):
    a = db.get(Application, app_id)
    if not a or a.student_id != user.id:
        raise HTTPException(404, "Application not found.")
    if a.status in ("accepted", "rejected"):
        raise HTTPException(400, "This application is already closed.")
    db.delete(a)
    db.commit()
    return {"ok": True}


@app.get("/api/student/saved")
def saved_jobs(user: User = Depends(student_only), db: Session = Depends(get_db)):
    p = _profile(user, db)
    rows = db.scalars(select(SavedJob).where(SavedJob.user_id == user.id).order_by(SavedJob.created_at.desc()))
    return [{**s.job.to_dict(), "match": match_job(p, s.job), "saved": True} for s in rows]


@app.post("/api/student/saved/{job_id}")
def save_job(job_id: int, user: User = Depends(student_only), db: Session = Depends(get_db)):
    if not db.get(Job, job_id):
        raise HTTPException(404, "Offer not found.")
    if not db.scalar(select(SavedJob).where(SavedJob.user_id == user.id, SavedJob.job_id == job_id)):
        db.add(SavedJob(user_id=user.id, job_id=job_id))
        db.commit()
    return {"saved": True}


@app.delete("/api/student/saved/{job_id}")
def unsave_job(job_id: int, user: User = Depends(student_only), db: Session = Depends(get_db)):
    row = db.scalar(select(SavedJob).where(SavedJob.user_id == user.id, SavedJob.job_id == job_id))
    if row:
        db.delete(row)
        db.commit()
    return {"saved": False}


# ---- Job alerts (saved searches)
class SearchIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    filters: dict = {}
    email: bool = True


def _clean_filters(f: dict) -> dict:
    """Keep only the filters the offers page knows, with safe values."""
    as_list = lambda v: [str(x)[:30] for x in (v if isinstance(v, list) else [v]) if x][:6]
    return {"q": str(f.get("q") or "").strip()[:80], "city": str(f.get("city") or "")[:60],
            "type": [t for t in as_list(f.get("type")) if t in JOB_TYPES],
            "mode": [m for m in as_list(f.get("mode")) if m in ("On-site", "Hybrid", "Remote")],
            "level": str(f.get("level") or "")[:20]}


def _own_search(search_id: int, user: User, db: Session) -> SavedSearch:
    s = db.get(SavedSearch, search_id)
    if not s or s.user_id != user.id:
        raise HTTPException(404, "Alert not found.")
    return s


@app.get("/api/student/searches")
def my_searches(user: User = Depends(student_only), db: Session = Depends(get_db)):
    rows = db.scalars(select(SavedSearch).where(SavedSearch.user_id == user.id).order_by(SavedSearch.created_at.desc()))
    return [s.to_dict() for s in rows]


@app.post("/api/student/searches")
def create_search(data: SearchIn, user: User = Depends(student_only), db: Session = Depends(get_db)):
    if db.scalar(select(func.count(SavedSearch.id)).where(SavedSearch.user_id == user.id)) >= 10:
        raise HTTPException(400, "You can have up to 10 alerts. Delete one first.")
    filters = _clean_filters(data.filters)
    if not any(filters.values()):
        raise HTTPException(400, "Choose at least one filter or keyword before creating an alert.")
    s = SavedSearch(user_id=user.id, name=data.name.strip(), filters=filters, email=data.email)
    db.add(s)
    db.commit()
    return s.to_dict()


class SearchUpdate(BaseModel):
    email: bool


@app.put("/api/student/searches/{search_id}")
def update_search(search_id: int, data: SearchUpdate, user: User = Depends(student_only), db: Session = Depends(get_db)):
    s = _own_search(search_id, user, db)
    s.email = data.email
    db.commit()
    return s.to_dict()


@app.delete("/api/student/searches/{search_id}")
def delete_search(search_id: int, user: User = Depends(student_only), db: Session = Depends(get_db)):
    db.delete(_own_search(search_id, user, db))
    db.commit()
    return {"ok": True}


class AIRequest(BaseModel):
    job_id: int | None = None
    language: str = "en"


def _job_or_404(job_id: int | None, db: Session, required: bool = False) -> Job | None:
    if job_id is None:
        if required:
            raise HTTPException(400, "Choose an offer first.")
        return None
    job = db.get(Job, job_id)
    if not job:
        raise HTTPException(404, "Offer not found.")
    return job


def _needs_profile(p: StudentProfile):
    if p.completion() < 30:
        raise HTTPException(400, "Complete at least 30% of your profile first.")


@app.get("/api/student/cv")
def get_cv(user: User = Depends(student_only), db: Session = Depends(get_db)):
    return {"html": _profile(user, db).cv_html}


@app.post("/api/student/cv/generate")
def generate_cv(data: AIRequest, user: User = Depends(student_only), db: Session = Depends(get_db)):
    p = _profile(user, db)
    _needs_profile(p)
    p.cv_html, source = ai.generate_cv(user, p, _job_or_404(data.job_id, db), data.language)
    db.commit()
    return {"html": p.cv_html, "source": source}


@app.get("/api/student/portfolio")
def get_portfolio(user: User = Depends(student_only), db: Session = Depends(get_db)):
    p = _profile(user, db)
    return {"html": p.portfolio_html, "theme": p.portfolio_theme, "public": p.portfolio_public, "url": f"/p/{user.id}"}


@app.post("/api/student/portfolio/generate")
def generate_portfolio(user: User = Depends(student_only), db: Session = Depends(get_db)):
    p = _profile(user, db)
    _needs_profile(p)
    p.portfolio_html, source = ai.generate_portfolio(user, p)
    db.commit()
    return {"html": p.portfolio_html, "source": source}


class PortfolioSettingsIn(BaseModel):
    theme: str = "emerald"
    public: bool = False


@app.put("/api/student/portfolio/settings")
def portfolio_settings(data: PortfolioSettingsIn, user: User = Depends(student_only), db: Session = Depends(get_db)):
    p = _profile(user, db)
    if data.theme not in THEMES:
        raise HTTPException(400, "Unknown theme.")
    p.portfolio_theme, p.portfolio_public = data.theme, data.public and bool(p.portfolio_html)
    db.commit()
    return {"theme": p.portfolio_theme, "public": p.portfolio_public, "url": f"/p/{user.id}"}


@app.post("/api/student/cover-letter")
def cover_letter(data: AIRequest, user: User = Depends(student_only), db: Session = Depends(get_db)):
    text, source = ai.generate_cover_letter(user, _profile(user, db), _job_or_404(data.job_id, db, True), data.language)
    return {"text": text, "source": source}


@app.post("/api/student/interview/questions")
def mock_interview_questions(data: AIRequest, user: User = Depends(student_only), db: Session = Depends(get_db)):
    questions, source = ai.interview_questions(_job_or_404(data.job_id, db, True), user.profile, data.language)
    return {"questions": questions, "source": source}


class InterviewAnswersIn(BaseModel):
    job_id: int
    language: str = "en"
    answers: list[dict] = Field(min_length=1, max_length=8)  # [{question, answer}]


@app.post("/api/student/interview/feedback")
def mock_interview_feedback(data: InterviewAnswersIn, user: User = Depends(student_only), db: Session = Depends(get_db)):
    answers = [{"question": str(a.get("question", ""))[:500], "answer": str(a.get("answer", ""))[:3000]} for a in data.answers]
    feedback, source = ai.interview_feedback(_job_or_404(data.job_id, db, True), answers, data.language)
    return {**feedback, "source": source}


class ReviewIn(BaseModel):
    company_id: int
    rating: int = Field(ge=1, le=5)
    title: str = Field(min_length=3, max_length=200)
    body: str = Field(min_length=20, max_length=3000)
    role: str = ""


@app.post("/api/student/reviews")
def write_review(data: ReviewIn, user: User = Depends(student_only), db: Session = Depends(get_db)):
    interned = db.scalar(select(Application).join(Job).where(Application.student_id == user.id, Application.status == "accepted",
                                                             Job.company_id == data.company_id))
    if not interned:
        raise HTTPException(403, "Only candidates accepted by this company can review it.")
    if db.scalar(select(Review).where(Review.company_id == data.company_id, Review.student_id == user.id)):
        raise HTTPException(400, "You already reviewed this company.")
    review = Review(company_id=data.company_id, student_id=user.id, rating=data.rating, title=data.title.strip(),
                    body=data.body.strip(), role=data.role.strip() or interned.job.title)
    db.add(review)
    db.commit()
    return review.to_dict()


# ============================================================================ 8. COMPANIES
def _company(user: User, db: Session) -> Company:
    if not user.company:
        user.company = Company(name=user.name)
        db.commit()
    return user.company


def _own_job(job_id: int, company: Company, db: Session) -> Job:
    job = db.get(Job, job_id)
    if not job or job.company_id != company.id:
        raise HTTPException(404, "Offer not found.")
    return job


def _own_application(app_id: int, user: User, db: Session) -> Application:
    a = db.get(Application, app_id)
    if not a or a.job.company_id != _company(user, db).id:
        raise HTTPException(404, "Application not found.")
    return a


class CompanyIn(BaseModel):
    name: str = Field(min_length=2, max_length=160)
    sector: str = ""
    city: str = ""
    size: str = ""
    website: str = ""
    description: str = ""
    logo_color: str = "#10b981"


@app.get("/api/company/profile")
def company_profile(user: User = Depends(company_only), db: Session = Depends(get_db)):
    return _company(user, db).to_dict(private=True)


@app.put("/api/company/profile")
def update_company(data: CompanyIn, user: User = Depends(company_only), db: Session = Depends(get_db)):
    c = _company(user, db)
    for field, value in data.model_dump().items():
        setattr(c, field, value.strip())
    db.commit()
    return c.to_dict(private=True)


class VerifyIn(BaseModel):
    ice: str = Field(pattern=r"^\d{15}$")
    rc: str = Field(min_length=1, max_length=30)


class LogoIn(BaseModel):
    image_base64: str


LOGO_TYPES = {b"\x89PNG": "image/png", b"\xff\xd8\xff": "image/jpeg", b"RIFF": "image/webp"}


@app.post("/api/company/logo")
def upload_logo(data: LogoIn, user: User = Depends(company_only), db: Session = Depends(get_db)):
    """Logo saved in the database (works on hosts without a permanent disk). PNG / JPG / WebP, max 300 KB."""
    try:
        image = base64.b64decode(data.image_base64.split(",")[-1], validate=True)
    except ValueError:
        raise HTTPException(400, "Invalid image.")
    kind = next((t for magic, t in LOGO_TYPES.items() if image.startswith(magic)), None)
    if not kind or (kind == "image/webp" and image[8:12] != b"WEBP") or len(image) > 300 * 1024:
        raise HTTPException(400, "Choose a PNG, JPG or WebP image under 300 KB.")
    c = _company(user, db)
    c.logo, c.logo_type, c.logo_version = image, kind, (c.logo_version or 0) + 1
    db.commit()
    return c.to_dict(private=True)


@app.delete("/api/company/logo")
def remove_logo(user: User = Depends(company_only), db: Session = Depends(get_db)):
    c = _company(user, db)
    c.logo, c.logo_type = None, ""
    db.commit()
    return c.to_dict(private=True)


@app.post("/api/company/verify")
def request_verification(data: VerifyIn, user: User = Depends(company_only), db: Session = Depends(get_db)):
    c = _company(user, db)
    if c.verified:
        raise HTTPException(400, "Your company is already verified.")
    c.ice, c.rc, c.verification_status = data.ice, data.rc.strip(), "pending"
    db.commit()
    return c.to_dict(private=True)


@app.get("/api/company/overview")
def company_overview(user: User = Depends(company_only), db: Session = Depends(get_db)):
    c = _company(user, db)
    apps = [a for j in c.jobs for a in j.applications]
    by_status = Counter(a.status for a in apps)
    upcoming = [{"application_id": a.id, "name": a.student.name, "job": a.job.title, **a.interview()}
                for a in apps if a.interview_at and a.interview_at >= utcnow() - timedelta(hours=2)]
    return {"company": c.to_dict(private=True), "open_jobs": sum(1 for j in c.jobs if j.status == "open"),
            "applications": len(apps), "views": sum(j.views for j in c.jobs),
            "avg_match": round(sum(a.match_score for a in apps) / len(apps)) if apps else 0,
            "by_status": {s: by_status.get(s, 0) for s in STATUSES},
            "recent": [{**a.to_dict(), "student": {"name": a.student.name, "avatar_url": a.student.avatar_url}, "job_title": a.job.title}
                       for a in sorted(apps, key=lambda a: a.created_at, reverse=True)[:6]],
            "interviews": sorted(upcoming, key=lambda x: x["at"])[:5]}


class JobIn(BaseModel):
    title: str = Field(min_length=3, max_length=200)
    type: str
    city: str
    work_mode: str = "On-site"
    description: str = Field(min_length=20)
    requirements: str = ""
    skills: list[str] = []
    level: str = ""
    salary_min: int | None = None
    salary_max: int | None = None
    duration: str = ""
    deadline: datetime | None = None
    status: str = "open"

    @field_validator("type")
    @classmethod
    def check_type(cls, v):
        if v not in JOB_TYPES:
            raise ValueError(f"Type must be one of {JOB_TYPES}")
        return v


def _alert_matching_students(job: Job, db: Session):
    """Job alerts for a new offer: first saved searches it matches, then students whose profile fits it well."""
    link, told = f"/job.html?id={job.id}", set()
    for s in db.scalars(select(SavedSearch).options(selectinload(SavedSearch.user))):
        if s.user_id in told or not s.user.is_active or not s.matches(job):
            continue
        told.add(s.user_id)
        # Email at most every 6 hours per alert, so a company posting many offers doesn't flood the inbox
        email = s.email and (not s.last_emailed_at or utcnow() - s.last_emailed_at > timedelta(hours=6))
        if email:
            s.last_emailed_at = utcnow()
        notify(db, s.user, "search_alert", {"search": s.name, "job": job.title, "company": job.company.name, "city": job.city},
               link, email=email)
    for p in db.scalars(select(StudentProfile).options(selectinload(StudentProfile.user))):
        if p.user_id not in told and p.user.is_active and match_job(p, job)["score"] >= 70:
            notify(db, p.user, "new_job_match", {"job": job.title, "company": job.company.name}, link)


@app.get("/api/company/jobs")
def company_jobs(user: User = Depends(company_only), db: Session = Depends(get_db)):
    c = _company(user, db)
    jobs = db.scalars(select(Job).where(Job.company_id == c.id).options(selectinload(Job.applications)).order_by(Job.created_at.desc()))
    return [j.to_dict(with_company=False) for j in jobs]


@app.post("/api/company/jobs")
def create_job(data: JobIn, user: User = Depends(company_only), db: Session = Depends(get_db)):
    c = _company(user, db)
    if c.verification_status == "rejected":
        raise HTTPException(403, "Your company verification was rejected. Contact support to publish offers.")
    job = Job(company_id=c.id, **{**data.model_dump(), "skills": _unique(data.skills, 20)},
              sector=guess_sector(f"{data.title} {c.name} {data.description}"))
    db.add(job)
    db.flush()
    job.company = c
    _alert_matching_students(job, db)
    db.commit()
    return job.to_dict(with_company=False)


@app.put("/api/company/jobs/{job_id}")
def update_job(job_id: int, data: JobIn, user: User = Depends(company_only), db: Session = Depends(get_db)):
    job = _own_job(job_id, _company(user, db), db)
    for field, value in data.model_dump().items():
        setattr(job, field, value)
    job.skills = _unique(data.skills, 20)
    job.sector = guess_sector(f"{data.title} {job.company.name} {data.description}")
    db.commit()
    return job.to_dict(with_company=False)


@app.delete("/api/company/jobs/{job_id}")
def delete_job(job_id: int, user: User = Depends(company_only), db: Session = Depends(get_db)):
    db.delete(_own_job(job_id, _company(user, db), db))
    db.commit()
    return {"ok": True}


@app.get("/api/company/applicants")
def applicants(job_id: int | None = None, user: User = Depends(company_only), db: Session = Depends(get_db)):
    stmt = (select(Application).join(Job).where(Job.company_id == _company(user, db).id)
            .options(selectinload(Application.student).selectinload(User.profile), selectinload(Application.job)))
    if job_id:
        stmt = stmt.where(Application.job_id == job_id)
    out = []
    for a in db.scalars(stmt.order_by(Application.match_score.desc(), Application.created_at.desc())):
        p = a.student.profile
        out.append({**a.to_dict(), "notes": a.company_notes, "messages": len(a.messages),
                    "job": {"id": a.job.id, "title": a.job.title, "type": a.job.type}, "match": match_job(p, a.job),
                    "student": {"id": a.student.id, "name": a.student.name, "email": a.student.email, "avatar_url": a.student.avatar_url,
                                **(p.to_dict() if p else {}), "portfolio_url": f"/p/{a.student.id}" if p and p.portfolio_public else None}})
    return out


@app.get("/api/company/applicants/{app_id}/cv")
def applicant_cv(app_id: int, user: User = Depends(company_only), db: Session = Depends(get_db)):
    a = _own_application(app_id, user, db)
    return {"html": a.student.profile.cv_html if a.student.profile else "", "name": a.student.name}


class ApplicationUpdateIn(BaseModel):
    status: str | None = None
    notes: str | None = None


def _set_status(a: Application, status: str, db: Session):
    if status not in STATUSES:
        raise HTTPException(400, "Invalid status.")
    if status != a.status:
        a.status = status
        notify(db, a.student, "status", {"job": a.job.title, "company": a.job.company.name, "status": status},
               "/dashboard.html#applications", email=True)


@app.put("/api/company/applicants/{app_id}")
def update_application(app_id: int, data: ApplicationUpdateIn, user: User = Depends(company_only), db: Session = Depends(get_db)):
    a = _own_application(app_id, user, db)
    if data.status is not None:
        _set_status(a, data.status, db)
    if data.notes is not None:
        a.company_notes = data.notes[:4000]
    db.commit()
    return {**a.to_dict(), "notes": a.company_notes}


class InterviewIn(BaseModel):
    at: datetime
    mode: str = "Online"
    location: str = Field(default="", max_length=300)
    note: str = Field(default="", max_length=2000)


@app.put("/api/company/applicants/{app_id}/interview")
def schedule_interview(app_id: int, data: InterviewIn, user: User = Depends(company_only), db: Session = Depends(get_db)):
    a = _own_application(app_id, user, db)
    if data.mode not in ("Online", "On-site", "Phone"):
        raise HTTPException(400, "Invalid interview type.")
    a.interview_at, a.interview_mode = data.at.replace(tzinfo=None), data.mode
    a.interview_location, a.interview_note = data.location.strip(), data.note.strip()
    a.status = "interview"
    when = a.interview_at.strftime("%d/%m/%Y %H:%M")
    notify(db, a.student, "interview", {"job": a.job.title, "company": a.job.company.name, "when": when,
                                        "where": data.location or data.mode}, "/dashboard.html#applications", email=True)
    db.commit()
    return a.to_dict()


# ============================================================================ 9. ADMIN
@app.get("/api/admin/stats")
def admin_stats(days: int = 30, _: User = Depends(admin_only), db: Session = Depends(get_db)):
    days = min(max(days, 7), 90)
    now = utcnow()
    start = (now - timedelta(days=days - 1)).replace(hour=0, minute=0, second=0, microsecond=0)
    week = now - timedelta(days=7)
    day_list = [(start + timedelta(days=i)).date() for i in range(days)]

    def per_day(column) -> list[int]:
        counts = Counter(d.date() for d in db.scalars(select(column).where(column >= start)))
        return [counts.get(day, 0) for day in day_list]

    def grouped(column, *where) -> dict:
        return dict(db.execute(select(column, func.count()).where(*where).group_by(column)).all())

    def count(model, *where) -> int:
        return db.scalar(select(func.count(model.id)).where(*where))

    total_apps = count(Application)
    open_job = Job.status == "open"
    return {
        "totals": {"users": count(User), "students": count(User, User.role == "student"),
                   "company_users": count(User, User.role == "company"),
                   "new_users_week": count(User, User.created_at >= week),
                   "companies": count(Company, Company.is_external.is_(False)),
                   "external_companies": count(Company, Company.is_external.is_(True)),
                   "directory": count(DirectoryCompany),
                   "verified_companies": count(Company, Company.verification_status == "verified"),
                   "pending_verifications": count(Company, Company.verification_status == "pending"),
                   "jobs": count(Job), "open_jobs": count(Job, open_job),
                   "site_jobs": count(Job, open_job, Job.source == ""),
                   "external_jobs": count(Job, open_job, Job.source != ""),
                   "applications": total_apps, "new_apps_week": count(Application, Application.created_at >= week),
                   "waiting_apps": db.scalar(select(func.count(Application.id)).join(Job).join(Company)
                                             .where(Company.is_external.is_(True))),
                   "acceptance_rate": round(100 * count(Application, Application.status == "accepted") / max(1, total_apps)),
                   "reviews": count(Review), "new_reviews_week": count(Review, Review.created_at >= week),
                   "spontaneous": count(SpontaneousApplication),
                   "messages": count(Message),
                   "unverified_emails": count(User, User.email_verified.is_(False), User.role != "admin")},
        "timeline": {"labels": [d.isoformat() for d in day_list], "users": per_day(User.created_at),
                     "applications": per_day(Application.created_at)},
        "jobs_by_type": grouped(Job.type, open_job), "jobs_by_city": grouped(Job.city, open_job),
        "jobs_by_sector": grouped(Job.sector, open_job),
        "applications_by_status": grouped(Application.status), "users_by_role": grouped(User.role),
        "recent_users": [u.public() for u in db.scalars(select(User).order_by(User.created_at.desc()).limit(6))],
        "offers_refresh": {"enabled": bool(JOOBLE_API_KEY), "last": (db.get(Setting, "offers_refreshed_at") or Setting(value="")).value},
        "ai_enabled": ai.ai_available(),
    }


@app.post("/api/admin/refresh-offers")
def admin_refresh_offers(_: User = Depends(admin_only), db: Session = Depends(get_db)):
    if not JOOBLE_API_KEY:
        raise HTTPException(400, "Add JOOBLE_API_KEY in the server settings to fetch new offers.")
    return _refresh_and_alert(db)


# Backup: every table as JSON (passwords stay hashed, files as base64). Keep the file somewhere safe.
BACKUP_TABLES = ["users", "student_profiles", "companies", "jobs", "applications", "saved_jobs", "messages", "reviews",
                 "saved_searches", "notifications", "spontaneous_applications", "student_cvs", "company_contacts", "settings"]


@app.get("/api/admin/backup")
def admin_backup(_: User = Depends(admin_only), db: Session = Depends(get_db)):
    def plain(v):
        if isinstance(v, bytes):
            return base64.b64encode(v).decode()
        return v.isoformat() if isinstance(v, datetime) else v

    tables = {name: [{k: plain(v) for k, v in row._mapping.items()} for row in db.execute(Base.metadata.tables[name].select())]
              for name in BACKUP_TABLES if name in Base.metadata.tables}
    body = json.dumps({"created_at": utcnow().isoformat(), "tables": tables}, ensure_ascii=False)
    return Response(body, media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="jobfinder-backup-{utcnow():%Y-%m-%d}.json"'})


@app.get("/api/admin/users")
def admin_users(q: str = "", role: str = "", _: User = Depends(admin_only), db: Session = Depends(get_db)):
    stmt = select(User).order_by(User.created_at.desc())
    if q:
        stmt = stmt.where(or_(User.name.ilike(f"%{q}%"), User.email.ilike(f"%{q}%")))
    if role:
        stmt = stmt.where(User.role == role)
    return [u.public() for u in db.scalars(stmt.limit(300))]


class UserUpdate(BaseModel):
    is_active: bool


def _other_user(user_id: int, admin: User, db: Session) -> User:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(404, "User not found.")
    if user.id == admin.id:
        raise HTTPException(400, "You cannot change your own admin account here.")
    return user


@app.put("/api/admin/users/{user_id}")
def admin_update_user(user_id: int, data: UserUpdate, admin: User = Depends(admin_only), db: Session = Depends(get_db)):
    user = _other_user(user_id, admin, db)
    user.is_active = data.is_active
    db.commit()
    return user.public()


@app.delete("/api/admin/users/{user_id}")
def admin_delete_user(user_id: int, admin: User = Depends(admin_only), db: Session = Depends(get_db)):
    db.delete(_other_user(user_id, admin, db))
    db.commit()
    return {"ok": True}


@app.get("/api/admin/companies")
def admin_companies(status: str = "", _: User = Depends(admin_only), db: Session = Depends(get_db)):
    stmt = select(Company).options(selectinload(Company.jobs), selectinload(Company.owner)).order_by(Company.created_at.desc())
    if status:
        stmt = stmt.where(Company.verification_status == status)
    return [{**c.to_dict(private=True), "owner_email": c.owner.email if c.owner else "", "jobs": len(c.jobs)} for c in db.scalars(stmt)]


class VerifyDecision(BaseModel):
    status: str  # verified | rejected | unverified


@app.put("/api/admin/companies/{company_id}/verify")
def admin_verify_company(company_id: int, data: VerifyDecision, _: User = Depends(admin_only), db: Session = Depends(get_db)):
    company = db.get(Company, company_id)
    if not company or data.status not in ("verified", "rejected", "unverified"):
        raise HTTPException(400, "Invalid request.")
    company.verification_status = data.status
    if data.status == "rejected":
        for job in company.jobs:
            job.status = "closed"
    if data.status in ("verified", "rejected") and company.owner:
        notify(db, company.owner, "verification", {"status": data.status}, "/company.html#profile")
    if data.status == "verified" and company.owner:
        _take_over_external(company, db)
    db.commit()
    return company.to_dict(private=True)


def _take_over_external(company: Company, db: Session) -> None:
    """When a company is verified, it takes over the job-board copy of itself (same name):
    its offers and the applications students sent while it wasn't on JobFinder yet."""
    external = db.scalar(select(Company).where(Company.is_external.is_(True),
                                               func.lower(Company.name) == company.name.strip().lower()))
    if not external:
        return
    apps = [a for job in external.jobs for a in job.applications]
    for job in list(external.jobs):
        job.company = company
    db.delete(external)
    for a in apps:
        notify(db, a.student, "application_forwarded", {"job": a.job.title, "company": company.name}, "/dashboard.html#applications")
    if apps:
        notify(db, company.owner, "applications_waiting", {"n": len(apps)}, "/company.html#applicants", email=True)


@app.get("/api/admin/jobs")
def admin_jobs(q: str = "", _: User = Depends(admin_only), db: Session = Depends(get_db)):
    stmt = select(Job).options(selectinload(Job.company), selectinload(Job.applications)).order_by(Job.created_at.desc())
    if q:
        stmt = stmt.where(Job.title.ilike(f"%{q}%"))
    return [j.to_dict() for j in db.scalars(stmt.limit(300))]


class JobStatus(BaseModel):
    status: str


@app.put("/api/admin/jobs/{job_id}")
def admin_job_status(job_id: int, data: JobStatus, _: User = Depends(admin_only), db: Session = Depends(get_db)):
    job = db.get(Job, job_id)
    if not job or data.status not in ("open", "closed"):
        raise HTTPException(400, "Invalid request.")
    job.status = data.status
    db.commit()
    return job.to_dict()


@app.delete("/api/admin/jobs/{job_id}")
def admin_delete_job(job_id: int, _: User = Depends(admin_only), db: Session = Depends(get_db)):
    job = db.get(Job, job_id)
    if not job:
        raise HTTPException(404, "Offer not found.")
    db.delete(job)
    db.commit()
    return {"ok": True}


@app.get("/api/admin/reviews")
def admin_reviews(_: User = Depends(admin_only), db: Session = Depends(get_db)):
    rows = db.scalars(select(Review).options(selectinload(Review.company), selectinload(Review.student)).order_by(Review.created_at.desc()))
    return [{**r.to_dict(), "company": r.company.name, "student_email": r.student.email} for r in rows]


@app.delete("/api/admin/reviews/{review_id}")
def admin_delete_review(review_id: int, _: User = Depends(admin_only), db: Session = Depends(get_db)):
    review = db.get(Review, review_id)
    if not review:
        raise HTTPException(404, "Review not found.")
    db.delete(review)
    db.commit()
    return {"ok": True}


# Website files (HTML, CSS, JS) — must stay last so it doesn't hide the API routes above
# ============================================================================ SEARCH ENGINES (Google for Jobs)
# The offer page is sent with its title, description and a JobPosting block (schema.org) already inside,
# so Google can show the offer in its job search. The sitemap lists every open offer.
EMPLOYMENT_TYPES = {"CDI": "FULL_TIME", "CDD": "TEMPORARY", "Stage": "INTERN", "PFE": "INTERN", "Alternance": "INTERN",
                    "Freelance": "CONTRACTOR"}


def job_posting(job: Job) -> dict:
    """schema.org JobPosting for one offer: https://developers.google.com/search/docs/appearance/structured-data/job-posting"""
    c = job.company
    data = {
        "@context": "https://schema.org/", "@type": "JobPosting",
        "title": job.title,
        "description": escape(job.description or job.title).replace("\n", "<br>"),
        "datePosted": job.created_at.date().isoformat(),
        "validThrough": (job.deadline or job.created_at + timedelta(days=OFFER_MAX_DAYS)).isoformat(),
        "employmentType": EMPLOYMENT_TYPES.get(job.type, "OTHER"),
        "hiringOrganization": {"@type": "Organization", "name": c.name, **({"sameAs": c.website} if c.website else {}),
                               **({"logo": f"{SITE_URL}/api/companies/{c.id}/logo"} if c.logo else {})},
        "jobLocation": {"@type": "Place", "address": {"@type": "PostalAddress", "addressLocality": job.city, "addressCountry": "MA"}},
        "directApply": True,  # students apply on JobFinder.ma
        "identifier": {"@type": "PropertyValue", "name": "JobFinder.ma", "value": str(job.id)},
        "url": f"{SITE_URL}/job.html?id={job.id}",
    }
    if job.work_mode == "Remote":
        data["jobLocationType"] = "TELECOMMUTE"
        data["applicantLocationRequirements"] = {"@type": "Country", "name": "Morocco"}
    if job.salary_min or job.salary_max:
        data["baseSalary"] = {"@type": "MonetaryAmount", "currency": "MAD", "value": {
            "@type": "QuantitativeValue", "minValue": job.salary_min or job.salary_max, "maxValue": job.salary_max or job.salary_min,
            "unitText": "MONTH"}}
    return data


@app.get("/job.html", include_in_schema=False)
def job_page(id: int = 0, db: Session = Depends(get_db)):
    page = (FRONTEND_DIR / "job.html").read_text(encoding="utf-8")
    job = db.get(Job, id) if id else None
    if job and job.status == "open":
        about = (job.description or "")[:155]
        ld = json.dumps(job_posting(job), ensure_ascii=False).replace("</", "<\\/")
        head = (f"<title>{escape(job.title)} — {escape(job.company.name)} | JobFinder.ma</title>\n"
                f'  <meta name="description" content="{escape(about)}">\n'
                f'  <link rel="canonical" href="{SITE_URL}/job.html?id={job.id}">\n'
                f'  <script type="application/ld+json">{ld}</script>')
        page = page.replace("<title>Offer — JobFinder.ma</title>", head, 1)
    return HTMLResponse(page, headers={"Cache-Control": "no-cache"})


@app.get("/sitemap.xml", include_in_schema=False)
def sitemap(db: Session = Depends(get_db)):
    pages = [f"{SITE_URL}/", f"{SITE_URL}/jobs.html", f"{SITE_URL}/companies.html", f"{SITE_URL}/privacy.html", f"{SITE_URL}/terms.html"]
    rows = [f"<url><loc>{escape(u)}</loc></url>" for u in pages]
    for job_id, created in db.execute(select(Job.id, Job.created_at).where(Job.status == "open").order_by(Job.created_at.desc())):
        rows.append(f"<url><loc>{SITE_URL}/job.html?id={job_id}</loc><lastmod>{created.date().isoformat()}</lastmod></url>")
    xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + "".join(rows) + "</urlset>"
    return Response(xml, media_type="application/xml")


@app.get("/robots.txt", include_in_schema=False)
def robots():
    return Response(f"User-agent: *\nDisallow: /api/\nDisallow: /dashboard.html\nDisallow: /company.html\nDisallow: /admin.html\n"
                    f"Sitemap: {SITE_URL}/sitemap.xml\n", media_type="text/plain")


app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
