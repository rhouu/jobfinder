/* ==========================================================================
   COMPANY.JS — the company dashboard (company.html)
   Tabs: overview · offers · applicants (drag & drop pipeline) · messages · company profile
   ========================================================================== */
const me = Auth.require("company");
let company = null;
let jobs = [];
let applicants = [];

// ------------------------------------------------------------ Verification
const VERIFY_BADGE = { verified: "badge-green", pending: "badge-gold", unverified: "", rejected: "badge-red" };

function renderVerification() {
  const s = company.verification_status;
  const label = t("verif." + s), text = t("verif." + s + "Text");
  $("#verifyCard").innerHTML = `<strong>${t("verif.title")}</strong><div style="margin:8px 0"><span class="badge ${VERIFY_BADGE[s]}">${label}</span></div><span class="muted">${text}</span>`;
  $("#verifyBanner").innerHTML = company.verified ? "" : `
    <div class="ai-banner warn">
      <div class="ai-icon">${icon("shield")}</div>
      <div class="grow"><strong>${label}</strong><div class="muted small">${text}</div></div>
      ${s === "unverified" ? `<a class="btn btn-gold btn-sm" href="#profile">${t("verif.now")}</a>` : ""}</div>`;
  const canSubmit = s === "unverified" || s === "rejected";
  $("#verifyBox").innerHTML = `
    <div class="card-title"><h3>${t("verif.title")}</h3><span class="badge ${VERIFY_BADGE[s]}">${label}</span></div>
    <p class="muted small" style="margin-bottom:16px">${text}</p>
    ${canSubmit ? `<form id="verifyForm" class="form-grid" style="grid-template-columns:1fr">
        <div class="field"><label>${t("verif.ice")}</label><input class="input" name="ice" inputmode="numeric" maxlength="15" value="${esc(company.ice || "")}"></div>
        <div class="field"><label>${t("verif.rc")}</label><input class="input" name="rc" value="${esc(company.rc || "")}"></div>
        <button class="btn btn-gold" type="submit">${t("verif.submit")}</button></form>`
      : `<div class="list-row"><span class="muted">ICE</span><strong style="margin-inline-start:auto">${esc(company.ice)}</strong></div><div class="list-row"><span class="muted">RC</span><strong style="margin-inline-start:auto">${esc(company.rc)}</strong></div>`}`;
  $("#verifyForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    if (!/^\d{15}$/.test(f.ice)) return toast(t("verif.iceInvalid"), "error");
    withLoading($("button", e.target), async () => {
      try { company = await API.post("/api/company/verify", f); renderVerification(); toast(t("verif.sent"), "success"); }
      catch (err) { toast(err.message, "error"); }
    });
  });
}

// ------------------------------------------------------------ Overview
async function loadOverview() {
  try {
    const o = await API.get("/api/company/overview");
    company = o.company;
    $("#coName").innerHTML = `${esc(company.name)} ${company.verified ? verifiedMark() : ""}`;
    $("#coLogo").innerHTML = companyLogo(company, "lg");
    $("#coRating").innerHTML = company.rating.count ? `${stars(company.rating.avg)} <strong>${company.rating.avg}</strong> <span class="muted">· ${t("reviews.count", { n: company.rating.count })}</span>` : "";
    renderVerification();
    animateCount($("#kOpen"), o.open_jobs);
    animateCount($("#kApps"), o.applications);
    animateCount($("#kViews"), o.views);
    animateCount($("#kMatch"), o.avg_match);
    barChart($("#funnel"), Object.entries(o.by_status).map(([k, v]) => ({ label: t("status." + k), value: v, color: STATUS_COLORS[k] })));
    $("#recentApps").innerHTML = o.recent.length ? o.recent.map((a) => `
      <div class="list-row">${avatar(a.student)}<div class="grow"><div class="title">${esc(a.student.name)}</div><div class="sub">${esc(a.job_title)} · ${timeAgo(a.created_at)}</div></div>
      ${statusBadge(a.status)}${ring(Math.round(a.match_score))}</div>`).join("") : `<div class="empty">${t("co.noApps")}</div>`;
    $("#coInterviews").innerHTML = o.interviews.length ? o.interviews.map((iv) => `
      <div class="list-row"><span class="notif-icon">${icon("calendar", 16)}</span><div class="grow"><div class="title">${esc(iv.name)}</div>
        <div class="sub">${dateTimeStr(iv.at)} · ${t("iv.mode." + iv.mode)}</div></div><a class="btn btn-ghost btn-sm" href="#messages/${iv.application_id}">${icon("chat", 14)}</a></div>`).join("")
      : `<p class="muted small">${t("co.noInterviews")}</p>`;
    animateRings($("#recentApps"));
  } catch (err) { toast(err.message, "error"); }
}

