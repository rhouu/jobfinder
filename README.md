# JobFinder.ma — Job & Internship Finder

A Moroccan career platform where students, trainees and young graduates find **jobs, internships and PFE**.
Companies publish offers and manage candidates; administrators moderate everything.

- **Backend:** Python + FastAPI, PostgreSQL (SQLite works with no setup)
- **Frontend:** plain HTML, CSS and JavaScript — no framework, no build step
- **AI:** Google Gemini (optional — every AI feature has a built-in fallback)
- **Languages:** English, French, Arabic (Arabic pages are right-to-left)

## Run it

```bash
pip install -r requirements.txt
python -m uvicorn backend.app:app --reload --port 8000
```

Or double-click `run.bat`. Open **http://localhost:8000**. API documentation: **http://localhost:8000/docs**.

The first start creates the database, the admin account (`ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env`) and imports the real data:

| File | What it becomes |
|---|---|
| `data/offers.csv` | job offers collected from Jooble. They show "via Jooble" and an "Apply on Jooble" button that opens the original offer |
| `data/companies.csv` | the company directory on the **Companies** page (name, activity, area, website, map link, Google rating; no phone numbers or emails) |

There are no demo accounts: students and companies sign up themselves. To import new files, replace them
(same columns), delete `jobfinder.db` (or empty the tables in PostgreSQL) and restart.

## Turn on the extras (`.env`)

Copy `.env.example` to `.env`, then:

| What | Variable |
|---|---|
| AI (chatbot, CV, portfolio, cover letter, CV upload, mock interview) | `GEMINI_API_KEY` — get one at https://aistudio.google.com/apikey |
| Google sign-in | `GOOGLE_CLIENT_ID` (OAuth Web client, origin `http://localhost:8000`) |
| Real emails | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SENDER` |
| PostgreSQL | `DATABASE_URL=postgresql://user:password@localhost:5432/jobfinder` |
| Production | `SECRET_KEY`, `ADMIN_PASSWORD`, `SITE_URL` |

Without SMTP, emails (verification and reset links included) are printed in the server console, so you can click the link from there.
**On Render's free plan, SMTP is blocked** (ports 25/465/587): set `BREVO_API_KEY` (free Brevo account, 300 emails/day) and `SMTP_SENDER` to an address verified in Brevo; emails then go through Brevo's HTTPS API. If a confirmation code can't be sent, the person is signed in without it instead of being stuck.

Spontaneous applications are the exception: they need real SMTP. With Gmail: turn on 2-step verification, create an
**app password** (Google account > Security > App passwords), then set `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`,
`SMTP_USER` / `SMTP_SENDER` = the Gmail address, `SMTP_PASSWORD` = the app password. Gmail sends up to ~500 emails a day.

## Put it online (Render)

