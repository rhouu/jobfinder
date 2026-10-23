/* ==========================================================================
   ADMIN.JS — the administrator dashboard (admin.html)
   Tabs: analytics · users · companies (verification) · offers · reviews
   ========================================================================== */
const me = Auth.require("admin");
// ------------------------------------------------------------ Charts
const dayLabel = (iso) => new Date(iso + "T00:00:00").toLocaleDateString(LOCALE, { day: "numeric", month: "short" });

// Line chart drawn at the container's real width (so the text is never stretched), with a hover tooltip
function lineChart(el, labels, series) {
  el._chart = [labels, series];
  const W = Math.max(300, el.clientWidth), H = 220, P = { l: 30, r: 10, t: 10, b: 26 };
  const step = Math.max(1, Math.ceil(Math.max(...series.flatMap((s) => s.data)) / 4)), max = step * 4;
  const x = (i) => P.l + (i * (W - P.l - P.r)) / Math.max(1, labels.length - 1);
  const y = (v) => H - P.b - (v * (H - P.t - P.b)) / max;
  const grid = [0, 1, 2, 3, 4].map((n) => `<line class="grid-line" x1="${P.l}" x2="${W - P.r}" y1="${y(n * step)}" y2="${y(n * step)}"/>
    <text x="${P.l - 8}" y="${y(n * step) + 4}" text-anchor="end">${n * step}</text>`).join("");
  const every = Math.ceil(labels.length / Math.max(2, Math.floor((W - P.l) / 70)));
  const xLabels = labels.map((l, i) => ((labels.length - 1 - i) % every === 0)
    ? `<text x="${x(i)}" y="${H - 6}" text-anchor="${i === 0 ? "start" : i === labels.length - 1 ? "end" : "middle"}">${esc(dayLabel(l))}</text>` : "").join("");
  const lines = series.map((s) => {
    const pts = s.data.map((v, i) => `${x(i)},${y(v)}`).join(" ");
    return `<polygon points="${P.l},${y(0)} ${pts} ${x(s.data.length - 1)},${y(0)}" fill="${s.color}" opacity=".08"/>
      <polyline class="path" points="${pts}" stroke="${s.color}"/>`;
  }).join("");
  const dots = series.map((s) => `<circle class="hover-dot" r="4.5" fill="${s.color}"/>`).join("");
  el.innerHTML = `<svg class="line-chart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc($("#activityTitle").textContent)}" style="direction:ltr">
      ${grid}${xLabels}${lines}<line class="crosshair" y1="${P.t}" y2="${H - P.b}"/>${dots}
      <rect class="hit" x="${P.l}" y="0" width="${W - P.l - P.r}" height="${H}" fill="transparent"/></svg>
    <div class="chart-tip" hidden></div>`;
  const svg = el.querySelector("svg"), tip = el.querySelector(".chart-tip"), cross = svg.querySelector(".crosshair");
  const show = (evt) => {
    const box = svg.getBoundingClientRect();
    const i = Math.min(labels.length - 1, Math.max(0, Math.round(((evt.clientX - box.left - P.l) / (W - P.l - P.r)) * (labels.length - 1))));
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.style.opacity = 1;
    svg.querySelectorAll(".hover-dot").forEach((d, n) => { d.setAttribute("cx", x(i)); d.setAttribute("cy", y(series[n].data[i])); d.style.opacity = 1; });
    tip.innerHTML = `<strong>${esc(dayLabel(labels[i]))}</strong>${series.map((s) => `<div><i style="background:${s.color}"></i>${esc(s.label)} <b>${s.data[i]}</b></div>`).join("")}`;
    tip.hidden = false;
    tip.style.left = (x(i) + 14 + tip.offsetWidth > W ? x(i) - 14 - tip.offsetWidth : x(i) + 14) + "px";
  };
  const hide = () => { tip.hidden = true; cross.style.opacity = 0; svg.querySelectorAll(".hover-dot").forEach((d) => (d.style.opacity = 0)); };
  const hit = svg.querySelector(".hit");
  hit.addEventListener("pointermove", show);
  hit.addEventListener("pointerleave", hide);
}
window.addEventListener("resize", debounce(() => { const el = $("#lineChart"); if (el._chart && el.offsetParent) lineChart(el, ...el._chart); }, 200));

const emptyChart = (text) => `<div class="chart-empty">${icon("chart", 28)}<p>${esc(text)}</p></div>`;

