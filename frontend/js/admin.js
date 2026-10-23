/* ==========================================================================
   ADMIN.JS — the administrator dashboard (admin.html)
   Tabs: analytics · users · companies (verification) · offers · reviews
   ========================================================================== */
const me = Auth.require("admin");
const PALETTE = ["#2e9e74", "#5b8def", "#f2a33a", "#9b7ede", "#4fb8c9", "#e8836b", "#f4b183", "#e88fb4"];

// ------------------------------------------------------------ Charts
function lineChart(el, labels, series) {
  const W = 800, H = 240, P = { l: 34, r: 12, t: 14, b: 28 };
  const max = Math.max(4, ...series.flatMap((s) => s.data));
  const x = (i) => P.l + (i * (W - P.l - P.r)) / (labels.length - 1);
  const y = (v) => H - P.b - (v * (H - P.t - P.b)) / max;
  const curve = (data) => data.map((v, i) => {
    if (i === 0) return `M${x(0)},${y(v)}`;
    const cx = (x(i - 1) + x(i)) / 2;
    return `C${cx},${y(data[i - 1])} ${cx},${y(v)} ${x(i)},${y(v)}`;
  }).join(" ");
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const v = Math.round(max * f);
    return `<line class="grid-line" x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${P.l - 8}" y="${y(v) + 3}" text-anchor="end">${v}</text>`;
  }).join("");
  const xLabels = labels.map((l, i) => (i % 5 === 0 || i === labels.length - 1) ? `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${esc(l)}</text>` : "").join("");
  const paths = series.map((s, n) => `
    <defs><linearGradient id="g${n}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${s.color}" stop-opacity=".28"/><stop offset="1" stop-color="${s.color}" stop-opacity="0"/></linearGradient></defs>
    <path d="${curve(s.data)} L${x(s.data.length - 1)},${H - P.b} L${x(0)},${H - P.b} Z" fill="url(#g${n})" opacity="0" style="animation:fadeUp 1s ${0.6 + n * 0.2}s forwards"/>
    <path class="path" d="${curve(s.data)}" stroke="${s.color}" style="animation-delay:${n * 0.2}s"/>`).join("");
  el.innerHTML = `<svg class="line-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(t("adm.activity"))}" style="direction:ltr">${grid}${xLabels}${paths}</svg>`;
}

function donut(el, entries, label) {
  const total = entries.reduce((s, e) => s + e.value, 0);
  let acc = 0;
  const stops = entries.map((e) => { const a = acc; acc += (e.value / (total || 1)) * 100; return `${e.color} ${a}% ${acc}%`; }).join(",");
  el.innerHTML = `
    <div class="donut" style="background:conic-gradient(${stops || "var(--surface-2) 0 100%"})"><div class="center"><div>${fmt.format(total)}<small>${esc(label)}</small></div></div></div>
    <div class="grow" style="display:grid;gap:8px;min-width:160px">${entries.map((e) => `
      <div class="row small" style="flex-wrap:nowrap"><span style="width:10px;height:10px;border-radius:3px;background:${e.color}"></span><span class="muted grow">${esc(e.label)}</span>
        <strong>${e.value}</strong><span class="muted end" style="width:42px">${Math.round((100 * e.value) / (total || 1))}%</span></div>`).join("")}</div>`;
}

// ------------------------------------------------------------ Analytics
async function loadStats() {
  try {
    const s = await API.get("/api/admin/stats");
    const tot = s.totals;
    animateCount($("#tUsers"), tot.users);
    animateCount($("#tCompanies"), tot.companies);
    animateCount($("#tJobs"), tot.open_jobs);
    animateCount($("#tApps"), tot.applications);
    $("#tNewUsers").textContent = t("adm.thisWeek", { n: tot.new_users_week });
    $("#tVerified").textContent = t("adm.verifiedPending", { v: tot.verified_companies, p: tot.pending_verifications });
    $("#tAllJobs").textContent = t("adm.totalOffers", { n: tot.jobs });
    $("#tRate").textContent = t("adm.acceptance", { n: tot.acceptance_rate });
    $("#pendingCount").textContent = tot.pending_verifications;
    $("#aiBadge").className = `badge ${s.ai_enabled ? "badge-green" : "badge-gold"}`;
    $("#aiBadge").innerHTML = `${icon("spark", 14)} ${t(s.ai_enabled ? "adm.aiOn" : "adm.aiOff")}`;
    lineChart($("#lineChart"), s.timeline.labels, [{ data: s.timeline.users, color: "#2e9e74" }, { data: s.timeline.applications, color: "#9b7ede" }]);
    donut($("#statusDonut"), Object.keys(STATUS_COLORS).map((k) => ({ label: t("status." + k), value: s.applications_by_status[k] || 0, color: STATUS_COLORS[k] })), t("nav.applications"));
    const roleColors = { student: "#2e9e74", company: "#5b8def", admin: "#f2a33a" };
    donut($("#roleDonut"), Object.entries(s.users_by_role).map(([k, v]) => ({ label: t("role." + k), value: v, color: roleColors[k] })), t("adm.users"));
    barChart($("#typeChart"), Object.entries(s.jobs_by_type).sort((a, b) => b[1] - a[1]).map(([k, v], i) => ({ label: k, value: v, color: PALETTE[i % PALETTE.length] })));
    barChart($("#cityChart"), Object.entries(s.jobs_by_city).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: k, value: v })));
  } catch (err) { toast(err.message, "error"); }
}

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
