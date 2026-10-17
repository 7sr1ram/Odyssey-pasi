/* Odyssey — standalone app logic. Navigation engine: Athena.
 * All scoring is done by the trained Athena model (entities/model.json).
 * Live Environment Agency data is fetched in the browser (CORS-enabled API).
 * No build step, no backend, no keys. Core is exported for Node testing.
 */
"use strict";

/* ----------------------------- constants ------------------------------ */
const BAND_RANK = { low: 0, medium: 1, high: 2 };
const WALK_M_PER_MIN = 80;

// Athena risk-penalty profiles: metres cost more on risky segments
const PROFILES = {
  shortest: { low: 0, medium: 0, high: 0, unknown: 0 },
  safest:   { low: 0, medium: 6, high: 60, unknown: 5 },
  balanced: { low: 0, medium: 3, high: 30, unknown: 3 },
};
// docks/parking access ways: allowed in the graph (they close gated-area
// gaps) but every profile discourages them.
const SERVICE_MULT = 3.0;
// how strongly the continuous model probability adds to segment cost
const RISK_W = { safest: 30, balanced: 15, shortest: 0 };

const PRESETS = [
  ["University of Southampton (Highfield)", 50.9362, -1.3957],
  ["Portswood shops", 50.9285, -1.3995],
  ["City centre (Above Bar)", 50.9045, -1.4025],
  ["Southampton Central station", 50.9085, -1.4115],
  ["Town Quay / ferries", 50.8998, -1.4005],
  ["Ocean Village", 50.9040, -1.3930],
  ["St Denys", 50.9215, -1.3905],
  ["Bitterne Park (Cobden Bridge)", 50.9245, -1.3780],
  ["Bevois Valley Road", 50.9200, -1.4045],
  ["Shirley High Street", 50.9105, -1.4325],
];

const EA_BASE = "https://environment.data.gov.uk/flood-monitoring";
const EA_TIDE_GAUGE = "E12660";   // Woolston tide gauge (live, OGL v3)

/* ------------------------------ utils --------------------------------- */
function distM(a, b) {
  const r = Math.PI / 180;
  const dLat = (b[0] - a[0]) * r, dLng = (b[1] - a[1]) * r;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}
const key = (c) => c[0].toFixed(5) + "," + c[1].toFixed(5);
const esc = (s) => String(s).replace(/[&<>"]/g,
  (m) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[m]));

/* ------------------------- graph + routing ---------------------------- */
function buildGraph(segments) {
  const nodes = new Map();
  function node(c) {
    const k = key(c);
    if (!nodes.has(k)) nodes.set(k, { c, adj: [] });
    return k;
  }
  const byId = new Map(segments.map(s => [s.id, s]));
  for (const s of segments) {
    const cs = s.coordinates;
    for (let i = 0; i < cs.length - 1; i++) {
      const a = node(cs[i]), b = node(cs[i + 1]);
      const len = distM(cs[i], cs[i + 1]) || 1;
      nodes.get(a).adj.push({ to: b, len, seg: s.id });
      nodes.get(b).adj.push({ to: a, len, seg: s.id });
    }
  }
  return { nodes, byId };
}

function snap(graph, latlng) {
  let best = null, bestD = Infinity;
  for (const n of graph.nodes.values()) {
    const d = distM(n.c, latlng);
    if (d < bestD) { bestD = d; best = n; }
  }
  return { key: key(best.c), coord: best.c, dist: bestD };
}

