/* ==========================================================================
   PUBLIC.JS — pages anyone can visit. Each page sets <body data-page="...">:
     home  → index.html     landing page
     jobs  → jobs.html      search + filters
     job   → job.html       offer detail, apply, reviews
     auth  → auth.html      sign in, register, Google, forgot / reset password, email verification
     companies → companies.html   companies hiring now + searchable company directory
     legal → privacy.html, terms.html   privacy policy and terms of use (texts in i18n.js)
   ========================================================================== */
const PAGES = { home: homePage, jobs: jobsPage, job: jobPage, auth: authPage, companies: companiesPage, legal: legalPage };
PAGES[document.body.dataset.page]();

// ============================================================ Landing page
function homePage() {
  initPage();
  $("#heroSearch select").innerHTML += CITIES.map((c) => `<option>${c}</option>`).join("");
  $("#heroSearch").addEventListener("submit", (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const qs = new URLSearchParams([...form].filter(([, v]) => v));
    location.href = `/jobs.html?${qs}`;
  });

  API.get("/api/stats").then((s) => {
    $("#heroBadge").textContent = t("home.badgeLive", { jobs: s.jobs, cities: s.cities });
    const obs = new IntersectionObserver((entries) => entries.forEach((e) => {
      if (e.isIntersecting) { animateCount(e.target, s[e.target.dataset.count] || 0); obs.unobserve(e.target); }
    }), { threshold: 0.4 });
    $$("[data-count]").forEach((c) => obs.observe(c));
  }).catch(() => {});

  API.get("/api/companies").then((list) => {
    $("#companyList").innerHTML = list.map((c) => `<a class="company-item" href="/jobs.html?company_id=${c.id}">${companyLogo(c, "sm")}
      <span class="grow ellipsis">${esc(c.name)}</span><span class="badge">${t("home.offersCount", { n: c.open_jobs })}</span></a>`).join("");
  }).catch(() => {});

  const cats = [["Stage", "graduation", "#f2a33a", "book"], ["PFE", "pfe", "#9b7ede", "layers"], ["CDI", "cdi", "#2e9e74", "briefcase"],
    ["CDD", "cdd", "#5b8def", "calendar"], ["Alternance", "alternance", "#4fb8c9", "award"], ["Freelance", "freelance", "#e8836b", "spark"]];
  $("#catGrid").innerHTML = cats.map(([type, key, color, ic], n) => `
    <a href="/jobs.html?type=${type}" class="card card-hover cat-card reveal" style="--d:${n * 0.06}s">
      <div class="cat-icon" style="--kc:${color}">${icon(ic, 24)}</div>
      <div><h3>${t("cat." + key)}</h3><div class="muted small">${t("cat." + key + "Sub")}</div></div>
      <span class="arrow">${icon("arrow")}</span></a>`).join("");
  observeReveals($("#catGrid"));

  API.get("/api/jobs?per_page=6").then((data) => {
    $("#latestJobs").innerHTML = data.items.map(jobCard).join("");
    bindJobCards($("#latestJobs"));
  }).catch((err) => { $("#latestJobs").innerHTML = `<div class="empty">${esc(err.message)}</div>`; });
}

