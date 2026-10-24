/* ==========================================================================
   APP.JS — shared by every page
     1. API client & login session
     2. Small helpers (formatting, escaping)
     3. Icons
     4. UI components (job card, toast, modal, charts, tag input)
     5. Page layout (navbar, notifications bell, language switch, footer)
     6. Chatbot widget (Gemini)
     7. Animations
   Translations live in i18n.js and are used here through t("key").
   ========================================================================== */

// ============================================================ 1. API & session
const API = {
  async request(method, url, body) {
    const headers = { "Content-Type": "application/json" };
    if (Auth.token()) headers.Authorization = `Bearer ${Auth.token()}`;
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null;
    try { data = await res.json(); } catch (_) { /* empty answer */ }
    if (!res.ok) {
      if (res.status === 401 && Auth.token()) Auth.clear();
      let msg = data && data.detail;
      if (Array.isArray(msg)) msg = msg.map((d) => d.msg).join(" · ");
      throw new Error(msg || t("common.error"));
    }
    return data;
  },
  get: (url) => API.request("GET", url),
  post: (url, body = {}) => API.request("POST", url, body),
  put: (url, body = {}) => API.request("PUT", url, body),
  del: (url) => API.request("DELETE", url),
};

const store = { // localStorage can be blocked (private mode): never let it crash the page
  get(key) { try { return localStorage.getItem(key); } catch (_) { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch (_) {} },
  remove(key) { try { localStorage.removeItem(key); } catch (_) {} },
};

const Auth = {
  token: () => store.get("jf_token"),
  user() { try { return JSON.parse(store.get("jf_user") || "null"); } catch (_) { return null; } },
  save(data) { store.set("jf_token", data.token); Auth.setUser(data.user); },
  setUser(user) { store.set("jf_user", JSON.stringify(user)); },
  clear() { store.remove("jf_token"); store.remove("jf_user"); },
  home: (role) => ({ student: "/dashboard.html", company: "/company.html", admin: "/admin.html" }[role] || "/"),
  logout() { Auth.clear(); location.href = "/"; },
  /** Sends visitors to the login page unless they have one of these roles. */
  require(...roles) {
    const u = Auth.user();
    if (!u || !Auth.token()) { location.href = `/auth.html?next=${encodeURIComponent(location.pathname + location.hash)}`; return null; }
    if (roles.length && !roles.includes(u.role)) { location.href = Auth.home(u.role); return null; }
    return u;
  },
};

// ============================================================ 2. Helpers
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const initials = (name) => (name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
const params = () => Object.fromEntries(new URLSearchParams(location.search));
const debounce = (fn, ms = 300) => { let id; return (...a) => { clearTimeout(id); id = setTimeout(() => fn(...a), ms); }; };
const fmt = new Intl.NumberFormat(LOCALE);
const money = (min, max) => (!min && !max) ? t("common.salaryNA")
  : `${min && max ? `${fmt.format(min)} – ${fmt.format(max)}` : fmt.format(min || max)} ${t("common.mad")}`;
const dateStr = (iso) => iso ? new Date(iso).toLocaleDateString(LOCALE, { day: "numeric", month: "short", year: "numeric" }) : "—";
const dateTimeStr = (iso) => iso ? new Date(iso).toLocaleString(LOCALE, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
function timeAgo(iso) {
  if (!iso) return "";
  const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto" });
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  for (const [unit, size] of [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]]) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return rtf.format(0, "minute");
}
const CITIES = ["Casablanca", "Rabat", "Marrakech", "Tanger", "Fès", "Agadir", "Meknès", "Oujda", "Kénitra", "Tétouan", "Ouarzazate", "El Jadida", "Berrechid"];
const JOB_TYPES = ["Stage", "PFE", "CDI", "CDD", "Alternance", "Freelance"];
const STATUS_COLORS = { submitted: "#5b8def", reviewing: "#f2a33a", interview: "#9b7ede", accepted: "#2e9e74", rejected: "#e8836b" };
const STATUS_BADGE = { submitted: "badge-blue", reviewing: "badge-gold", interview: "badge-violet", accepted: "badge-green", rejected: "badge-red" };
const TYPE_BADGE = { CDI: "badge-green", CDD: "badge-blue", Stage: "badge-gold", PFE: "badge-violet", Alternance: "badge-cyan", Freelance: "badge-red" };
const typeBadge = (type) => `<span class="badge ${TYPE_BADGE[type] || ""}">${esc(type)}</span>`;
const statusBadge = (s) => `<span class="badge ${STATUS_BADGE[s] || ""}">${t("status." + s)}</span>`;
const modeLabel = (m) => t("mode." + m);
/** Readable summary of saved-search filters, e.g. "Python · PFE · Rabat". */
const describeFilters = (f) => [f.q, ...(f.type || []), ...(f.mode || []).map(modeLabel), f.city, f.level].filter(Boolean).join(" · ") || t("alerts.all");
/** Offers-page address for saved-search filters. */
const filtersUrl = (f) => {
  const qs = new URLSearchParams();
  ["q", "city", "level"].forEach((k) => f[k] && qs.set(k, f[k]));
  if (f.type?.length) qs.set("type", f.type.join(","));
  if (f.mode?.length) qs.set("mode", f.mode.join(","));
  return `/jobs.html?${qs}`;
};

// ============================================================ 3. Icons (simple line icons)
const ICON_PATHS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  pin: '<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  bookmark: '<path d="M6 3h12v18l-6-4-6 4z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6C3.9 8.3 2 12 2 12s3.6 7 10 7a9.8 9.8 0 0 0 5.4-1.6"/>',
  users: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0M16 4a4 4 0 0 1 0 8M22 21a7 7 0 0 0-4-6.3"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  building: '<rect x="4" y="3" width="16" height="18" rx="1.5"/><path d="M9 7h1M14 7h1M9 11h1M14 11h1M9 15h1M14 15h1M10 21v-3h4v3"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  book: '<path d="M4 19V5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 19a2 2 0 0 0 2 2h13"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  award: '<circle cx="12" cy="9" r="6"/><path d="m8.5 14-1.5 7 5-3 5 3-1.5-7"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5zM3 13l9 5 9-5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  verified: '<path d="M12 2l2.4 2.1 3.2-.3.9 3.1 2.8 1.6-1 3 1 3-2.8 1.6-.9 3.1-3.2-.3L12 22l-2.4-2.1-3.2.3-.9-3.1L2.7 15.5l1-3-1-3 2.8-1.6.9-3.1 3.2.3z" fill="currentColor" stroke="none"/><path d="m8.5 12 2.3 2.3 4.7-4.6" stroke="#fff"/>',
};
const icon = (name, size = 18) => `<svg class="icon${name === "arrow" || name === "send" ? " flip" : ""}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ""}</svg>`;
const verifiedMark = () => `<span class="verified" title="${esc(t("common.verified"))}">${icon("verified", 16)}</span>`;
/** Replaces <i data-icon="name"></i> placeholders written in the HTML files. */
function hydrateIcons(root = document) {
  $$("i[data-icon]", root).forEach((el) => { el.outerHTML = icon(el.dataset.icon, +el.dataset.size || 18); });
}

// ============================================================ 4. UI components
/* One free Unsplash photo per sector, used as the thumbnail of offers and companies (sector comes from the server). */
const SECTOR_PHOTOS = {
  it: "photo-1515879218367-8466d910aaa4", ai: "photo-1677442135703-1787eea5ce01", finance: "photo-1707157284454-553ef0a4ed0d",
  sales: "photo-1758520144427-ddb02ac74e9d", callcenter: "photo-1766066014237-00645c74e9c6", hr: "photo-1758520144437-f068ecaf0d83",
  tourism: "photo-1570133435807-5feefeb2d196", health: "photo-1631549916768-4119b2e5f926", education: "photo-1509062522246-3755977927d7",
  retail: "photo-1777073233428-ff338440ccad", industry: "photo-1581091226825-a6a2a5aee158", consulting: "photo-1573164574511-73c773193279",
  coworking: "photo-1527192491265-7e15c55b1ed2", realestate: "photo-1621831337128-35676ca30868", services: "photo-1758270705290-62b6294dd044",
};
const sectorPhoto = (sector, w = 640) => `https://images.unsplash.com/${SECTOR_PHOTOS[sector] || SECTOR_PHOTOS.services}?auto=format&fit=crop&w=${w}&h=${Math.round(w * 0.5)}&q=60`;
const sectorLabel = (sector) => t("sector." + (SECTOR_PHOTOS[sector] ? sector : "services"));
const thumb = (sector, extra = "") => `<div class="thumb" style="background-image:url('${sectorPhoto(sector)}')">${extra}</div>`;
const companyLogo = (c, cls = "") => c.logo_url
  ? `<img class="company-logo ${cls}" src="${esc(c.logo_url)}" alt="${esc(c.name)}" loading="lazy">`
  : `<div class="company-logo ${cls}" style="background:${esc(c.logo_color)}">${esc(initials(c.name))}</div>`;
const avatar = (u, cls = "") => u.avatar_url
  ? `<img class="avatar ${cls}" src="${esc(u.avatar_url)}" alt="" referrerpolicy="no-referrer">`
  : `<div class="avatar ${cls}">${esc(initials(u.name))}</div>`;
const matchColor = (s) => (s >= 75 ? "#2e9e74" : s >= 50 ? "#f2a33a" : "#e8836b");
const ring = (score, cls = "") => `<div class="ring ${cls}" data-score="${score}" style="--c:${matchColor(score)}"><span>${score}%</span></div>`;
const stars = (rating) => `<span class="stars" aria-label="${rating}/5">${[1, 2, 3, 4, 5].map((i) => `<span class="${i <= Math.round(rating) ? "on" : ""}">★</span>`).join("")}</span>`;

function jobCard(job, i = 0) {
  const u = Auth.user();
  const save = u && u.role === "student"
    ? `<button class="save-btn ${job.saved ? "saved" : ""}" data-save="${job.id}" aria-label="${esc(t("common.save"))}">${icon("bookmark", 17)}</button>` : "";
  const rating = job.company.rating && job.company.rating.count ? `<span class="muted small">${stars(job.company.rating.avg)} ${job.company.rating.avg}</span>` : "";
  return `
  <article class="card card-hover job-card fade-up" style="--d:${Math.min(i, 10) * 0.05}s" data-href="/job.html?id=${job.id}" tabindex="0">
    ${thumb(job.sector, `<span class="thumb-tag">${esc(sectorLabel(job.sector))}</span>${job.source ? `<span class="thumb-tag source">${t("job.via", { source: job.source })}</span>` : ""}`)}
    <div class="top">
      ${companyLogo(job.company)}
      <div class="grow">
        <h3>${esc(job.title)}</h3>
        <div class="company">${esc(job.company.name)} ${job.company.verified ? verifiedMark() : ""} ${rating}</div>
      </div>
      ${job.match ? ring(job.match.score) : save}
    </div>
    <div class="meta">
      ${typeBadge(job.type)}<span class="badge">${icon("pin", 14)} ${esc(job.city)}</span><span class="badge">${modeLabel(job.work_mode)}</span>
      ${job.duration ? `<span class="badge">${icon("clock", 14)} ${esc(job.duration)}</span>` : ""}
      ${job.applied ? `<span class="badge badge-green">${icon("check", 14)} ${t("common.applied")}</span>` : ""}
    </div>
    <div class="chips">${(job.skills || []).slice(0, 4).map((s) => `<span class="chip ${job.match && job.match.matched.includes(s) ? "ok" : ""}">${esc(s)}</span>`).join("")}</div>
    <div class="bottom"><span class="salary">${money(job.salary_min, job.salary_max)}</span><span class="muted">${timeAgo(job.created_at)}</span>${job.match ? save : ""}</div>
  </article>`;
}

/** Makes rendered job cards clickable and their bookmark buttons work. */
function bindJobCards(root = document) {
  $$(".job-card:not([data-bound])", root).forEach((card) => {
    card.dataset.bound = "1";
    card.addEventListener("click", (e) => { if (!e.target.closest("[data-save]")) location.href = card.dataset.href; });
    card.addEventListener("keydown", (e) => { if (e.key === "Enter") location.href = card.dataset.href; });
  });
  $$("[data-save]:not([data-bound])", root).forEach((btn) => {
    btn.dataset.bound = "1";
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const saved = btn.classList.contains("saved");
      try {
        await (saved ? API.del(`/api/student/saved/${btn.dataset.save}`) : API.post(`/api/student/saved/${btn.dataset.save}`));
        btn.classList.toggle("saved", !saved);
        toast(t(saved ? "common.unsaved" : "common.savedOk"), "success");
      } catch (err) { toast(err.message, "error"); }
    });
  });
  animateRings(root);
}