// ---------------------------------------------------------------- Offer stats
async function openJobStats(id) {
  let s;
  try { s = await API.get(`/api/company/jobs/${id}/stats`); } catch (err) { return toast(err.message, "error"); }
  const max = Math.max(1, ...s.per_day.map((d) => d.views));
  const dayName = (d) => new Date(d + "T12:00:00Z").toLocaleDateString(LOCALE, { day: "numeric", month: "short" });
  const tile = (label, value, suffix = "") => `<div class="stat-tile"><span class="muted small">${label}</span><strong>${fmt.format(value)}${suffix}</strong></div>`;
  const recent = s.per_day.reduce((n, d) => n + d.views, 0);
  modal({
    title: t("st.title", { job: s.title }),
    wide: true,
    body: `
      <div class="stat-tiles">
        ${tile(t("st.views"), s.views)}${tile(t("st.apps"), s.applications)}${tile(t("st.conv"), s.conversion, "%")}${tile(t("st.saves"), s.saves)}
      </div>
      <h4 class="stat-h">${t("st.perDay", { n: s.per_day.length })}</h4>
      <p class="muted small" id="dayReadout" aria-live="polite">${recent ? t("st.hover") : t("st.noViews")}</p>
      <div class="day-chart" role="img" aria-label="${esc(t("st.perDay", { n: s.per_day.length }))}">
        ${s.per_day.map((d) => `<div class="day-col" tabindex="0" data-label="${esc(t("st.dayViews", { day: dayName(d.day), n: d.views }))}">
          <div class="day-bar ${d.views ? "" : "zero"}" style="--h:${(100 * d.views) / max}%"></div></div>`).join("")}
      </div>
      <div class="day-axis muted small"><span>${dayName(s.per_day[0].day)}</span><span>${dayName(s.per_day[s.per_day.length - 1].day)}</span></div>
      <table class="sr-only"><tbody>${s.per_day.map((d) => `<tr><th>${d.day}</th><td>${d.views}</td></tr>`).join("")}</tbody></table>
      <h4 class="stat-h">${t("st.pipeline")}</h4>
      <div id="statFunnel"></div>
      <p class="muted small" style="margin-top:14px">${s.applications ? t("st.avgMatch", { n: s.avg_match }) : t("st.noApps")}</p>`,
    onOpen: (el) => {
      barChart($("#statFunnel", el), Object.entries(s.by_status).map(([k, v]) => ({ label: t("status." + k), value: v, color: STATUS_COLORS[k] })));
      const readout = $("#dayReadout", el), idle = readout.textContent;
      $$(".day-col", el).forEach((c) => {
        const show = () => { readout.textContent = c.dataset.label; };
        c.addEventListener("mouseenter", show);
        c.addEventListener("focus", show);
        c.addEventListener("mouseleave", () => { readout.textContent = idle; });
        c.addEventListener("blur", () => { readout.textContent = idle; });
      });
    },
  });
}

