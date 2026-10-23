/* ==========================================================================
   STUDENT.JS — the student dashboard (dashboard.html)
   Tabs: overview · profile (+ PDF upload) · applications · messages · saved
         · AI CV builder · mock interview · portfolio
   ========================================================================== */
const me = Auth.require("student");
let skillsTags, langTags;

// ------------------------------------------------------------ Overview
function setCompletion(pct) {
  $("#sideProgress").style.width = pct + "%";
  $("#sideProgressLabel").textContent = t("dash.complete_pct", { n: pct });
}

async function loadOverview() {
  try {
    const o = await API.get("/api/student/overview");
    animateCount($("#kApps"), o.applications);
    animateCount($("#kInterviews"), o.by_status.interview);
    animateCount($("#kAccepted"), o.by_status.accepted);
    animateCount($("#kSaved"), o.saved);
    $("#appCount").textContent = o.applications;
    setCompletion(o.completion);
    $("#completionBadge").textContent = `${o.completion}%`;
    requestAnimationFrame(() => ($("#completionBar").style.width = o.completion + "%"));
    $("#completionTip").textContent = t(o.completion >= 90 ? "dash.tipGreat" : "dash.tipMore");
    barChart($("#pipelineChart"), Object.entries(o.by_status).map(([k, v]) => ({ label: t("status." + k), value: v, color: STATUS_COLORS[k] })));

    $("#interviewsCard").hidden = !o.interviews.length;
    $("#interviews").innerHTML = o.interviews.map((iv) => interviewCard(iv, `${iv.job} · ${iv.company}`)).join("");

    $("#gapsCard").hidden = !o.skill_gaps.length;
    $("#gaps").innerHTML = learnBlock(o.skill_gaps.slice(0, 4));

    $("#matches").innerHTML = o.matches.length ? o.matches.map((j) => `
      <a class="list-row" href="/job.html?id=${j.id}">${companyLogo(j.company)}
        <div class="grow"><div class="title">${esc(j.title)}</div><div class="sub">${esc(j.company.name)} · ${esc(j.city)} · ${esc(j.type)}</div></div>${ring(j.match.score)}</a>`).join("")
      : `<div class="empty">${t("dash.noMatches")}</div>`;
    animateRings($("#matches"));
  } catch (err) { toast(err.message, "error"); }
}

function interviewCard(iv, title) {
  const d = new Date(iv.at);
  return `<div class="interview-card">
    <div class="date-box"><div class="d">${d.getDate()}</div><div class="m">${d.toLocaleDateString(LOCALE, { month: "short" })}</div></div>
    <div class="grow"><strong>${esc(title)}</strong>
      <div class="small">${icon("clock", 14)} ${d.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" })} · ${t("iv.mode." + iv.mode)}</div>
      ${iv.location ? `<div class="small ellipsis">${/^https?:/.test(iv.location) ? `<a href="${esc(iv.location)}" target="_blank" rel="noopener" class="grad-text">${esc(iv.location)}</a>` : esc(iv.location)}</div>` : ""}
      ${iv.note ? `<div class="muted small">${esc(iv.note)}</div>` : ""}</div>
    <a class="btn btn-ghost btn-sm" href="#messages/${iv.application_id}">${icon("chat", 14)}</a></div>`;
}

// ------------------------------------------------------------- Profile
const REPEATERS = {
  education: [["degree", "rep.degree"], ["school", "profile.school"], ["start", "rep.start"], ["end", "rep.end"]],
  experience: [["title", "rep.role"], ["org", "rep.org"], ["start", "rep.start"], ["end", "rep.endNow"], ["description", "rep.achievements", true]],
  projects: [["name", "rep.project"], ["tech", "rep.tech"], ["link", "rep.link"], ["description", "rep.description", true]],
};

function repeaterItem(kind, data = {}) {
  const div = document.createElement("div");
  div.className = "repeater-item fade-up";
  div.innerHTML = `<button type="button" class="icon-btn remove" style="width:30px;height:30px" aria-label="${esc(t("common.delete"))}">${icon("close", 14)}</button>
    <div class="form-grid">${REPEATERS[kind].map(([key, label, long]) => long
      ? `<div class="field full"><label>${t(label)}</label><textarea class="textarea" data-k="${key}" rows="3">${esc(data[key] || "")}</textarea></div>`
      : `<div class="field"><label>${t(label)}</label><input class="input" data-k="${key}" value="${esc(data[key] || "")}"></div>`).join("")}</div>`;
  $(".remove", div).addEventListener("click", () => div.remove());
  return div;
}