// ============================================================ Jobs list
function jobsPage() {
  const p = params();
  const internships = p.type === "Stage,PFE";
  initPage({ active: internships ? "internships" : "jobs" });
  if (internships) $("#pageTitle").innerHTML = t("jobs.titleInternships");

  const state = { q: p.q || "", city: p.city || "", level: p.level || "", company_id: p.company_id || "",
    type: p.type ? p.type.split(",") : [], mode: p.mode ? p.mode.split(",") : [], sort: p.sort || "recent", page: +p.page || 1,
    view: p.view === "map" && window.L ? "map" : "list" };
  const user = Auth.user();
  if (user && user.role === "student") { $("#matchOpt").hidden = false; if (!p.sort) state.sort = "match"; }

  $("#fCity").innerHTML += CITIES.map((c) => `<option>${c}</option>`).join("");
  const pills = (name, values, label) => values.map((v) => `<label class="check-pill"><input type="checkbox" name="${name}" value="${v}"><span>${label(v)}</span></label>`).join("");
  $("#fType").innerHTML = pills("type", JOB_TYPES, (v) => v);
  $("#fMode").innerHTML = pills("mode", ["On-site", "Hybrid", "Remote"], modeLabel);

  const syncControls = () => {
    $("#fQ").value = state.q; $("#fCity").value = state.city; $("#fLevel").value = state.level; $("#sort").value = state.sort;
    $$("#fType input").forEach((i) => (i.checked = state.type.includes(i.value)));
    $$("#fMode input").forEach((i) => (i.checked = state.mode.includes(i.value)));
  };
  const query = () => {
    const qs = new URLSearchParams();
    ["q", "city", "level", "company_id"].forEach((k) => state[k] && qs.set(k, state[k]));
    if (state.type.length) qs.set("type", state.type.join(","));
    if (state.mode.length) qs.set("mode", state.mode.join(","));
    return qs;
  };
  const update = (changes) => {
    Object.assign(state, changes);
    const qs = query();
    if (state.sort !== "recent") qs.set("sort", state.sort);
    if (state.page > 1) qs.set("page", state.page);
    if (state.view === "map") qs.set("view", "map");
    history.replaceState(null, "", `?${qs}`);
    load();
  };

  // List / map switch
  const showView = () => {
    $$(".view-switch button").forEach((b) => b.classList.toggle("active", b.dataset.view === state.view));
    ["#results", "#pagination"].forEach((s) => $(s).classList.toggle("hidden", state.view === "map"));
    $("#jobsMap").classList.toggle("hidden", state.view !== "map");
    $("#sort").classList.toggle("hidden", state.view === "map");
  };
  if (!window.L) $(".view-switch").classList.add("hidden"); // map library didn't load
  $$(".view-switch button").forEach((b) => b.addEventListener("click", () => { state.view = b.dataset.view; showView(); update({}); }));

  // Job alert: save the current filters
  if (user && user.role !== "student") $("#alertBtn").classList.add("hidden");
  $("#alertBtn").addEventListener("click", () => {
    if (!user) { location.href = `/auth.html?next=${encodeURIComponent(location.pathname + location.search)}`; return; }
    const filters = { q: state.q, city: state.city, type: state.type, mode: state.mode, level: state.level };
    if (!filters.q && !filters.city && !filters.level && !filters.type.length && !filters.mode.length) return toast(t("alerts.needFilter"), "error");
    openAlertDialog(filters);
  });

  $("#fQ").addEventListener("input", debounce((e) => update({ q: e.target.value.trim(), page: 1 }), 350));
  $("#fCity").addEventListener("change", (e) => update({ city: e.target.value, page: 1 }));
  $("#fLevel").addEventListener("change", (e) => update({ level: e.target.value, page: 1 }));
  $("#sort").addEventListener("change", (e) => update({ sort: e.target.value, page: 1 }));
  $("#fType").addEventListener("change", () => update({ type: $$("#fType input:checked").map((i) => i.value), page: 1 }));
  $("#fMode").addEventListener("change", () => update({ mode: $$("#fMode input:checked").map((i) => i.value), page: 1 }));
  $("#resetBtn").addEventListener("click", () => { update({ q: "", city: "", type: [], mode: [], level: "", company_id: "", page: 1 }); syncControls(); });

  let requestId = 0;
  async function load() {
    const id = ++requestId;
    if (state.view === "map") return loadMap(id);
    $("#results").innerHTML = Array(6).fill('<div class="skeleton" style="height:240px"></div>').join("");
    const qs = query();
    qs.set("sort", state.sort); qs.set("page", state.page);
    try {
      const data = await API.get(`/api/jobs?${qs}`);
      if (id !== requestId) return; // a newer search started meanwhile
      $("#countLabel").textContent = t("jobs.found", { n: data.total });
      $("#resultInfo").textContent = data.total ? t("jobs.page", { page: data.page, pages: data.pages }) : "";
      $("#results").innerHTML = data.items.length ? data.items.map(jobCard).join("")
        : `<div class="card empty" style="grid-column:1/-1">${icon("search", 36)}<h3>${t("jobs.none")}</h3><p>${t("jobs.noneSub")}</p></div>`;
      bindJobCards($("#results"));
      pagination(data);
    } catch (err) { $("#results").innerHTML = `<div class="card empty" style="grid-column:1/-1">${esc(err.message)}</div>`; }
  }

  function pagination({ page, pages }) {
    const el = $("#pagination");
    if (pages <= 1) { el.innerHTML = ""; return; }
    let html = `<button ${page === 1 ? "disabled" : ""} data-p="${page - 1}">‹</button>`;
    for (let n = 1; n <= pages; n++) {
      if (n === 1 || n === pages || Math.abs(n - page) <= 1) html += `<button class="${n === page ? "active" : ""}" data-p="${n}">${n}</button>`;
      else if (Math.abs(n - page) === 2) html += "<button disabled>…</button>";
    }
    el.innerHTML = html + `<button ${page === pages ? "disabled" : ""} data-p="${page + 1}">›</button>`;
    $$("button[data-p]", el).forEach((b) => b.addEventListener("click", () => { update({ page: +b.dataset.p }); scrollToTop(true); }));
  }

  // ---- Map view: every offer matching the filters, grouped by city
  let map = null, pins = null;
  async function loadMap(id) {
    const qs = query();
    qs.set("per_page", 200);
    let data;
    try { data = await API.get(`/api/jobs?${qs}`); } catch (err) { toast(err.message, "error"); return; }
    if (id !== requestId) return;
    $("#countLabel").textContent = t("jobs.found", { n: data.total });
    $("#resultInfo").textContent = "";
    if (!map) {
      map = L.map("jobsMap", { scrollWheelZoom: false }).setView([31.8, -7.1], 5); // Morocco
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(map);
      pins = L.layerGroup().addTo(map);
    }
    map.invalidateSize(); // the map box was hidden before
    pins.clearLayers();
    const byCity = {};
    data.items.forEach((j) => (byCity[j.city] = byCity[j.city] || []).push(j));
    const points = [];
    Object.entries(byCity).forEach(([city, jobs]) => {
      const at = CITY_COORDS[city];
      if (!at) return;
      points.push(at);
      const list = jobs.slice(0, 5).map((j) => `<a class="map-job" href="/job.html?id=${j.id}"><strong>${esc(j.title)}</strong><small>${esc(j.company.name)} · ${esc(j.type)}</small></a>`).join("");
      L.marker(at, { icon: L.divIcon({ className: "map-pin", html: `<span>${jobs.length}</span>`, iconSize: [40, 40], iconAnchor: [20, 20] }) })
        .bindPopup(`<div class="map-popup"><h4>${esc(city)} · ${t("home.offersCount", { n: jobs.length })}</h4>${list}
          <a class="map-all" href="/jobs.html?city=${encodeURIComponent(city)}">${t("jobs.mapSeeAll", { city })}</a></div>`, { maxWidth: 280 })
        .addTo(pins);
    });
    if (points.length) map.fitBounds(points, { padding: [50, 50], maxZoom: 8 });
    else toast(t("jobs.mapNone"), "info");
  }

  syncControls();
  showView();
  load();
}

// Approximate centre of each city, for the map
const CITY_COORDS = {
  Casablanca: [33.5731, -7.5898], Rabat: [34.0209, -6.8416], Marrakech: [31.6295, -7.9811], Tanger: [35.7595, -5.834],
  "Fès": [34.0181, -5.0078], Agadir: [30.4278, -9.5981], "Meknès": [33.8935, -5.5473], Oujda: [34.6814, -1.9086],
  "Kénitra": [34.261, -6.5802], "Tétouan": [35.5889, -5.3626], Ouarzazate: [30.9189, -6.8934], "El Jadida": [33.2316, -8.5007],
  Berrechid: [33.2655, -7.5875],
};

function openAlertDialog(filters) {
  modal({
    title: t("jobs.createAlert"),
    body: `<p class="muted" style="margin-bottom:14px">${t("alerts.sub")}</p>
      <div class="field" style="margin-bottom:14px"><label>${t("alerts.criteria")}</label><div class="chips">${describeFilters(filters).split(" · ").map((x) => `<span class="chip ok">${esc(x)}</span>`).join("")}</div></div>
      <div class="field" style="margin-bottom:14px"><label for="alertName">${t("alerts.name")}</label><input class="input" id="alertName" maxlength="120" value="${esc(describeFilters(filters))}"></div>
      <label class="row" style="cursor:pointer"><span class="switch"><input type="checkbox" id="alertEmail" checked><span></span></span><span>${t("alerts.email")}</span></label>`,
    footer: `<button class="btn btn-ghost" data-close>${t("common.cancel")}</button><button class="btn btn-primary" id="saveAlert">${icon("bell", 15)} ${t("alerts.save")}</button>`,
    onOpen: (el, close) => $("#saveAlert", el).addEventListener("click", (e) => withLoading(e.currentTarget, async () => {
      try {
        await API.post("/api/student/searches", { name: $("#alertName", el).value.trim() || describeFilters(filters), filters, email: $("#alertEmail", el).checked });
        close();
        toast(t("alerts.created"), "success");
      } catch (err) { toast(err.message, "error"); }
    })),
  });
}

