"""
DATABASE — settings, connection and every table of the platform.

Tables
  users            accounts (student | company | admin)
  student_profiles CV data of a student
  companies        company profile + verification
  jobs             offers (CDI, Stage, PFE, ...)
  applications     a student applying to a job (+ interview details)
  saved_jobs       bookmarks
  notifications    in-app alerts (bell icon)
  messages         chat between a company and a candidate, per application
  reviews          internship reviews written by former interns
  saved_searches   a student's saved search: new matching offers trigger an alert
  directory        public company directory (Marrakech businesses, loaded from data/companies.csv)
  company_contacts private email of a directory company (never sent to the browser)
  spontaneous_applications  a student's CV emailed to a directory company
"""
import os
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy import (JSON, Boolean, DateTime, Float, ForeignKey, Integer, LargeBinary, String, Text, UniqueConstraint,
                        create_engine)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship, sessionmaker

# --------------------------------------------------------------------------- settings
BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"
load_dotenv(BASE_DIR / ".env")

DATABASE_URL = os.getenv("DATABASE_URL") or f"sqlite:///{BASE_DIR / 'jobfinder.db'}"  # SQLite if no PostgreSQL
for prefix in ("postgres://", "postgresql://"):  # always use the psycopg 3 driver
    if DATABASE_URL.startswith(prefix):
        DATABASE_URL = "postgresql+psycopg://" + DATABASE_URL[len(prefix):]
SECRET_KEY = os.getenv("SECRET_KEY", "dev-secret-change-me-in-production")
SITE_URL = os.getenv("SITE_URL", "http://localhost:8000")
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.8-flash")
SMTP = {k: os.getenv(f"SMTP_{k.upper()}", "") for k in ("host", "port", "user", "password", "sender")}
ADMIN_EMAIL = os.getenv("ADMIN_EMAIL", "admin@jobfinder.ma")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "Admin@123")

# On a real server (Render sets RENDER=true) refuse to start with the default secrets
if os.getenv("RENDER") or os.getenv("PRODUCTION"):
    if SECRET_KEY.startswith("dev-secret") or ADMIN_PASSWORD == "Admin@123" or len(ADMIN_PASSWORD) < 10:
        raise RuntimeError("Set SECRET_KEY and a strong ADMIN_PASSWORD (10+ characters) before starting in production.")

