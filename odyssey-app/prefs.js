/* Odyssey — route preferences: the questions, their defaults, and saving.
 * Pure logic, no DOM, so questionnaire.js (browser) and a Node test can both
 * use it. Answers are saved on this device only (localStorage). There is no
 * account and nothing is sent anywhere.
 */
"use strict";
(function (root) {
  const PREFS_KEY = "odyssey_prefs_v1";
  const PREFS_VERSION = 1;
  const MAX_PRIORITIES = 3;
  const NOTE_MAX = 300;

  /* How ready the map data is for each question. Numbers in the hints come from
   * the 17 Oct 2026 data build (see odyssey-city-data) and need refreshing when
   * the data is rebuilt. "soon" questions are still asked and saved, but
   * nothing uses the answer yet. */
  const TIERS = { ready: "Data ready", partial: "Partial data", soon: "Coming soon" };

  // Detour slider stops (minutes). null = "show me options even if they take longer".
  const EXTRA_MIN_STOPS = [0, 5, 10, 15, null];
  const EXTRA_MIN_LABELS = ["No extra time", "Up to 5 minutes", "Up to 10 minutes",
    "Up to 15 minutes", "Show me options even if they take longer"];

  const AVOID3 = [
    { value: "cannot", label: "Cannot use" },
    { value: "prefer_avoid", label: "Prefer to avoid" },
    { value: "none", label: "Don't mind" },
  ];
  const AVOID2 = [
    { value: "prefer_avoid", label: "Prefer to avoid" },
    { value: "none", label: "Don't mind" },
  ];

  /* Choose up to three, in order. `excludes` = the two can't both be chosen. */
  const PRIORITIES = [
    { id: "shorter", label: "A shorter walk", tier: "ready" },
    { id: "lighting", label: "Sections with confirmed lighting", tier: "partial" },
    { id: "parks", label: "Avoiding parks", tier: "ready" },
    { id: "stairs", label: "Avoiding known stairs", tier: "ready" },
    { id: "crossings", label: "Easier road crossings", tier: "soon" },
    { id: "fewer_turns", label: "A simpler route with fewer turns", tier: "ready" },
    { id: "main_streets", label: "Staying on main streets", tier: "ready", excludes: "quiet_streets" },
    { id: "quiet_streets", label: "Staying on quieter side streets", tier: "ready", excludes: "main_streets" },
  ];

  /* One entry per "how do you feel about X?" question. group: core = shown on
   * the must-haves screen, more = optional screen. Wording follows the draft. */
  const FACTORS = [
    { id: "lighting", group: "core", label: "Confirmed lighting", tier: "partial",
      question: "How important is confirmed lighting?",
      options: [{ value: "very", label: "Very important" }, { value: "some", label: "Somewhat important" },
        { value: "none", label: "Don't mind" }],
      hint: "Very important means we prioritise sections where lighting has been checked. It's confirmed on about 1 in 4 walkable segments; where it's unknown we say unknown, never unlit or unsafe." },
    { id: "parks", group: "core", label: "Park paths", tier: "ready",
      question: "How do you feel about routes through parks?",
      options: [{ value: "avoid", label: "Avoid" }, { value: "prefer_avoid", label: "Prefer to avoid" },
        { value: "none", label: "Don't mind" }, { value: "happy", label: "Happy to use" }],
      hint: "Based on mapped green spaces (parks, commons, woods, gardens, cemeteries). About 7% of walkable segments, and over a third of off-road paths, are inside one. If a journey can't avoid them, we'll say so." },
    { id: "stairs", group: "core", label: "Stairs", tier: "ready",
      question: "Do stairs affect your route choice?",
      options: AVOID3,
      hint: "382 sets of steps are mapped. We'll say \"no known stairs on this route\", never \"guaranteed step-free\"." },
    { id: "crossings", group: "core", label: "Road crossings", tier: "soon",
      question: "What would you prefer for road crossings?",
      options: [{ value: "mapped", label: "Mapped crossings, even if longer" },
        { value: "fewer", label: "Fewer crossings" }, { value: "none", label: "Don't mind" }],
      hint: "Crossing points aren't in our map data yet. We'll show crossing details rather than declare a crossing safe." },

    { id: "surface", group: "more", section: "path", label: "Uneven or unpaved surfaces", tier: "partial",
      options: AVOID3, hint: "Surface is mapped on about 44% of paths; the rest is unknown." },
    { id: "slopes", group: "more", section: "path", label: "Steep slopes", tier: "soon",
      options: AVOID3, hint: "We don't have elevation data yet." },
    { id: "narrow", group: "more", section: "path", label: "Narrow paths", tier: "soon",
      options: AVOID3, hint: "Path width is rarely mapped." },
    { id: "kerbs", group: "more", section: "path", label: "Crossings without a confirmed dropped kerb", tier: "soon",
      options: AVOID3, hint: "Dropped kerbs are almost never mapped." },

    { id: "traffic", group: "more", section: "around", label: "Paths beside heavy traffic", tier: "partial",
      options: AVOID2, hint: "Estimated from distance to main roads; about 14% of paths run alongside one." },
    { id: "underpasses", group: "more", section: "around", label: "Underpasses", tier: "partial",
      options: AVOID2, hint: "Only where mapped as a tunnel, and few are." },
    { id: "passages", group: "more", section: "around", label: "Enclosed pedestrian passages", tier: "partial",
      options: AVOID2, hint: "Only where mapped as a covered passage." },
    { id: "shared", group: "more", section: "around", label: "Shared walking and cycling paths", tier: "partial",
      options: AVOID2, hint: "Where mapped as a shared or cycle path." },

    { id: "pauses", group: "more", section: "pause", label: "Places to pause", tier: "soon",
      question: "Would places to pause help?",
      options: [{ value: "5", label: "About every 5 min" }, { value: "10", label: "About every 10 min" },
        { value: "15", label: "About every 15 min" }, { value: "none", label: "Don't mind" }],
      hint: "We haven't checked that resting places exist and are accessible yet, so we won't score this." },
    { id: "assist", group: "more", section: "assist", label: "Places that may offer assistance", tier: "soon",
      question: "Would you like routes with places that may offer assistance nearby?",
      options: [{ value: "show", label: "Show verified places" }, { value: "map_only", label: "Map only, don't change ranking" },
        { value: "none", label: "Don't mind" }],
      hint: "A mapped shop isn't evidence it's open or able to help. We'll only show places once locations and hours are verified." },
  ];

  const DIRECTIONS = [
    { value: "summary", label: "Map and short text", tier: "ready" },
    { value: "steps", label: "Detailed step-by-step text", tier: "soon" },
    { value: "spoken", label: "Spoken directions, if available", tier: "soon" },
  ];

  const CARD_ITEMS = [
    { id: "time_distance", label: "Estimated walking time and distance", tier: "ready" },
    { id: "lighting_checked", label: "How much of the lighting information has been checked", tier: "partial" },
    { id: "parks", label: "Mapped park sections", tier: "ready" },
    { id: "stairs", label: "Known stairs", tier: "ready" },
    { id: "crossings", label: "Road crossings", tier: "soon" },
    { id: "extra_time", label: "Extra time compared with the fastest route", tier: "ready" },
    { id: "last_checked", label: "When the route information was last checked", tier: "ready" },
  ];

  /* Presets only fill in answers; every screen can still be adjusted. */
  const PRESETS = [
    { id: "quickest", label: "Quickest", blurb: "Shortest walk, no extra time.",
      apply: { extraMin: 0, priorities: ["shorter"], levels: {} } },
    { id: "lit_main", label: "Confirmed lighting + main streets",
      blurb: "Prefers sections with checked lighting and main streets; up to 10 minutes extra.",
      apply: { extraMin: 10, priorities: ["lighting", "main_streets", "shorter"], levels: { lighting: "very" } } },
    { id: "no_stairs", label: "No known stairs, simple route",
      blurb: "Avoids known stairs and extra turns; up to 15 minutes extra.",
      apply: { extraMin: 15, priorities: ["stairs", "fewer_turns", "shorter"], levels: { stairs: "cannot" } } },
  ];

  /* ------------------------------ defaults ------------------------------ */
  function defaultPrefs() {
    const levels = {};
    for (const f of FACTORS) levels[f.id] = "none";
    return {
      v: PREFS_VERSION,
      departure: { mode: "now", time: "" },   // time = "YYYY-MM-DDTHH:MM", local
      extraMin: 10,
      priorities: [],
      levels,
      display: { directions: "summary", large: false, cardItems: CARD_ITEMS.map(c => c.id) },
      save: true,
      note: "",
    };
  }

  const clone = (o) => JSON.parse(JSON.stringify(o));

  /* Accepts anything (e.g. old or hand-edited saved data) and returns a valid,
   * complete prefs object. Unknown or invalid values fall back to defaults. */
  function sanitize(raw) {
    const d = defaultPrefs();
    if (!raw || typeof raw !== "object") return d;

    if (raw.departure && raw.departure.mode === "time" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(raw.departure.time || ""))) {
      d.departure = { mode: "time", time: raw.departure.time };
    }
    if (EXTRA_MIN_STOPS.includes(raw.extraMin)) d.extraMin = raw.extraMin;

    if (Array.isArray(raw.priorities)) {
      for (const id of raw.priorities) {
        const p = PRIORITIES.find(x => x.id === id);
        if (!p || d.priorities.includes(id)) continue;
        if (p.excludes && d.priorities.includes(p.excludes)) continue;
        if (d.priorities.length < MAX_PRIORITIES) d.priorities.push(id);
      }
    }
    if (raw.levels && typeof raw.levels === "object") {
      for (const f of FACTORS) {
        if (f.options.some(o => o.value === raw.levels[f.id])) d.levels[f.id] = raw.levels[f.id];
      }
    }
    if (raw.display && typeof raw.display === "object") {
      if (DIRECTIONS.some(x => x.value === raw.display.directions)) d.display.directions = raw.display.directions;
      d.display.large = raw.display.large === true;
      if (Array.isArray(raw.display.cardItems)) {
        d.display.cardItems = CARD_ITEMS.map(c => c.id).filter(id => raw.display.cardItems.includes(id));
      }
    }
    if (typeof raw.save === "boolean") d.save = raw.save;
    if (typeof raw.note === "string") d.note = raw.note.slice(0, NOTE_MAX);
    return d;
  }

  function applyPreset(prefs, presetId) {
    const p = PRESETS.find(x => x.id === presetId);
    const next = sanitize(prefs);
    if (!p) return next;
    const fresh = defaultPrefs();
    next.extraMin = p.apply.extraMin;
    next.priorities = p.apply.priorities.slice();
    next.levels = { ...fresh.levels, ...p.apply.levels };
    return sanitize(next);
  }

  /* Tap-to-rank. Returns { priorities, result } where result is one of
   * "added" | "removed" | "max" | "conflict" (the last two leave the list as is). */
  function togglePriority(list, id) {
    const p = PRIORITIES.find(x => x.id === id);
    if (!p) return { priorities: list.slice(), result: "unknown" };
    if (list.includes(id)) return { priorities: list.filter(x => x !== id), result: "removed" };
    if (p.excludes && list.includes(p.excludes)) return { priorities: list.slice(), result: "conflict" };
    if (list.length >= MAX_PRIORITIES) return { priorities: list.slice(), result: "max" };
    return { priorities: [...list, id], result: "added" };
  }

  /* Departure time as epoch ms, used as the base for arrival times. A chosen
   * time in the past (or an invalid one) means "now". */
  function departureMs(prefs, now) {
    if (prefs && prefs.departure && prefs.departure.mode === "time") {
      const t = new Date(prefs.departure.time).getTime();
      if (Number.isFinite(t) && t > now) return t;
    }
    return now;
  }

  const factorById = (id) => FACTORS.find(f => f.id === id);
  function levelLabel(factorId, value) {
    const f = factorById(factorId);
    const o = f && f.options.find(x => x.value === value);
    return o ? o.label : "";
  }

  /* Short human-readable list of what the user chose (for the summary card). */
  function summarise(prefs) {
    const p = sanitize(prefs);
    const out = [];
    p.priorities.forEach((id, i) => {
      const pr = PRIORITIES.find(x => x.id === id);
      out.push({ kind: "priority", text: `${i + 1}. ${pr.label}` });
    });
    out.push({ kind: "extra", text: EXTRA_MIN_LABELS[EXTRA_MIN_STOPS.indexOf(p.extraMin)] });
    for (const f of FACTORS) {
      if (p.levels[f.id] !== "none") {
        out.push({ kind: "level", tier: f.tier, text: `${f.label}: ${levelLabel(f.id, p.levels[f.id])}` });
      }
    }
    if (p.departure.mode === "time") out.push({ kind: "time", text: "Leaving at a chosen time" });
    if (p.display.large) out.push({ kind: "display", text: "Large text" });
    return out;
  }

  /* --------------------------- saving on device ------------------------- */
  const stored = {
    load(storage) {
      try {
        const s = storage && storage.getItem(PREFS_KEY);
        if (!s) return { prefs: defaultPrefs(), saved: false };
        return { prefs: sanitize(JSON.parse(s)), saved: true };
      } catch (e) { return { prefs: defaultPrefs(), saved: false }; }
    },
    save(storage, prefs) {
      try { storage.setItem(PREFS_KEY, JSON.stringify(sanitize(prefs))); return true; }
      catch (e) { return false; }
    },
    clear(storage) {
      try { storage.removeItem(PREFS_KEY); return true; } catch (e) { return false; }
    },
  };

  const api = {
    PREFS_KEY, PREFS_VERSION, MAX_PRIORITIES, NOTE_MAX, TIERS,
    EXTRA_MIN_STOPS, EXTRA_MIN_LABELS, PRIORITIES, FACTORS, DIRECTIONS, CARD_ITEMS, PRESETS,
    defaultPrefs, sanitize, clone, applyPreset, togglePriority, departureMs,
    levelLabel, summarise, stored,
  };
  if (typeof module !== "undefined") module.exports = api;
  else root.OdysseyPrefs = api;
})(typeof window !== "undefined" ? window : globalThis);