// ============================================================ Companies (hiring now + directory)
function companiesPage() {
  initPage({ active: "companies" });
  const p = params();
  const state = { q: p.q || "", city: p.city || "", sector: p.sector || "", page: +p.page || 1 };
  let hiring = [];
  const user = Auth.user();
  const sent = new Set(); // directory companies this student already emailed
  $("#dq").value = state.q;

  const saveUrl = () => {
    const qs = new URLSearchParams(Object.entries(state).filter(([k, v]) => v && !(k === "page" && v === 1)));
    history.replaceState(null, "", `?${qs}`);
  };

  // Companies with open offers (posted here or found on job boards)
  const drawHiring = () => {
    const q = state.q.toLowerCase();
    const list = hiring.filter((c) => (!q || c.name.toLowerCase().includes(q)) && (!state.sector || c.sector === state.sector)
      && (!state.city || c.city === state.city));
    $("#hiringBlock").classList.toggle("hidden", !list.length);
    $("#hiringGrid").innerHTML = list.map((c, i) => `
      <a class="card card-hover dir-card fade-up" style="--d:${Math.min(i, 8) * 0.04}s" href="/jobs.html?company_id=${c.id}">
        ${thumb(c.sector, `<span class="thumb-tag">${esc(sectorLabel(c.sector))}</span>`)}
        <div class="dir-body"><div class="row" style="flex-wrap:nowrap">${companyLogo(c, "sm")}<h3 class="grow ellipsis">${esc(c.name)}</h3>${c.verified ? verifiedMark() : ""}</div>
          <div class="muted small">${icon("pin", 13)} ${esc(c.city || "—")}</div>
          <div class="dir-foot"><span class="badge badge-green">${t("home.offersCount", { n: c.open_jobs })}</span><span class="link-btn">${t("dir.seeOffers")} ${icon("arrow", 14)}</span></div></div>
      </a>`).join("");
  };

  // Directory (server side search, 24 per page)
  let requestId = 0;
  async function loadDirectory() {
    const id = ++requestId;
    $("#dirGrid").innerHTML = Array(6).fill('<div class="skeleton" style="height:280px"></div>').join("");
    const qs = new URLSearchParams({ q: state.q, city: state.city, sector: state.sector, page: state.page });
    let data;
    try { data = await API.get(`/api/directory?${qs}`); } catch (err) { $("#dirGrid").innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }
    if (id !== requestId) return;
    $("#countLabel").textContent = t("dir.found", { n: data.total });
    const total = Object.values(data.sectors).reduce((a, b) => a + b, 0);
    $("#dSectors").innerHTML = [["", t("dir.allSectors"), total], ...Object.entries(data.sectors).sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, sectorLabel(k), n])]
      .map(([k, label, n]) => `<button class="check-chip ${state.sector === k ? "active" : ""}" data-sector="${k}">${esc(label)} <span class="muted">${n}</span></button>`).join("");
    $$("#dSectors [data-sector]").forEach((b) => b.addEventListener("click", () => { Object.assign(state, { sector: b.dataset.sector, page: 1 }); refresh(); }));
    const allCities = Object.values(data.cities).reduce((a, b) => a + b, 0);
    $("#dCities").innerHTML = [["", t("dir.allCities"), allCities], ...Object.entries(data.cities).filter(([k, n]) => n >= 5 || k === state.city).sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, k, n])]
      .map(([k, label, n]) => `<button class="check-chip ${state.city === k ? "active" : ""}" data-city="${esc(k)}">${icon("pin", 13)} ${esc(label)} <span class="muted">${n}</span></button>`).join("");
    $$("#dCities [data-city]").forEach((b) => b.addEventListener("click", () => { Object.assign(state, { city: b.dataset.city, sector: "", page: 1 }); refresh(); }));
    $("#dirGrid").innerHTML = data.items.length ? data.items.map((c, i) => `
      <article class="card dir-card fade-up" style="--d:${Math.min(i, 8) * 0.04}s">
        ${thumb(c.sector, `<span class="thumb-tag">${esc(sectorLabel(c.sector))}</span>`)}
        <div class="dir-body">
          <h3>${esc(c.name)}</h3>
          ${c.category ? `<div class="muted small">${esc(c.category)}</div>` : ""}
          <div class="small ellipsis" title="${esc(c.area)}">${icon("pin", 13)} ${esc(c.area || c.city)}</div>
          ${c.rating ? `<div class="small">${stars(c.rating)} <strong>${c.rating}</strong> <span class="muted">${t("dir.reviews", { n: c.reviews })}</span></div>` : ""}
          <div class="row" style="gap:6px">
            ${c.website ? `<a class="btn btn-ghost btn-sm" href="${esc(c.website)}" target="_blank" rel="noopener nofollow">${icon("globe", 14)} ${t("dir.website")}</a>` : ""}
            ${c.maps_url ? `<a class="btn btn-ghost btn-sm" href="${esc(c.maps_url)}" target="_blank" rel="noopener nofollow">${icon("pin", 14)} ${t("dir.map")}</a>` : ""}
          </div>
          ${c.can_apply ? `<button class="btn ${sent.has(c.id) ? "btn-ghost" : "btn-primary"} btn-sm btn-block" data-apply="${c.id}" ${sent.has(c.id) ? "disabled" : ""}>
            ${icon(sent.has(c.id) ? "check" : "send", 14)} ${t(sent.has(c.id) ? "spont.sent" : "spont.send")}</button>` : ""}
          <div class="dir-foot"><span class="badge">${t("dir.notOnSite")}</span>
            <a class="link-btn" href="/auth.html?mode=register&role=company&company=${encodeURIComponent(c.name)}">${t("dir.claim")}</a></div>
        </div>
      </article>`).join("") : `<div class="card empty" style="grid-column:1/-1">${icon("search", 36)}<h3>${t("dir.none")}</h3></div>`;
    $$("[data-apply]", $("#dirGrid")).forEach((b) => b.addEventListener("click", () => openSpontaneous(data.items.find((c) => c.id === +b.dataset.apply), b)));
    pages(data);
  }

  // Spontaneous application: message + CV emailed to the company; its reply goes to the student's own mailbox
  async function openSpontaneous(company, button) {
    if (!user) { location.href = `/auth.html?next=${encodeURIComponent(location.pathname + location.search)}`; return; }
    if (user.role !== "student") return toast(t("spont.studentsOnly"), "error");
    const saved = await API.get("/api/student/cv-file").catch(() => null);
    modal({
      title: t("spont.title", { company: company.name }),
      body: `<p class="muted" style="margin-bottom:14px">${t("spont.intro", { company: company.name })}</p>
        <div class="field"><label for="spMsg">${t("spont.message")}</label>
          <textarea class="input" id="spMsg" rows="9">${esc(t("spont.template", { company: company.name, name: user.name }, true))}</textarea></div>
        <div class="field"><label>${t("spont.cv")}</label>
          ${saved ? `<label class="radio-line"><input type="radio" name="spCvChoice" value="saved" checked> ${t("spont.useSaved", { name: saved.name })}</label>
            <label class="radio-line"><input type="radio" name="spCvChoice" value="new"> ${t("spont.useOther")}</label>` : ""}
          <div id="spNewCv" class="${saved ? "hidden" : ""}"><input class="input" type="file" id="spCv" accept="application/pdf">
            <label class="radio-line"><input type="checkbox" id="spSaveCv" checked> ${t("spont.saveToProfile")}</label></div></div>
        <p class="notice small">${icon("mail", 15)} <span>${t("spont.privacy", { email: user.email })}</span></p>`,
      footer: `<button class="btn btn-ghost" data-close>${t("common.cancel")}</button><button class="btn btn-primary" id="spSend">${icon("send", 15)} ${t("spont.submit")}</button>`,
      onOpen: (el, close) => {
        $$("[name=spCvChoice]", el).forEach((r) => r.addEventListener("change", () => $("#spNewCv", el).classList.toggle("hidden", r.value === "saved" && r.checked)));
        $("#spSend", el).addEventListener("click", (e) => {
        const btn = e.currentTarget, message = $("#spMsg", el).value.trim();
        const useSaved = saved && $("[name=spCvChoice]:checked", el).value === "saved";
        const file = useSaved ? null : $("#spCv", el).files[0];
        if (message.length < 30) return toast(t("spont.short"), "error");
        if (!useSaved && (!file || file.type !== "application/pdf" || file.size > 2 * 1024 * 1024)) return toast(t("spont.cvInvalid"), "error");
        const send = (cvBase64) => withLoading(btn, async () => {
          try {
            if (cvBase64 && $("#spSaveCv", el).checked) await API.post("/api/student/cv-file", { file_name: file.name, file_base64: cvBase64 });
            await API.post(`/api/directory/${company.id}/apply`, { message, cv_name: file ? file.name : "", cv_base64: cvBase64 || "" });
            sent.add(company.id);
            button.disabled = true;
            button.className = "btn btn-ghost btn-sm btn-block";
            button.innerHTML = `${icon("check", 14)} ${t("spont.sent")}`;
            close();
            toast(t("spont.done", { company: company.name }), "success");
          } catch (err) { toast(err.message, "error"); }
        });
        if (useSaved) return send("");
        const reader = new FileReader();
        reader.onload = () => send(reader.result);
        reader.readAsDataURL(file);
        });
      },
    });
  }

  function pages({ page, pages: n }) {
    const el = $("#dirPages");
    if (n <= 1) { el.innerHTML = ""; return; }
    let html = `<button ${page === 1 ? "disabled" : ""} data-p="${page - 1}">‹</button>`;
    for (let k = 1; k <= n; k++) {
      if (k === 1 || k === n || Math.abs(k - page) <= 1) html += `<button class="${k === page ? "active" : ""}" data-p="${k}">${k}</button>`;
      else if (Math.abs(k - page) === 2) html += "<button disabled>…</button>";
    }
    el.innerHTML = html + `<button ${page === n ? "disabled" : ""} data-p="${page + 1}">›</button>`;
    $$("button[data-p]", el).forEach((b) => b.addEventListener("click", () => {
      state.page = +b.dataset.p; saveUrl(); loadDirectory();
      $("#directory").scrollIntoView({ behavior: "smooth" });
    }));
  }

  const refresh = () => { saveUrl(); drawHiring(); loadDirectory(); };
  $("#dq").addEventListener("input", debounce((e) => { Object.assign(state, { q: e.target.value.trim(), page: 1 }); refresh(); }, 350));
  API.get("/api/companies").then((list) => { hiring = list; drawHiring(); }).catch(() => {});
  if (user?.role === "student") {
    API.get("/api/student/spontaneous").then((list) => { list.forEach((r) => sent.add(r.directory_id)); loadDirectory(); }).catch(() => loadDirectory());
  } else loadDirectory();
}