// "To do" card: only the things that need the admin's attention
function todoList(tot, aiOn) {
  const items = [
    { n: tot.pending_verifications, key: "adm.todoPending", href: "#companies", ic: "shield" },
    { n: tot.waiting_apps, key: "adm.todoWaiting", href: "#jobs", ic: "clock" },
    { n: tot.new_reviews_week, key: "adm.todoReviews", href: "#reviews", ic: "star" },
    { n: tot.unverified_emails, key: "adm.todoEmails", href: "#users", ic: "mail" },
  ].filter((i) => i.n > 0);
  $("#todoList").innerHTML = items.map((i) => `
      <a class="todo-item" href="${i.href}"><span class="todo-icon">${icon(i.ic, 16)}</span><span class="grow">${t(i.key)}</span><span class="todo-count">${i.n}</span></a>`).join("")
    + (aiOn ? "" : `<div class="todo-item"><span class="todo-icon">${icon("spark", 16)}</span><span class="grow">${t("adm.todoAi")}</span></div>`)
    || `<div class="chart-empty">${icon("check", 28)}<p>${t("adm.allGood")}</p></div>`;
}

// ------------------------------------------------------------ Analytics
let statDays = 30;

async function loadStats() {
  try {
    const s = await API.get(`/api/admin/stats?days=${statDays}`);
    const tot = s.totals;
    const delta = (el, n) => { el.textContent = t("adm.thisWeek", { n }); el.classList.toggle("up", n > 0); };
    animateCount($("#tUsers"), tot.users);
    $("#tUsersSub").textContent = t("adm.usersSplit", { s: tot.students, c: tot.company_users });
    delta($("#tUsersWeek"), tot.new_users_week);
    animateCount($("#tJobs"), tot.open_jobs);
    $("#tJobsSub").textContent = t("adm.offersSplit", { s: tot.site_jobs, e: tot.external_jobs });
    $("#tJobsType").textContent = t("adm.internships", { n: (s.jobs_by_type.Stage || 0) + (s.jobs_by_type.PFE || 0) });
    animateCount($("#tApps"), tot.applications);
    $("#tAppsSub").textContent = t("adm.acceptance", { n: tot.acceptance_rate });
    delta($("#tAppsWeek"), tot.new_apps_week);
    animateCount($("#tCompanies"), tot.companies);
    $("#tCompaniesSub").textContent = t("adm.verifiedPending", { v: tot.verified_companies, p: tot.pending_verifications });
    $("#tDirectory").textContent = t("adm.inDirectory", { d: fmt.format(tot.directory), e: tot.external_companies });
    $("#pendingCount").textContent = tot.pending_verifications;
    $("#aiBadge").className = `badge ${s.ai_enabled ? "badge-green" : "badge-gold"}`;
    $("#aiBadge").innerHTML = `${icon("spark", 14)} ${t(s.ai_enabled ? "adm.aiOn" : "adm.aiOff")}`;

    $("#activityTitle").textContent = t("adm.activityRange", { n: statDays });
    $("#sumUsers").textContent = s.timeline.users.reduce((a, b) => a + b, 0);
    $("#sumApps").textContent = s.timeline.applications.reduce((a, b) => a + b, 0);
    const css = getComputedStyle(document.documentElement);
    lineChart($("#lineChart"), s.timeline.labels, [
      { label: t("adm.newUsers"), data: s.timeline.users, color: css.getPropertyValue("--series-1").trim() },
      { label: t("nav.applications"), data: s.timeline.applications, color: css.getPropertyValue("--series-2").trim() }]);
    todoList(tot, s.ai_enabled);

    if (tot.applications) barChart($("#statusChart"), Object.keys(STATUS_COLORS).map((k) => ({ label: t("status." + k), value: s.applications_by_status[k] || 0, color: STATUS_COLORS[k] })));
    else $("#statusChart").innerHTML = emptyChart(t("adm.noApps"));
    const sorted = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]);
    barChart($("#sectorChart"), sorted(s.jobs_by_sector).map(([k, v]) => ({ label: sectorLabel(k || "services"), value: v })));
    barChart($("#cityChart"), sorted(s.jobs_by_city).slice(0, 8).map(([k, v]) => ({ label: k, value: v })));
    $("#recentUsers").innerHTML = s.recent_users.map((u) => `
      <div class="recent-user">${avatar(u)}<div class="grow" style="min-width:0"><strong class="ellipsis">${esc(u.name)}</strong><div class="muted small ellipsis">${esc(u.email)}</div></div>
        <div class="end"><span class="badge ${ROLE_BADGE[u.role]}">${t("role." + u.role)}</span><div class="muted small">${timeAgo(u.created_at)}</div></div></div>`).join("");
  } catch (err) { toast(err.message, "error"); }
}

