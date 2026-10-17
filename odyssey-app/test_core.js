/* Node test for the Odyssey routing core + real-data sanity — node test_core.js */
"use strict";
const fs = require("fs");
const core = require("./app.js");
const segments = JSON.parse(fs.readFileSync("data/path_segments.json"));
const crimes = JSON.parse(fs.readFileSync("data/incidents.json"));
const havens = JSON.parse(fs.readFileSync("data/safe_havens.json"));
const model = JSON.parse(fs.readFileSync("data/model.json"));
console.log(`segments: ${segments.length}, real crimes: ${crimes.length}, havens: ${havens.length}`);
console.log(`model: AUC ${model.evaluation.auc_model} vs baseline ${model.evaluation.auc_baseline_recent_crime} (test month ${model.training.test_month})`);

// real-data sanity
const withCrime = segments.filter(s => s.crime_count_90d > 0);
console.log(`segments with real crimes in last 3 months: ${withCrime.length}`);
const months = [...new Set(crimes.map(c => c.month))].sort();
console.log(`crime months: ${months[0]}..${months[-1] ?? months[months.length-1]}`);
const unsnapped = crimes.filter(c => !c.segment_id).length;
if (unsnapped) { console.log(`!! ${unsnapped} crimes missing segment_id`); }
const hi = segments.filter(s => s.risk_band === "high");
const hiCrime = hi.filter(s => s.crime_count_90d > 0).length;
console.log(`high-band segments: ${hi.length}, of which with recent crime: ${hiCrime}`);

const t0 = Date.now();
const graph = core.buildGraph(segments);
console.log(`graph built in ${Date.now() - t0}ms, nodes: ${graph.nodes.size}`);

const trips = [
  ["Uni -> Portswood",        [50.9362,-1.3957], [50.9285,-1.3995], 2.5],
  ["City centre -> Town Quay",[50.9045,-1.4025], [50.8998,-1.4005], 2.0],
  ["City centre -> Ocean Village",[50.9045,-1.4025],[50.9040,-1.3930], 2.5],
  ["St Denys -> Cobden Bridge",[50.9215,-1.3905],[50.9245,-1.3780], 2.5],
  ["Shirley -> city centre",  [50.9105,-1.4325], [50.9045,-1.4025], 4.5],
];
let fail = 0;
for (const [name, from, to, maxKm] of trips) {
  console.log(`\n== ${name} ==`);
  const a = core.snap(graph, from), b = core.snap(graph, to);
  const triad = core.planTriad(graph, a.key, b.key);
  const routes = [];
  for (const [label, route] of [["Safest", triad.safest], ["Shortest", triad.shortest], ["Balanced", triad.balanced]]) {
    if (!route) { console.log(`  ${label}: NO ROUTE`); fail++; continue; }
    const st = core.routeStats(route);
    const high = route.segments.filter(s => s.risk_band === "high").length;
    const crimes90 = route.segments.reduce((t, s) => t + (s.crime_count_90d||0), 0);
    console.log(`  ${label}: ${(st.len/1000).toFixed(2)}km, ${Math.round(st.minutes)}min, ` +
      `band=${st.band}, high-segs=${high}, recent-crimes-on-route=${crimes90}, unscored=${st.unknownCount}` +
      (label === "Safest" && triad.safestNote ? `  [bound applied]` : ""));
    routes.push({ label, route });
    if (label === "Shortest" && st.len / 1000 > maxKm) { console.log(`  !! shortest ${(st.len/1000).toFixed(2)}km > ${maxKm}km`); fail++; }
  }
  // bounded-safest invariants
  const shortMin = core.routeStats(routes[1].route).minutes;
  const safeMin = core.routeStats(routes[0].route).minutes;
  if (safeMin - shortMin > core.MAX_EXTRA_MIN + 1) { console.log(`  !! safest detour ${(safeMin-shortMin).toFixed(0)} min > ${core.MAX_EXTRA_MIN}`); fail++; }
  const exposure = (rr) => rr.route.segments.reduce((t, s) => t + (s.crime_count_90d || 0), 0);
  const hiN = (rr) => rr.route.segments.filter(s => s.risk_band === "high").length;
  // in uniformly risky areas "safest" may only match the shortest; it must
  // never be dramatically worse, and the UI states the similarity honestly.
  if (exposure(routes[0]) > exposure(routes[1]) * 2 || hiN(routes[0]) > hiN(routes[1]) * 2) {
    console.log("  !! safest exposure dramatically worse than shortest"); fail++;
  }
  const uniq = [];
  for (const r of routes)
    if (!uniq.some(u => u.route.segments.map(s=>s.id).join() === r.route.segments.map(s=>s.id).join())) uniq.push(r);
  for (const r of uniq.slice(0, 2))
    console.log(`  [${r.label}] "${core.explain(r.route, uniq, crimes, havens, r.label)}"`);
  console.log("  gmaps:", core.gmapsUrl(uniq[0].route, from, to, graph).slice(0, 90) + "…");
}
console.log(fail ? `\nFAILED: ${fail} problems` : "\nALL TESTS PASSED");
process.exit(fail ? 1 : 0);