// ---------------------------------------------------------------- Offers
async function loadJobs() {
  try {
    jobs = await API.get("/api/company/jobs");
    $("#jobsTable").innerHTML = jobs.length ? jobs.map((j) => `
      <tr>
        <td><strong>${esc(j.title)}</strong><div class="muted small">${timeAgo(j.created_at)}</div></td>
        <td>${typeBadge(j.type)}</td><td>${esc(j.city)}</td>
        <td><button class="btn btn-ghost btn-sm" data-applicants="${j.id}">${icon("users", 14)} ${j.applicants}</button></td>
        <td>${j.views}</td>
        <td><label class="row" style="cursor:pointer;flex-wrap:nowrap"><span class="switch"><input type="checkbox" data-toggle="${j.id}" ${j.status === "open" ? "checked" : ""}><span></span></span><span class="muted small">${t(j.status === "open" ? "co.open" : "co.closed")}</span></label></td>
        <td><div class="actions"><button class="btn btn-ghost btn-sm" data-stats="${j.id}" aria-label="${esc(t("st.open"))}" title="${esc(t("st.open"))}">${icon("chart", 14)}</button>
          <a class="btn btn-ghost btn-sm" href="/job.html?id=${j.id}" target="_blank">${icon("eye", 14)}</a>
          <button class="btn btn-ghost btn-sm" data-edit="${j.id}">${icon("edit", 14)}</button><button class="btn btn-danger btn-sm" data-del="${j.id}">${icon("trash", 14)}</button></div></td>
      </tr>`).join("") : `<tr><td colspan="7"><div class="empty">${icon("briefcase", 36)}<h3>${t("co.noOffers")}</h3></div></td></tr>`;
    $$("[data-edit]").forEach((b) => b.addEventListener("click", () => openJobForm(jobs.find((j) => j.id === +b.dataset.edit))));
    $$("[data-stats]").forEach((b) => b.addEventListener("click", () => openJobStats(+b.dataset.stats)));
    $$("[data-applicants]").forEach((b) => b.addEventListener("click", () => { $("#jobFilter").value = b.dataset.applicants; location.hash = "applicants"; }));
    $$("[data-del]").forEach((b) => b.addEventListener("click", async () => {
      if (!(await confirmDialog(t("co.deleteConfirm"), t("common.delete")))) return;
      try { await API.del(`/api/company/jobs/${b.dataset.del}`); toast(t("co.deleted"), "success"); loadJobs(); } catch (err) { toast(err.message, "error"); }
    }));
    $$("[data-toggle]").forEach((box) => box.addEventListener("change", async () => {
      const j = jobs.find((x) => x.id === +box.dataset.toggle);
      try { await API.put(`/api/company/jobs/${j.id}`, { ...j, status: box.checked ? "open" : "closed" }); loadJobs(); }
      catch (err) { toast(err.message, "error"); box.checked = !box.checked; }
    }));
  } catch (err) { toast(err.message, "error"); }
}