$$("#rangeSwitch button").forEach((b) => b.addEventListener("click", () => {
  $$("#rangeSwitch button").forEach((x) => x.classList.toggle("active", x === b));
  statDays = +b.dataset.days;
  loadStats();
}));

// ---------------------------------------------------------------- Users
const ROLE_BADGE = { student: "badge-green", company: "badge-blue", admin: "badge-gold" };

async function loadUsers() {
  try {
    const users = await API.get(`/api/admin/users?${new URLSearchParams({ q: $("#userQ").value.trim(), role: $("#userRole").value })}`);
    $("#usersTable").innerHTML = users.map((u) => `
      <tr>
        <td><div class="cell-user">${avatar(u)}<div><strong>${esc(u.name)}</strong><div class="muted small">${esc(u.email)} ${u.email_verified ? icon("check", 12) : ""}</div></div></div></td>
        <td><span class="badge ${ROLE_BADGE[u.role]}">${t("role." + u.role)}</span></td>
        <td>${u.google ? "Google" : "Email"}</td><td>${dateStr(u.created_at)}</td>
        <td>${u.is_active ? `<span class="badge badge-green">${t("adm.active")}</span>` : `<span class="badge badge-red">${t("adm.suspended")}</span>`}</td>
        <td><div class="actions">${u.id === me.id ? `<span class="muted">${t("adm.you")}</span>` : `
          <button class="btn btn-ghost btn-sm" data-toggle="${u.id}" data-active="${u.is_active}">${t(u.is_active ? "adm.suspend" : "adm.reactivate")}</button>
          <button class="btn btn-danger btn-sm" data-del="${u.id}">${icon("trash", 14)}</button>`}</div></td>
      </tr>`).join("") || `<tr><td colspan="6" class="empty">${t("adm.noResults")}</td></tr>`;
    $$("#usersTable [data-toggle]").forEach((b) => b.addEventListener("click", async () => {
      try { await API.put(`/api/admin/users/${b.dataset.toggle}`, { is_active: b.dataset.active !== "true" }); loadUsers(); } catch (err) { toast(err.message, "error"); }
    }));
    $$("#usersTable [data-del]").forEach((b) => b.addEventListener("click", async () => {
      if (!(await confirmDialog(t("adm.deleteUser"), t("common.delete")))) return;
      try { await API.del(`/api/admin/users/${b.dataset.del}`); toast(t("adm.deleted"), "success"); loadUsers(); } catch (err) { toast(err.message, "error"); }
    }));
  } catch (err) { toast(err.message, "error"); }
}

// ------------------------------------------------------------ Companies
const CO_BADGE = { verified: "badge-green", pending: "badge-gold", unverified: "", rejected: "badge-red" };

async function loadCompanies() {
  try {
    const list = await API.get(`/api/admin/companies?status=${$("#coStatus").value}`);
    $("#coTable").innerHTML = list.map((c) => `
      <tr>
        <td><div class="cell-user">${companyLogo(c, "sm")}<div><strong>${esc(c.name)}</strong><div class="muted small">${esc(c.sector)} · ${esc(c.city)}</div></div></div></td>
        <td class="muted">${esc(c.owner_email || "—")}</td>
        <td><div style="font-family:monospace;font-size:.82rem">${esc(c.ice || "—")}</div><div class="muted small">RC ${esc(c.rc || "—")}</div></td>
        <td>${c.jobs}</td><td>${c.external ? `<span class="badge badge-blue">${t("adm.external")}</span>` : `<span class="badge ${CO_BADGE[c.verification_status]}">${t("verif." + c.verification_status)}</span>`}</td>
        <td><div class="actions">${c.external ? "" : `
          ${c.verification_status !== "verified" ? `<button class="btn btn-primary btn-sm" data-verify="${c.id}" data-status="verified">${t("adm.approve")}</button>` : ""}
          ${c.verification_status !== "rejected" ? `<button class="btn btn-danger btn-sm" data-verify="${c.id}" data-status="rejected">${t("adm.reject")}</button>` : ""}
          ${c.verification_status !== "unverified" ? `<button class="btn btn-ghost btn-sm" data-verify="${c.id}" data-status="unverified">${t("adm.reset")}</button>` : ""}`}
        </div></td>
      </tr>`).join("") || `<tr><td colspan="6"><div class="empty">${icon("check", 36)}<p>${t("adm.nothing")}</p></div></td></tr>`;
    $$("#coTable [data-verify]").forEach((b) => b.addEventListener("click", async () => {
      const status = b.dataset.status;
      if (status === "rejected" && !(await confirmDialog(t("adm.rejectConfirm"), t("adm.reject")))) return;
      try {
        await API.put(`/api/admin/companies/${b.dataset.verify}/verify`, { status });
        toast(t("verif." + status), "success");
        loadCompanies();
        API.get("/api/admin/stats").then((s) => ($("#pendingCount").textContent = s.totals.pending_verifications));
      } catch (err) { toast(err.message, "error"); }
    }));
  } catch (err) { toast(err.message, "error"); }
}