// ============================================================ Dropdowns in the site's style
/* The list a browser opens for a <select> can't be styled, so each select.select gets a button + list drawn by us.
   The real <select> stays (hidden) and keeps the value: forms, filters and "change" listeners work as before. */
const nativeSelectValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
const nativeSelectIndex = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "selectedIndex");

function enhanceSelect(sel) {
  if (sel.dataset.cselect || sel.multiple) return;
  sel.dataset.cselect = "1";
  const wrap = document.createElement("div");
  wrap.className = "cselect" + (sel.style.width === "auto" ? " inline" : "");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "select cselect-btn";
  btn.style.cssText = sel.style.cssText;
  btn.setAttribute("aria-haspopup", "listbox");
  btn.setAttribute("aria-expanded", "false");
  if (sel.id) {
    btn.id = sel.id + "-btn";
    document.querySelectorAll(`label[for="${sel.id}"]`).forEach((l) => l.setAttribute("for", btn.id));
  }
  const menu = document.createElement("div");
  menu.className = "cselect-menu";
  menu.setAttribute("role", "listbox");
  menu.setAttribute("data-lenis-prevent", ""); // the mouse wheel scrolls the list, not the page
  sel.parentNode.insertBefore(wrap, sel);
  wrap.append(sel, btn, menu);
  sel.classList.add("cselect-native");
  sel.tabIndex = -1;

  const items = () => [...menu.querySelectorAll(".cselect-opt:not([disabled])")];
  const refresh = () => {
    const opt = sel.options[sel.selectedIndex];
    btn.innerHTML = `<span class="cselect-label">${esc(opt ? opt.textContent : "")}</span>${icon("chevron", 16)}`;
    btn.disabled = sel.disabled;
    menu.querySelectorAll(".cselect-opt").forEach((o) => o.setAttribute("aria-selected", String(+o.dataset.i === sel.selectedIndex)));
  };
  const build = () => {
    menu.innerHTML = [...sel.options].map((o, i) => `<button type="button" class="cselect-opt" role="option" data-i="${i}" ${o.disabled ? "disabled" : ""}>
      <span>${esc(o.textContent)}</span>${icon("check", 15)}</button>`).join("");
    if (wrap.classList.contains("inline")) { // keep the button the same width whatever is chosen
      const longest = Math.max(4, ...[...sel.options].map((o) => o.textContent.length));
      btn.style.minWidth = `min(320px, calc(${longest}ch + 52px))`;
    }
    refresh();
  };
  const close = () => { wrap.classList.remove("open", "up"); btn.setAttribute("aria-expanded", "false"); };
  const open = () => {
    document.querySelectorAll(".cselect.open").forEach((w) => w !== wrap && w.classList.remove("open"));
    wrap.classList.add("open");
    btn.setAttribute("aria-expanded", "true");
    const below = window.innerHeight - btn.getBoundingClientRect().bottom;
    wrap.classList.toggle("up", below < Math.min(320, menu.scrollHeight) + 16 && btn.getBoundingClientRect().top > below);
    const current = menu.querySelector('[aria-selected="true"]') || items()[0];
    current?.focus();
    current?.scrollIntoView({ block: "nearest" });
  };
  const choose = (i) => {
    if (i !== sel.selectedIndex) {
      nativeSelectIndex.set.call(sel, i);
      sel.dispatchEvent(new Event("input", { bubbles: true }));
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
    refresh();
    close();
    btn.focus();
  };

  btn.addEventListener("click", () => (wrap.classList.contains("open") ? close() : open()));
  btn.addEventListener("keydown", (e) => { if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) { e.preventDefault(); open(); } });
  menu.addEventListener("click", (e) => { const o = e.target.closest(".cselect-opt"); if (o && !o.disabled) choose(+o.dataset.i); });
  menu.addEventListener("keydown", (e) => {
    const list = items(), at = list.indexOf(document.activeElement);
    const go = (n) => { e.preventDefault(); list[Math.max(0, Math.min(list.length - 1, n))]?.focus(); };
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(list.length - 1);
    else if (e.key === "Escape") { e.preventDefault(); close(); btn.focus(); }
    else if (e.key === "Tab") close();
    else if (e.key.length === 1) { // jump to the first option starting with that letter
      const hit = list.find((o, k) => k > at && o.textContent.trim().toLowerCase().startsWith(e.key.toLowerCase()))
        || list.find((o) => o.textContent.trim().toLowerCase().startsWith(e.key.toLowerCase()));
      hit?.focus();
    }
  });
  // Options added later (cities, offers, translations) and values set by code keep the button up to date
  new MutationObserver(build).observe(sel, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["disabled"] });
  Object.defineProperty(sel, "value", { configurable: true, get() { return nativeSelectValue.get.call(this); }, set(v) { nativeSelectValue.set.call(this, v); refresh(); } });
  Object.defineProperty(sel, "selectedIndex", { configurable: true, get() { return nativeSelectIndex.get.call(this); }, set(v) { nativeSelectIndex.set.call(this, v); refresh(); } });
  sel.addEventListener("change", refresh);
  sel.form?.addEventListener("reset", () => setTimeout(refresh));
  build();
}