1. Push this folder to a GitHub repository.
2. On [render.com](https://render.com): **New > Blueprint**, pick the repository. `render.yaml` creates the website and a PostgreSQL database.
3. Fill in the values Render asks for: `ADMIN_EMAIL`, `ADMIN_PASSWORD` (10+ characters), `SITE_URL` (your `https://….onrender.com` address).
   The AI, Google sign-in and email keys are optional and can be added later in the service's **Environment** tab.
4. The first start creates the tables, the admin account and imports the offers and the company directory.

In production (`RENDER` or `PRODUCTION` set) the site refuses to start with the default `SECRET_KEY` or admin password.
Free Render services sleep after 15 minutes without visitors (the first visit then takes ~1 minute), and the free database expires after 30 days.

## Fresh offers, Google and backups

- **New offers every day.** With `JOOBLE_API_KEY` set (free key from Jooble's API page), the site asks Jooble once a day for
  new offers in Morocco (search words in `JOOBLE_KEYWORDS`), adds the ones it doesn't have, sends job alerts for them, and
  closes job-board offers older than `OFFER_MAX_DAYS`. Admins can also click **Refresh offers**. On a free Render service
  that sleeps, the daily refresh runs the next time the site wakes up.
- **Google for Jobs.** Each offer page is sent with a schema.org `JobPosting` block, so Google can show it in its job
  search. `/sitemap.xml` lists every open offer and `/robots.txt` points to it. After going live, add the sitemap in
  Google Search Console.
- **Backups.** Admin dashboard > **Download backup** saves every table as one JSON file (passwords stay hashed).
  Download one regularly and keep it somewhere safe.
- **Privacy and terms.** `/privacy.html` and `/terms.html` (texts in `js/i18n.js`, contact email from `CONTACT_EMAIL`).

### Moving the database to Neon (free, doesn't expire)

Render's free PostgreSQL is deleted 30 days after creation. To move to Neon:
1. Create a free project on neon.tech and copy its connection string.
2. In Neon, use **Import data** with your Render database's *External Database URL* (Render > jobfinder-db > Connect).
3. In Render > jobfinder > Environment, set `DATABASE_URL` to the Neon connection string and redeploy.
4. Check the site, then delete `jobfinder-db` in Render.

## Features

**Offers page:** list or **map view** (Leaflet + OpenStreetMap: one marker per city with the number of matching offers),
and **job alerts**: a student saves the current filters, and every new matching offer sends a notification
(plus an email, at most every 6 hours per alert). Alerts are managed in the dashboard's "Saved offers" tab.

**Companies page:** search the Marrakech directory by name, activity or area, filter by sector, and see the companies
hiring right now. A company that finds itself there can click "This is my company" to create its account.

**Spontaneous applications:** 228 directory companies have a known email (kept private in `data/company_emails.csv`,
never sent to the browser). Their card shows **Send my application**: the student writes a message, attaches a PDF CV,
and the site emails it to the company with **Reply-To = the student's email**, so the answer lands in the student's own
mailbox. Students can save their CV once in their profile and reuse it. Limits: confirmed email required, one application per company, 5 per day. Every email has a link the company
can click to stop receiving applications. Needs the `SMTP_…` settings (see below).

**Students:** profile (or upload a PDF CV to fill it), offers ranked by match score, saved offers, application board,
messages with companies, interview invitations, AI CV / cover letter / portfolio, mock interviews with feedback,
free courses for missing skills, internship reviews, notifications.

**Companies:** verified profile (ICE + RC), logo upload (PNG/JPG/WebP, max 300 KB), publish offers, applicants ranked by match, drag-and-drop pipeline,
messages, interview scheduling (the candidate gets a notification and an email), reviews from former interns.

**Admins:** statistics, user moderation, company verification, offer and review moderation.

**Everyone:** chatbot assistant, EN/FR/AR, light/dark mode, password reset, Google sign-in.

**Sign-in:** "Continue with Google" appears on the login page once `GOOGLE_CLIENT_ID` is set (Google accounts are
already verified). Accounts created with an email and password must type the **6-digit code** emailed to them before
they can sign in (valid 15 minutes, 5 tries, one new code per minute). This only applies when SMTP is configured;
without it, accounts are signed in right away as before.

## How the code is organised

```
backend/                 5 Python files
  app.py        every API route, grouped in numbered sections (accounts, jobs, chat, messages, students, companies, admin)
  database.py   settings from .env + all database tables
  helpers.py    passwords & login tokens, job matching, HTML cleaning, emails, notifications
  ai.py         everything that talks to Gemini (+ the fallback when there is no key)
  seed.py       admin account + imports data/offers.csv and data/companies.csv

frontend/
  index.html jobs.html job.html               public pages      → js/public.js
  companies.html auth.html
  dashboard.html                               student area      → js/student.js
  company.html                                 company area      → js/company.js
  admin.html                                   admin area        → js/admin.js
  js/app.js       shared code: API calls, navbar, notifications, chatbot, messages, small UI helpers
  js/i18n.js      all texts in English, French and Arabic (one line per text)
  css/style.css   the whole design; change --primary at the top to change the main colour
```

## Animations

[GSAP](https://gsap.com) 3.13 (with ScrollTrigger and SplitText, all free) and [Lenis](https://lenis.darkroom.engineering)
smooth scrolling are loaded from a CDN. The code is in `js/app.js`, section 7 ("Animations"):

- smooth scrolling (paused while a dialog is open)
- page titles appear word by word; section titles do the same when they scroll into view
- elements with class `reveal` glide in as you scroll; statistics count up
- the home photo moves slightly slower than the page (parallax)
- cards tilt a little towards the mouse, big buttons lean towards it (mouse only)

If the libraries can't load, or the visitor turned on "reduce motion" in their system settings, the site falls
back to simple CSS fades.

## Photos

The photos come from [Unsplash](https://unsplash.com/license) (free to use, including commercially) and load from Unsplash's image server.

Only two photos are used: the home page's search area (Brooke Cagle) and the sign-in page (Vitaly Gariev).
To replace one, change its `--photo:url(...)` address in `index.html` or `auth.html`.

Offer and company cards get a small photo for their sector (IT, tourism, finance…). Those are listed in
`SECTOR_PHOTOS` at the top of `js/app.js`. A company that uploads its logo shows the logo instead of its initials.

**Add a translation:** add a line `"my.key": ["English", "Français", "العربية"]` in `js/i18n.js`,
then use `data-i18n="my.key"` in HTML or `t("my.key")` in JavaScript.