class MinHeap {
  constructor() { this.a = []; }
  push(x) { const a = this.a; a.push(x); let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() { const a = this.a, top = a[0], last = a.pop();
    if (a.length) { a[0] = last; let i = 0;
      for (;;) { const l = 2*i+1, r = l+1; let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } }
    return top; }
  get size() { return this.a.length; }
}

/* Dijkstra over a per-segment penalty profile. Returns:
 * { segments: unique segs in order, chainLen: metres actually walked,
 *   steps: [{from,to,seg,len}] node hops } or null. */
const MAX_EXTRA_MIN = 12;   // a safer route is only offered if the detour
                            // stays within this many extra walking minutes

function findRoute(graph, startKey, destKey, profile) {
  const isNamed = typeof profile === "string";
  const pen = isNamed ? PROFILES[profile] : profile;
  const rw = profile.rw ?? (isNamed ? RISK_W[profile] : RISK_W.safest);
  const dist = new Map([[startKey, 0]]);
  const prev = new Map();
  const done = new Set();
  const heap = new MinHeap(); heap.push([0, startKey]);
  while (heap.size) {
    const [d, u] = heap.pop();
    if (done.has(u)) continue;
    done.add(u);
    if (u === destKey) break;
    for (const e of graph.nodes.get(u).adj) {
      if (done.has(e.to)) continue;
      const seg = graph.byId.get(e.seg);
      const cost = e.len * (1 + pen[seg.risk_band]
        + rw * (seg.risk_score ?? 0)) *
        (seg.highway_type === "service" ? SERVICE_MULT : 1);
      const nd = d + cost;
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        prev.set(e.to, { node: u, seg: e.seg, len: e.len });
        heap.push([nd, e.to]);
      }
    }
  }
  if (!done.has(destKey)) return null;
  const back = [];
  let cur = destKey;
  while (cur !== startKey) {
    const p = prev.get(cur);
    if (!p) return null;
    back.push({ from: p.node, to: cur, seg: p.seg, len: p.len });
    cur = p.node;
  }
  back.reverse();
  const segments = [];
  let chainLen = 0, lastSeg = null;
  for (const st of back) {
    chainLen += st.len;
    if (st.seg !== lastSeg) { segments.push(graph.byId.get(st.seg)); lastSeg = st.seg; }
  }
  return { segments, chainLen, steps: back };
}

function routeStats(route) {
  const len = route.chainLen;
  let worst = "low", unknownCount = 0;
  for (const s of route.segments) {
    if (s.risk_band === "unknown") { unknownCount++; continue; }
    if (BAND_RANK[s.risk_band] > BAND_RANK[worst]) worst = s.risk_band;
  }
  return { len, minutes: len / WALK_M_PER_MIN, band: worst, unknownCount };
}

/* Full route triad with the detour bound applied. Returns
 * { shortest, safest, safestNote, balanced } (any may be null). */
function planTriad(graph, startKey, destKey) {
  const shortest = findRoute(graph, startKey, destKey, "shortest");
  const shortMin = shortest ? routeStats(shortest).minutes : 0;
  let safest = null, safestNote = "";
  for (const f of [1, 0.5, 0.25]) {
    const pen = {};
    for (const [band, p] of Object.entries(PROFILES.safest)) pen[band] = p * f;
    const r = findRoute(graph, startKey, destKey, { ...pen, rw: RISK_W.safest * f });
    if (!r) continue;
    safest = safest || r;
    if (routeStats(r).minutes - shortMin <= MAX_EXTRA_MIN) {
      safest = r;
      if (f < 1) safestNote =
        `Best risk reduction Athena can offer within a ${MAX_EXTRA_MIN}-minute detour.`;
      break;
    }
  }
  const balanced = findRoute(graph, startKey, destKey, "balanced");
  return { shortest, safest, safestNote, balanced };
}