function enhanceSelects(root = document) {
  root.querySelectorAll("select.select").forEach(enhanceSelect);
}
document.addEventListener("click", (e) => { if (!e.target.closest(".cselect")) document.querySelectorAll(".cselect.open").forEach((w) => w.classList.remove("open", "up")); });
// Dropdowns that appear later (dialogs, forms drawn by JavaScript) are upgraded too
new MutationObserver((records) => {
  if (records.some((r) => [...r.addedNodes].some((n) => n.nodeType === 1 && (n.matches?.("select.select") || n.querySelector?.("select.select:not([data-cselect])"))))) enhanceSelects();
}).observe(document.documentElement, { childList: true, subtree: true });

function toast(message, type = "info") {
  let box = $(".toasts");
  if (!box) { box = document.createElement("div"); box.className = "toasts"; box.setAttribute("role", "status"); document.body.appendChild(box); }
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="t-icon">${icon(type === "error" ? "close" : type === "success" ? "check" : "bell", 14)}</span><span>${esc(message)}</span>`;
  box.appendChild(el);
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 300); }, 3800);
}

/** Opens a dialog. onOpen(el, close) lets the caller wire up buttons. */
function modal({ title, body, footer = "", wide = false, onOpen, onClose }) {
  const wrap = document.createElement("div");
  wrap.className = "modal-backdrop";
  wrap.innerHTML = `<div class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" data-close aria-label="${esc(t("common.close"))}">${icon("close")}</button></div>
    <div class="modal-body">${body}</div>${footer ? `<div class="modal-foot">${footer}</div>` : ""}</div>`;
  document.body.appendChild(wrap);
  document.body.style.overflow = "hidden";
  lenis?.stop(); // the page behind a dialog doesn't scroll
  requestAnimationFrame(() => wrap.classList.add("open"));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    wrap.classList.remove("open");
    document.body.style.overflow = "";
    lenis?.start();
    document.removeEventListener("keydown", onKey);
    setTimeout(() => wrap.remove(), 250);
    if (onClose) onClose();
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  wrap.addEventListener("click", (e) => { if (e.target === wrap || e.target.closest("[data-close]")) close(); });
  if (onOpen) onOpen(wrap, close);
  return { el: wrap, close };
}

function confirmDialog(message, okText = t("common.confirm")) {
  return new Promise((resolve) => {
    let ok = false;
    modal({
      title: t("common.confirmTitle"), body: `<p>${esc(message)}</p>`,
      footer: `<button class="btn btn-ghost" data-close>${t("common.cancel")}</button><button class="btn btn-danger" data-ok>${esc(okText)}</button>`,
      onOpen: (el, close) => $("[data-ok]", el).addEventListener("click", () => { ok = true; close(); }),
      onClose: () => resolve(ok),
    });
  });
}

/** Shows a spinner in the button while `fn` runs. */
async function withLoading(btn, fn) {
  const html = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> ${t("common.wait")}`;
  try { return await fn(); } finally { btn.disabled = false; btn.innerHTML = html; }
}