function openJobForm(job = null) {
  const j = job || { type: "Stage", work_mode: "On-site", city: company?.city || "Casablanca", skills: [] };
  let skills;
  const opts = (values, current, label = (v) => v) => values.map((v) => `<option value="${v}" ${v === current ? "selected" : ""}>${label(v)}</option>`).join("");
  modal({
    title: t(job ? "co.editOffer" : "co.publish"), wide: true,
    body: `<form id="jobForm" class="form-grid" onsubmit="return false">
      <div class="field full"><label>${t("co.offerTitle")}</label><input class="input" name="title" value="${esc(j.title || "")}"></div>
      <div class="field"><label>${t("jobs.type")}</label><select class="select" name="type">${opts(JOB_TYPES, j.type)}</select></div>
      <div class="field"><label>${t("jobs.mode")}</label><select class="select" name="work_mode">${opts(["On-site", "Hybrid", "Remote"], j.work_mode, modeLabel)}</select></div>
      <div class="field"><label>${t("jobs.city")}</label><select class="select" name="city">${opts(CITIES, j.city)}</select></div>
      <div class="field"><label>${t("jobs.level")}</label><select class="select" name="level">${opts(["", "Bac+2", "Bac+3", "Bac+5"], j.level || "", (v) => v || t("jobs.anyLevel"))}</select></div>
      <div class="field"><label>${t("co.salaryMin")}</label><input class="input" name="salary_min" type="number" min="0" value="${j.salary_min ?? ""}"></div>
      <div class="field"><label>${t("co.salaryMax")}</label><input class="input" name="salary_max" type="number" min="0" value="${j.salary_max ?? ""}"></div>
      <div class="field"><label>${t("job.duration")}</label><input class="input" name="duration" value="${esc(j.duration || "")}"></div>
      <div class="field"><label>${t("job.deadline")}</label><input class="input" name="deadline" type="date" value="${j.deadline ? j.deadline.slice(0, 10) : ""}"></div>
      <div class="field full"><label>${t("job.skills")}</label><div id="jobSkills"></div></div>
      <div class="field full"><label>${t("co.descriptionLabel")}</label><textarea class="textarea" name="description" rows="5">${esc(j.description || "")}</textarea></div>
      <div class="field full"><label>${t("job.requirements")}</label><textarea class="textarea" name="requirements" rows="4">${esc(j.requirements || "")}</textarea></div></form>`,
    footer: `<button class="btn btn-ghost" data-close>${t("common.cancel")}</button><button class="btn btn-primary" id="saveJob">${t(job ? "profile.save" : "co.publish")}</button>`,
    onOpen: (el, close) => {
      skills = tagInput($("#jobSkills", el), j.skills, t("profile.skillsPh"));
      $("#saveJob", el).addEventListener("click", (e) => {
        const f = Object.fromEntries(new FormData($("#jobForm", el)));
        if (f.title.trim().length < 3) return toast(t("co.needTitle"), "error");
        if (f.description.trim().length < 20) return toast(t("co.needDescription"), "error");
        const body = { ...f, skills: skills.get(), status: job ? job.status : "open", salary_min: f.salary_min ? +f.salary_min : null,
          salary_max: f.salary_max ? +f.salary_max : null, deadline: f.deadline ? `${f.deadline}T23:59:00` : null };
        withLoading(e.currentTarget, async () => {
          try {
            await (job ? API.put(`/api/company/jobs/${job.id}`, body) : API.post("/api/company/jobs", body));
            close();
            toast(t(job ? "co.updated" : "co.published"), "success");
            if (location.hash === "#jobs") loadJobs(); else location.hash = "jobs";
          } catch (err) { toast(err.message, "error"); }
        });
      });
    },
  });
}

