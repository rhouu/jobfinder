"""
HELPERS — small tools used by the routes in app.py.

  1. Passwords & tokens   hash_password, verify_password, make_token, read_token
  2. Who is calling?      current_user, optional_user, require_role   (FastAPI dependencies)
  3. Job matching         match_job(profile, job) -> score 0-100
  4. HTML cleaning        clean_html(text) — removes scripts / dangerous links from generated HTML
  5. Emails               send_email(user, kind, data) — SMTP, or printed in the console in development
  6. Notifications        notify(db, user, kind, data, link, email=False)
  7. Sectors              guess_sector(text), directory_sector(category, specialty) — pick the card thumbnail
"""
import base64
import hashlib
import hmac
import logging
import os
import re
import smtplib
import threading
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from html import escape
from html.parser import HTMLParser

import jwt
import requests
from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from .database import BREVO_API_KEY, SECRET_KEY, SITE_URL, SMTP, Job, Notification, StudentProfile, User, get_db

log = logging.getLogger("jobfinder")


# =========================================================== 1. Passwords & tokens
def hash_password(password: str) -> str:
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 260_000)
    return f"pbkdf2$260000${base64.b64encode(salt).decode()}${base64.b64encode(digest).decode()}"


def verify_password(password: str, stored: str | None) -> bool:
    try:
        _, rounds, salt, digest = (stored or "").split("$")
        check = hashlib.pbkdf2_hmac("sha256", password.encode(), base64.b64decode(salt), int(rounds))
        return hmac.compare_digest(check, base64.b64decode(digest))
    except ValueError:
        return False


def _password_fingerprint(user: User) -> str:
    # Changes when the password changes, so a reset link only works once
    return hashlib.sha256((user.password_hash or "none").encode()).hexdigest()[:16]


def make_token(user: User, purpose: str = "login", hours: int = 72) -> str:
    """Signed token. purpose = login | verify | reset."""
    payload = {"sub": str(user.id), "p": purpose, "exp": datetime.now(timezone.utc) + timedelta(hours=hours)}
    if purpose == "reset":
        payload["fp"] = _password_fingerprint(user)
    return jwt.encode(payload, SECRET_KEY, algorithm="HS256")


def sign(value: str) -> str:
    """Short signature for links that need no login (e.g. a company's "stop receiving applications" link)."""
    return hmac.new(SECRET_KEY.encode(), value.encode(), hashlib.sha256).hexdigest()[:32]


def check_signature(value: str, signature: str) -> bool:
    return hmac.compare_digest(sign(value), signature or "")


def read_token(token: str, purpose: str, db: Session) -> User | None:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None
    if payload.get("p") != purpose:
        return None
    user = db.get(User, int(payload["sub"]))
    if not user or (purpose == "reset" and payload.get("fp") != _password_fingerprint(user)):
        return None
    return user


def login_response(user: User) -> dict:
    return {"token": make_token(user), "user": user.public()}


# =========================================================== 2. Who is calling?
def optional_user(request: Request, db: Session = Depends(get_db)) -> User | None:
    header = request.headers.get("Authorization", "")
    user = read_token(header[7:], "login", db) if header.startswith("Bearer ") else None
    return user if user and user.is_active else None


def current_user(user: User | None = Depends(optional_user)) -> User:
    if not user:
        raise HTTPException(401, "Please sign in to continue.")
    return user