/** Dashboard tabs driven by the URL hash (#profile, #messages/12 ...). */
function panelRouter(defaultPanel, loaders = {}) {
  const show = () => {
    const [name, arg] = location.hash.slice(1).split("/");
    const panel = $(`#panel-${name}`) ? name : defaultPanel;
    $$(".panel").forEach((p) => p.classList.toggle("active", p.id === `panel-${panel}`));
    $$(".side-link[data-panel]").forEach((l) => l.classList.toggle("active", l.dataset.panel === panel));
    if (loaders[panel]) loaders[panel](arg);
    scrollToTop();
  };
  $$(".side-link[data-panel], [data-go]").forEach((el) => el.addEventListener("click", () => { location.hash = el.dataset.panel || el.dataset.go; }));
  addEventListener("hashchange", show);
  show();
}

function barChart(el, rows) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  el.innerHTML = rows.map((r) => `
    <div class="bar-row" title="${esc(r.label)}: ${r.value}"><span class="muted ellipsis">${esc(r.label)}</span>
      <div class="bar-track"><div class="bar-fill" data-w="${(100 * r.value) / max}" style="background:${r.color || "var(--series-1)"}"></div></div>
      <strong class="end">${r.value}</strong></div>`).join("");
  requestAnimationFrame(() => requestAnimationFrame(() => $$(".bar-fill", el).forEach((b) => (b.style.width = b.dataset.w + "%"))));
}

function tagInput(container, initial = [], placeholder = "") {
  let tags = [...initial];
  container.classList.add("tag-input");
  const add = (text) => text.split(",").map((v) => v.trim()).filter(Boolean)
    .forEach((v) => { if (!tags.some((x) => x.toLowerCase() === v.toLowerCase())) tags.push(v); });
  const draw = () => {
    container.innerHTML = tags.map((x, i) => `<span class="chip">${esc(x)}<button type="button" data-i="${i}" aria-label="${esc(t("common.delete"))}">×</button></span>`).join("")
      + `<input type="text" placeholder="${esc(placeholder)}">`;
    const input = $("input", container);
    input.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === ",") && input.value.trim()) { e.preventDefault(); add(input.value); draw(); $("input", container).focus(); }
      else if (e.key === "Backspace" && !input.value && tags.length) { tags.pop(); draw(); $("input", container).focus(); }
    });
    input.addEventListener("blur", () => { if (input.value.trim()) { add(input.value); draw(); } });
    $$("button[data-i]", container).forEach((b) => b.addEventListener("click", () => { tags.splice(+b.dataset.i, 1); draw(); }));
  };
  container.addEventListener("click", (e) => { if (e.target === container) $("input", container).focus(); });
  draw();
  return { get: () => [...tags], set: (v) => { tags = [...v]; draw(); } };
}

/** Free learning links for a skill (search pages, so they never break). */
function learnLinks(skill) {
  const q = encodeURIComponent(skill);
  return [["OpenClassrooms", `https://openclassrooms.com/fr/search?query=${q}`], ["Coursera", `https://www.coursera.org/search?query=${q}&free=true`],
    ["freeCodeCamp", `https://www.freecodecamp.org/news/search/?query=${q}`], ["YouTube", `https://www.youtube.com/results?search_query=${encodeURIComponent(t("learn.query", { skill }, true))}`]];
}
const learnBlock = (skills) => skills.map((s) => `
  <div class="learn-item"><strong>${esc(s)}</strong><div class="learn-links">${learnLinks(s).map(([name, url]) => `<a href="${url}" target="_blank" rel="noopener">${name}</a>`).join("")}</div></div>`).join("");

// ============================================================ 5. Layout
(function applyThemeEarly() { document.documentElement.dataset.theme = store.get("jf_theme") || "light"; })();

function notificationText(n) {
  const key = n.kind === "verification" ? `notif.verification_${n.data.status}` : `notif.${n.kind}`;
  return t(key, { ...n.data, status: n.data.status ? t("status." + n.data.status) : "" }, true); // escaped later by esc()
}