// ------------------------------------------------------------ Applicants
async function loadPipeline() {
  const board = $("#pipeline");
  if ($("#jobFilter").options.length === 1) {
    const selected = $("#jobFilter").value;
    const list = await API.get("/api/company/jobs").catch(() => []);
    $("#jobFilter").innerHTML += list.map((j) => `<option value="${j.id}">${esc(j.title)}</option>`).join("");
    $("#jobFilter").value = selected;
  }
  board.innerHTML = '<div class="skeleton" style="height:300px;grid-column:1/-1"></div>';
  try {
    const id = $("#jobFilter").value;
    applicants = await API.get(`/api/company/applicants${id ? `?job_id=${id}` : ""}`);
    board.innerHTML = Object.keys(STATUS_COLORS).map((key) => {
      const items = applicants.filter((a) => a.status === key);
      return `<div class="k-col" data-status="${key}"><div class="k-col-head"><span class="dot" style="background:${STATUS_COLORS[key]}"></span>${t("status." + key)}<span class="count">${items.length}</span></div>
        ${items.map((a) => `<div class="k-card" draggable="true" data-app="${a.id}">
          <div class="row" style="margin-bottom:8px;flex-wrap:nowrap">${avatar(a.student)}<div class="grow"><div class="t" style="margin:0">${esc(a.student.name)}</div><div class="s ellipsis">${esc(a.student.school || a.student.field || "")}</div></div>${ring(a.match.score)}</div>
          <div class="s">${esc(a.job.title)}</div><div class="s">${timeAgo(a.created_at)}${a.messages ? ` · ${icon("chat", 12)} ${a.messages}` : ""}</div>
          ${a.interview ? `<div class="s" style="color:#a78bfa">${icon("calendar", 12)} ${dateTimeStr(a.interview.at)}</div>` : ""}
        </div>`).join("")}</div>`;
    }).join("");
    animateRings(board);
    enableDragAndDrop(board);
    $$("[data-app]", board).forEach((c) => c.addEventListener("click", () => openCandidate(applicants.find((a) => a.id === +c.dataset.app))));
  } catch (err) { board.innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
}

function enableDragAndDrop(board) {
  let dragged = null;
  $$(".k-card", board).forEach((card) => {
    card.addEventListener("dragstart", () => { dragged = card; card.classList.add("dragging"); });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
  });
  $$(".k-col", board).forEach((col) => {
    col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("drag-over"); });
    col.addEventListener("dragleave", () => col.classList.remove("drag-over"));
    col.addEventListener("drop", async (e) => {
      e.preventDefault();
      col.classList.remove("drag-over");
      const a = dragged && applicants.find((x) => x.id === +dragged.dataset.app);
      if (!a || a.status === col.dataset.status) return;
      col.appendChild(dragged);
      try { await API.put(`/api/company/applicants/${a.id}`, { status: col.dataset.status }); toast(`${a.student.name} → ${t("status." + col.dataset.status)}`, "success"); }
      catch (err) { toast(err.message, "error"); }
      loadPipeline();
    });
  });
}