const fillRepeater = (kind, items) => { const box = $(`#rep-${kind}`); box.innerHTML = ""; (items || []).forEach((it) => box.appendChild(repeaterItem(kind, it))); };
const readRepeater = (kind) => $$(`#rep-${kind} .repeater-item`)
  .map((item) => Object.fromEntries($$("[data-k]", item).map((i) => [i.dataset.k, i.value.trim()])))
  .filter((o) => Object.values(o).some(Boolean));

function fillProfileForm(profile, name) {
  const f = $("#profileForm");
  if (name) f.name.value = name;
  ["headline", "phone", "city", "school", "field", "level", "bio"].forEach((k) => { if (profile[k] !== undefined) f[k].value = profile[k] || ""; });
  ["linkedin", "github", "website"].forEach((k) => { if (profile.links && profile.links[k] !== undefined) f[k].value = profile.links[k] || ""; });
  if (profile.skills) skillsTags.set(profile.skills);
  if (profile.languages) langTags.set(profile.languages);
  if (profile.desired_types) $$("#desiredTypes input").forEach((i) => (i.checked = profile.desired_types.includes(i.value)));
  Object.keys(REPEATERS).forEach((k) => { if (profile[k]) fillRepeater(k, profile[k]); });
}

async function loadProfile() {
  try {
    const data = await API.get("/api/student/profile");
    fillProfileForm(data.profile, data.user.name);
    setCompletion(data.profile.completion);
  } catch (err) { toast(err.message, "error"); }
}

async function saveProfile(e) {
  const f = $("#profileForm");
  const body = {
    name: f.name.value,
    ...Object.fromEntries(["headline", "phone", "city", "school", "field", "level", "bio"].map((k) => [k, f[k].value])),
    skills: skillsTags.get(), languages: langTags.get(), desired_types: $$("#desiredTypes input:checked").map((i) => i.value),
    links: Object.fromEntries(["linkedin", "github", "website"].map((k) => [k, f[k].value.trim()])),
    education: readRepeater("education"), experience: readRepeater("experience"), projects: readRepeater("projects"),
  };
  await withLoading(e.currentTarget, async () => {
    try {
      const data = await API.put("/api/student/profile", body);
      Auth.setUser(data.user);
      setCompletion(data.profile.completion);
      toast(t("profile.saved", { n: data.profile.completion }), "success");
    } catch (err) { toast(err.message, "error"); }
  });
}

/** PDF upload: the server reads the CV, we fill the form, the student checks it and clicks Save. */
function uploadCv(file) {
  if (!file) return;
  if (file.type !== "application/pdf" || file.size > 5 * 1024 * 1024) return toast(t("upload.invalid"), "error");
  const reader = new FileReader();
  reader.onload = async () => {
    const zone = $("#dropZone");
    zone.classList.add("generating");
    try {
      const { fields } = await API.post("/api/student/cv-upload", { file_base64: reader.result });
      const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v && (!Array.isArray(v) || v.length) && (typeof v !== "object" || Object.keys(v).length)));
      if (clean.skills) clean.skills = [...new Set([...skillsTags.get(), ...clean.skills])];
      fillProfileForm(clean);
      toast(t("upload.done"), "success");
    } catch (err) { toast(err.message, "error"); }
    finally { zone.classList.remove("generating"); $("#cvFile").value = ""; }
  };
  reader.readAsDataURL(file);
}