function renderNav(active = "") {
  const u = Auth.user();
  const nav = document.createElement("nav");
  nav.className = "nav";
  nav.innerHTML = `
  <div class="container">
    <a href="/" class="logo"><span class="logo-mark">${icon("spark", 18)}</span><span class="txt">Job<span class="grad-text">Finder</span>.ma</span></a>
    <div class="nav-links" id="navLinks">
      <a href="/jobs.html" class="${active === "jobs" ? "active" : ""}">${t("nav.jobs")}</a>
      <a href="/jobs.html?type=Stage,PFE" class="${active === "internships" ? "active" : ""}">${t("nav.internships")}</a>
      <a href="/companies.html" class="${active === "companies" ? "active" : ""}">${t("nav.companies")}</a>
      <a href="/#features">${t("nav.ai")}</a>
      ${!u ? `<a href="/auth.html?mode=register&role=company">${t("nav.employers")}</a>` : ""}
    </div>
    <div class="nav-actions">
      <div class="menu-wrap">
        <button class="icon-btn" id="langBtn" aria-label="${esc(t("nav.language"))}">${icon("globe")}<span class="lang-code">${LANG.toUpperCase()}</span></button>
        <div class="dropdown" id="langMenu">${Object.entries(LANG_NAMES).map(([code, name]) => `<button data-lang="${code}" class="${code === LANG ? "active" : ""}">${name}</button>`).join("")}</div>
      </div>
      <button class="icon-btn" id="themeBtn" aria-label="${esc(t("nav.theme"))}"></button>
      ${u ? `
      <div class="menu-wrap">
        <button class="icon-btn" id="bellBtn" aria-label="${esc(t("notif.title"))}">${icon("bell")}<span class="bell-dot hidden" id="bellDot"></span></button>
        <div class="dropdown notif-menu" id="notifMenu">
          <div class="notif-head"><strong>${t("notif.title")}</strong><button class="link-btn" id="readAll">${t("notif.markAll")}</button></div>
          <div id="notifList"><div class="muted small pad">${t("common.loading")}</div></div>
        </div>
      </div>
      <div class="menu-wrap">
        <button class="user-chip" id="userBtn">${avatar(u)}<span class="name">${esc(u.name)}</span></button>
        <div class="dropdown" id="userMenu">
          <a href="${Auth.home(u.role)}">${icon("grid", 16)} ${t("nav.dashboard")}</a>
          ${u.role === "student" ? `<a href="/dashboard.html#applications">${icon("briefcase", 16)} ${t("nav.applications")}</a><a href="/dashboard.html#messages">${icon("chat", 16)} ${t("nav.messages")}</a>` : ""}
          ${u.role === "company" ? `<a href="/company.html#jobs">${icon("briefcase", 16)} ${t("nav.offers")}</a><a href="/company.html#messages">${icon("chat", 16)} ${t("nav.messages")}</a>` : ""}
          <button id="logoutBtn">${icon("logout", 16)} ${t("nav.logout")}</button>
        </div>
      </div>` : `
      <a href="/auth.html" class="btn btn-ghost btn-sm">${t("nav.signin")}</a>
      <a href="/auth.html?mode=register" class="btn btn-primary btn-sm hide-sm">${t("nav.start")}</a>`}
      <button class="icon-btn menu-toggle" id="menuBtn" aria-label="Menu">${icon("menu")}</button>
    </div>
  </div>`;
  document.body.prepend(nav);

  // Dropdown menus: one open at a time, closed by clicking elsewhere
  const menus = { langBtn: "langMenu", bellBtn: "notifMenu", userBtn: "userMenu" };
  Object.entries(menus).forEach(([btnId, menuId]) => {
    const btn = $("#" + btnId);
    if (!btn) return;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = !$("#" + menuId).classList.contains("open");
      Object.values(menus).forEach((m) => $("#" + m)?.classList.remove("open"));
      $("#" + menuId).classList.toggle("open", open);
      if (open && menuId === "notifMenu") loadNotifications();
    });
  });
  $$(".dropdown").forEach((d) => d.addEventListener("click", (e) => e.stopPropagation()));
  document.addEventListener("click", () => $$(".dropdown.open").forEach((d) => d.classList.remove("open")));

  $$("[data-lang]").forEach((b) => b.addEventListener("click", () => setLanguage(b.dataset.lang)));
  const themeBtn = $("#themeBtn");
  const paintTheme = () => { themeBtn.innerHTML = icon(document.documentElement.dataset.theme === "light" ? "moon" : "sun"); };
  paintTheme();
  themeBtn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    store.set("jf_theme", next);
    paintTheme();
  });
  $("#menuBtn").addEventListener("click", () => $("#navLinks").classList.toggle("open"));
  $("#logoutBtn")?.addEventListener("click", Auth.logout);
  if (u) {
    $("#readAll").addEventListener("click", async () => { await API.post("/api/notifications/read", { ids: [] }).catch(() => {}); loadNotifications(); });
    refreshBell();
    setInterval(refreshBell, 60000);
  }
  addEventListener("scroll", () => nav.classList.toggle("scrolled", scrollY > 10), { passive: true });
}

async function refreshBell() {
  try {
    const data = await API.get("/api/notifications");
    $("#bellDot").classList.toggle("hidden", !data.unread);
    $("#bellDot").textContent = data.unread > 9 ? "9+" : data.unread;
    return data;
  } catch (_) { return null; }
}

async function loadNotifications() {
  const data = await refreshBell();
  if (!data) return;
  $("#notifList").innerHTML = data.items.length ? data.items.map((n) => `
    <a class="notif-item ${n.is_read ? "" : "unread"}" href="${esc(n.link || "#")}" data-id="${n.id}">
      <span class="notif-icon">${icon({ status: "briefcase", new_application: "users", new_job_match: "target", search_alert: "search", message: "chat", interview: "calendar", verification: "shield" }[n.kind] || "bell", 16)}</span>
      <span class="grow"><span class="notif-text">${esc(notificationText(n))}</span><span class="muted small">${timeAgo(n.created_at)}</span></span>
    </a>`).join("") : `<div class="muted small pad">${t("notif.empty")}</div>`;
  $$(".notif-item", $("#notifList")).forEach((a) => a.addEventListener("click", () => {
    API.post("/api/notifications/read", { ids: [+a.dataset.id] }).catch(() => {});
    // Same page with another #tab: the hashchange shows it; also close the menu
    $("#notifMenu").classList.remove("open");
  }));
}

function setLanguage(code) {
  store.set("jf_lang", code);
  if (Auth.user()) API.put("/api/auth/settings", { language: code }).catch(() => {}).finally(() => location.reload());
  else location.reload();
}