def require_role(*roles: str):
    def check(user: User = Depends(current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(403, "You don't have access to this area.")
        return user
    return check


# =========================================================== 3. Job matching
def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip().lower())


def match_job(profile: StudentProfile | None, job: Job) -> dict:
    """Score = 60% skills + 15% location + 15% contract type + 10% field of study."""
    if profile is None:
        return {"score": 0, "matched": [], "missing": job.skills or []}
    mine = {_norm(s) for s in profile.skills or [] if s}
    text = _norm(f"{job.title} {job.description} {job.requirements}")
    wanted = job.skills or []
    matched = [s for s in wanted if _norm(s) in mine]
    missing = [s for s in wanted if _norm(s) not in mine]
    bonus = [s for s in mine if len(s) > 2 and s in text and s not in {_norm(m) for m in matched}]

    skills = min(1.0, (len(matched) + 0.5 * len(bonus)) / len(wanted)) if wanted else min(1.0, 0.4 + 0.15 * len(bonus))
    if job.work_mode == "Remote" or (profile.city and _norm(profile.city) == _norm(job.city)):
        place = 1.0
    else:
        place = 0.5 if job.work_mode == "Hybrid" else 0.25
    kind = 1.0 if not profile.desired_types or job.type in profile.desired_types else 0.2
    words = [w for w in re.split(r"[\s,/&-]+", _norm(profile.field)) if len(w) > 3]
    field = 1.0 if words and any(w in text for w in words) else 0.4

    score = round(100 * (0.6 * skills + 0.15 * place + 0.15 * kind + 0.10 * field))
    return {"score": max(0, min(100, score)), "matched": matched, "missing": missing}


# =========================================================== 4. HTML cleaning
class _Cleaner(HTMLParser):
    ALLOWED = {"h1", "h2", "h3", "h4", "p", "ul", "ol", "li", "strong", "em", "b", "i", "br", "hr", "span",
               "div", "section", "header", "article", "a", "small", "blockquote"}
    DROP = {"script", "style", "iframe", "object", "embed", "head", "title", "svg", "math", "template"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out, self.skip = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in self.DROP:
            self.skip += 1
        elif not self.skip and tag in self.ALLOWED:
            extra = ""
            for key, value in attrs:
                if key == "class" and value:
                    extra += f' class="{escape(value)}"'
                elif tag == "a" and key == "href" and value and value.strip().lower().startswith(("http://", "https://", "mailto:")):
                    extra += f' href="{escape(value)}" target="_blank" rel="noopener noreferrer"'
            self.out.append(f"<{tag}{extra}>")

    def handle_endtag(self, tag):
        if tag in self.DROP:
            self.skip = max(0, self.skip - 1)
        elif not self.skip and tag in self.ALLOWED and tag not in ("br", "hr"):
            self.out.append(f"</{tag}>")

    def handle_data(self, data):
        if not self.skip:
            self.out.append(escape(data, quote=False))


def clean_html(raw: str) -> str:
    cleaner = _Cleaner()
    cleaner.feed(raw or "")
    cleaner.close()
    return "".join(cleaner.out)


# =========================================================== 5. Emails
STATUS_NAMES = {
    "en": {"submitted": "Submitted", "reviewing": "Under review", "interview": "Interview", "accepted": "Accepted", "rejected": "Not selected"},
    "fr": {"submitted": "Envoyée", "reviewing": "En cours d'examen", "interview": "Entretien", "accepted": "Acceptée", "rejected": "Non retenue"},
    "ar": {"submitted": "مُرسَل", "reviewing": "قيد المراجعة", "interview": "مقابلة", "accepted": "مقبول", "rejected": "غير مقبول"},
}

EMAILS = {  # kind -> language -> (subject, body). {placeholders} come from `data`.
    "verify": {
        "en": ("Confirm your email", "Hello {name},\n\nWelcome to JobFinder.ma! Confirm your email address:\n{link}\n\nThis link expires in 48 hours."),
        "fr": ("Confirmez votre e-mail", "Bonjour {name},\n\nBienvenue sur JobFinder.ma ! Confirmez votre adresse e-mail :\n{link}\n\nCe lien expire dans 48 heures."),
        "ar": ("أكّد بريدك الإلكتروني", "مرحبًا {name}،\n\nمرحبًا بك في JobFinder.ma! أكّد بريدك الإلكتروني:\n{link}\n\nتنتهي صلاحية هذا الرابط خلال 48 ساعة."),
    },
    "applications_waiting": {
        "en": ("Candidates are waiting for you", "Hello {name},\n\nYour company is verified. {n} students applied to your offers before you joined JobFinder.ma.\n\nSee them here: {link}"),
        "fr": ("Des candidats vous attendent", "Bonjour {name},\n\nVotre entreprise est vérifiée. {n} étudiants ont postulé à vos offres avant votre arrivée sur JobFinder.ma.\n\nVoyez-les ici : {link}"),
        "ar": ("مرشحون بانتظارك", "مرحبًا {name}،\n\nتم توثيق شركتك. تقدّم {n} طالب لعروضك قبل انضمامك إلى JobFinder.ma.\n\nشاهدهم هنا: {link}"),
    },
    "spontaneous_sent": {
        "en": ("Your application was sent to {company}", "Hello {name},\n\nYour application and CV were emailed to {company}. If they answer, the reply will arrive in this mailbox.\n\nYour message:\n{message}\n\nAll your applications: {link}"),
        "fr": ("Votre candidature a été envoyée à {company}", "Bonjour {name},\n\nVotre candidature et votre CV ont été envoyés par e-mail à {company}. S'ils répondent, la réponse arrivera dans cette boîte mail.\n\nVotre message :\n{message}\n\nToutes vos candidatures : {link}"),
        "ar": ("تم إرسال طلبك إلى {company}", "مرحبًا {name}،\n\nتم إرسال طلبك وسيرتك الذاتية بالبريد إلى {company}. إذا ردّوا، سيصل الرد إلى هذا البريد.\n\nرسالتك:\n{message}\n\nكل طلباتك: {link}"),
    },
    "code": {
        "en": ("Your JobFinder code: {code}", "Hello {name},\n\nYour confirmation code is:\n\n    {code}\n\nEnter it on JobFinder.ma to confirm your email address. It expires in {minutes} minutes.\nIf you didn't create an account, ignore this email."),
        "fr": ("Votre code JobFinder : {code}", "Bonjour {name},\n\nVotre code de confirmation est :\n\n    {code}\n\nSaisissez-le sur JobFinder.ma pour confirmer votre adresse e-mail. Il expire dans {minutes} minutes.\nSi vous n'avez pas créé de compte, ignorez cet e-mail."),
        "ar": ("رمز JobFinder الخاص بك: {code}", "مرحبًا {name}،\n\nرمز التأكيد الخاص بك هو:\n\n    {code}\n\nأدخله في JobFinder.ma لتأكيد بريدك الإلكتروني. تنتهي صلاحيته خلال {minutes} دقيقة.\nإذا لم تنشئ حسابًا، تجاهل هذه الرسالة."),
    },
    "reset": {
        "en": ("Reset your password", "Hello {name},\n\nChoose a new password here:\n{link}\n\nThis link expires in 1 hour. If you didn't ask for it, ignore this email."),
        "fr": ("Réinitialisez votre mot de passe", "Bonjour {name},\n\nChoisissez un nouveau mot de passe ici :\n{link}\n\nCe lien expire dans 1 heure. Si vous n'avez rien demandé, ignorez cet e-mail."),
        "ar": ("إعادة تعيين كلمة المرور", "مرحبًا {name}،\n\nاختر كلمة مرور جديدة من هنا:\n{link}\n\nتنتهي صلاحية الرابط خلال ساعة. إذا لم تطلب ذلك فتجاهل هذه الرسالة."),
    },
    "status": {
        "en": ("Update on your application", "Hello {name},\n\nYour application for \"{job}\" at {company} is now: {status}.\n\nFollow it here: {link}"),
        "fr": ("Mise à jour de votre candidature", "Bonjour {name},\n\nVotre candidature pour « {job} » chez {company} est maintenant : {status}.\n\nSuivez-la ici : {link}"),
        "ar": ("تحديث بخصوص طلبك", "مرحبًا {name}،\n\nحالة طلبك لوظيفة \"{job}\" لدى {company} أصبحت: {status}.\n\nتابعه من هنا: {link}"),
    },
    "interview": {
        "en": ("Interview invitation", "Hello {name},\n\n{company} invites you to an interview for \"{job}\".\nWhen: {when}\nWhere: {where}\n\nDetails: {link}"),
        "fr": ("Invitation à un entretien", "Bonjour {name},\n\n{company} vous invite à un entretien pour « {job} ».\nQuand : {when}\nOù : {where}\n\nDétails : {link}"),
        "ar": ("دعوة لمقابلة", "مرحبًا {name}،\n\nتدعوك {company} لمقابلة لوظيفة \"{job}\".\nالموعد: {when}\nالمكان: {where}\n\nالتفاصيل: {link}"),
    },
    "message": {
        "en": ("New message from {sender}", "Hello {name},\n\nYou have a new message from {sender} about \"{job}\".\n\nRead it here: {link}"),
        "fr": ("Nouveau message de {sender}", "Bonjour {name},\n\nVous avez un nouveau message de {sender} concernant « {job} ».\n\nLisez-le ici : {link}"),
        "ar": ("رسالة جديدة من {sender}", "مرحبًا {name}،\n\nلديك رسالة جديدة من {sender} بخصوص \"{job}\".\n\nاقرأها من هنا: {link}"),
    },
    "search_alert": {
        "en": ("New offer for your alert \"{search}\"", "Hello {name},\n\nA new offer matches your alert \"{search}\":\n{job} at {company} ({city})\n\nSee it here: {link}\n\nYou can turn off these emails in your dashboard."),
        "fr": ("Nouvelle offre pour votre alerte « {search} »", "Bonjour {name},\n\nUne nouvelle offre correspond à votre alerte « {search} » :\n{job} chez {company} ({city})\n\nVoir l'offre : {link}\n\nVous pouvez désactiver ces e-mails depuis votre tableau de bord."),
        "ar": ("عرض جديد لتنبيهك \"{search}\"", "مرحبًا {name}،\n\nعرض جديد يطابق تنبيهك \"{search}\":\n{job} لدى {company} ({city})\n\nشاهده من هنا: {link}\n\nيمكنك إيقاف هذه الرسائل من لوحة التحكم."),
    },
}


CODE_HTML_TEXT = {  # The designed version of the "code" email. Tables and inline styles: email apps ignore most CSS.
    "en": {"dir": "ltr", "title": "Confirm your email", "hello": "Hello {name},",
           "lead": "Enter this code on JobFinder.ma to confirm your email address.", "expires": "Expires in {minutes} minutes",
           "safe": "Never share this code with anyone. JobFinder.ma will never ask you for it.",
           "ignore": "If you didn't create an account, you can ignore this email.", "tagline": "Jobs and internships in Morocco"},
    "fr": {"dir": "ltr", "title": "Confirmez votre e-mail", "hello": "Bonjour {name},",
           "lead": "Saisissez ce code sur JobFinder.ma pour confirmer votre adresse e-mail.", "expires": "Expire dans {minutes} minutes",
           "safe": "Ne partagez jamais ce code. JobFinder.ma ne vous le demandera jamais.",
           "ignore": "Si vous n'avez pas créé de compte, ignorez cet e-mail.", "tagline": "Emplois et stages au Maroc"},
    "ar": {"dir": "rtl", "title": "أكّد بريدك الإلكتروني", "hello": "مرحبًا {name}،",
           "lead": "أدخل هذا الرمز في JobFinder.ma لتأكيد بريدك الإلكتروني.", "expires": "تنتهي صلاحيته خلال {minutes} دقيقة",
           "safe": "لا تشارك هذا الرمز مع أي شخص. لن يطلبه منك JobFinder.ma أبدًا.",
           "ignore": "إذا لم تنشئ حسابًا، تجاهل هذه الرسالة.", "tagline": "وظائف وتداريب في المغرب"},
}


def code_email_html(lang: str, name: str, code: str, minutes: int) -> str:
    text = CODE_HTML_TEXT[lang]
    align = "right" if text["dir"] == "rtl" else "left"
    font = "font-family:Arial,Helvetica,sans-serif;"
    return f"""<!doctype html>
<html lang="{lang}" dir="{text['dir']}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f6f1e9;">
<div style="display:none;max-height:0;overflow:hidden;">{code} - {escape(text['title'])}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f1e9;"><tr><td align="center" style="padding:32px 16px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #ebe3d6;">
    <tr><td style="background:#23805d;padding:24px 32px;{font}font-size:21px;font-weight:bold;color:#ffffff;text-align:{align};" dir="ltr">JobFinder<span style="color:#f6c06f;">.ma</span></td></tr>
    <tr><td dir="{text['dir']}" style="padding:32px 32px 8px;{font}text-align:{align};">
      <h1 style="margin:0 0 16px;font-size:24px;line-height:1.3;color:#2c2a33;">{escape(text['title'])}</h1>
      <p style="margin:0 0 6px;font-size:16px;line-height:1.5;color:#2c2a33;">{escape(text['hello'].format(name=name))}</p>
      <p style="margin:0;font-size:16px;line-height:1.5;color:#6c6877;">{escape(text['lead'])}</p>
    </td></tr>
    <tr><td style="padding:20px 32px 8px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" dir="ltr" style="background:#e8f5ee;border:1px solid #bfe3d2;border-radius:12px;padding:20px 8px;{font}font-size:36px;font-weight:bold;letter-spacing:8px;color:#23805d;">{code}</td></tr></table>
    </td></tr>
    <tr><td align="center" dir="{text['dir']}" style="padding:4px 32px 24px;{font}font-size:14px;font-weight:bold;color:#6c6877;">{escape(text['expires'].format(minutes=minutes))}</td></tr>
    <tr><td style="padding:0 32px;"><div style="border-top:1px solid #ebe3d6;font-size:0;line-height:0;">&nbsp;</div></td></tr>
    <tr><td dir="{text['dir']}" style="padding:20px 32px 28px;{font}font-size:13px;line-height:1.6;color:#6c6877;text-align:{align};">{escape(text['safe'])}<br>{escape(text['ignore'])}</td></tr>
  </table>
  <p dir="{text['dir']}" style="margin:16px 0 0;{font}font-size:12px;color:#6c6877;text-align:center;">JobFinder.ma · {escape(text['tagline'])}</p>
</td></tr></table>
</body></html>"""


def send_email(user: User, kind: str, data: dict, wait: bool = False) -> bool:
    """Sends in a background thread (wait=True: now, and returns whether it worked).
    Without email settings the email is printed in the server console."""
    lang = user.language if user.language in ("en", "fr", "ar") else "en"
    values = {"name": user.name.split()[0], **data}
    if "status" in values:
        values["status"] = STATUS_NAMES[lang].get(values["status"], values["status"])
    if values.get("link", "").startswith("/"):
        values["link"] = SITE_URL + values["link"]
    subject, body = (part.format(**values) for part in EMAILS[kind][lang])
    html = code_email_html(lang, values["name"], values["code"], values["minutes"]) if kind == "code" else ""

    if not mail_enabled():
        log.info("EMAIL (no email settings) to %s\nSubject: %s\n%s", user.email, subject, body)
        return False
    if wait:
        return send_mail(user.email, subject, body, html=html)
    threading.Thread(target=send_mail, args=(user.email, subject, body), kwargs={"html": html}, daemon=True).start()
    return True


def mail_enabled() -> bool:
    return bool(BREVO_API_KEY or SMTP["host"])


def _send_brevo(to: str, subject: str, body: str, reply_to: str, attachment: tuple[str, bytes] | None, html: str = "") -> bool:
    """Brevo's transactional email API: https://developers.brevo.com/reference/sendtransacemail"""
    payload = {"sender": {"name": "JobFinder.ma", "email": SMTP["sender"] or SMTP["user"]}, "to": [{"email": to}],
               "subject": subject, "textContent": body}
    if html:
        payload["htmlContent"] = html
    if reply_to:
        payload["replyTo"] = {"email": reply_to}
    if attachment:
        payload["attachment"] = [{"name": attachment[0], "content": base64.b64encode(attachment[1]).decode()}]
    try:
        r = requests.post("https://api.brevo.com/v3/smtp/email", json=payload, timeout=20,
                          headers={"api-key": BREVO_API_KEY, "accept": "application/json"})
        if r.status_code < 300:
            return True
        log.warning("Brevo refused the email to %s: %s %s", to, r.status_code, r.text[:300])
    except requests.RequestException as exc:
        log.warning("Could not reach Brevo for %s: %s", to, exc)
    return False


def send_mail(to: str, subject: str, body: str, reply_to: str = "", attachment: tuple[str, bytes] | None = None, html: str = "") -> bool:
    """Sends one email now. reply_to: where answers go. attachment: (file name, PDF bytes). html: designed version of body.
    Returns False on failure. Uses Brevo's API when BREVO_API_KEY is set, otherwise SMTP."""
    if BREVO_API_KEY:
        return _send_brevo(to, subject, body, reply_to, attachment, html)
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"] = SMTP["sender"] or SMTP["user"], to, subject
    if reply_to:
        msg["Reply-To"] = reply_to
    msg.set_content(body)
    if html:
        msg.add_alternative(html, subtype="html")
    if attachment:
        msg.add_attachment(attachment[1], maintype="application", subtype="pdf", filename=attachment[0])
    try:
        with smtplib.SMTP(SMTP["host"], int(SMTP["port"] or 587), timeout=20) as server:
            server.starttls()
            if SMTP["user"]:
                server.login(SMTP["user"], SMTP["password"])
            server.send_message(msg)
        return True
    except (OSError, smtplib.SMTPException) as exc:
        log.warning("Could not send email to %s: %s", to, exc)
        return False


# =========================================================== 6. Notifications
def notify(db: Session, user: User, kind: str, data: dict, link: str = "", email: bool = False) -> None:
    """Adds a bell notification (saved with the caller's commit) and optionally emails the user."""
    db.add(Notification(user_id=user.id, kind=kind, data=data, link=link))
    if email:
        send_email(user, kind, {**data, "link": link})


# =========================================================== 7. Sectors
# The frontend shows one photo per sector (SECTOR_PHOTOS in app.js). Checked in this order; first match wins.
SECTOR_WORDS = [
    ("ai", ["intelligence artificielle", "machine learning", "deep learning", "data scien", "nlp", " ia ", " ai "]),
    ("tourism", ["hôtel", "hotel", "sofitel", "fairmont", "riad", "touris", "travel", "voyage", "restaurant"]),
    ("callcenter", ["télévente", "televente", "téléconseill", "teleconseill", "teleservice", "bpo", "call cent",
                    "centre d'appel", "prise de rdv", "service client", "customer service", "conseiller"]),
    ("it", ["developer", "développeur", "developpeur", "devops", "cloud", "architect", "dba", "qa tester", "php", "java",
            ".net", "node", "ios", "laravel", "software", "logiciel", "informatique", "network", "réseau", "sysadmin",
            "system administrator", "datastage", "swift", "web", "data"]),
    ("finance", ["financ", "comptab", "contrôleur de gestion", "controleur de gestion", "banque", "bank", "assurance",
                 "insurance", "audit", "business analyst", "société générale"]),
    ("hr", [" rh", "ressources humaines", "recrut", "people & culture", "talent", "formation"]),
    ("health", ["pharmac", "médical", "medical", "santé", "clinique", "esthétique"]),
    ("education", ["école", "school", "universit", "enseignement", "formateur", "teacher"]),
    ("industry", ["industri", "usine", "faisceaux", "mécanique", "production", "manufactur", "biw"]),
    ("sales", ["commercial", "vente", "business development", "développement d'affaires", "sales", "partenariat"]),
    ("consulting", ["conseil", "consult", "cabinet"]),
]


def guess_sector(text: str) -> str:
    text = f" {(text or '').lower()} "
    return next((sector for sector, words in SECTOR_WORDS if any(w in text for w in words)), "services")


DIRECTORY_CATEGORIES = [  # Google Maps category words -> sector
    ("education", ["educational", "école", "ecole", "universit", "enseignement", "school", "académique", "academique"]),
    ("retail", ["magasin", "store", "électronique", "electronics", "shop"]),
    ("tourism", ["hôtel", "hotel", "travel", "tour agency", "agence de voyage", "riad", "restaurant", "lodging", "café",
                 "coffee", "resort", " spa "]),
    ("finance", ["banque", "bank", "finance", "accounting", "comptab", "insurance", "assurance"]),
    ("realestate", ["immobili", "real estate"]),
    ("coworking", ["coworking"]),
    ("industry", ["manufacturer", "fabricant", "contractor", "electrician", "électricien", "entrepreneur", "plombier"]),
    ("health", ["pharmac", "clinic", "clinique", "médecin", "doctor", "hospital", "dentist"]),
    ("consulting", ["consultant", "conseil", "avocat", "lawyer"]),
]
AI_SPECIALTIES = {"ai", "machine learning", "generative ai", "nlp", "data science", "ai automation", "data analytics",
                  "business intelligence", "computer vision"}


def directory_sector(category: str, specialty: str, name: str = "") -> str:
    """A clear business category (or a telling name, like "... Hotel") wins; otherwise use the tech specialty."""
    cat = f" {category or ''} {name or ''} ".lower()
    for sector, words in DIRECTORY_CATEGORIES:
        if any(w in cat for w in words):
            return sector
    spec = (specialty or "").lower()
    if spec in AI_SPECIALTIES:
        return "ai"
    if spec in ("software/it", "digital transformation"):
        return "it"
    return "services"