function openCandidate(a) {
  const s = a.student, links = s.links || {};
  modal({
    title: s.name, wide: true,
    body: `
      <div class="row" style="gap:16px;margin-bottom:20px">${avatar(s, "lg")}
        <div class="grow"><div class="muted">${esc(s.headline || "")}</div><div class="muted small">${[s.level, s.school, s.city].filter(Boolean).map(esc).join(" · ")}</div>
          <a href="mailto:${esc(s.email)}" class="small grad-text">${esc(s.email)}</a></div>${ring(a.match.score, "lg")}</div>
      <div class="info-item" style="margin-bottom:18px"><small>${t("co.appliedFor")}</small><div>${esc(a.job.title)}</div></div>
      <h4 style="margin-bottom:8px">${t("job.skills")}</h4>
      <div class="chips" style="margin-bottom:10px">${(s.skills || []).map((k) => `<span class="chip ${a.match.matched.includes(k) ? "ok" : ""}">${esc(k)}</span>`).join("") || "—"}</div>
      ${a.match.missing.length ? `<p class="muted small" style="margin-bottom:18px">${t("co.missing")}: ${a.match.missing.map(esc).join(", ")}</p>` : ""}
      ${s.bio ? `<p class="muted" style="margin-bottom:18px">${esc(s.bio)}</p>` : ""}
      ${a.cover_letter ? `<h4 style="margin-bottom:8px">${t("co.coverLetter")}</h4><div class="card" style="padding:16px;margin-bottom:18px;white-space:pre-line;font-size:.92rem">${esc(a.cover_letter)}</div>` : ""}
      <div class="row" style="margin-bottom:18px">
        ${s.has_cv ? `<button class="btn btn-ghost btn-sm" id="viewCv">${icon("file", 14)} CV</button>` : ""}
        ${s.portfolio_url ? `<a class="btn btn-ghost btn-sm" href="${esc(s.portfolio_url)}" target="_blank">${icon("globe", 14)} ${t("side.portfolio")}</a>` : ""}
        ${links.linkedin ? `<a class="btn btn-ghost btn-sm" href="${esc(links.linkedin)}" target="_blank" rel="noopener">LinkedIn</a>` : ""}
        ${links.github ? `<a class="btn btn-ghost btn-sm" href="${esc(links.github)}" target="_blank" rel="noopener">GitHub</a>` : ""}
        <a class="btn btn-ghost btn-sm" href="#messages/${a.id}" data-close>${icon("chat", 14)} ${t("co.sendMessage")}</a>
        <button class="btn btn-ghost btn-sm" id="planIv">${icon("calendar", 14)} ${t(a.interview ? "iv.change" : "iv.plan")}</button>
      </div>
      ${a.interview ? `<div class="interview-card">${icon("calendar", 20)}<div><strong>${dateTimeStr(a.interview.at)}</strong><div class="small">${t("iv.mode." + a.interview.mode)} ${a.interview.location ? "· " + esc(a.interview.location) : ""}</div></div></div>` : ""}
      <div class="form-grid">
        <div class="field"><label>${t("co.status")}</label><select class="select" id="candStatus">${Object.keys(STATUS_COLORS).map((k) => `<option value="${k}" ${k === a.status ? "selected" : ""}>${t("status." + k)}</option>`).join("")}</select></div>
        <div class="field full"><label>${t("co.notes")}</label><textarea class="textarea" id="candNotes" rows="3">${esc(a.notes || "")}</textarea></div>
      </div>`,
    footer: `<button class="btn btn-ghost" data-close>${t("common.close")}</button><button class="btn btn-primary" id="saveCand">${t("profile.save")}</button>`,
    onOpen: (el, close) => {
      animateRings(el);
      $("#viewCv", el)?.addEventListener("click", async () => {
        try { const cv = await API.get(`/api/company/applicants/${a.id}/cv`); modal({ title: `CV — ${cv.name}`, wide: true, body: `<div class="cv-paper">${cv.html}</div>` }); }
        catch (err) { toast(err.message, "error"); }
      });
      $("#planIv", el).addEventListener("click", () => { close(); planInterview(a); });
      $("#saveCand", el).addEventListener("click", (e) => withLoading(e.currentTarget, async () => {
        try {
          await API.put(`/api/company/applicants/${a.id}`, { status: $("#candStatus", el).value, notes: $("#candNotes", el).value });
          close(); toast(t("co.candidateSaved"), "success"); loadPipeline();
        } catch (err) { toast(err.message, "error"); }
      }));
    },
  });
}

function planInterview(a) {
  const iv = a.interview || {};
  const d = iv.at ? new Date(iv.at) : null; // the date input wants local time, not UTC
  const local = d ? new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "";
  modal({
    title: `${t("iv.plan")} — ${a.student.name}`,
    body: `<form id="ivForm" class="form-grid">
      <div class="field"><label>${t("iv.when")}</label><input class="input" type="datetime-local" name="at" value="${local}" required></div>
      <div class="field"><label>${t("iv.type")}</label><select class="select" name="mode">${["Online", "On-site", "Phone"].map((m) => `<option value="${m}" ${m === iv.mode ? "selected" : ""}>${t("iv.mode." + m)}</option>`).join("")}</select></div>
      <div class="field full"><label>${t("iv.where")}</label><input class="input" name="location" value="${esc(iv.location || "")}" placeholder="https://meet… / ${esc(company?.city || "")}"></div>
      <div class="field full"><label>${t("iv.note")}</label><textarea class="textarea" name="note" rows="3">${esc(iv.note || "")}</textarea></div></form>
      <p class="muted small" style="margin-top:10px">${t("iv.info")}</p>`,
    footer: `<button class="btn btn-ghost" data-close>${t("common.cancel")}</button><button class="btn btn-primary" id="sendIv">${t("iv.send")}</button>`,
    onOpen: (el, close) => $("#sendIv", el).addEventListener("click", (e) => {
      const f = Object.fromEntries(new FormData($("#ivForm", el)));
      if (!f.at) return toast(t("iv.needDate"), "error");
      withLoading(e.currentTarget, async () => {
        try {
          // Send the time as UTC so everyone sees it in their own time zone
          await API.put(`/api/company/applicants/${a.id}/interview`, { ...f, at: new Date(f.at).toISOString() });
          close(); toast(t("iv.sent"), "success"); loadPipeline();
        } catch (err) { toast(err.message, "error"); }
      });
    }),
  });
}