function renderFooter() {
  const f = document.createElement("footer");
  f.className = "footer";
  f.innerHTML = `
  <div class="container">
    <div class="footer-grid">
      <div><a href="/" class="logo"><span class="logo-mark">${icon("spark", 18)}</span><span>Job<span class="grad-text">Finder</span>.ma</span></a>
        <p class="muted small" style="margin-top:14px;max-width:320px">${t("footer.tagline")}</p></div>
      <div><h4>${t("footer.candidates")}</h4><ul><li><a href="/jobs.html">${t("nav.jobs")}</a></li><li><a href="/jobs.html?type=Stage,PFE">${t("nav.internships")}</a></li><li><a href="/dashboard.html#cv">${t("footer.cv")}</a></li><li><a href="/dashboard.html#interview">${t("footer.interview")}</a></li></ul></div>
      <div><h4>${t("footer.employers")}</h4><ul><li><a href="/auth.html?mode=register&role=company">${t("footer.createCompany")}</a></li><li><a href="/company.html#jobs">${t("footer.publish")}</a></li><li><a href="/company.html#applicants">${t("nav.applicants")}</a></li></ul></div>
      <div><h4>${t("footer.cities")}</h4><ul>${["Casablanca", "Rabat", "Marrakech", "Tanger"].map((c) => `<li><a href="/jobs.html?city=${c}">${c}</a></li>`).join("")}</ul></div>
    </div>
    <div class="footer-bottom"><span>© ${new Date().getFullYear()} JobFinder.ma — ${t("footer.made")}</span><span><a href="/privacy.html">${t("footer.privacy")}</a> · <a href="/terms.html">${t("footer.terms")}</a> · <a href="/privacy.html#contact">${t("footer.contact")}</a> · <a href="https://unsplash.com" target="_blank" rel="noopener">${t("footer.photos")}</a></span></div>
  </div>`;
  document.body.appendChild(f);
}

/** Simple page transition: fade out before following a link to another page. */
function enablePageTransitions() {
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a[href]");
    if (!a || e.defaultPrevented || e.ctrlKey || e.metaKey || e.shiftKey || a.target === "_blank") return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin || (url.pathname === location.pathname && url.search === location.search)) return;
    e.preventDefault();
    document.body.classList.add("leaving");
    setTimeout(() => { location.href = url.href; }, 180);
  });
  addEventListener("pageshow", () => document.body.classList.remove("leaving")); // coming back with the Back button
}

/** Every page calls this first. */
function initPage({ active = "", footer = true, chat = true } = {}) {
  translatePage();
  hydrateIcons();
  enhanceSelects();
  enablePageTransitions();
  renderNav(active);
  if (footer) renderFooter();
  if (chat) renderChat();
  initMotion();
  observeReveals();
}

// ============================================================ 6. Chatbot widget
function chatHistory() { try { return JSON.parse(sessionStorage.getItem("jf_chat") || "[]"); } catch (_) { return []; } }
function saveChatHistory(h) { try { sessionStorage.setItem("jf_chat", JSON.stringify(h.slice(-20))); } catch (_) {} }

