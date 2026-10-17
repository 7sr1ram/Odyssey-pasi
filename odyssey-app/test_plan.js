/* Tests for the preference-aware planner, the preferences module and the ride
 * rules. Run from anywhere:  node odyssey-app/test_plan.js
 * Uses the real data in data/ and all 45 pairs of the app's preset places. */
"use strict";
const fs = require("fs");
const path = require("path");
const core = require("./app.js");
const P = require("./prefs.js");
const R = require("./rides.js");

const read = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, "data", f)));
const segments = read("path_segments.json");
const extras = read("segment_extras.json");
const graph = core.attachExtras(core.buildGraph(segments), extras);

let fails = 0, checks = 0;
function check(name, ok, detail) {
  checks++;
  if (!ok) { fails++; console.log(`  FAIL ${name}${detail ? ": " + detail : ""}`); }
}

const pairs = [];
for (let i = 0; i < core.PRESETS.length; i++) for (let j = i + 1; j < core.PRESETS.length; j++) {
  pairs.push({ name: `${core.PRESETS[i][0].split(" (")[0]} -> ${core.PRESETS[j][0].split(" (")[0]}`,
    a: core.snap(graph, [core.PRESETS[i][1], core.PRESETS[i][2]]).key,
    b: core.snap(graph, [core.PRESETS[j][1], core.PRESETS[j][2]]).key });
}
console.log(`${segments.length} segments, ${Object.keys(extras.seg).length} with extras, ${pairs.length} preset pairs`);

/* ---- 1. planner invariants for many button combinations ---- */
const SETS = {
  none: { on: {} }, stairs: { on: { stairs: true } }, parks: { on: { parks: true } }, lit: { on: { lit: true } },
  unpaved: { on: { unpaved: true } }, main: { on: { main: true } }, quiet: { on: { quiet: true } },
  traffic: { on: { traffic: true } }, shared: { on: { shared: true } }, underpass: { on: { underpass: true } },
  passage: { on: { passage: true } }, nightlife: { on: { nightlife: true } }, crime: { on: { crime: true } },
  turns: { on: { turns: true } }, shorter: { on: { shorter: true } }, further: { on: { further: true } },
  combo: { on: { lit: true, parks: true, stairs: true, traffic: true, turns: true }, extraMin: 10 },
  limit0: { on: { lit: true, parks: true }, extraMin: 0 },
  furtherCombo: { on: { further: true, parks: true, lit: true } },
  soonOnly: { on: { slopes: true, crossings: true } },
};
const agg = {};
const times = [];
for (const [name, prefs] of Object.entries(SETS)) {
  const on = prefs.on;
  const limit = on.further || prefs.extraMin === null ? null : (prefs.extraMin ?? core.DEFAULT_EXTRA_MIN);
  const a = agg[name] = { better: 0, equal: 0, worse: 0 };
  for (const p of pairs) {
    const t0 = Date.now();
    const plan = core.planRoutes(graph, p.a, p.b, prefs, {});
    times.push(Date.now() - t0);
    const tag = `${name} / ${p.name}`;
    check(`${tag}: finds routes`, plan.ok && plan.routes.length >= 1 && plan.routes.length <= 3);
    if (!plan.ok) continue;
    const roles = plan.routes.map(r => r.role);
    check(`${tag}: unique roles`, new Set(roles).size === roles.length && !(roles.includes("both") && roles.includes("fastest")), roles.join());
    const exceedNote = plan.notes.some(n => /needs about/.test(n));
    for (const r of plan.routes) {
      const st = r.route.steps;
      let contiguous = st.length > 0 && st[0].from === p.a && st[st.length - 1].to === p.b;
      for (let i = 1; i < st.length; i++) if (st[i].from !== st[i - 1].to) contiguous = false;
      check(`${tag}/${r.role}: route is contiguous start to end`, contiguous);
      if (limit !== null && r.role !== "fastest") {
        check(`${tag}/${r.role}: within extra-time limit`, r.extraMin <= limit + 0.05 || exceedNote, `+${r.extraMin.toFixed(1)} min`);
      }
      if (on.stairs && r.role !== "fastest") check(`${tag}/${r.role}: no stairs`, r.metrics.stairsSegs === 0);
      if (on.slopes) check(`${tag}/${r.role}: coming-soon is "not applied"`, r.report.some(i => i.id === "slopes" && i.status === "na"));
    }
    for (let i = 0; i < plan.routes.length; i++) for (let j = i + 1; j < plan.routes.length; j++) {
      check(`${tag}: routes differ`, core.routeDistance(plan.routes[i].route, plan.routes[j].route) >= 0.09);
    }
    const fast = plan.routes.find(r => r.role === "fastest" || r.role === "both").metrics;
    const best = plan.routes.find(r => r.role === "best" || r.role === "both").metrics;
    const cmp = (better, worse) => { if (better) a.better++; else if (!worse) a.equal++; else a.worse++; };
    if (on.parks) cmp(best.parkM < fast.parkM - 1, best.parkM > fast.parkM + 1);
    if (on.lit) cmp(best.lit.confirmed / best.lenM > fast.lit.confirmed / fast.lenM + 0.01, best.lit.confirmed / best.lenM < fast.lit.confirmed / fast.lenM - 0.01);
    if (on.crime) cmp(best.crime90 < fast.crime90, best.crime90 > fast.crime90);
    if (on.turns) cmp(best.turns < fast.turns, best.turns > fast.turns);
    if (on.main) cmp(best.cls.main / best.lenM > fast.cls.main / fast.lenM + 0.01, best.cls.main / best.lenM < fast.cls.main / fast.lenM - 0.01);
  }
}
for (const k of ["parks", "lit", "crime", "turns", "main"]) {
  check(`${k}: never worse than the fastest route`, agg[k].worse === 0, JSON.stringify(agg[k]));
  check(`${k}: improves at least one pair`, agg[k].better > 0, JSON.stringify(agg[k]));
}
times.sort((x, y) => x - y);
console.log(`planRoutes: ${times.length} runs, median ${times[times.length >> 1]} ms, max ${times[times.length - 1]} ms`);
console.log("improvement counts (better/equal/worse vs fastest, over 45 pairs):",
  JSON.stringify(Object.fromEntries(["parks", "lit", "crime", "turns", "main"].map(k => [k, agg[k]]))));