// ------------------------------------------------------------- Profile
/** Logo card: preview, upload (PNG/JPG/WebP, max 300 KB) and remove. */
function renderLogo() {
  $("#logoBox").innerHTML = `
    <div class="card-title"><h3>${t("logo.title")}</h3></div>
    <div class="row" style="gap:16px;flex-wrap:nowrap">${companyLogo(company, "lg")}
      <div class="grow"><p class="muted small" style="margin-bottom:10px">${t("logo.sub")}</p>
        <label class="btn btn-ghost btn-sm">${icon("upload", 14)} ${t("logo.upload")}<input type="file" id="logoFile" accept="image/png,image/jpeg,image/webp" hidden></label>
        ${company.logo_url ? `<button class="btn btn-danger btn-sm" id="logoRemove">${icon("trash", 14)} ${t("logo.remove")}</button>` : ""}</div></div>`;
  $("#logoFile").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 300 * 1024) return toast(t("logo.invalid"), "error");
    const reader = new FileReader();
    reader.onload = async () => {
      try { company = await API.post("/api/company/logo", { image_base64: reader.result }); renderLogo(); toast(t("logo.saved"), "success"); }
      catch (err) { toast(err.message, "error"); }
    };
    reader.readAsDataURL(file);
  });
  $("#logoRemove")?.addEventListener("click", async () => {
    try { company = await API.del("/api/company/logo"); renderLogo(); toast(t("logo.removed"), "success"); } catch (err) { toast(err.message, "error"); }
  });
}

async function loadProfile() {
  try {
    company = await API.get("/api/company/profile");
    const f = $("#coForm");
    ["name", "sector", "city", "size", "website", "description", "logo_color"].forEach((k) => (f[k].value = company[k] || ""));
    renderVerification();
    renderLogo();
    const r = await API.get(`/api/companies/${company.id}/reviews`);
    $("#reviewsBox").innerHTML = `<div class="card-title"><h3>${t("reviews.title")}</h3>${r.rating.count ? `<span>${stars(r.rating.avg)} <strong>${r.rating.avg}</strong></span>` : ""}</div>
      ${r.reviews.length ? r.reviews.map((x) => `<div class="review">${stars(x.rating)}<h4>${esc(x.title)}</h4><p>${esc(x.body)}</p><div class="muted small">${esc(x.author)} · ${esc(x.role)}</div></div>`).join("") : `<p class="muted small">${t("reviews.none")}</p>`}`;
  } catch (err) { toast(err.message, "error"); }
}

function saveCompany(e) {
  const f = Object.fromEntries(new FormData($("#coForm")));
  if ((f.name || "").trim().length < 2) return toast(t("co.needName"), "error");
  withLoading(e.currentTarget, async () => {
    try { company = await API.put("/api/company/profile", f); toast(t("co.profileSaved"), "success"); } catch (err) { toast(err.message, "error"); }
  });
}

// ------------------------------------------------------------- Start
if (me) {
  initPage({ footer: false });
  $("[name=city]").innerHTML += CITIES.map((c) => `<option>${c}</option>`).join("");
  $$("[data-new-job]").forEach((b) => b.addEventListener("click", () => openJobForm()));
  $("#saveCo").addEventListener("click", saveCompany);
  $("#jobFilter").addEventListener("change", loadPipeline);
  API.get("/api/company/profile").then((c) => { company = c; renderVerification(); }).catch(() => {});
  panelRouter("overview", { overview: loadOverview, jobs: loadJobs, applicants: loadPipeline, messages: loadInbox, profile: loadProfile });
}