/** Turns the assistant's plain text into safe HTML: escapes it, then adds bold and bullet lists. */
function chatFormat(text) {
  const lines = esc(text.replace(/\[job:\d+\]/g, "").trim()).split("\n");
  let html = "", inList = false;
  for (const line of lines) {
    const bullet = line.match(/^\s*[-*•]\s+(.*)/);
    if (bullet && !inList) { html += "<ul>"; inList = true; }
    if (!bullet && inList) { html += "</ul>"; inList = false; }
    html += bullet ? `<li>${bullet[1]}</li>` : line.trim() ? `<p>${line}</p>` : "";
  }
  if (inList) html += "</ul>";
  return html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

const chatJobCard = (j) => `<a class="chat-job" href="/job.html?id=${j.id}">${companyLogo(j.company, "sm")}<span class="grow"><strong>${esc(j.title)}</strong><span class="muted small">${esc(j.company.name)} · ${esc(j.city)} · ${esc(j.type)}</span></span>${icon("arrow", 16)}</a>`;

function renderChat() {
  const box = document.createElement("div");
  box.className = "chat";
  box.innerHTML = `
    <button class="chat-fab" id="chatFab" aria-label="${esc(t("chat.open"))}">${icon("chat", 24)}</button>
    <section class="chat-panel" id="chatPanel" aria-label="${esc(t("chat.title"))}">
      <header class="chat-head">
        <span class="chat-avatar">${icon("spark", 18)}</span>
        <div class="grow"><strong>${t("chat.title")}</strong><div class="muted small">${t("chat.subtitle")}</div></div>
        <button class="icon-btn" id="chatReset" title="${esc(t("chat.reset"))}">${icon("trash", 16)}</button>
        <button class="icon-btn" id="chatClose" aria-label="${esc(t("common.close"))}">${icon("close", 16)}</button>
      </header>
      <div class="chat-body" id="chatBody"></div>
      <div class="chat-suggest" id="chatSuggest">${["chat.s1", "chat.s2", "chat.s3"].map((k) => `<button>${t(k)}</button>`).join("")}</div>
      <form class="chat-form" id="chatForm"><input class="input" id="chatInput" autocomplete="off" placeholder="${esc(t("chat.placeholder"))}" maxlength="2000">
        <button class="btn btn-primary" aria-label="${esc(t("chat.send"))}">${icon("send", 16)}</button></form>
    </section>`;
  document.body.appendChild(box);
  const body = $("#chatBody");
  let history = chatHistory();

  const bubble = (role, html) => { body.insertAdjacentHTML("beforeend", `<div class="msg ${role}">${html}</div>`); body.scrollTop = body.scrollHeight; };
  const drawAll = () => {
    body.innerHTML = "";
    bubble("model", `<p>${esc(t("chat.hello"))}</p>`);
    history.forEach((m) => bubble(m.role, m.role === "user" ? `<p>${esc(m.text)}</p>` : chatFormat(m.text) + (m.jobs || []).map(chatJobCard).join("")));
    $("#chatSuggest").classList.toggle("hidden", history.length > 0);
  };

  async function send(text) {
    text = text.trim();
    if (!text) return;
    $("#chatSuggest").classList.add("hidden");
    bubble("user", `<p>${esc(text)}</p>`);
    bubble("model typing", "<span></span><span></span><span></span>");
    try {
      const res = await API.post("/api/chat", { message: text, language: LANG, history: history.map(({ role, text: x }) => ({ role, text: x })) });
      $(".msg.typing", body)?.remove();
      const reply = res.offline ? (res.jobs.length ? t("chat.offlineJobs") : t("chat.offline")) : res.reply;
      history.push({ role: "user", text }, { role: "model", text: reply, jobs: res.jobs });
      bubble("model", chatFormat(reply) + res.jobs.map(chatJobCard).join(""));
    } catch (err) {
      $(".msg.typing", body)?.remove();
      bubble("model", `<p>${esc(err.message)}</p>`);
    }
    saveChatHistory(history);
  }

  $("#chatFab").addEventListener("click", () => { box.classList.toggle("open"); if (box.classList.contains("open")) $("#chatInput").focus(); });
  $("#chatClose").addEventListener("click", () => box.classList.remove("open"));
  $("#chatReset").addEventListener("click", () => { history = []; saveChatHistory(history); drawAll(); });
  $("#chatForm").addEventListener("submit", (e) => { e.preventDefault(); const v = $("#chatInput").value; $("#chatInput").value = ""; send(v); });
  $$("#chatSuggest button").forEach((b) => b.addEventListener("click", () => send(b.textContent)));
  drawAll();
}

// ============================================================ Messages inbox (student + company dashboards)
let threadTimer = null;

/** Fills <div id="inbox"> with the conversation list, and opens conversation `openId` if given. */
async function loadInbox(openId) {
  clearInterval(threadTimer);
  const box = $("#inbox");
  const me = Auth.user();
  let convs = [];
  try { convs = await API.get("/api/messages"); } catch (err) { toast(err.message, "error"); }
  box.innerHTML = `<div class="inbox-list">${convs.length ? convs.map((c) => `
      <div class="conv" data-conv="${c.application_id}">
        ${me.role === "student" ? companyLogo(c.other, "sm") : avatar(c.other)}
        <div class="grow"><div class="row" style="justify-content:space-between;gap:6px"><strong class="ellipsis">${esc(c.other.name)}</strong><span class="muted small">${timeAgo(c.last.created_at)}</span></div>
          <div class="muted small ellipsis">${esc(c.job.title)}</div><div class="small ellipsis">${esc(c.last.body)}</div></div>
        ${c.unread ? `<span class="unread-count">${c.unread}</span>` : ""}
      </div>`).join("") : `<div class="empty">${icon("chat", 36)}<p>${t("msg.empty")}</p></div>`}</div>
    <div class="thread" id="thread"><div class="empty grow">${icon("chat", 36)}<p>${t("msg.pick")}</p></div></div>`;
  $$(".conv", box).forEach((c) => c.addEventListener("click", () => { location.hash = `messages/${c.dataset.conv}`; }));
  if (openId) openThread(+openId);
}

async function openThread(id) {
  const box = $("#inbox");
  const me = Auth.user();
  let data;
  try { data = await API.get(`/api/messages/${id}`); } catch (err) { toast(err.message, "error"); return; }
  box.classList.add("has-thread");
  $$(".conv", box).forEach((c) => c.classList.toggle("active", +c.dataset.conv === id));
  $(`.conv[data-conv="${id}"] .unread-count`, box)?.remove();
  const other = me.role === "student"
    ? { pic: companyLogo(data.company, "sm"), name: data.company.name }
    : { pic: avatar(data.student), name: data.student.name };
  const iv = data.interview;
  $("#thread").innerHTML = `
    <div class="thread-head">
      <button class="icon-btn" id="backToList" aria-label="${esc(t("common.back"))}">${DIR === "rtl" ? "›" : "‹"}</button>
      ${other.pic}<div class="grow"><strong>${esc(other.name)}</strong><div class="muted small ellipsis">${esc(data.job.title)} · ${t("status." + data.status)}</div></div>
    </div>
    ${iv ? `<div class="interview-card" style="margin:12px 12px 0">${icon("calendar", 20)}<div><strong>${t("iv.title")}</strong><div class="small">${dateTimeStr(iv.at)} · ${t("iv.mode." + iv.mode)}</div>${iv.location ? `<div class="small ellipsis">${esc(iv.location)}</div>` : ""}</div></div>` : ""}
    <div class="thread-body" id="threadBody"></div>
    <form class="thread-form" id="threadForm"><textarea class="textarea" id="threadInput" rows="1" placeholder="${esc(t("msg.placeholder"))}" maxlength="4000"></textarea>
      <button class="btn btn-primary" aria-label="${esc(t("chat.send"))}">${icon("send", 16)}</button></form>`;
  const drawMessages = (messages) => {
    const body = $("#threadBody");
    if (!body) return;
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
    body.innerHTML = messages.length ? messages.map((m) => `<div class="bubble ${m.sender_id === me.id ? "me" : ""}">${esc(m.body)}<time>${timeAgo(m.created_at)}</time></div>`).join("")
      : `<div class="empty">${t("msg.start")}</div>`;
    if (atBottom || !drawMessages.done) body.scrollTop = body.scrollHeight;
    drawMessages.done = true;
  };
  drawMessages(data.messages);
  $("#backToList").addEventListener("click", () => { box.classList.remove("has-thread"); location.hash = "messages"; });
  const input = $("#threadInput");
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#threadForm").requestSubmit(); } });
  $("#threadForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    try {
      await API.post(`/api/messages/${id}`, { body: text });
      data = await API.get(`/api/messages/${id}`);
      drawMessages(data.messages);
      $("#threadBody").scrollTop = $("#threadBody").scrollHeight;
    } catch (err) { toast(err.message, "error"); input.value = text; }
  });
  input.focus({ preventScroll: true });
  clearInterval(threadTimer);
  threadTimer = setInterval(async () => {  // check for new messages every 8 seconds while the conversation is open
    if (!document.body.contains($("#threadBody")) || !$("#panel-messages").classList.contains("active")) return clearInterval(threadTimer);
    try { drawMessages((await API.get(`/api/messages/${id}`)).messages); } catch (_) {}
  }, 8000);
}

// ============================================================ 7. Animations
/* GSAP + Lenis (loaded from a CDN on every page) power the motion. If they can't load, or the visitor
   asked their system for reduced motion, MOTION is false and the simple CSS animations are used instead. */
const MOTION = !!(window.gsap && window.ScrollTrigger) && !matchMedia("(prefers-reduced-motion: reduce)").matches;
let lenis = null; // smooth scrolling