function etaTime(minutes) {
  return new Date(Date.now() + minutes * 60000)
    .toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/* ----------------------- plain-English explanation ---------------------
 * Template-based, deterministic: the same route always reads the same.
 * All crime numbers are real Police UK data (see entities/incidents.json).
 * --------------------------------------------------------------------- */
function explain(route, altRoutes, crimes, havens, label) {
  const st = routeStats(route);
  const segIds = new Set(route.segments.map(s => s.id));
  const parts = [];

  const shortest = altRoutes.find(r => r.label === "Shortest");
  if (shortest && label !== "Shortest") {
    const dMin = Math.round(st.minutes - routeStats(shortest.route).minutes);
    const lead = label === "Safest" ? "Takes the lit streets" : "Balances distance and safety";
    parts.push(dMin < 3
      ? `${lead}, for much the same walking time as the shortest option.`
      : `${lead}; about ${dMin} min longer than the shortest option.`);
  } else {
    parts.push("The most direct route Athena found.");
  }

  // what this route avoids vs the shortest route
  if (shortest && label !== "Shortest") {
    const shortIds = new Set(shortest.route.segments.map(s => s.id));
    const avoided = shortest.route.segments.filter(s => !segIds.has(s.id) &&
      (s.risk_band === "high" || s.risk_band === "unknown"));
    if (avoided.length) {
      const s = avoided[0];
      const what = s.lighting === "no" ? "unlit" :
        (s.lighting === "unknown" ? "no-lighting-data" : "higher-risk");
      const nm = s.name === "unnamed path" ? "path" : s.name +
        ((s.highway_type === "footway" || s.highway_type === "path") ? " path" : "");
      parts.push(`Avoids the ${what} ${nm}.`);
    }
  }

  // real crime history on this route (Police UK)
  const withCrime = route.segments.filter(s => s.crime_count_90d > 0)
    .sort((a, b) => b.crime_count_90d - a.crime_count_90d);
  if (withCrime.length) {
    const s = withCrime[0];
    const nm = s.name === "unnamed path" ? "this route" : s.name;
    parts.push(`${s.crime_count_90d} street crimes were reported on or near ` +
      `${nm} in the last 3 months (Police UK, to ${s.last_crime_month}).`);
  }

  // unknowns — the honesty case
  if (st.unknownCount > 0) {
    parts.push(`${st.unknownCount} segment${st.unknownCount > 1 ? "s" : ""} on this ` +
      `route have no lighting data — risk unknown there.`);
  }

  // safe havens
  const near = havens.filter(h => route.segments.some(s =>
    s.coordinates.some(c => distM(c, [h.lat, h.lng]) < 150)));
  const haven = near.find(h => /24\/7/.test(h.hours)) || near[0];
  if (haven) parts.push(`Passes ${haven.name}${/24\/7/.test(haven.hours) ? " (staffed 24/7)" : ""}.`);

  // tidal paths
  const tidal = route.segments.find(s => s.tide_exposed);
  if (tidal) parts.push("Uses a tidal waterside path that can flood at high tide.");

  // honesty: if the safest option doesn't actually reduce exposure, say so
  if (label === "Safest" && shortest) {
    const exposure = (rr) => rr.segments.reduce((t, s) => t + (s.crime_count_90d || 0), 0);
    if (exposure(route) >= exposure(shortest.route))
      parts.push("In this area reported crime is similar on all reasonable options — Athena cannot reduce it further here.");
  }

  return parts.slice(0, 3).join(" ");
}

function gmapsUrl(route, origin, dest, graph) {
  const pts = [graph.nodes.get(route.steps[0].from).c]
    .concat(route.steps.map(st => graph.nodes.get(st.to).c));
  const step = Math.max(1, Math.floor(pts.length / 8));
  const wps = pts.filter((_, i) => i % step === 0).slice(1, -1)
    .map(c => `${c[0].toFixed(5)},${c[1].toFixed(5)}`).join("|");
  const q = new URLSearchParams({
    api: "1", origin: `${origin[0]},${origin[1]}`,
    destination: `${dest[0]},${dest[1]}`, travelmode: "walking",
  });
  if (wps) q.set("waypoints", wps);
  return "https://www.google.com/maps/dir/?" + q.toString();
}

/* ----------------------------- exports -------------------------------- */
if (typeof module !== "undefined") {
  module.exports = { buildGraph, snap, findRoute, routeStats, explain,
                     gmapsUrl, distM, PRESETS, PROFILES, MAX_EXTRA_MIN,
                     planTriad };
}

/* ============================ browser UI =============================== */
if (typeof document !== "undefined") (async function () {
  const $ = (id) => document.getElementById(id);
  const load = (p) => fetch(p).then(r => r.json());
  const [segments, crimes, havens, model, liveSnapshot, manifest, basemap] = await Promise.all([
    load("data/path_segments.json"), load("data/incidents.json"),
    load("data/safe_havens.json"), load("data/model.json").catch(() => null),
    load("data/live_check.json").catch(() => null),
    load("data/data_manifest.json").catch(() => null),
    load("data/basemap.geojson").catch(() => null),
  ]);

  /* map */
  const map = L.map("map", { preferCanvas: true, zoomControl: true }).setView([50.9195, -1.4045], 13);
  L.control.attribution({ prefix: false })
    .addAttribution("basemap &copy; OpenStreetMap contributors (ODbL) · crime: Police UK (OGL v3) · search: Nominatim")
    .addTo(map);

  /* self-contained GeoJSON basemap: no third-party tile server, no API key.
     Water, parks and rail from the same OSM build that feeds Athena. */
  const BASE_STYLE = {
    water: { color: "#16324f", weight: 1.5, fill: true, fillColor: "#101f35", fillOpacity: 0.9 },
    green: { color: "#16281e", weight: 0, fill: true, fillColor: "#111f18", fillOpacity: 0.9 },
    rail:  { color: "#262e3a", weight: 2, dashArray: "10 7", fill: false, fillOpacity: 0 },
  };
  const basemapLayer = L.layerGroup().addTo(map);
  if (basemap && basemap.features) {
    for (const f of basemap.features) {
      const st = BASE_STYLE[f.properties.kind] || {};
      const toLL = (c) => [c[1], c[0]];
      if (f.geometry.type === "Polygon") {
        const ring = f.geometry.coordinates[0].map(toLL);
        if (ring.length > 3) L.polygon(ring, st).addTo(basemapLayer);
      } else if (f.geometry.type === "LineString") {
        L.polyline(f.geometry.coordinates.map(toLL), st).addTo(basemapLayer);
      }
    }
  }

  /* locate-me control (mobile-first: one tap back to where you are) */
  const LocateControl = L.Control.extend({
    onAdd() {
      const btn = L.DomUtil.create("button", "locate-btn");
      btn.type = "button";
      btn.title = "Show my location";
      btn.setAttribute("aria-label", "Show my location");
      btn.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3.5"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>';
      L.DomEvent.on(btn, "click", (e) => {
        L.DomEvent.stopPropagation(e);
        if (!navigator.geolocation) return;
        btn.classList.add("busy");
        navigator.geolocation.getCurrentPosition(
          (pos) => { map.setView([pos.coords.latitude, pos.coords.longitude], 16); btn.classList.remove("busy"); },
          () => { btn.classList.remove("busy"); },
          { enableHighAccuracy: true, timeout: 10000 });
      });
      return btn;
    },
  });
  new LocateControl({ position: "topleft" }).addTo(map);

  const COLORS = { low: "#10b981", medium: "#f59e0b", high: "#ef4444", unknown: "#5b6673" };
  const segLayer = L.layerGroup().addTo(map);

  function popupHtml(s) {
    const cats = Object.entries(s.crime_categories || {})
      .sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([k, v]) => `${esc(k)} (${v})`).join(", ");
    const rows = [
      ["Risk band", s.risk_band === "unknown" ? "UNKNOWN (no lighting data)" :
        s.risk_band.toUpperCase() + (s.risk_score != null ? ` · model risk ${(s.risk_score*100).toFixed(1)}%/month` : "")],
      ["Lighting", s.lighting === "unknown"
        ? "data unavailable (no OSM lighting survey)"
        : s.lighting + (s.lighting_source.startsWith("assumed") ? " (assumed: UK main-road default)" : " (OSM lit tag)")],
      ["Street crimes (90d)", s.crime_count_90d +
        (s.last_crime_month ? ` (latest ${s.last_crime_month})` : " (none recorded)")],
      ["Crimes (7 months)", s.crime_count_6m + (cats ? `<br>${cats}` : "")],
      ["Isolation score", s.isolation_score + " / 10"],
      ["Tide-exposed", s.tide_exposed ? "yes — can flood at high tide" : "no"],
      ["Nightlife venues ≤250m", s.nightlife_venues_250m],
      ["Length", s.length_m + " m"],
    ];
    return `<b>${esc(s.name)}</b> (${s.id})` +
      `<table>${rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join("")}</table>` +
      `<p class="pop-note">Sources: OSM geometry & lighting (ODbL) · Police UK ` +
      `street-level crime (OGL v3) · Athena model ${model ? "AUC " + model.evaluation.auc_model : "n/a"}.</p>`;
  }

  const walkable = segments.filter(s => s.highway_type !== "service" && s.length_m >= 10);
  for (const s of walkable) {
    L.polyline(s.coordinates, {
      color: COLORS[s.risk_band],
      weight: s.risk_band === "high" ? 3 : s.risk_band === "unknown" ? 1.5 : 2,
      opacity: s.risk_band === "unknown" ? 0.55 : 0.9,
      dashArray: s.risk_band === "unknown" ? "4 4" : null,
    }).on("click", (e) => {
      L.popup().setLatLng(e.latlng).setContent(popupHtml(s)).openOn(map);
      L.DomEvent.stopPropagation(e);
    }).addTo(segLayer);
  }

  for (const h of havens) {
    L.circleMarker([h.lat, h.lng], {
      radius: 5, color: "#7dd3fc", fillColor: "#7dd3fc", fillOpacity: 0.9,
    }).bindPopup(`<b>Safe haven</b><br>${esc(h.name)}<br>${esc(h.hours)}`).addTo(map);
  }

  /* honesty + model coverage line */
  const counts = { low: 0, medium: 0, high: 0, unknown: 0 };
  walkable.forEach(s => counts[s.risk_band]++);
  const pct = Math.round(counts.unknown / walkable.length * 100);
  const monthSpan = model && model.training ? model.training.test_month : "";
  $("coverage").innerHTML =
    `${walkable.length.toLocaleString()} walking segments · ` +
    `${counts.low.toLocaleString()} low · ${counts.medium.toLocaleString()} medium · ` +
    `${counts.high} high · <b>${counts.unknown.toLocaleString()} unknown</b> ` +
    `(${pct}% have no lighting data — we show it, not hide it).` +
    (model ? `<br><span class="modelcard">Athena model: trained on ${crimes.length.toLocaleString()} ` +
      `real Police UK street crimes (${model.training.train_months[0]}–${model.training.test_month}); ` +
      `AUC ${model.evaluation.auc_model} vs ${model.evaluation.auc_baseline_recent_crime} ` +
      `recency baseline on held-out ${monthSpan}.</span>` : "");

  /* data freshness panel */
  if (manifest) {
    const rows = manifest.sources.map(s =>
      `<tr><td>${esc(s.name)}</td><td>${(s.fetched_at || "").slice(0, 16).replace("T", " ")}</td></tr>`)
      .join("");
    $("sources").innerHTML =
      `<details><summary>Data sources &amp; freshness (click)</summary>` +
      `<table class="src">${rows}</table>` +
      `<p class="hint">Licences: OSM ODbL · Police UK &amp; EA OGL v3 · CARTO tiles.</p></details>`;
  }

  /* LIVE panel: real-time Environment Agency data, fetched in this browser */
  async function refreshLive() {
    const el = $("live");
    try {
      const r = await fetch(`${EA_BASE}/id/stations/${EA_TIDE_GAUGE}/readings?latest`).then(x => x.json());
      const it = r.items[0];
      const level = it.value.toFixed(2);
      const t = new Date(it.dateTime).toLocaleTimeString("en-GB", {hour: "2-digit", minute: "2-digit"});
      const fw = await fetch(`${EA_BASE}/id/floods`).then(x => x.json());
      const hants = (fw.items || []).filter(i => (i.countyName || "") === "Hampshire"
        || (i.countyName || "") === "Southampton");
      el.innerHTML = `<span class="livedot"></span> LIVE · EA Woolston tide gauge:
        <b>${level} mAOD</b> at ${t}` +
        (hants.length ? ` · <b style="color:var(--high)">${hants.length} flood warning(s) active in Hampshire</b>`
         : " · no active flood warnings in Hampshire");
    } catch (e) {
      // offline: fall back to the build-time snapshot, clearly dated
      if (liveSnapshot && liveSnapshot.tide_gauge && liveSnapshot.tide_gauge.value != null) {
        el.innerHTML = `EA gauge (snapshot from data build): ` +
          `${liveSnapshot.tide_gauge.value} mAOD at ` +
          `${liveSnapshot.tide_gauge.reading_time.slice(11, 16)}Z` +
          ` — offline, not live`;
      } else {
        el.textContent = "";
      }
    }
  }
  $("live").textContent = "checking live EA data…";
  refreshLive();

  /* destination geocoding: Nominatim (OSM, ODbL), bounded to Southampton */
  const NOMINATIM = "https://nominatim.openstreetmap.org/search";
  const SOTON_VIEWBOX = "-1.48,50.86,-1.33,50.96";   // left,top,right,bottom
  async function geocode(q) {
    const url = `${NOMINATIM}?format=jsonv2&limit=1&accept-language=en` +
      `&countrycodes=gb&viewbox=${SOTON_VIEWBOX}&bounded=1&q=${encodeURIComponent(q)}`;
    const r = await fetch(url).then(x => x.json());
    return Array.isArray(r) && r[0] ? r[0] : null;
  }
  function setStatus(msg) { $("status").textContent = msg; }

  let clickStart = null, clickCount = 0, markers = [];
  map.on("click", (e) => {
    markers[clickCount] = L.marker([e.latlng.lat, e.latlng.lng], {
      icon: L.divIcon({ className: "", html: `<b style="color:#7dd3fc;font-size:14px">${clickCount === 0 ? "A" : "B"}</b>` }),
    }).addTo(map);
    if (clickCount === 0) clickStart = [e.latlng.lat, e.latlng.lng];
    else {
      planRoute(clickStart, [e.latlng.lat, e.latlng.lng]);
      clickCount = -1;
    }
    clickCount++;
  });

  /* routing */
  const graph = buildGraph(segments);
  let routeLayers = [];
  let routeLines = [], routeCards = [], selected = -1;

  function selectRoute(idx) {
    selected = idx;
    routeLines.forEach((l, i) => {
      if (i === idx) l.setStyle({ color: "#7dd3fc", weight: 6, opacity: 1, dashArray: null });
      else l.setStyle({ color: "#e6e6e6", weight: 3, opacity: 0.7, dashArray: "6 6" });
      if (i === idx) l.bringToFront();
    });
    routeCards.forEach((c, i) => {
      c.classList.toggle("selected", i === idx);
      const btn = c.querySelector(".choose");
      if (btn) { btn.disabled = i === idx;
                 btn.textContent = i === idx ? "✓ Chosen" : "Choose this route"; }
    });
  }
  function clearRouteLayers() {
    routeLayers.forEach(l => map.removeLayer(l));
    routeLayers = [];
    routeLines = []; routeCards = []; selected = -1;
    markers.forEach(m => m && map.removeLayer(m));
    planMarkers.forEach(m => map && map.removeLayer(m));
  }

  let planMarkers = [];
  function setPlanMarkers(fromLL, toLL, aLabel, bLabel) {
    planMarkers.forEach(m => map.removeLayer(m));
    const mk = (ll, letter, name) => L.marker(ll, {
      icon: L.divIcon({ className: "", html:
        `<b style="color:#7dd3fc;font-size:14px">${letter}</b>` }),
    }).bindPopup(`<b>${esc(name || letter)}</b>`).addTo(map);
    planMarkers = [mk(fromLL, "A", aLabel), mk(toLL, "B", bLabel)];
  }

  async function planRoute(fromLL, toLL, destName) {
    clearRouteLayers();
    const routesEl = $("routes");
    routesEl.classList.remove("hidden");
    routesEl.innerHTML = "<p class='hint'>Athena is scoring routes…</p>";

    setPlanMarkers(fromLL, toLL, "Your location", destName);
    const a = snap(graph, fromLL), b = snap(graph, toLL);
    if (a.dist > 400 || b.dist > 400) {
      routesEl.innerHTML = "<p class='hint'>Start or destination is too far from the walking network — pick a point nearer a street or path.</p>";
      return;
    }
    const triad = planTriad(graph, a.key, b.key);
    const results = [];
    if (triad.safest) results.push({ label: "Safest", profile: "safest", route: triad.safest, note: triad.safestNote });
    if (triad.shortest) results.push({ label: "Shortest", profile: "shortest", route: triad.shortest });
    if (triad.balanced) results.push({ label: "Balanced", profile: "balanced", route: triad.balanced });
    if (!results.length) {
      routesEl.innerHTML = "<p class='hint'>No walking route found between those points.</p>";
      return;
    }
    const uniq = [];
    for (const r of results) {
      if (!uniq.some(u => u.route.segments.map(s => s.id).join()
                       === r.route.segments.map(s => s.id).join())) uniq.push(r);
    }

    routesEl.innerHTML = "";
    uniq.forEach((r, idx) => {
      const st = routeStats(r.route);
      const text = [r.note, explain(r.route, uniq, crimes, havens, r.label)]
        .filter(Boolean).join(" ");
      const isBest = st.band === "low" || (idx === 0 && r.label === "Safest");

      const card = document.createElement("div");
      card.className = "route-card" + (isBest ? " best" : "");
      card.innerHTML =
        `<div class="route-head"><span class="route-title">${r.label}</span>` +
        `<span class="badge ${st.band}">${st.band === "unknown" ? "risk unknown" : st.band + " risk"}</span></div>` +
        `<div class="route-meta"><b>ETA ${etaTime(st.minutes)}</b> · ${Math.round(st.minutes)} min · ${(st.len / 1000).toFixed(1)} km` +
        (st.unknownCount ? ` · ${st.unknownCount} unscored` : "") + `</div>` +
        `<p class="route-explain">${text}</p>` +
        `<div class="route-actions">` +
        `<button class="choose" data-i="${idx}">Choose this route</button>` +
        `<a class="gmaps" target="_blank" href="${gmapsUrl(r.route, fromLL, toLL, graph)}">Open in Google Maps</a>` +
        `<button class="report" data-i="${idx}">Report this route</button></div>` +
        `<p class="report-msg hidden" id="msg-${idx}">Thanks — saved. Athena retrains on monthly Police UK data; your report is kept for the next retrain.</p>`;
      routesEl.appendChild(card);

      const pts = [graph.nodes.get(r.route.steps[0].from).c]
        .concat(r.route.steps.map(st => graph.nodes.get(st.to).c));
      routeLayers.push(L.polyline(pts, { color: "#0b1220", weight: 9, opacity: 0.6 }).addTo(map));
      const line = L.polyline(pts, {
        color: idx === 0 ? "#7dd3fc" : "#e6e6e6",
        weight: idx === 0 ? 5 : 3, opacity: 0.95, dashArray: idx === 0 ? null : "6 6",
      }).addTo(map);
      routeLayers.push(line);
      routeLines[idx] = line;
      routeCards[idx] = card;
    });
    selectRoute(0);
    map.fitBounds(routeLayers[routeLayers.length - 1].getBounds(), { padding: [40, 40] });

    routesEl.querySelectorAll(".choose").forEach(btn =>
      btn.addEventListener("click", () => selectRoute(+btn.dataset.i)));
    routesEl.querySelectorAll(".report").forEach(btn =>
      btn.addEventListener("click", () => {
        const r = uniq[+btn.dataset.i];
        const reports = JSON.parse(localStorage.getItem("odyssey_reports") || "[]");
        reports.push({
          ts: new Date().toISOString(),
          route_label: r.label,
          segment_ids: r.route.segments.map(s => s.id),
          band: routeStats(r.route).band,
        });
        localStorage.setItem("odyssey_reports", JSON.stringify(reports));
        $("msg-" + btn.dataset.i).classList.remove("hidden");
        btn.disabled = true;
      }));
  }

  /* the core flow: type where you're going, start from where you are */
  $("plan").addEventListener("click", async () => {
    const q = $("dest").value.trim();
    if (!q) { setStatus("Type a destination first — e.g. 'Ocean Village' or a street name."); return; }
    setStatus("Searching for that place…");
    let dest = null;
    try { dest = await geocode(q); } catch (e) { /* offline / blocked */ }
    if (!dest) { setStatus("Couldn't find that place in Southampton. Try a street name, landmark, or postcode area."); return; }
    const destLL = [+dest.lat, +dest.lon];
    const destName = (dest.display_name || "").split(",")[0];
    setStatus(`Destination: ${destName}. Getting your location…`);
    if (!navigator.geolocation) {
      setStatus("This browser can't share GPS — click two points on the map instead (start, then destination).");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setStatus(`Heading to ${destName} — Athena is scoring routes…`);
        planRoute([pos.coords.latitude, pos.coords.longitude], destLL, destName);
      },
      (err) => {
        setStatus("GPS unavailable (" + err.message + ") — click two points on the map: first your start, then your destination.");
      }, { enableHighAccuracy: true, timeout: 10000 });
  });

  /* SOS: official guidance links, per safety-product best practice */
  $("sos-open").addEventListener("click", () => {
    navigator.geolocation?.getCurrentPosition(
      (pos) => {
        const ll = `${pos.coords.latitude.toFixed(5)},${pos.coords.longitude.toFixed(5)}`;
        $("sos-location").textContent = `Location: ${ll}`;
        $("sos-copy").onclick = () => navigator.clipboard?.writeText(
          `https://www.google.com/maps?q=${ll}`);
      },
      () => { $("sos-location").textContent = "Location unavailable — enable GPS."; });
    $("sos-overlay").classList.remove("hidden");
  });
  $("sos-close").addEventListener("click", () => $("sos-overlay").classList.add("hidden"));
})();