# --------------------------------------------------------------------------- connection
engine = create_engine(DATABASE_URL, pool_pre_ping=True,
                       connect_args={"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {})
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def get_db():
    """FastAPI dependency: one database session per request."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def iso(dt: datetime | None) -> str | None:
    return dt.isoformat() + "Z" if dt else None


# --------------------------------------------------------------------------- tables
class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120))
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    google_id: Mapped[str | None] = mapped_column(String(64), unique=True, nullable=True)
    avatar_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    role: Mapped[str] = mapped_column(String(20), default="student", index=True)  # student | company | admin
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    email_verified: Mapped[bool] = mapped_column(Boolean, default=False)
    language: Mapped[str] = mapped_column(String(5), default="en")  # en | fr | ar (used for emails)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_login: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    profile: Mapped["StudentProfile | None"] = relationship(back_populates="user", uselist=False, cascade="all, delete-orphan")
    company: Mapped["Company | None"] = relationship(back_populates="owner", uselist=False, cascade="all, delete-orphan")
    applications: Mapped[list["Application"]] = relationship(back_populates="student", cascade="all, delete-orphan")
    saved: Mapped[list["SavedJob"]] = relationship(cascade="all, delete-orphan")
    notifications: Mapped[list["Notification"]] = relationship(cascade="all, delete-orphan")
    reviews: Mapped[list["Review"]] = relationship(back_populates="student", cascade="all, delete-orphan")
    searches: Mapped[list["SavedSearch"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    spontaneous: Mapped[list["SpontaneousApplication"]] = relationship(back_populates="student", cascade="all, delete-orphan")

    def public(self) -> dict:
        return {"id": self.id, "email": self.email, "name": self.name, "role": self.role,
                "avatar_url": self.avatar_url, "is_active": self.is_active, "email_verified": self.email_verified,
                "language": self.language, "google": bool(self.google_id),
                "created_at": iso(self.created_at), "last_login": iso(self.last_login)}


class StudentProfile(Base):
    __tablename__ = "student_profiles"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), unique=True)
    headline: Mapped[str] = mapped_column(String(200), default="")
    phone: Mapped[str] = mapped_column(String(40), default="")
    city: Mapped[str] = mapped_column(String(80), default="")
    school: Mapped[str] = mapped_column(String(200), default="")
    field: Mapped[str] = mapped_column(String(120), default="")
    level: Mapped[str] = mapped_column(String(40), default="")
    bio: Mapped[str] = mapped_column(Text, default="")
    skills: Mapped[list] = mapped_column(JSON, default=list)
    languages: Mapped[list] = mapped_column(JSON, default=list)
    desired_types: Mapped[list] = mapped_column(JSON, default=list)
    experience: Mapped[list] = mapped_column(JSON, default=list)  # [{title, org, start, end, description}]
    education: Mapped[list] = mapped_column(JSON, default=list)   # [{degree, school, start, end}]
    projects: Mapped[list] = mapped_column(JSON, default=list)    # [{name, description, tech, link}]
    links: Mapped[dict] = mapped_column(JSON, default=dict)       # {linkedin, github, website}
    cv_html: Mapped[str] = mapped_column(Text, default="")
    portfolio_html: Mapped[str] = mapped_column(Text, default="")
    portfolio_theme: Mapped[str] = mapped_column(String(20), default="emerald")
    portfolio_public: Mapped[bool] = mapped_column(Boolean, default=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)

    user: Mapped[User] = relationship(back_populates="profile")

    def completion(self) -> int:
        links = self.links or {}
        checks = [self.headline, self.city, self.school, self.field, self.level, self.bio, len(self.skills or []) >= 3,
                  self.languages, self.experience or self.projects, self.education, links.get("linkedin") or links.get("github")]
        return round(100 * sum(1 for c in checks if c) / len(checks))

    def to_dict(self) -> dict:
        return {"headline": self.headline, "phone": self.phone, "city": self.city, "school": self.school,
                "field": self.field, "level": self.level, "bio": self.bio, "skills": self.skills or [],
                "languages": self.languages or [], "desired_types": self.desired_types or [],
                "experience": self.experience or [], "education": self.education or [], "projects": self.projects or [],
                "links": self.links or {}, "has_cv": bool(self.cv_html), "has_portfolio": bool(self.portfolio_html),
                "portfolio_theme": self.portfolio_theme, "portfolio_public": self.portfolio_public,
                "completion": self.completion()}


class Company(Base):
    __tablename__ = "companies"
    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), unique=True, nullable=True)
    is_external: Mapped[bool] = mapped_column(Boolean, default=False)  # listed from another job board, no account here
    name: Mapped[str] = mapped_column(String(160))
    sector: Mapped[str] = mapped_column(String(100), default="")
    city: Mapped[str] = mapped_column(String(80), default="")
    size: Mapped[str] = mapped_column(String(40), default="")
    website: Mapped[str] = mapped_column(String(255), default="")
    description: Mapped[str] = mapped_column(Text, default="")
    logo_color: Mapped[str] = mapped_column(String(20), default="#10b981")
    ice: Mapped[str] = mapped_column(String(30), default="")  # Identifiant Commun de l'Entreprise
    rc: Mapped[str] = mapped_column(String(30), default="")   # Registre de Commerce
    verification_status: Mapped[str] = mapped_column(String(20), default="unverified")  # unverified|pending|verified|rejected
    logo: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)  # uploaded logo image (max 300 KB)
    logo_type: Mapped[str] = mapped_column(String(30), default="")
    logo_version: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    owner: Mapped[User | None] = relationship(back_populates="company")
    jobs: Mapped[list["Job"]] = relationship(back_populates="company", cascade="all, delete-orphan")
    reviews: Mapped[list["Review"]] = relationship(back_populates="company", cascade="all, delete-orphan")

    @property
    def verified(self) -> bool:
        return self.verification_status == "verified"

    def rating(self) -> dict:
        n = len(self.reviews)
        return {"avg": round(sum(r.rating for r in self.reviews) / n, 1) if n else None, "count": n}

    def to_dict(self, private: bool = False) -> dict:
        d = {"id": self.id, "name": self.name, "sector": self.sector, "city": self.city, "size": self.size,
             "website": self.website, "description": self.description, "logo_color": self.logo_color,
             "verified": self.verified, "external": self.is_external, "rating": self.rating(),
             "logo_url": f"/api/companies/{self.id}/logo?v={self.logo_version}" if self.logo else None,
             "created_at": iso(self.created_at)}
        if private:
            d.update(ice=self.ice, rc=self.rc, verification_status=self.verification_status)
        return d


class Job(Base):
    __tablename__ = "jobs"
    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(200))
    type: Mapped[str] = mapped_column(String(30), index=True)    # CDI CDD Stage PFE Alternance Freelance
    city: Mapped[str] = mapped_column(String(80), index=True)
    work_mode: Mapped[str] = mapped_column(String(20), default="On-site")  # On-site | Hybrid | Remote
    description: Mapped[str] = mapped_column(Text, default="")
    requirements: Mapped[str] = mapped_column(Text, default="")
    skills: Mapped[list] = mapped_column(JSON, default=list)
    level: Mapped[str] = mapped_column(String(40), default="")
    salary_min: Mapped[int | None] = mapped_column(Integer, nullable=True)  # MAD / month
    salary_max: Mapped[int | None] = mapped_column(Integer, nullable=True)
    duration: Mapped[str] = mapped_column(String(60), default="")
    deadline: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="open", index=True)  # open | closed
    views: Mapped[int] = mapped_column(Integer, default=0)
    sector: Mapped[str] = mapped_column(String(30), default="")         # it, finance, tourism ... (chooses the thumbnail)
    source: Mapped[str] = mapped_column(String(40), default="")         # "" = posted here, otherwise e.g. "Jooble"
    external_url: Mapped[str] = mapped_column(String(500), default="")  # where to apply for an external offer
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)

    company: Mapped[Company] = relationship(back_populates="jobs")
    applications: Mapped[list["Application"]] = relationship(back_populates="job", cascade="all, delete-orphan")

    def to_dict(self, with_company: bool = True) -> dict:
        d = {"id": self.id, "title": self.title, "type": self.type, "city": self.city, "work_mode": self.work_mode,
             "description": self.description, "requirements": self.requirements, "skills": self.skills or [],
             "level": self.level, "salary_min": self.salary_min, "salary_max": self.salary_max,
             "duration": self.duration, "deadline": iso(self.deadline), "status": self.status, "views": self.views,
             "created_at": iso(self.created_at), "applicants": len(self.applications), "sector": self.sector,
             "source": self.source, "external_url": self.external_url}
        if with_company:
            d["company"] = self.company.to_dict()
        return d


class Application(Base):
    __tablename__ = "applications"
    __table_args__ = (UniqueConstraint("job_id", "student_id", name="uq_application"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    job_id: Mapped[int] = mapped_column(ForeignKey("jobs.id", ondelete="CASCADE"), index=True)
    student_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    status: Mapped[str] = mapped_column(String(20), default="submitted")  # submitted|reviewing|interview|accepted|rejected
    cover_letter: Mapped[str] = mapped_column(Text, default="")
    match_score: Mapped[float] = mapped_column(Float, default=0)
    company_notes: Mapped[str] = mapped_column(Text, default="")
    interview_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    interview_mode: Mapped[str] = mapped_column(String(20), default="")      # Online | On-site | Phone
    interview_location: Mapped[str] = mapped_column(String(300), default="")  # meeting link or address
    interview_note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)

    job: Mapped[Job] = relationship(back_populates="applications")
    student: Mapped[User] = relationship(back_populates="applications")
    messages: Mapped[list["Message"]] = relationship(back_populates="application", cascade="all, delete-orphan",
                                                     order_by="Message.created_at")

    def interview(self) -> dict | None:
        if not self.interview_at:
            return None
        return {"at": iso(self.interview_at), "mode": self.interview_mode,
                "location": self.interview_location, "note": self.interview_note}

    def to_dict(self) -> dict:
        return {"id": self.id, "job_id": self.job_id, "student_id": self.student_id, "status": self.status,
                "cover_letter": self.cover_letter, "match_score": self.match_score, "interview": self.interview(),
                "created_at": iso(self.created_at), "updated_at": iso(self.updated_at)}


class SavedJob(Base):
    __tablename__ = "saved_jobs"
    __table_args__ = (UniqueConstraint("user_id", "job_id", name="uq_saved"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    job_id: Mapped[int] = mapped_column(ForeignKey("jobs.id", ondelete="CASCADE"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    job: Mapped[Job] = relationship()


class Notification(Base):
    """In-app alert. `kind` + `data` are turned into text by the frontend (so it is translated)."""
    __tablename__ = "notifications"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(40))  # status | new_application | new_job_match | message | interview | verified
    data: Mapped[dict] = mapped_column(JSON, default=dict)
    link: Mapped[str] = mapped_column(String(300), default="")
    is_read: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)

    def to_dict(self) -> dict:
        return {"id": self.id, "kind": self.kind, "data": self.data or {}, "link": self.link,
                "is_read": self.is_read, "created_at": iso(self.created_at)}


class Message(Base):
    __tablename__ = "messages"
    id: Mapped[int] = mapped_column(primary_key=True)
    application_id: Mapped[int] = mapped_column(ForeignKey("applications.id", ondelete="CASCADE"), index=True)
    sender_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    body: Mapped[str] = mapped_column(Text)
    is_read: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    application: Mapped[Application] = relationship(back_populates="messages")

    def to_dict(self) -> dict:
        return {"id": self.id, "sender_id": self.sender_id, "body": self.body, "is_read": self.is_read,
                "created_at": iso(self.created_at)}


class Review(Base):
    __tablename__ = "reviews"
    __table_args__ = (UniqueConstraint("company_id", "student_id", name="uq_review"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), index=True)
    student_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    rating: Mapped[int] = mapped_column(Integer)  # 1..5
    role: Mapped[str] = mapped_column(String(200), default="")
    title: Mapped[str] = mapped_column(String(200), default="")
    body: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    company: Mapped[Company] = relationship(back_populates="reviews")
    student: Mapped[User] = relationship(back_populates="reviews")

    def to_dict(self) -> dict:
        parts = self.student.name.split()  # show "Salma B." to protect privacy
        author = parts[0] + (f" {parts[-1][0]}." if len(parts) > 1 else "")
        return {"id": self.id, "company_id": self.company_id, "rating": self.rating, "role": self.role,
                "title": self.title, "body": self.body, "author": author, "created_at": iso(self.created_at)}


class SavedSearch(Base):
    """A saved search (job alert). filters = {q, city, type: [...], mode: [...], level} — same as the offers page."""
    __tablename__ = "saved_searches"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    filters: Mapped[dict] = mapped_column(JSON, default=dict)
    email: Mapped[bool] = mapped_column(Boolean, default=True)  # also send an email, not only the bell notification
    last_emailed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    user: Mapped[User] = relationship(back_populates="searches")

    def matches(self, job: Job) -> bool:
        """True when the offer passes every filter of this search."""
        f = self.filters or {}
        if f.get("city") and job.city != f["city"]:
            return False
        if f.get("type") and job.type not in f["type"]:
            return False
        if f.get("mode") and job.work_mode not in f["mode"]:
            return False
        if f.get("level") and job.level != f["level"]:
            return False
        q = (f.get("q") or "").strip().lower()
        text = f"{job.title} {job.description} {job.company.name} {' '.join(job.skills or [])}".lower()
        return not q or q in text

    def to_dict(self) -> dict:
        return {"id": self.id, "name": self.name, "filters": self.filters or {}, "email": self.email,
                "created_at": iso(self.created_at)}


class DirectoryCompany(Base):
    """A company in the public directory (public business information only, no contact details)."""
    __tablename__ = "directory"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), index=True)
    sector: Mapped[str] = mapped_column(String(30), default="services", index=True)
    category: Mapped[str] = mapped_column(String(120), default="")
    city: Mapped[str] = mapped_column(String(80), default="")
    area: Mapped[str] = mapped_column(String(300), default="")
    website: Mapped[str] = mapped_column(String(300), default="")
    maps_url: Mapped[str] = mapped_column(String(300), default="")
    rating: Mapped[float | None] = mapped_column(Float, nullable=True)
    reviews: Mapped[int] = mapped_column(Integer, default=0)
    latitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    longitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    contact: Mapped["CompanyContact | None"] = relationship(back_populates="company", lazy="selectin", cascade="all, delete-orphan")

    @property
    def can_apply(self) -> bool:
        return bool(self.contact and not self.contact.opted_out)

    def to_dict(self) -> dict:  # the email itself is never included
        return {"id": self.id, "name": self.name, "sector": self.sector, "category": self.category, "city": self.city,
                "area": self.area, "website": self.website, "maps_url": self.maps_url, "rating": self.rating,
                "reviews": self.reviews, "latitude": self.latitude, "longitude": self.longitude, "can_apply": self.can_apply}


class CompanyContact(Base):
    """Email of a directory company, used only to send it spontaneous applications. Loaded from data/company_emails.csv."""
    __tablename__ = "company_contacts"
    id: Mapped[int] = mapped_column(primary_key=True)
    directory_id: Mapped[int] = mapped_column(ForeignKey("directory.id", ondelete="CASCADE"), unique=True)
    email: Mapped[str] = mapped_column(String(255))
    opted_out: Mapped[bool] = mapped_column(Boolean, default=False)  # the company asked not to receive applications
    company: Mapped[DirectoryCompany] = relationship(back_populates="contact")


class SpontaneousApplication(Base):
    """A student's application (message + CV) emailed to a directory company."""
    __tablename__ = "spontaneous_applications"
    __table_args__ = (UniqueConstraint("student_id", "directory_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    student_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    directory_id: Mapped[int] = mapped_column(ForeignKey("directory.id", ondelete="CASCADE"))
    message: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    student: Mapped[User] = relationship(back_populates="spontaneous")
    company: Mapped[DirectoryCompany] = relationship()

    def to_dict(self) -> dict:
        return {"id": self.id, "directory_id": self.directory_id, "company": self.company.name, "sector": self.company.sector,
                "city": self.company.city, "message": self.message, "created_at": iso(self.created_at)}