// ============================================================ Privacy policy / terms of use
const LEGAL_UPDATED = "2026-10-23";

function legalPage() {
  initPage();
  const doc = document.body.dataset.doc, k = (key) => `legal.${doc}.${key}`;
  const draw = (email) => {
    const mail = `<a class="grad-text" href="mailto:${esc(email)}">${esc(email)}</a>`;
    const sections = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<h2 ${n === 1 ? 'id="contact"' : ""}>${t(k("s" + n + "h"))}</h2><p>${t(k("s" + n), { email: mail }, true)}</p>`).join("");
    $("#legalDoc").innerHTML = `<h1>${t(k("title"))}</h1><p class="muted">${t("legal.updated", { date: dateStr(LEGAL_UPDATED) })}</p>
      <p class="lead">${t(k("intro"), { email: mail }, true)}</p>${sections}`;
    document.title = `${t(k("title"))} — JobFinder.ma`;
  };
  API.get("/api/config").then((cfg) => draw(cfg.contact_email)).catch(() => draw("contact@jobfinder.ma"));
}

// ============================================================ Job detail
function jobPage() {
  initPage({ active: "jobs" });
  const user = Auth.user();
  let job;

  API.get(`/api/jobs/${encodeURIComponent(params().id)}`).then((data) => {
    job = data;
    document.title = `${job.title} — ${job.company.name} | JobFinder.ma`;
    render();
  }).catch((err) => {
    $("#jobRoot").innerHTML = `<div class="card empty">${icon("search", 36)}<h3>${esc(err.message)}</h3><a class="btn btn-primary" href="/jobs.html" style="margin-top:16px">${t("nav.jobs")}</a></div>`;
  });

  function applyBox() {
    if (!job.external_url) return mainApply();
    // offer from a job board: apply here (kept until the company joins) or directly on the original site
    return `${mainApply()}
      <div class="external-apply">
        <p class="muted small">${t("job.externalInfo", { source: job.source })}</p>
        <a class="btn btn-ghost btn-block btn-sm" href="${esc(job.external_url)}" target="_blank" rel="noopener nofollow">${t("job.applyExternal", { source: job.source })} ${icon("arrow", 14)}</a>
      </div>`;
  }

  function mainApply() {
    if (!user) return `<a class="btn btn-primary btn-block btn-lg" href="/auth.html?next=${encodeURIComponent(location.pathname + location.search)}">${t("job.signInApply")}</a>`;
    if (user.role !== "student") return `<p class="muted" style="text-align:center">${t("job.studentsOnly")}</p>`;
    if (job.applied) return `<div class="badge badge-green" style="width:100%;justify-content:center;padding:12px">${icon("check", 16)} ${t("job.applied")}</div>
      <a class="btn btn-ghost btn-block" href="/dashboard.html#applications" style="margin-top:10px">${t("job.track")}</a>`;
    return `<button class="btn btn-primary btn-block btn-lg" id="applyBtn">${t("job.apply")}</button>
      <button class="btn btn-ghost btn-block" id="saveBtn" style="margin-top:10px">${icon("bookmark", 16)} <span>${t(job.saved ? "job.saved" : "job.save")}</span></button>`;
  }

  function render() {
    const c = job.company, m = job.match;
    $("#jobRoot").innerHTML = `
    <div class="detail-layout">
      <div>
        <div class="card fade-up detail-card">
          ${thumb(job.sector, `<span class="thumb-tag">${esc(sectorLabel(job.sector))}</span>${job.source ? `<span class="thumb-tag source">${t("job.via", { source: job.source })}</span>` : ""}`)}
          <div class="detail-head">
            ${companyLogo(c, "lg")}
            <div class="grow" style="min-width:240px">
              <h1>${esc(job.title)}</h1>
              <div class="muted row" style="gap:6px"><strong style="color:var(--text)">${esc(c.name)}</strong>${c.verified ? verifiedMark() : c.external ? "" : `<span class="badge">${t("common.unverified")}</span>`}
                <span>· ${esc(sectorLabel(job.sector))} · ${timeAgo(job.created_at)}</span></div>
              <div class="row" style="gap:6px;margin-top:14px">${typeBadge(job.type)}<span class="badge">${icon("pin", 14)} ${esc(job.city)}</span><span class="badge">${modeLabel(job.work_mode)}</span>${job.level ? `<span class="badge">${esc(job.level)}</span>` : ""}</div>
            </div>
          </div>
          <div class="info-grid">
            <div class="info-item"><small>${t("job.salary")}</small><div>${money(job.salary_min, job.salary_max)}</div></div>
            <div class="info-item"><small>${t("job.duration")}</small><div>${esc(job.duration || (job.type === "CDI" ? t("job.permanent") : "—"))}</div></div>
            <div class="info-item"><small>${t("job.deadline")}</small><div>${dateStr(job.deadline)}</div></div>
            <div class="info-item"><small>${t("job.applicants")}</small><div>${job.applicants} · ${t("job.views", { n: job.views })}</div></div>
          </div>
          <div class="prose">
            <h2>${t("job.about")}</h2><p>${esc(job.description)}</p>
            ${job.requirements ? `<h2>${t("job.requirements")}</h2><p>${esc(job.requirements)}</p>` : ""}
            <h2>${t("job.skills")}</h2>
            <div class="chips">${job.skills.map((s) => `<span class="chip ${m ? (m.matched.includes(s) ? "ok" : "miss") : ""}">${esc(s)}</span>`).join("")}</div>
          </div>
        </div>

        <div class="card fade-up" style="--d:.1s;margin-top:18px">
          <div class="card-title"><h3>${t("job.aboutCompany", { name: c.name })}</h3><a class="btn btn-ghost btn-sm" href="/jobs.html?company_id=${c.id}">${t("job.allOffers")}</a></div>
          <p class="muted">${c.external ? t("job.externalCompany", { source: job.source }) : esc(c.description || "—")}</p>
          <div class="row" style="margin-top:14px">${c.city ? `<span class="badge">${icon("pin", 14)} ${esc(c.city)}</span>` : ""}${c.size ? `<span class="badge">${icon("users", 14)} ${esc(c.size)}</span>` : ""}</div>
        </div>

        <div class="card fade-up ${c.external ? "hidden" : ""}" style="--d:.15s;margin-top:18px">
          <div class="card-title"><h3>${t("reviews.title")}</h3>
            ${c.rating.count ? `<div class="row"><span class="rating-big">${c.rating.avg}</span><div>${stars(c.rating.avg)}<div class="muted small">${t("reviews.count", { n: c.rating.count })}</div></div></div>` : ""}</div>
          ${job.reviews.length ? job.reviews.map((r) => `
            <div class="review">${stars(r.rating)}<h4>${esc(r.title)}</h4><p>${esc(r.body)}</p>
              <div class="muted small">${esc(r.author)} · ${esc(r.role)} · ${dateStr(r.created_at)}</div></div>`).join("")
            : `<p class="muted">${t("reviews.none")}</p>`}
        </div>
        ${job.similar.length ? `<h3 style="margin:34px 0 16px">${t("job.similar")}</h3><div class="job-grid">${job.similar.map(jobCard).join("")}</div>` : ""}
      </div>

      <aside class="sticky-side">
        <div class="card fade-up" style="--d:.1s">${applyBox()}
          <div class="share-row">
            <a class="btn btn-whatsapp btn-sm" id="shareWa" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(`${t("job.shareText", { job: job.title, company: c.name, city: job.city }, true)}\n${location.origin}/job.html?id=${job.id}`)}">${icon("whatsapp", 15)} ${t("job.shareWhatsapp")}</a>
            <button class="btn btn-ghost btn-sm" id="copyLink">${icon("link", 15)} ${t("job.copyLink")}</button>
          </div>
        </div>
        ${m ? `
        <div class="card fade-up" style="--d:.2s;text-align:center">
          <h3 style="margin-bottom:16px">${t("job.matchTitle")}</h3>
          <div style="display:grid;place-items:center">${ring(m.score, "lg")}</div>
          <p class="muted small" style="margin-top:14px">${t(m.score >= 75 ? "job.matchHigh" : m.score >= 50 ? "job.matchMid" : "job.matchLow")}</p>
          <div class="row" style="justify-content:center;margin-top:14px">
            <a class="btn btn-ghost btn-sm" href="/dashboard.html?job=${job.id}#cv">${icon("file", 15)} ${t("job.tailorCv")}</a>
            <a class="btn btn-ghost btn-sm" href="/dashboard.html?job=${job.id}#interview">${icon("mic", 15)} ${t("job.practice")}</a>
          </div>
        </div>
        ${m.missing.length ? `<div class="card fade-up" style="--d:.25s"><h3 style="margin-bottom:4px">${t("learn.title")}</h3><p class="muted small">${t("learn.sub")}</p>${learnBlock(m.missing)}</div>` : ""}` : ""}
      </aside>
    </div>`;
    animateRings();
    bindJobCards($("#jobRoot"));
    $("#applyBtn")?.addEventListener("click", openApply);
    $("#copyLink").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(`${location.origin}/job.html?id=${job.id}`); toast(t("job.linkCopied"), "success"); }
      catch (_) { prompt(t("job.copyLink"), `${location.origin}/job.html?id=${job.id}`); }
    });
    $("#saveBtn")?.addEventListener("click", async (e) => {
      try {
        await (job.saved ? API.del(`/api/student/saved/${job.id}`) : API.post(`/api/student/saved/${job.id}`));
        job.saved = !job.saved;
        $("span", e.currentTarget).textContent = t(job.saved ? "job.saved" : "job.save");
        toast(t(job.saved ? "common.savedOk" : "common.unsaved"), "success");
      } catch (err) { toast(err.message, "error"); }
    });
  }

  function openApply() {
    modal({
      title: `${t("job.apply")} — ${job.title}`,
      body: `<p class="muted" style="margin-bottom:16px">${t("job.applyInfo", { company: job.company.name })}</p>
        <div class="field"><label for="cover">${t("job.cover")}</label><textarea class="textarea" id="cover" rows="10"></textarea></div>
        <button class="btn btn-ghost btn-sm" id="genCover" style="margin-top:10px">${icon("spark", 15)} ${t("job.coverAi")}</button>`,
      footer: `<button class="btn btn-ghost" data-close>${t("common.cancel")}</button><button class="btn btn-primary" id="sendApp">${t("job.submit")}</button>`,
      onOpen: (el, close) => {
        $("#genCover", el).addEventListener("click", (e) => withLoading(e.currentTarget, async () => {
          try { $("#cover", el).value = (await API.post("/api/student/cover-letter", { job_id: job.id, language: LANG })).text; }
          catch (err) { toast(err.message, "error"); }
        }));
        $("#sendApp", el).addEventListener("click", (e) => withLoading(e.currentTarget, async () => {
          try {
            await API.post("/api/student/applications", { job_id: job.id, cover_letter: $("#cover", el).value });
            close();
            toast(t("job.sent"), "success");
            job.applied = true; job.applicants += 1;
            render();
          } catch (err) { toast(err.message, "error"); }
        }));
      },
    });
  }
}

// ============================================================ Sign in / register / password / verification
/** Sign-in page, left panel: four characters. Their eyes follow the mouse, they look at the field you type in,
    look away while you type a password, and the tall one peeks when the password is shown. */
function authCharacters() {
  const scene = $("#chars");
  if (!scene) return;
  const chars = $$("[data-ch]", scene);
  const pw = $("#password");
  let mode = "follow", pointer = null, shown = false, flash = null;

  // Mouths: each shape is a closed lip outline "M x1 y1 Q cx cy x2 y2 Q cx cy x1 y1" in a 40x24 box.
  // Shapes share the same numbers, so one can morph smoothly into another.
  const MOUTHS = {
    line: [7, 11, 20, 11, 33, 11, 20, 14, 7, 11],    smile: [6, 8, 20, 18, 34, 8, 20, 21, 6, 8],
    grin: [5, 7, 20, 9, 35, 7, 20, 31, 5, 7],         oh: [14, 11, 20, 2, 26, 11, 20, 20, 14, 11],
    frown: [8, 16, 20, 5, 32, 16, 20, 9, 8, 16],      tight: [12, 12, 20, 10, 28, 12, 20, 13.5, 12, 12],
    smirk: [8, 12, 23, 16, 33, 6, 22, 19, 8, 12],     soft: [9, 10, 20, 15, 31, 10, 20, 17, 9, 10],
  };
  // Who makes which face in each mood
  const FACES = {
    follow: { tall: "soft", dark: "line", yellow: "line", orange: "smile" },
    field: { tall: "oh", dark: "smile", yellow: "oh", orange: "smile" },
    shy: { tall: "tight", dark: "tight", yellow: "tight", orange: "tight" },
    peek: { tall: "smirk", dark: "tight", yellow: "tight", orange: "tight" },
    sad: { tall: "frown", dark: "frown", yellow: "frown", orange: "frown" },
    happy: { tall: "grin", dark: "grin", yellow: "grin", orange: "grin" },
  };
  const toPath = (n) => `M${n[0]} ${n[1]} Q${n[2]} ${n[3]} ${n[4]} ${n[5]} Q${n[6]} ${n[7]} ${n[8]} ${n[9]}Z`;
  const setMouth = (ch, shape) => {
    const path = ch.querySelector(".mouth path"), to = MOUTHS[shape], from = ch._mouth || to;
    if (ch._shape === shape) return;
    ch._shape = shape;
    const start = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - start) / 260), e = 1 - (1 - k) ** 3; // ease-out
      ch._mouth = from.map((v, i) => v + (to[i] - v) * e);
      path.setAttribute("d", toPath(ch._mouth));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  const setMood = () => {
    const mood = flash || (mode === "field" ? "field" : mode === "shy" ? "shy" : mode === "peek" ? "peek" : "follow");
    scene.dataset.mood = mood;
    chars.forEach((ch) => setMouth(ch, FACES[mood][ch.dataset.ch]));
  };

  // Where the eyes should look: the mouse, the end of the text being typed, or away from the form
  const lookAt = (x, y) => chars.forEach((ch) => {
    const r = ch.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + Math.min(90, r.height / 3);
    const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy) || 1;
    ch.style.setProperty("--lean", `${Math.max(-8, Math.min(8, dx / 70)).toFixed(1)}deg`);
    ch.style.setProperty("--fx", `${((dx / d) * 9).toFixed(1)}px`);
    ch.style.setProperty("--fy", `${((dy / d) * 6).toFixed(1)}px`);
    $$(".eye i", ch).forEach((pupil) => {
      const m = pupil.parentElement.offsetWidth / 5; // bigger eyes, bigger movement
      pupil.style.transform = `translate(${((dx / d) * m).toFixed(1)}px, ${((dy / d) * m).toFixed(1)}px)`;
    });
  });
  const measure = document.createElement("canvas").getContext("2d");
  const caret = (input) => { // roughly where the text ends inside the field
    const r = input.getBoundingClientRect(), cs = getComputedStyle(input);
    measure.font = `${cs.fontSize} ${cs.fontFamily}`;
    const text = input.type === "password" ? "•".repeat(input.value.length) : input.value;
    return [Math.min(r.right - 16, r.left + 14 + measure.measureText(text).width), r.top + r.height / 2];
  };
  const formCentre = () => { const r = $(".auth-card:not(.hidden)")?.getBoundingClientRect(); return r ? [r.left + r.width / 2, r.top + 120] : [innerWidth * 0.75, innerHeight / 2]; };
  const update = () => {
    setMood();
    scene.classList.toggle("shy", mode === "shy" || mode === "peek");
    scene.classList.toggle("peek", mode === "peek");
    const field = document.activeElement;
    if (mode === "shy" || mode === "peek") {
      const r = scene.getBoundingClientRect();
      lookAt(r.left - 300, r.top - 260); // look away, up and to the left
      if (mode === "peek") { const ch = scene.querySelector(".ch-tall"), [x, y] = caret(pw); peekAt(ch, x, y); }
    } else if (mode === "field" && field?.matches?.("input")) lookAt(...caret(field));
    else if (pointer) lookAt(...pointer);
    else lookAt(...formCentre());
  };
  const peekAt = (ch, x, y) => { // the tall one turns back to read the shown password
    const r = ch.getBoundingClientRect(), dx = x - (r.left + r.width / 2), dy = y - (r.top + 80), d = Math.hypot(dx, dy) || 1;
    ch.style.setProperty("--lean", "6deg");
    ch.style.setProperty("--fx", `${((dx / d) * 12).toFixed(1)}px`);
    ch.style.setProperty("--fy", `${((dy / d) * 6).toFixed(1)}px`);
    $$(".eye i", ch).forEach((p) => (p.style.transform = `translate(${((dx / d) * 4).toFixed(1)}px, ${((dy / d) * 4).toFixed(1)}px)`));
  };

  document.addEventListener("pointermove", (e) => { pointer = [e.clientX, e.clientY]; if (mode === "follow") update(); }, { passive: true });
  document.addEventListener("focusin", (e) => {
    if (e.target === pw) mode = shown ? "peek" : "shy";
    else if (e.target.matches("input:not([type=checkbox]):not([type=radio]), textarea")) mode = "field";
    else return;
    update();
  });
  document.addEventListener("focusout", () => setTimeout(() => { if (!document.activeElement?.matches?.("input, textarea")) { mode = "follow"; update(); } }));
  document.addEventListener("input", (e) => { if (e.target.matches?.("input")) update(); });
  addEventListener("resize", update);

  // Show / hide the password (the tall one peeks while it is shown)
  $("#pwEye")?.addEventListener("click", () => {
    shown = !shown;
    pw.type = shown ? "text" : "password";
    $("#pwEye").innerHTML = icon(shown ? "eyeOff" : "eye", 18);
    $("#pwEye").setAttribute("aria-label", t(shown ? "auth.hidePw" : "auth.showPw"));
    pw.focus();
    mode = shown ? "peek" : "shy";
    update();
  });

  // Blinking, a little shake after a wrong password, a hop when signed in
  chars.forEach((ch) => {
    const blink = () => { ch.classList.add("blink"); setTimeout(() => ch.classList.remove("blink"), 160); setTimeout(blink, 2500 + Math.random() * 4000); };
    setTimeout(blink, 800 + Math.random() * 3000);
  });
  const play = (cls, ms) => {
    flash = cls;
    setMood();
    scene.classList.remove(cls); void scene.offsetWidth; scene.classList.add(cls);
    setTimeout(() => { scene.classList.remove(cls); flash = null; setMood(); }, ms + 600); // keep the face a moment longer
  };
  window.authCharsSad = () => play("sad", 700);
  window.authCharsHappy = () => play("happy", 900);
  update();
}

function authPage() {
  initPage({ footer: false, chat: false });
  authCharacters();
  const p = params();
  const next = p.next && p.next.startsWith("/") && !p.next.startsWith("//") ? p.next : null;
  const cards = ["mainCard", "forgotCard", "resetCard", "verifyCard", "codeCard"];
  const showCard = (id) => cards.forEach((c) => $("#" + c).classList.toggle("hidden", c !== id));

  const done = (data) => {
    if (data.needs_code) return askCode(data.email);
    window.authCharsHappy?.();
    Auth.save(data);
    toast(t("auth.welcome", { name: data.user.name.split(" ")[0] }, true), "success");
    setTimeout(() => location.replace(next || Auth.home(data.user.role)), 400);
  };

  // Links from emails: ?verify=TOKEN or ?reset=TOKEN
  if (p.verify) {
    showCard("verifyCard");
    API.post("/api/auth/verify", { token: p.verify }).then(() => {
      $("#verifyTitle").textContent = t("auth.verifiedTitle");
      $("#verifyText").textContent = t("auth.verifiedText");
      const u = Auth.user();
      if (u) { Auth.setUser({ ...u, email_verified: true }); $("#verifyBtn").href = Auth.home(u.role); }
    }).catch((err) => { $("#verifyTitle").textContent = t("auth.verifyFailed"); $("#verifyText").textContent = err.message; });
    return;
  }
  if (p.reset) {
    showCard("resetCard");
    $("#resetCard").addEventListener("submit", (e) => {
      e.preventDefault();
      if ($("#newPw").value.length < 8) return toast(t("auth.pwHint"), "error");
      withLoading($("button", e.target), async () => {
        try { done(await API.post("/api/auth/reset", { token: p.reset, password: $("#newPw").value })); toast(t("auth.resetOk"), "success"); }
        catch (err) { toast(err.message, "error"); }
      });
    });
    return;
  }

  if (Auth.user() && Auth.token()) location.replace(next || Auth.home(Auth.user().role));
  if (p.role === "company") $('input[name="role"][value="company"]').checked = true;
  let mode = p.mode === "register" ? "register" : "login";
  const role = () => $('input[name="role"]:checked').value;

  function setMode(m) {
    mode = m;
    $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === m));
    const active = $(".tabs button.active");
    Object.assign($(".tabs .indicator").style, { left: active.offsetLeft + "px", width: active.offsetWidth + "px" });
    $("#roleWrap").classList.toggle("hidden", m !== "register");
    $$('[data-only="register"]').forEach((el) => el.classList.toggle("hidden", m !== "register"));
    $$('[data-only="company"]').forEach((el) => el.classList.toggle("hidden", m !== "register" || role() !== "company"));
    $("#password").autocomplete = m === "register" ? "new-password" : "current-password";
    $("#submitBtn").textContent = t(m === "register" ? "auth.createBtn" : "nav.signin");
    $("#forgotLink").classList.toggle("hidden", m !== "login");
  }
  $$(".tabs button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.tab)));
  $$('input[name="role"]').forEach((r) => r.addEventListener("change", () => setMode(mode)));
  addEventListener("resize", () => setMode(mode));
  setMode(mode);

  $("#authForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    if (!f.email || !f.password) return toast(t("auth.fillAll"), "error");
    if (mode === "register" && (f.name || "").trim().length < 2) return toast(t("auth.nameMissing"), "error");
    if (mode === "register" && f.password.length < 8) return toast(t("auth.pwHint"), "error");
    withLoading($("#submitBtn"), async () => {
      try {
        done(mode === "register"
          ? await API.post("/api/auth/register", { name: f.name, email: f.email, password: f.password, role: role(), company_name: f.company_name || null, language: LANG })
          : await API.post("/api/auth/login", { email: f.email, password: f.password }));
      } catch (err) { toast(err.message, "error"); window.authCharsSad?.(); }
    });
  });

  // Email accounts confirm their address with the 6-digit code we email them
  let pending = null, timer = null, codeWave = null;
  function askCode(email) {
    pending = { email, password: $("#password").value };
    $("#codeText").textContent = t("code.sent");
    $("#codeEmail").textContent = email;
    setCode("");
    showCard("codeCard");
    $("#codeInput").focus();
    countdown();
  }
  function setCode(value) {
    const input = $("#codeInput");
    input.value = value;
    $$(".code-slots span").forEach((box, i) => {
      box.textContent = value[i] || "";
      box.classList.toggle("filled", i < value.length);
      box.classList.toggle("active", i === Math.min(value.length, 5));
    });
    $("#codeField").classList.remove("wrong", "right");
    $("#codeField").classList.toggle("complete", value.length === 6);
    $("#codeError").textContent = "";
    $("#codeSubmit").disabled = value.length < 6;
  }
  function wrongCode(message) {
    window.authCharsSad?.();
    setCode("");
    $("#codeError").textContent = message;
    void $("#codeField").offsetWidth; // restarts the shake
    $("#codeField").classList.add("wrong");
    $("#codeInput").focus();
  }
  function countdown(seconds = 60) {
    const btn = $("#resendCode");
    clearInterval(timer);
    const tick = () => {
      btn.disabled = seconds > 0;
      btn.textContent = seconds > 0 ? t("code.resendIn", { n: seconds }) : t("code.resend");
      if (seconds-- <= 0) clearInterval(timer);
    };
    tick();
    timer = setInterval(tick, 1000);
  }
  $("#codeInput").addEventListener("input", (e) => {
    setCode(e.target.value.replace(/\D/g, "").slice(0, 6));
    clearTimeout(codeWave);
    if (e.target.value.length === 6) codeWave = setTimeout(() => $("#codeCard").requestSubmit(), 650); // lets the wave finish
  });
  $("#codeInput").addEventListener("focus", () => $("#codeField").classList.add("focused"));
  $("#codeInput").addEventListener("blur", () => $("#codeField").classList.remove("focused"));
  $("#codeCard").addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = $("#codeInput").value;
    if (!/^\d{6}$/.test(code) || $("#codeSubmit").disabled) return;
    const failed = await withLoading($("#codeSubmit"), async () => {
      try {
        const data = await API.post("/api/auth/verify-code", { ...pending, code });
        $("#codeField").classList.add("right");
        done(data);
      } catch (err) { return err; }
    });
    if (failed) wrongCode(failed.message);
  });
  $("#resendCode").addEventListener("click", async () => {
    try { await API.post("/api/auth/resend-code", pending); setCode(""); toast(t("code.resent"), "success"); countdown(); $("#codeInput").focus(); }
    catch (err) { toast(err.message, "error"); }
  });

  $("#forgotLink").addEventListener("click", () => { showCard("forgotCard"); $("#fEmail").value = $("#email").value; });
  $$("[data-back]").forEach((b) => b.addEventListener("click", () => { showCard("mainCard"); setMode("login"); }));
  $("#forgotCard").addEventListener("submit", (e) => {
    e.preventDefault();
    withLoading($("button", e.target), async () => {
      try { await API.post("/api/auth/forgot", { email: $("#fEmail").value }); toast(t("auth.linkSent"), "success"); showCard("mainCard"); setMode("login"); }
      catch (err) { toast(err.message, "error"); }
    });
  });

  if (p.company) $("#company_name").value = p.company; // "This is my company" link from the directory

  // Google Sign-In: only shown when GOOGLE_CLIENT_ID is set on the server
  API.get("/api/config").then((cfg) => {
    if (!cfg.google_client_id) return;
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.onload = () => {
      google.accounts.id.initialize({
        client_id: cfg.google_client_id,
        callback: async (resp) => { try { done(await API.post("/api/auth/google", { credential: resp.credential, role: role() })); } catch (err) { toast(err.message, "error"); } },
      });
      $("#googleWrap").classList.remove("hidden");
      google.accounts.id.renderButton($("#googleBtn"), { theme: "outline",
        size: "large", shape: "pill", text: "continue_with", locale: LANG, width: Math.min(400, $("#googleBtn").offsetWidth || 360) });
    };
    document.head.appendChild(s);
  }).catch(() => {});
}