/* ---- 2. a requirement that cannot be met says so ---- */
{
  const mk = (id, hw, c) => ({ id, highway_type: hw, coordinates: c, length_m: 30, lighting: "unknown", lighting_source: "no OSM lit tag",
    risk_band: "unknown", risk_score: null, crime_count_90d: 0, name: "unnamed path", tide_exposed: false, nightlife_venues_250m: 0 });
  const g = core.attachExtras(core.buildGraph([mk("A", "steps", [[50.9, -1.4], [50.9003, -1.4]]), mk("B", "footway", [[50.9003, -1.4], [50.9006, -1.4]])]), null);
  const a = core.snap(g, [50.9, -1.4]).key, b = core.snap(g, [50.9006, -1.4]).key;
  const strict = core.planRoutes(g, a, b, { on: { stairs: true } }, {});
  check("only route has stairs: strict 'No stairs' reports an unmet requirement", !strict.ok && strict.reason === "requirement" && strict.unmet.includes("stairs"));
  const relaxed = core.planRoutes(g, a, b, { on: { stairs: true } }, { relaxHard: true });
  check("relaxed: route shown and stairs marked 'missed'", relaxed.ok && relaxed.routes[0].report.some(i => i.id === "stairs" && i.status === "missed"));
}

/* ---- 3. bugs fixed ---- */
{
  const unk = segments.find(s => s.risk_band === "unknown" && s.highway_type === "footway");
  const st = core.routeStats({ segments: [unk], chainLen: unk.length_m, steps: [{ seg: unk.id, len: unk.length_m }] });
  check("routeStats: an all-unscored route is 'unknown', not 'low'", st.band === "unknown", st.band);

  const names = Object.fromEntries(core.PRESETS.map(p => [p[0].split(" (")[0], p]));
  const key = (n) => core.snap(graph, [names[n][1], names[n][2]]).key;
  for (const [x, y] of [["University of Southampton", "St Denys"], ["University of Southampton", "Bitterne Park"],
                        ["Portswood shops", "St Denys"], ["Portswood shops", "Bitterne Park"]]) {
    const t = core.planTriad(graph, key(x), key(y));
    const extra = core.routeStats(t.safest).minutes - core.routeStats(t.shortest).minutes;
    check(`planTriad bound holds: ${x} -> ${y}`, extra <= core.MAX_EXTRA_MIN + 0.05, `+${extra.toFixed(1)} min`);
  }

  const evil = { id: "X", name: "<img src=x onerror=alert(1)>", highway_type: "residential", risk_band: "low", risk_score: 0.01, lighting: "yes",
    coordinates: [[50.9, -1.4], [50.9001, -1.4]], crime_count_90d: 3, last_crime_month: "2026-08", tide_exposed: false, length_m: 20 };
  const unk2 = { ...evil, id: "Y", name: "Quiet Lane", risk_band: "unknown", risk_score: null, lighting: "unknown", crime_count_90d: 0 };
  const text = core.explain({ segments: [evil, unk2], chainLen: 40, steps: [] }, [], [], [], "Safest");
  check("explain: street names are HTML-escaped", !/<img/.test(text) && /&lt;img/.test(text), text);
  check("explain: the unknown-lighting note is not cut", /no lighting data/.test(text), text);
}

