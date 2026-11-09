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
    const r = s.offers_refresh;
    // Jooble per search word: number of offers, or the error it sent back
    const jooble = Object.entries(r.report?.jooble || {}).map(([k, v]) => `${k}: ${v}`).join(", ");
    $("#refreshInfo").textContent = [!r.jooble ? t("adm.refreshRemoteOnly") : "", r.last ? t("adm.refreshLast", { when: timeAgo(r.last + "Z") }) : "",
      jooble ? `Jooble — ${jooble}` : "", r.report?.remotive != null ? `Remotive — ${r.report.remotive}` : ""].filter(Boolean).join(" · ");
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

// New offers from Jooble right now (it also runs by itself once a day)
$("#refreshBtn").addEventListener("click", (e) => withLoading(e.currentTarget, async () => {
  try {
    const r = await API.post("/api/admin/refresh-offers");
    toast(t("adm.refreshDone", { added: r.added, closed: r.closed }), "success");
    loadStats();
  } catch (err) { toast(err.message, "error"); }
}));

// Backup: downloads every table as one JSON file
$("#backupBtn").addEventListener("click", (e) => withLoading(e.currentTarget, async () => {
  try {
    const res = await fetch("/api/admin/backup", { headers: { Authorization: `Bearer ${Auth.token()}` } });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(await res.blob()),
      download: `jobfinder-backup-${new Date().toISOString().slice(0, 10)}.json` });
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) { toast(err.message, "error"); }
}));

// ------------------------------------------------- Data analysis: the chart types of the M202 course, on the platform's data
// Charts are drawn with Plotly (like the course). Filters at the top work like a Dash dropdown: every chart redraws.
const INS_PAL = ["#2e9e74", "#4f7fe0", "#d9663f", "#8b6fd6", "#b8790a", "#1597b8"]; // checked for colour-blind safety
const INS_OTHER = "#9a95a3";
const TYPE_COLORS = { CDI: INS_PAL[0], CDD: INS_PAL[1], Stage: INS_PAL[2], PFE: INS_PAL[3], Alternance: INS_PAL[4], Freelance: INS_PAL[5] };
let insData = null, sectorColor = {};

const insTheme = () => {
  const cs = getComputedStyle(document.documentElement), v = (n) => cs.getPropertyValue(n).trim();
  return { text: v("--text"), muted: v("--muted"), border: v("--border"), surface: v("--surface") };
};

function insPlot(id, data, layout = {}) {
  const th = insTheme(), el = $("#" + id);
  const axis = { gridcolor: th.border, linecolor: th.border, zerolinecolor: th.border, tickfont: { color: th.muted }, title: { font: { color: th.muted, size: 12 } } };
  const merge = (a) => ({ ...axis, ...(layout[a] || {}), title: { ...axis.title, ...((layout[a] || {}).title || {}) } });
  if (el.dataset.empty) { el.innerHTML = ""; delete el.dataset.empty; }
  // the map is redrawn from scratch: updating it while its tiles still load throws "Style is not done loading"
  if (layout.mapbox) Plotly.purge(el);
  (layout.mapbox ? Plotly.newPlot : Plotly.react)(el, data, {
    paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)", font: { family: "Nunito Sans, sans-serif", color: th.text, size: 12 },
    margin: { l: 52, r: 16, t: 34, b: 52 }, hoverlabel: { bgcolor: th.surface, bordercolor: th.border, font: { color: th.text } },
    legend: { orientation: "h", x: 0, xanchor: "left", y: 1.02, yanchor: "bottom", font: { color: th.muted } }, ...layout, xaxis: merge("xaxis"), yaxis: merge("yaxis"),
  }, { displaylogo: false, responsive: true, scrollZoom: false, // the mouse wheel scrolls the page, not the chart
    modeBarButtonsToRemove: ["lasso2d", "select2d", "autoScale2d", "toggleSpikelines"] }).catch(() => {});
}

function insEmpty(id, key) {
  const el = $("#" + id);
  if (window.Plotly) Plotly.purge(el);
  el.dataset.empty = "1";
  el.innerHTML = `<div class="chart-empty">${icon("chart", 28)}<p>${t(key)}</p></div>`;
}