// ----------------------------------------------------------------- Offers
async function loadJobs() {
  try {
    const list = await API.get(`/api/admin/jobs?q=${encodeURIComponent($("#jobQ").value.trim())}`);
    $("#jobsTable").innerHTML = list.map((j) => `
      <tr>
        <td><a href="/job.html?id=${j.id}" target="_blank"><strong>${esc(j.title)}</strong></a><div class="muted small">${esc(j.city)} · ${timeAgo(j.created_at)}</div></td>
        <td>${esc(j.company.name)} ${j.company.verified ? verifiedMark() : ""}</td><td>${typeBadge(j.type)}</td><td>${j.applicants}</td>
        <td>${j.status === "open" ? `<span class="badge badge-green">${t("co.open")}</span>` : `<span class="badge">${t("co.closed")}</span>`}</td>
        <td><div class="actions"><button class="btn btn-ghost btn-sm" data-status="${j.id}" data-to="${j.status === "open" ? "closed" : "open"}">${t(j.status === "open" ? "adm.close" : "adm.reopen")}</button>
          <button class="btn btn-danger btn-sm" data-del="${j.id}">${icon("trash", 14)}</button></div></td>
      </tr>`).join("") || `<tr><td colspan="6" class="empty">${t("adm.noResults")}</td></tr>`;
    $$("#jobsTable [data-status]").forEach((b) => b.addEventListener("click", async () => {
      try { await API.put(`/api/admin/jobs/${b.dataset.status}`, { status: b.dataset.to }); loadJobs(); } catch (err) { toast(err.message, "error"); }
    }));
    $$("#jobsTable [data-del]").forEach((b) => b.addEventListener("click", async () => {
      if (!(await confirmDialog(t("co.deleteConfirm"), t("common.delete")))) return;
      try { await API.del(`/api/admin/jobs/${b.dataset.del}`); toast(t("co.deleted"), "success"); loadJobs(); } catch (err) { toast(err.message, "error"); }
    }));
  } catch (err) { toast(err.message, "error"); }
}

// ---------------------------------------------------------------- Reviews
async function loadReviews() {
  try {
    const list = await API.get("/api/admin/reviews");
    $("#reviewsTable").innerHTML = list.map((r) => `
      <tr><td><strong>${esc(r.company)}</strong></td><td>${stars(r.rating)}</td>
        <td><strong>${esc(r.title)}</strong><div class="muted small" style="max-width:420px">${esc(r.body)}</div></td>
        <td class="muted small">${esc(r.author)}<br>${esc(r.student_email)}</td>
        <td><div class="actions"><button class="btn btn-danger btn-sm" data-del="${r.id}">${icon("trash", 14)}</button></div></td></tr>`).join("")
      || `<tr><td colspan="5" class="empty">${t("reviews.none")}</td></tr>`;
    $$("#reviewsTable [data-del]").forEach((b) => b.addEventListener("click", async () => {
      if (!(await confirmDialog(t("adm.deleteReview"), t("common.delete")))) return;
      try { await API.del(`/api/admin/reviews/${b.dataset.del}`); loadReviews(); } catch (err) { toast(err.message, "error"); }
    }));
  } catch (err) { toast(err.message, "error"); }
}

// ----------------------------------------------------------------- Start
if (me) {
  initPage({ footer: false });
  $("#userQ").addEventListener("input", debounce(loadUsers));
  $("#userRole").addEventListener("change", loadUsers);
  $("#coStatus").addEventListener("change", loadCompanies);
  $("#jobQ").addEventListener("input", debounce(loadJobs));
  panelRouter("analytics", { analytics: loadStats, users: loadUsers, companies: loadCompanies, jobs: loadJobs, reviews: loadReviews });
}