/* ---- 4. preferences module ---- */
{
  const bad = P.sanitize({ on: { stairs: true, main: true, quiet: true, shorter: true, further: true, nope: true },
    extraMin: 999, departure: { mode: "time", time: "garbage" }, large: "yes", ride: { on: "x", minutes: 7 }, save: "no" });
  check("sanitize: opposite buttons can't both be on", bad.on.main && !bad.on.quiet && bad.on.shorter && !bad.on.further);
  check("sanitize: bad values fall back to defaults", bad.extraMin === 10 && bad.departure.mode === "now" && bad.large === false &&
    bad.ride.on === true && bad.ride.minutes === 20 && bad.save === true && !("nope" in bad.on));
  const t = P.setToggle({ main: true, quiet: false }, "quiet", true);
  check("setToggle: turning one on turns its partner off", t.on.quiet && !t.on.main && t.switchedOff === "main");
  const now = Date.now();
  check("departureMs: a past time means now", P.departureMs({ departure: { mode: "time", time: "2020-01-01T10:00" } }, now) === now);
  check("departureMs: a future time is used", P.departureMs({ departure: { mode: "time", time: "2999-01-01T10:00" } }, now) > now);
  check("departureMs: 'now' mode and empty prefs mean now", P.departureMs({ departure: { mode: "now", time: "" } }, now) === now && P.departureMs(null, now) === now);
  const boom = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  check("storage that throws never crashes", P.stored.load(boom).saved === false && P.stored.save(boom, {}) === false && P.stored.clear(boom) === false && P.stored.load(null).saved === false);
  check("every soon button is known to the planner", P.TOGGLES.filter(x => x.tier === "soon").every(x => core.SOON_IDS.includes(x.id)) &&
    core.SOON_IDS.every(id => P.toggleById(id) && P.toggleById(id).tier === "soon"));
}

/* ---- 5. ride suggestion ---- */
{
  const m = (o) => Object.assign({ lenM: 1000, minutes: 12, lit: { confirmed: 900 }, band: { high: 0 } }, o);
  const prefs = { ride: { on: true, minutes: 20 } };
  const noon = new Date(2026, 9, 17, 12, 0).getTime(), late = new Date(2026, 9, 17, 23, 30).getTime();
  check("ride: short daytime walk -> no suggestion", R.rideReasons(m(), prefs, noon).length === 0);
  check("ride: walk over the limit -> suggested", R.rideReasons(m({ minutes: 24 }), prefs, noon).some(r => r.id === "long"));
  check("ride: late start with little confirmed lighting -> suggested", R.rideReasons(m({ lit: { confirmed: 200 } }), prefs, late).some(r => r.id === "late"));
  check("ride: late start with good lighting -> not suggested", R.rideReasons(m(), prefs, late).length === 0);
  check("ride: a quarter of the route in the highest crime band -> suggested", R.rideReasons(m({ band: { high: 300 } }), prefs, noon).some(r => r.id === "crime"));
  check("ride: switched off -> never", R.rideReasons(m({ minutes: 60 }), { ride: { on: false, minutes: 20 } }, late).length === 0);
  const all = R.rideReasons(m({ minutes: 60, lit: { confirmed: 0 }, band: { high: 900 } }), prefs, late).map(r => r.text + r.chip).join(" ");
  check("ride: wording never says 'unsafe'", !/unsafe|dangerous/i.test(all), all);
  const u = R.uberUrl([50.9, -1.39], "Ocean Village", [50.93, -1.4], true);
  check("uberUrl: pre-filled destination and my_location pickup", /^https:\/\/m\.uber\.com\/ul\/\?/.test(u) && /pickup=my_location/.test(u) &&
    /dropoff\[latitude\]=50\.900000/.test(u) && /dropoff\[longitude\]=-1\.390000/.test(u) && /dropoff\[nickname\]=Ocean%20Village/.test(u), u);
  const u2 = R.uberUrl([50.9, -1.39], "", [50.93, -1.4], false);
  check("uberUrl: explicit pickup when the start isn't GPS", /pickup\[latitude\]=50\.930000/.test(u2) && /dropoff\[nickname\]=Destination/.test(u2), u2);
}

console.log(`${checks} checks, ${fails} failed`);
console.log(fails ? "\nFAILED" : "\nALL TESTS PASSED");
process.exit(fails ? 1 : 0);