// -------------------------------------------------------- Applications
async function loadApplications() {
  const board = $("#kanban");
  board.innerHTML = '<div class="skeleton" style="height:300px;grid-column:1/-1"></div>';
  try {
    const apps = await API.get("/api/student/applications");
    $("#appCount").textContent = apps.length;
    board.innerHTML = Object.keys(STATUS_COLORS).map((key) => {
      const items = apps.filter((a) => a.status === key);
      return `<div class="k-col"><div class="k-col-head"><span class="dot" style="background:${STATUS_COLORS[key]}"></span>${t("status." + key)}<span class="count">${items.length}</span></div>
        ${items.map((a) => `<div class="k-card fade-up" data-app="${a.id}">
          <div class="row" style="margin-bottom:8px">${companyLogo(a.job.company, "sm")}<div class="s grow">${esc(a.job.company.name)}</div></div>
          <div class="t">${esc(a.job.title)}</div><div class="s">${typeBadge(a.job.type)} · ${timeAgo(a.created_at)}</div>
          ${a.interview ? `<div class="s" style="margin-top:6px;color:#a78bfa">${icon("calendar", 13)} ${dateTimeStr(a.interview.at)}</div>` : ""}
          ${a.can_review ? `<div class="s" style="margin-top:6px;color:var(--accent)">${icon("star", 13)} ${t("reviews.write")}</div>` : ""}
        </div>`).join("") || `<div class="muted small" style="text-align:center;padding:20px 0">${t("apps.emptyCol")}</div>`}</div>`;
    }).join("");
    $$("[data-app]", board).forEach((card) => card.addEventListener("click", () => openApplication(apps.find((a) => a.id === +card.dataset.app))));
  } catch (err) { board.innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
}

function openApplication(a) {
  const steps = ["submitted", "reviewing", "interview", "accepted"];
  const reached = a.status === "rejected" ? -1 : steps.indexOf(a.status);
  modal({
    title: a.job.title,
    body: `
      <div class="row" style="margin-bottom:18px">${companyLogo(a.job.company)}<div class="grow"><strong>${esc(a.job.company.name)}</strong><div class="muted small">${esc(a.job.city)} · ${t("apps.appliedOn", { date: dateStr(a.created_at) })}</div></div>${statusBadge(a.status)}</div>
      <div class="row" style="gap:6px;margin-bottom:20px;flex-wrap:nowrap">${steps.map((s, i) => `<div class="grow"><div class="progress" style="height:6px"><i style="width:${i <= reached ? 100 : 0}%"></i></div><small class="muted">${t("status." + s)}</small></div>`).join("")}</div>
      ${a.interview ? interviewCard({ ...a.interview, application_id: a.id }, t("iv.title")) : ""}
      <div class="row" style="margin:16px 0">${ring(Math.round(a.match_score))}<span class="muted">${t("apps.matchWhen")}</span></div>
      ${a.cover_letter ? `<h4 style="margin-bottom:8px">${t("job.cover")}</h4><p class="muted small" style="white-space:pre-line">${esc(a.cover_letter)}</p>` : ""}`,
    footer: `${["accepted", "rejected"].includes(a.status) ? "" : `<button class="btn btn-danger" id="withdraw">${t("apps.withdraw")}</button>`}
      ${a.can_review ? `<button class="btn btn-gold" id="reviewBtn">${icon("star", 15)} ${t("reviews.write")}</button>` : ""}
      <a class="btn btn-ghost" href="#messages/${a.id}" data-close>${icon("chat", 15)} ${t("apps.message")}</a>
      <a class="btn btn-ghost" href="/job.html?id=${a.job.id}">${t("apps.viewOffer")}</a>`,
    onOpen: (el, close) => {
      animateRings(el);
      $("#withdraw", el)?.addEventListener("click", async () => {
        if (!(await confirmDialog(t("apps.withdrawConfirm"), t("apps.withdraw")))) return;
        try { await API.del(`/api/student/applications/${a.id}`); close(); toast(t("apps.withdrawn"), "success"); loadApplications(); }
        catch (err) { toast(err.message, "error"); }
      });
      $("#reviewBtn", el)?.addEventListener("click", () => { close(); openReview(a); });
    },
  });
}

function openReview(a) {
  modal({
    title: t("reviews.writeFor", { company: a.job.company.name }, true),
    body: `<form id="reviewForm" class="form-grid" style="grid-template-columns:1fr">
      <div class="field"><label>${t("reviews.rating")}</label><div class="star-input">${[5, 4, 3, 2, 1].map((n) => `<input type="radio" name="rating" id="r${n}" value="${n}"><label for="r${n}" title="${n}/5">★</label>`).join("")}</div></div>
      <div class="field"><label>${t("reviews.titleLabel")}</label><input class="input" name="title" maxlength="200"></div>
      <div class="field"><label>${t("reviews.body")}</label><textarea class="textarea" name="body" rows="5" maxlength="3000" placeholder="${esc(t("reviews.bodyPh"))}"></textarea></div>
      <p class="muted small">${t("reviews.privacy")}</p></form>`,
    footer: `<button class="btn btn-ghost" data-close>${t("common.cancel")}</button><button class="btn btn-primary" id="sendReview">${t("reviews.publish")}</button>`,
    onOpen: (el, close) => $("#sendReview", el).addEventListener("click", (e) => {
      const f = Object.fromEntries(new FormData($("#reviewForm", el)));
      if (!f.rating) return toast(t("reviews.needRating"), "error");
      if ((f.title || "").trim().length < 3 || (f.body || "").trim().length < 20) return toast(t("reviews.needText"), "error");
      withLoading(e.currentTarget, async () => {
        try {
          await API.post("/api/student/reviews", { company_id: a.job.company.id, rating: +f.rating, title: f.title, body: f.body, role: a.job.title });
          close(); toast(t("reviews.thanks"), "success"); loadApplications();
        } catch (err) { toast(err.message, "error"); }
      });
    }),
  });
}

// --------------------------------------------------------------- Saved
async function loadAlerts() {
  const box = $("#alertsList");
  try {
    const alerts = await API.get("/api/student/searches");
    box.innerHTML = alerts.length ? alerts.map((a) => `
      <div class="list-row" data-alert="${a.id}">
        <span class="notif-icon">${icon("bell", 16)}</span>
        <div class="grow"><div class="title">${esc(a.name)}</div><div class="sub">${esc(describeFilters(a.filters))}</div></div>
        <label class="row small" style="cursor:pointer;flex-wrap:nowrap" title="${esc(t("alerts.email"))}"><span class="switch"><input type="checkbox" data-email ${a.email ? "checked" : ""}><span></span></span>${t("alerts.emailShort")}</label>
        <a class="btn btn-ghost btn-sm" href="${filtersUrl(a.filters)}">${t("alerts.view")}</a>
        <button class="btn btn-danger btn-sm" data-del aria-label="${esc(t("common.delete"))}">${icon("trash", 14)}</button>
      </div>`).join("") : `<p class="muted small">${t("alerts.empty")}</p>`;
    $$("[data-alert]", box).forEach((row) => {
      const id = row.dataset.alert;
      $("[data-email]", row).addEventListener("change", async (e) => {
        try { await API.put(`/api/student/searches/${id}`, { email: e.target.checked }); } catch (err) { toast(err.message, "error"); e.target.checked = !e.target.checked; }
      });
      $("[data-del]", row).addEventListener("click", async () => {
        if (!(await confirmDialog(t("alerts.deleteConfirm"), t("common.delete")))) return;
        try { await API.del(`/api/student/searches/${id}`); toast(t("alerts.deleted"), "success"); loadAlerts(); } catch (err) { toast(err.message, "error"); }
      });
    });
  } catch (err) { box.innerHTML = `<p class="muted small">${esc(err.message)}</p>`; }
}

async function loadSaved() {
  loadAlerts();
  const grid = $("#savedGrid");
  try {
    const jobs = await API.get("/api/student/saved");
    grid.innerHTML = jobs.length ? jobs.map(jobCard).join("")
      : `<div class="card empty" style="grid-column:1/-1">${icon("bookmark", 36)}<h3>${t("saved.empty")}</h3><p>${t("saved.emptySub")}</p></div>`;
    bindJobCards(grid);
  } catch (err) { grid.innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
}

// ------------------------------------------------- Job pickers (CV + interview)
let pickersFilled = false;
async function fillJobPickers() {
  if (pickersFilled) return;
  pickersFilled = true;
  const data = await API.get("/api/jobs?per_page=50&sort=match");
  const options = data.items.map((j) => `<option value="${j.id}">${esc(j.title)} — ${esc(j.company.name)}</option>`).join("");
  $$(".jobPicker").forEach((s) => { s.innerHTML += options; if (params().job) s.value = params().job; });
}

// ------------------------------------------------------------- CV builder
function showCv(html) {
  $("#cvTools").classList.toggle("hidden", !html);
  $("#cvPreview").innerHTML = html ? `<div class="cv-paper fade-up">${html}</div>`
    : `<div class="card empty">${icon("file", 36)}<h3>${t("cv.none")}</h3><p>${t("cv.noneSub")}</p></div>`;
}

async function loadCv() {
  try { const [cv] = await Promise.all([API.get("/api/student/cv"), fillJobPickers()]); showCv(cv.html); }
  catch (err) { toast(err.message, "error"); }
}

async function generateCv(e) {
  $("#cvPreview").classList.add("generating");
  await withLoading(e.currentTarget, async () => {
    try {
      const r = await API.post("/api/student/cv/generate", { job_id: $("#cvJob").value ? +$("#cvJob").value : null, language: $("#cvLang").value });
      showCv(r.html);
      toast(t(r.source === "ai" ? "ai.doneAi" : "ai.doneTemplate"), "success");
    } catch (err) { toast(err.message, "error"); }
  });
  $("#cvPreview").classList.remove("generating");
}

// --------------------------------------------------------- Mock interview
async function loadInterview() { fillJobPickers().catch(() => {}); }

async function startMock(e) {
  const jobId = +$("#mockJob").value;
  if (!jobId) return toast(t("mock.choose"), "error");
  await withLoading(e.currentTarget, async () => {
    try {
      const { questions } = await API.post("/api/student/interview/questions", { job_id: jobId, language: LANG });
      $("#mockArea").innerHTML = questions.map((q, i) => `
        <div class="question-card fade-up" style="--d:${i * 0.06}s"><div class="q-num">${t("mock.question", { n: i + 1, total: questions.length })}</div>
          <h4>${esc(q)}</h4><textarea class="textarea" data-q="${i}" rows="4" placeholder="${esc(t("mock.answerPh"))}"></textarea><div class="feedback hidden" id="fb${i}"></div></div>`).join("")
        + `<div class="row" style="justify-content:flex-end"><button class="btn btn-primary btn-lg" id="getFeedback">${icon("check", 16)} ${t("mock.feedback")}</button></div><div id="mockResult"></div>`;
      $("#getFeedback").addEventListener("click", (ev) => sendAnswers(ev, jobId, questions));
    } catch (err) { toast(err.message, "error"); }
  });
}

async function sendAnswers(e, jobId, questions) {
  const answers = questions.map((q, i) => ({ question: q, answer: $(`[data-q="${i}"]`).value.trim() }));
  if (answers.every((a) => !a.answer)) return toast(t("mock.needAnswer"), "error");
  await withLoading(e.currentTarget, async () => {
    try {
      const r = await API.post("/api/student/interview/feedback", { job_id: jobId, language: LANG, answers });
      (r.items || []).forEach((item, i) => {
        const box = $("#fb" + i);
        if (!box) return;
        box.classList.remove("hidden");
        box.innerHTML = `<strong>${item.score}/10</strong> — ${esc(item.feedback)}<div class="muted" style="margin-top:4px">${icon("spark", 13)} ${esc(item.tip)}</div>`;
      });
      $("#mockResult").innerHTML = `<div class="card fade-up row" style="margin-top:18px;gap:20px">${ring(r.score, "lg")}
        <div class="grow"><h3>${t("mock.result")}</h3><p class="muted">${esc(r.summary || "")}</p></div></div>`;
      animateRings($("#mockResult"));
      $("#mockResult").scrollIntoView({ behavior: "smooth", block: "center" });
    } catch (err) { toast(err.message, "error"); }
  });
}

// --------------------------------------------------------------- Portfolio
const pf = { html: "", theme: "emerald", public: false, url: "" };
const THEMES = { emerald: ["#10b981", "#06b6d4", "#06100d"], sunset: ["#f97316", "#ec4899", "#140a0b"], ocean: ["#3b82f6", "#8b5cf6", "#080b18"], mono: ["#e5e7eb", "#6b7280", "#0a0a0a"] };

async function loadPortfolio() {
  try { Object.assign(pf, await API.get("/api/student/portfolio")); showPortfolio(); } catch (err) { toast(err.message, "error"); }
}

function showPortfolio() {
  $("#themes").innerHTML = Object.entries(THEMES).map(([k, [a, b]]) => `<button class="${pf.theme === k ? "active" : ""}" data-theme-name="${k}" style="background:linear-gradient(135deg,${a},${b})" aria-label="${k}"></button>`).join("");
  $$("#themes button").forEach((b) => b.addEventListener("click", () => savePortfolioSettings({ theme: b.dataset.themeName })));
  $("#pfPublic").checked = pf.public;
  $("#pfPublic").disabled = !pf.html;
  const full = location.origin + pf.url;
  $("#pfLink").innerHTML = pf.public ? `${icon("link", 14)} <a href="${esc(pf.url)}" target="_blank" class="grad-text" style="font-weight:700">${esc(full)}</a> <button class="btn btn-ghost btn-sm" id="copyLink">${t("pf.copy")}</button>` : t("pf.private");
  $("#copyLink")?.addEventListener("click", () => navigator.clipboard.writeText(full).then(() => toast(t("pf.copied"), "success")));
  if (!pf.html) { $("#pfPreview").innerHTML = `<div class="card empty">${icon("globe", 36)}<h3>${t("pf.none")}</h3><p>${t("pf.noneSub")}</p></div>`; return; }
  const [a, b, bg] = THEMES[pf.theme];
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;800&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="${location.origin}/css/portfolio.css"><style>:root{--a:${a};--b:${b};--bg:${bg}}</style></head>
    <body><div class="pf-glow"></div><main class="pf">${pf.html}</main><script src="${location.origin}/js/portfolio.js"><\/script></body></html>`;
  $("#pfPreview").innerHTML = `<iframe class="portfolio-frame fade-up" title="${esc(t("side.portfolio"))}" sandbox="allow-scripts allow-popups"></iframe>`;
  $("#pfPreview iframe").srcdoc = doc;
}

async function savePortfolioSettings(changes) {
  try {
    Object.assign(pf, await API.put("/api/student/portfolio/settings", { theme: changes.theme ?? pf.theme, public: changes.public ?? pf.public }));
    showPortfolio();
    if ("public" in changes) toast(t(pf.public ? "pf.nowPublic" : "pf.nowPrivate"), "success");
  } catch (err) { toast(err.message, "error"); }
}

async function generatePortfolio(e) {
  await withLoading(e.currentTarget, async () => {
    try {
      const r = await API.post("/api/student/portfolio/generate");
      pf.html = r.html;
      showPortfolio();
      toast(t(r.source === "ai" ? "ai.doneAi" : "ai.doneTemplate"), "success");
    } catch (err) { toast(err.message, "error"); }
  });
}

// ------------------------------------------------------------- Start
function verifyBanner() {
  API.get("/api/auth/me").then((u) => {
    Auth.setUser({ ...Auth.user(), ...u });
    setCompletion(u.completion || 0);
    if (u.email_verified) return;
    $("#verifyBanner").innerHTML = `<div class="ai-banner warn">
      <div class="ai-icon">${icon("mail")}</div>
      <div class="grow"><strong>${t("verify.title")}</strong><div class="muted small">${t("verify.text", { email: u.email })}</div></div>
      <button class="btn btn-gold btn-sm" id="resend">${t("verify.resend")}</button></div>`;
    $("#resend").addEventListener("click", async (e) => { await API.post("/api/auth/resend-verification").catch(() => {}); e.target.disabled = true; toast(t("verify.sent"), "success"); });
  }).catch(() => {});
}

if (me) {
  initPage({ footer: false });
  const hour = new Date().getHours();
  $("#greet").innerHTML = t(hour < 12 ? "dash.morning" : hour < 18 ? "dash.afternoon" : "dash.evening", { name: `<span class="grad-text">${esc(me.name.split(" ")[0])}</span>` }, true);
  $("#greetDate").textContent = new Date().toLocaleDateString(LOCALE, { weekday: "long", day: "numeric", month: "long" });
  $("[name=city]").innerHTML += CITIES.map((c) => `<option>${c}</option>`).join("");
  $("#desiredTypes").innerHTML = JOB_TYPES.map((x) => `<label class="check-pill"><input type="checkbox" value="${x}"><span>${x}</span></label>`).join("");
  skillsTags = tagInput($("#skillsInput"), [], t("profile.skillsPh"));
  langTags = tagInput($("#langInput"), [], t("profile.langPh"));
  $$("[data-add]").forEach((b) => b.addEventListener("click", () => $(`#rep-${b.dataset.add}`).appendChild(repeaterItem(b.dataset.add))));
  $("#saveProfile").addEventListener("click", saveProfile);
  $("#cvFile").addEventListener("change", (e) => uploadCv(e.target.files[0]));
  const zone = $("#dropZone");
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => { e.preventDefault(); zone.classList.remove("over"); uploadCv(e.dataTransfer.files[0]); });
  $("#genCv").addEventListener("click", generateCv);
  $("#startMock").addEventListener("click", startMock);
  $("#genPf").addEventListener("click", generatePortfolio);
  $("#pfPublic").addEventListener("change", (e) => savePortfolioSettings({ public: e.target.checked }));
  $("#cvLang").value = LANG;
  API.get("/api/config").then((c) => $$(".aiStatus").forEach((el) => (el.textContent = t(c.ai_enabled ? "ai.on" : "ai.off")))).catch(() => {});
  verifyBanner();
  API.get("/api/student/applications").then((apps) => ($("#appCount").textContent = apps.length)).catch(() => {});
  panelRouter("overview", { overview: loadOverview, profile: loadProfile, applications: loadApplications, messages: loadInbox,
    saved: loadSaved, cv: loadCv, interview: loadInterview, portfolio: loadPortfolio });
}