function initMotion() {
  if (!MOTION) return;
  document.documentElement.classList.add("gsap-on");
  gsap.registerPlugin(ScrollTrigger, ...(window.SplitText ? [SplitText] : []));

  // Lenis smooth scrolling, driven by GSAP's clock so ScrollTrigger stays in sync.
  // Loaded as a module: its normal script version leaks globals (one is named `t` and would replace our translations).
  import("https://unpkg.com/lenis@1.3.4/dist/lenis.mjs").then((mod) => {
    const Lenis = mod.default || mod.Lenis;
    lenis = new Lenis({
      lerp: 0.1,
      anchors: { offset: -80 },  // smooth scroll for links like /#features
      allowNestedScroll: true,   // menus, chat, modals and tables keep their own scrolling
      prevent: (node) => !!node.closest?.(".modal-backdrop, .chat-panel, .dropdown, .sidebar, .inbox, .kanban, .table-wrap"),
    });
    lenis.on("scroll", ScrollTrigger.update);
    gsap.ticker.add((time) => lenis.raf(time * 1000));
    gsap.ticker.lagSmoothing(0);
  }).catch(() => {}); // without Lenis the page simply scrolls normally

  animateHeadings();
  heroParallax();
  hoverEffects();
  document.fonts?.ready.then(() => ScrollTrigger.refresh()); // positions change once fonts are loaded
}

/** Scroll to the top, smoothly or at once (goes through Lenis when it is active). */
function scrollToTop(smooth = false) {
  if (lenis) lenis.scrollTo(0, { immediate: !smooth });
  else scrollTo({ top: 0, behavior: smooth ? "smooth" : "auto" });
}

/** Headlines appear word by word: the page title at once, section titles when they scroll into view. */
function animateHeadings() {
  if (!window.SplitText) return;
  const split = (el) => SplitText.create(el, { type: "words", mask: "words" }).words;
  $$(".hero h1, .page-head h1, .dash-head h1, .auth-side h2").forEach((el) => {
    el.classList.remove("fade-up");
    gsap.from(split(el), { yPercent: 110, duration: 0.9, ease: "power4.out", stagger: 0.06, delay: 0.1 });
  });
  $$(".section-head h2, .toolbar h2, .cta-box h2").forEach((el) => {
    gsap.from(split(el), { yPercent: 110, duration: 0.8, ease: "power3.out", stagger: 0.05,
      scrollTrigger: { trigger: el, start: "top 88%", once: true } });
  });
}

/** The home-page photo moves a little slower than the page. */
function heroParallax() {
  const hero = $(".hero.photo-bg");
  if (!hero) return;
  gsap.fromTo(hero, { backgroundPosition: "50% 40%" }, { backgroundPosition: "50% 75%", ease: "none",
    scrollTrigger: { trigger: hero, start: "top top", end: "bottom top", scrub: true } });
}

/** Cards tilt slightly towards the mouse; big buttons lean towards it. Mouse only (not on touch screens). */
function hoverEffects() {
  if (!matchMedia("(pointer: fine)").matches) return;
  document.addEventListener("pointerover", (e) => {
    const card = e.target.closest?.(".card-hover:not([data-tilt])");
    if (card) {
      card.dataset.tilt = "1";
      card.addEventListener("pointermove", (ev) => {
        const r = card.getBoundingClientRect();
        const x = (ev.clientX - r.left) / r.width - 0.5, y = (ev.clientY - r.top) / r.height - 0.5;
        gsap.to(card, { rotationY: x * 6, rotationX: -y * 6, y: -4, transformPerspective: 900, duration: 0.4, ease: "power2.out" });
      });
      card.addEventListener("pointerleave", () => gsap.to(card, { rotationY: 0, rotationX: 0, y: 0, duration: 0.7, ease: "elastic.out(1, 0.6)" }));
    }
    const btn = e.target.closest?.(".btn-lg:not([data-magnet]), .search-bar .btn:not([data-magnet]), .chat-fab:not([data-magnet])");
    if (btn) {
      btn.dataset.magnet = "1";
      btn.addEventListener("pointermove", (ev) => {
        const r = btn.getBoundingClientRect();
        gsap.to(btn, { x: (ev.clientX - r.left - r.width / 2) * 0.2, y: (ev.clientY - r.top - r.height / 2) * 0.3, duration: 0.3, ease: "power2.out" });
      });
      btn.addEventListener("pointerleave", () => gsap.to(btn, { x: 0, y: 0, duration: 0.6, ease: "elastic.out(1, 0.5)" }));
    }
  });
}

const revealObserver = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
  // Also reveal elements already scrolled past (fast scrolling can skip them)
  entries.forEach((e) => { if (e.isIntersecting || e.boundingClientRect.top < 0) { e.target.classList.add("in"); revealObserver.unobserve(e.target); } });
}, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }) : null;

/** Elements with class "reveal" glide in when they scroll into view (several at once are staggered). */
function observeReveals(root = document) {
  const items = $$(".reveal:not([data-seen]), .reveal-scale:not([data-seen])", root);
  items.forEach((el) => (el.dataset.seen = "1"));
  if (!items.length) return;
  if (MOTION) {
    gsap.set(items, { opacity: 0, y: 32 });
    ScrollTrigger.batch(items, { start: "top 90%", once: true,
      onEnter: (batch) => gsap.to(batch, { opacity: 1, y: 0, duration: 0.8, ease: "power3.out", stagger: 0.08, overwrite: true }) });
    return;
  }
  items.forEach((el) => (revealObserver ? revealObserver.observe(el) : el.classList.add("in")));
}

/** Numbers count up from 0 (used for statistics). */
function animateCount(el, to, duration = 1400) {
  const show = (v) => { el.textContent = fmt.format(Math.round(v)) + (el.dataset.suffix || ""); };
  if (MOTION) {
    const counter = { v: 0 };
    gsap.to(counter, { v: to, duration: duration / 1000, ease: "power2.out", onUpdate: () => show(counter.v) });
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - start) / duration);
    show(to * (1 - Math.pow(1 - p, 4)));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function animateRings(root = document) {
  $$(".ring[data-score]:not([data-anim])", root).forEach((r) => {
    r.dataset.anim = "1";
    requestAnimationFrame(() => requestAnimationFrame(() => r.style.setProperty("--v", r.dataset.score)));
  });
}