// last n weeks (Monday start) and how many dated rows fall in each
function insWeeks(n = 12) {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return Array.from({ length: n }, (_, i) => new Date(d.getTime() - (n - 1 - i) * 7 * 864e5));
}
const insPerWeek = (rows, weeks) => weeks.map((w, i) => rows.filter((r) => {
  const at = new Date(r.created_at); return at >= w && (i === weeks.length - 1 || at < weeks[i + 1]);
}).length);
const insWeekLabel = (w) => w.toLocaleDateString(LOCALE, { day: "numeric", month: "short" });
const insCount = (rows, key) => rows.reduce((m, r) => ((m[r[key]] = (m[r[key]] || 0) + 1), m), {});
const insTop = (counts, n) => Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
const insKm = (lat, lng) => { // distance to the centre of Marrakech (Jemaa el-Fna)
  const r = Math.PI / 180, dLat = (lat - 31.6258) * r, dLng = (lng + 7.9892) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(31.6258 * r) * Math.cos(lat * r) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
};

async function loadInsights() {
  if (!window.Plotly) { $("#insGrid").innerHTML = `<div class="card empty">${t("ins.noLib")}</div>`; return; }
  try { insData = await API.get("/api/admin/insights"); } catch (err) { toast(err.message, "error"); return; }
  const d = insData;
  // Fixed colour per sector (most common sectors in the directory), so a sector keeps its colour in every chart
  sectorColor = Object.fromEntries(insTop(insCount(d.directory, "sector"), 5).map((s, i) => [s, INS_PAL[i]]));
  const sectors = insTop(insCount([...d.directory, ...d.jobs], "sector"), 20);
  const cities = insTop(insCount(d.jobs, "city"), 20);
  const keep = (sel, opts, all) => { const v = sel.value; sel.innerHTML = `<option value="">${t(all)}</option>` + opts; sel.value = v; };
  keep($("#insSector"), sectors.map((s) => `<option value="${s}">${esc(sectorLabel(s))}</option>`).join(""), "ins.allSectors");
  keep($("#insCity"), cities.map((c) => `<option>${esc(c)}</option>`).join(""), "common.allCities");
  drawInsights();
}

function drawInsights() {
  const d = insData, sector = $("#insSector").value, city = $("#insCity").value, th = insTheme();
  const dir = d.directory.filter((c) => !sector || c.sector === sector);
  const rated = dir.filter((c) => c.rating);
  const jobs = d.jobs.filter((j) => (!sector || j.sector === sector) && (!city || j.city === city));
  const open = jobs.filter((j) => j.status === "open");
  const colorOf = (s) => sectorColor[s] || INS_OTHER;
  const groupOf = (s) => (sectorColor[s] ? sectorLabel(s) : t("ins.other"));
  $("#insSummary").textContent = t("ins.summary", { c: dir.length, o: open.length });

  // 1. Histogram: distribution of company ratings
  if (rated.length) insPlot("chHist", [{ type: "histogram", x: rated.map((c) => c.rating), xbins: { start: 1, end: 5.01, size: 0.25 },
    marker: { color: INS_PAL[0], line: { color: th.surface, width: 2 } }, hovertemplate: `%{x} ★<br>%{y} ${t("ins.companies")}<extra></extra>` }],
    { xaxis: { title: { text: t("ins.rating") } }, yaxis: { title: { text: t("ins.mCompanies") } }, bargap: 0.04 });
  else insEmpty("chHist", "ins.noData");

  // 2. Grouped bars: open offers per city, internships vs jobs
  const topCities = insTop(insCount(open, "city"), 8);
  if (topCities.length) {
    const isInt = (j) => j.type === "Stage" || j.type === "PFE";
    insPlot("chBars", [
      { type: "bar", name: t("nav.internships"), x: topCities, y: topCities.map((c) => open.filter((j) => j.city === c && isInt(j)).length), marker: { color: INS_PAL[2] } },
      { type: "bar", name: t("ins.jobs"), x: topCities, y: topCities.map((c) => open.filter((j) => j.city === c && !isInt(j)).length), marker: { color: INS_PAL[0] } },
    ], { barmode: "group", bargap: 0.3, bargroupgap: 0.08, yaxis: { title: { text: t("ins.offers") } } });
  } else insEmpty("chBars", "ins.noData");

  // 3. Pie (donut): share of each contract type
  const types = insCount(jobs, "type");
  if (jobs.length) insPlot("chPie", [{ type: "pie", hole: 0.55, sort: false, labels: Object.keys(types), values: Object.values(types),
    marker: { colors: Object.keys(types).map((k) => TYPE_COLORS[k] || INS_OTHER), line: { color: th.surface, width: 2 } },
    textinfo: "label+percent", textfont: { color: "#fff" }, hovertemplate: `%{label}: %{value} ${t("ins.offers")}<extra></extra>` }],
    { margin: { l: 10, r: 10, t: 10, b: 10 }, showlegend: false });
  else insEmpty("chPie", "ins.noData");

  // 4. Line: sign-ups and applications per week
  const weeks = insWeeks(12), labels = weeks.map(insWeekLabel);
  const signups = insPerWeek(d.users, weeks), apps = insPerWeek(d.applications, weeks);
  insPlot("chLine", [
    { type: "scatter", mode: "lines+markers", name: t("ins.signups"), x: labels, y: signups, line: { color: INS_PAL[0], width: 2 }, marker: { size: 8 } },
    { type: "scatter", mode: "lines+markers", name: t("nav.applications"), x: labels, y: apps, line: { color: INS_PAL[3], width: 2 }, marker: { size: 8 } },
  ], { yaxis: { title: { text: t("ins.perWeek") }, rangemode: "tozero" } });

  // 5. Scatter: rating vs number of reviews
  if (rated.length) insPlot("chScatter", [true, false].map((acc, i) => {
    const pts = rated.filter((c) => c.accepts === acc);
    return { type: "scatter", mode: "markers", name: t(acc ? "ins.acceptsApps" : "ins.noEmail"), x: pts.map((c) => c.reviews + 1), y: pts.map((c) => c.rating),
      text: pts.map((c) => c.name), marker: { color: acc ? INS_PAL[0] : INS_PAL[1], size: 8, opacity: 0.75, line: { color: th.surface, width: 1 } },
      hovertemplate: `<b>%{text}</b><br>%{y} ★ · %{x} ${t("ins.reviews")}<extra></extra>` };
  }), { xaxis: { type: "log", title: { text: t("ins.reviewsLog") } }, yaxis: { title: { text: t("ins.rating") }, range: [0.8, 5.2] } });
  else insEmpty("chScatter", "ins.noData");

  // 6. Heatmap: offers per sector and city
  const hmCities = insTop(insCount(d.jobs, "city"), 8), hmSectors = insTop(insCount(d.jobs, "sector"), 8);
  if (hmCities.length) insPlot("chHeat", [{ type: "heatmap", x: hmCities, y: hmSectors.map(sectorLabel),
    z: hmSectors.map((s) => hmCities.map((c) => d.jobs.filter((j) => j.sector === s && j.city === c).length)),
    colorscale: [[0, "#f1f8f4"], [0.35, "#9fd6bd"], [1, "#1f6b4f"]], texttemplate: "%{z}", hovertemplate: `%{y} · %{x}: %{z} ${t("ins.offers")}<extra></extra>`,
    xgap: 2, ygap: 2, colorbar: { thickness: 10, outlinewidth: 0, tickfont: { color: th.muted } } }],
    { margin: { l: 140, r: 16, t: 8, b: 48 }, xaxis: { gridcolor: "rgba(0,0,0,0)" }, yaxis: { gridcolor: "rgba(0,0,0,0)", automargin: true } });
  else insEmpty("chHeat", "ins.noData");

  // 7. Box plot: ratings per sector
  const boxSectors = insTop(insCount(d.directory.filter((c) => c.rating), "sector"), 6);
  insPlot("chBox", boxSectors.map((s) => ({ type: "box", name: sectorLabel(s), y: d.directory.filter((c) => c.sector === s && c.rating).map((c) => c.rating),
    marker: { color: colorOf(s), size: 4 }, line: { width: 1.5 }, boxpoints: "outliers" })),
    { showlegend: false, yaxis: { title: { text: t("ins.rating") }, range: [0.8, 5.2] } });

  // 8. Radar: the 4 biggest sectors compared on 5 measures (each scaled to 100 = best of the 4)
  const radarSectors = insTop(insCount(d.directory, "sector"), 4);
  const raw = radarSectors.map((s) => {
    const cs = d.directory.filter((c) => c.sector === s), r = cs.filter((c) => c.rating);
    return [cs.length, r.length ? r.reduce((a, c) => a + c.rating, 0) / r.length : 0, cs.reduce((a, c) => a + c.reviews, 0) / (cs.length || 1),
      (100 * cs.filter((c) => c.accepts).length) / (cs.length || 1), d.jobs.filter((j) => j.sector === s && j.status === "open").length];
  });
  const maxes = [0, 1, 2, 3, 4].map((i) => Math.max(...raw.map((r) => r[i]), 1e-9));
  const axes = ["ins.mCompanies", "ins.mRating", "ins.mReviews", "ins.mAccepts", "ins.mOffers"].map((k) => t(k));
  insPlot("chRadar", radarSectors.map((s, n) => ({ type: "scatterpolar", fill: "toself", name: sectorLabel(s), r: [...raw[n].map((v, i) => Math.round((100 * v) / maxes[i])), Math.round((100 * raw[n][0]) / maxes[0])],
    theta: [...axes, axes[0]], line: { color: colorOf(s), width: 2 }, fillcolor: colorOf(s), opacity: 0.55,
    hovertemplate: `${sectorLabel(s)} · %{theta}: %{r}/100<extra></extra>` })),
    { polar: { bgcolor: "rgba(0,0,0,0)", radialaxis: { range: [0, 100], gridcolor: th.border, linecolor: th.border, showticklabels: false },
      angularaxis: { gridcolor: th.border, linecolor: th.border, tickfont: { color: th.text } } }, margin: { l: 60, r: 60, t: 24, b: 50 },
    legend: { orientation: "h", x: 0.5, xanchor: "center", y: -0.08, yanchor: "top", font: { color: th.muted } } });

  // 9. Combined chart: offers published (bars) and applications (line) per week, on one scale
  insPlot("chCombo", [
    { type: "bar", name: t("ins.published"), x: labels, y: insPerWeek(jobs, weeks), marker: { color: INS_PAL[0] }, opacity: 0.85 },
    { type: "scatter", mode: "lines+markers", name: t("nav.applications"), x: labels, y: insPerWeek(d.applications, weeks), line: { color: INS_PAL[2], width: 2 }, marker: { size: 8 } },
  ], { bargap: 0.35, yaxis: { title: { text: t("ins.perWeek") }, rangemode: "tozero" } });

  // 10. Map: directory companies in Marrakech, coloured by sector, sized by number of reviews
  const located = dir.filter((c) => c.lat && c.lng);
  if (located.length) {
    const groups = {};
    located.forEach((c) => (groups[groupOf(c.sector)] = groups[groupOf(c.sector)] || { color: colorOf(c.sector), rows: [] }).rows.push(c));
    insPlot("chMap", Object.entries(groups).map(([name, g]) => ({ type: "scattermapbox", name, lat: g.rows.map((c) => c.lat), lon: g.rows.map((c) => c.lng),
      text: g.rows.map((c) => `${c.name}${c.rating ? ` · ${c.rating} ★` : ""}`), marker: { color: g.color, size: g.rows.map((c) => Math.min(22, 7 + Math.sqrt(c.reviews) / 3)), opacity: 0.8 },
      hovertemplate: "%{text}<extra></extra>" })),
      { mapbox: { style: "open-street-map", center: { lat: 31.635, lon: -8.0 }, zoom: 11 }, margin: { l: 0, r: 0, t: 30, b: 0 } });
  } else insEmpty("chMap", "ins.noData");

  // 11. Network: sectors linked to the cities where they publish offers (line width = number of offers)
  const links = {};
  d.jobs.forEach((j) => { const k = `${j.sector}|${j.city}`; links[k] = (links[k] || 0) + 1; });
  const nSectors = insTop(insCount(d.jobs, "sector"), 8), nCities = insTop(insCount(d.jobs, "city"), 8);
  if (nSectors.length) {
    const ys = (n, i) => (n === 1 ? 0.5 : i / (n - 1));
    const pos = Object.fromEntries([...nSectors.map((s, i) => [`s:${s}`, [0, ys(nSectors.length, i)]]), ...nCities.map((c, i) => [`c:${c}`, [1, ys(nCities.length, i)]])]);
    const edges = Object.entries(links).map(([k, n]) => [k.split("|"), n]).filter(([[s, c]]) => pos[`s:${s}`] && pos[`c:${c}`]);
    const total = (key, list) => list.filter((j) => key(j)).length;
    insPlot("chNet", [
      ...edges.map(([[s, c], n]) => ({ type: "scatter", mode: "lines", x: [0, 1], y: [pos[`s:${s}`][1], pos[`c:${c}`][1]], line: { color: colorOf(s), width: 1 + n * 1.2 },
        opacity: 0.45, hoverinfo: "text", text: `${sectorLabel(s)} → ${c}: ${n}`, showlegend: false })),
      { type: "scatter", mode: "markers+text", x: nSectors.map(() => 0), y: nSectors.map((s, i) => ys(nSectors.length, i)), text: nSectors.map(sectorLabel), textposition: "middle left",
        marker: { size: nSectors.map((s) => 10 + Math.sqrt(total((j) => j.sector === s, d.jobs)) * 4), color: nSectors.map(colorOf) }, hoverinfo: "text", showlegend: false },
      { type: "scatter", mode: "markers+text", x: nCities.map(() => 1), y: nCities.map((c, i) => ys(nCities.length, i)), text: nCities, textposition: "middle right",
        marker: { size: nCities.map((c) => 10 + Math.sqrt(total((j) => j.city === c, d.jobs)) * 4), color: th.text }, hoverinfo: "text", showlegend: false },
    ], { xaxis: { visible: false, range: [-0.9, 1.9] }, yaxis: { visible: false, range: [-0.1, 1.1] }, margin: { l: 10, r: 10, t: 10, b: 10 } });
  } else insEmpty("chNet", "ins.noData");

  // 12. 3D scatter: rating × reviews × distance to the city centre
  const pts3d = rated.filter((c) => c.lat && c.lng);
  if (pts3d.length) insPlot("ch3d", [true, false].map((acc) => {
    const pts = pts3d.filter((c) => c.accepts === acc);
    return { type: "scatter3d", mode: "markers", name: t(acc ? "ins.acceptsApps" : "ins.noEmail"), x: pts.map((c) => c.rating), y: pts.map((c) => Math.log10(c.reviews + 1)),
      z: pts.map((c) => insKm(c.lat, c.lng)), text: pts.map((c) => c.name), marker: { size: 3.5, color: acc ? INS_PAL[0] : INS_PAL[1], opacity: 0.8 },
      hovertemplate: `<b>%{text}</b><br>%{x} ★ · %{z:.1f} km<extra></extra>` };
  }), { margin: { l: 0, r: 0, t: 30, b: 0 }, scene: { bgcolor: "rgba(0,0,0,0)", aspectmode: "cube", camera: { eye: { x: 1.6, y: 1.6, z: 0.9 } },
    xaxis: { title: { text: t("ins.rating") }, gridcolor: th.border, color: th.muted }, yaxis: { title: { text: t("ins.reviews3d") }, gridcolor: th.border, color: th.muted },
    zaxis: { title: { text: t("ins.distance") }, gridcolor: th.border, color: th.muted } } });
  else insEmpty("ch3d", "ins.noData");
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

// ------------------------------------------------- Marrakech directory (emails used for spontaneous applications)
let dirPage = 1;
async function loadDirectoryAdmin() {
  try {
    const qs = new URLSearchParams({ q: $("#dirQ").value.trim(), show: $("#dirShow").value, page: dirPage });
    const d = await API.get(`/api/admin/directory?${qs}`);
    $("#dirTotal").textContent = d.counts.all;
    $$("#dirShow option").forEach((o) => { o.textContent = `${t(o.dataset.i18n)} (${d.counts[o.value || "all"]})`; });
    $("#dirTable").innerHTML = d.items.map((c) => `
      <tr>
        <td><div class="cell-user">${companyLogo({ ...c, logo_color: "#2e9e74" }, "sm")}<div style="min-width:0;max-width:260px"><strong class="ellipsis" style="display:block" title="${esc(c.name)}">${esc(c.name)}</strong><div class="muted small">${esc(c.category || sectorLabel(c.sector))}${c.rating ? ` · ★ ${c.rating}` : ""}</div></div></div></td>
        <td class="muted small"><div class="ellipsis" style="max-width:220px" title="${esc(c.area || c.city)}">${esc(c.area || c.city)}</div></td>
        <td class="small">${c.email ? esc(c.email) : `<span class="muted">—</span>`}</td>
        <td>${c.applications}</td>
        <td>${!c.email ? `<span class="badge">${t("adm.dirNoEmailBadge")}</span>` : c.opted_out ? `<span class="badge badge-red">${t("adm.dirOptoutBadge")}</span>` : `<span class="badge badge-green">${t("adm.dirAcceptsBadge")}</span>`}</td>
        <td><div class="actions">
          <button class="btn btn-ghost btn-sm" data-edit="${c.id}" title="${esc(t("adm.dirEditEmail"))}">${icon("edit", 14)}</button>
          ${c.email ? `<button class="btn btn-ghost btn-sm" data-optout="${c.id}" data-to="${!c.opted_out}">${t(c.opted_out ? "adm.dirResume" : "adm.dirStop")}</button>` : ""}
          <button class="btn btn-danger btn-sm" data-del="${c.id}">${icon("trash", 14)}</button></div></td>
      </tr>`).join("") || `<tr><td colspan="6" class="empty">${t("adm.noResults")}</td></tr>`;
    const byId = Object.fromEntries(d.items.map((c) => [c.id, c]));
    $$("#dirTable [data-edit]").forEach((b) => b.addEventListener("click", () => editDirectoryEmail(byId[b.dataset.edit])));
    $$("#dirTable [data-optout]").forEach((b) => b.addEventListener("click", async () => {
      try { await API.put(`/api/admin/directory/${b.dataset.optout}`, { opted_out: b.dataset.to === "true" }); loadDirectoryAdmin(); } catch (err) { toast(err.message, "error"); }
    }));
    $$("#dirTable [data-del]").forEach((b) => b.addEventListener("click", async () => {
      if (!(await confirmDialog(t("adm.dirDeleteConfirm"), t("common.delete")))) return;
      try { await API.del(`/api/admin/directory/${b.dataset.del}`); loadDirectoryAdmin(); } catch (err) { toast(err.message, "error"); }
    }));
    const el = $("#dirPages");
    let html = "";
    if (d.pages > 1) { // ‹ 1 … 4 5 6 … 22 ›, like the other pages
      html = `<button ${d.page === 1 ? "disabled" : ""} data-p="${d.page - 1}">‹</button>`;
      for (let n = 1; n <= d.pages; n++) {
        if (n === 1 || n === d.pages || Math.abs(n - d.page) <= 1) html += `<button class="${n === d.page ? "active" : ""}" data-p="${n}">${n}</button>`;
        else if (Math.abs(n - d.page) === 2) html += "<button disabled>…</button>";
      }
      html += `<button ${d.page === d.pages ? "disabled" : ""} data-p="${d.page + 1}">›</button>`;
    }
    el.innerHTML = html;
    $$("button[data-p]", el).forEach((b) => b.addEventListener("click", () => { dirPage = +b.dataset.p; loadDirectoryAdmin(); scrollToTop(true); }));
  } catch (err) { toast(err.message, "error"); }
}

function editDirectoryEmail(c) {
  modal({
    title: c.name,
    body: `<div class="field"><label for="dirEmail">${t("adm.dirEmailCol")}</label><input class="input" id="dirEmail" type="email" value="${esc(c.email)}" placeholder="contact@…"></div>
      <p class="muted small" style="margin-top:10px">${t("adm.dirEmailHelp")}</p>`,
    footer: `<button class="btn btn-ghost" data-close>${t("common.cancel")}</button><button class="btn btn-primary" id="dirSave">${t("profile.save")}</button>`,
    onOpen: (el, close) => $("#dirSave", el).addEventListener("click", async () => {
      try { await API.put(`/api/admin/directory/${c.id}`, { email: $("#dirEmail", el).value }); close(); loadDirectoryAdmin(); } catch (err) { toast(err.message, "error"); }
    }),
  });
}

const showCompanyView = (view) => {
  $$("#coView button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $("#coAccounts").classList.toggle("hidden", view !== "accounts");
  $("#coDirectory").classList.toggle("hidden", view !== "directory");
  (view === "directory" ? loadDirectoryAdmin : loadCompanies)();
};

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
  $$("#coView button").forEach((b) => b.addEventListener("click", () => showCompanyView(b.dataset.view)));
  $("#dirQ").addEventListener("input", debounce(() => { dirPage = 1; loadDirectoryAdmin(); }));
  $("#dirShow").addEventListener("change", () => { dirPage = 1; loadDirectoryAdmin(); });
  $("#jobQ").addEventListener("input", debounce(loadJobs));
  $("#insSector").addEventListener("change", drawInsights);
  $("#insCity").addEventListener("change", drawInsights);
  panelRouter("analytics", { analytics: loadStats, insights: loadInsights, users: loadUsers, companies: loadCompanies, jobs: loadJobs, reviews: loadReviews });
}
