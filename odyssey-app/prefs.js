/* Odyssey — route preferences: the on/off buttons, their defaults, and saving.
 * Pure logic, no DOM, so questionnaire.js (browser) and a Node test can both
 * use it. Answers are saved on this device only (localStorage). There is no
 * account and nothing is sent anywhere.
 *
 * The questionnaire is one question: "What matters on this walk?" Every
 * preference is a button. On = the route finder takes it into account.
 * Off = ignored. Buttons marked "soon" are saved but nothing uses them yet.
 */
"use strict";
(function (root) {
  const PREFS_KEY = "odyssey_prefs_v2";
  const PREFS_VERSION = 2;

  /* How ready the map data is for each button. Hints describe the 17 Oct 2026
   * data build and need refreshing when the data is rebuilt. */
  const TIERS = { ready: "Data ready", partial: "Partial data", soon: "Coming soon" };

  // Extra-time slider (Settings). null = no limit.
  const EXTRA_MIN_STOPS = [0, 5, 10, 15, null];
  const EXTRA_MIN_LABELS = ["No extra time", "Up to 5 minutes", "Up to 10 minutes", "Up to 15 minutes", "No limit"];
  // "Suggest a ride" walk-length choices (Settings), in minutes.
  const RIDE_MINUTES = [10, 15, 20, 30, 45];

  const GROUPS = [
    { id: "light", label: "Lighting, steps and ground" },
    { id: "where", label: "Where you walk" },
    { id: "style", label: "Route style" },
    { id: "soon", label: "Coming soon (saved for later)" },
  ];

  /* strict: never broken if a route exists (only "No stairs").
   * excludes: the two can't both be on. */
  const TOGGLES = [
    { id: "lit", group: "light", tier: "partial", label: "Well-lit (confirmed lighting)",
      hint: "Prefers sections where lighting is mapped. Unknown stays available." },
    { id: "stairs", group: "light", tier: "ready", strict: true, label: "No stairs",
      hint: "Strict: never uses known stairs." },
    { id: "unpaved", group: "light", tier: "partial", label: "Avoid unpaved or uneven surfaces",
      hint: "Where the surface is mapped." },

    { id: "parks", group: "where", tier: "ready", label: "Avoid parks and green spaces",
      hint: "Mapped parks, commons, woods, gardens and cemeteries." },
    { id: "main", group: "where", tier: "ready", excludes: "quiet", label: "Stay on main streets",
      hint: "Describes road type, not safety." },
    { id: "quiet", group: "where", tier: "ready", excludes: "main", label: "Stay on quiet side streets",
      hint: "Describes road type, not safety." },
    { id: "traffic", group: "where", tier: "partial", label: "Avoid paths beside busy roads",
      hint: "Estimated from distance to main roads." },
    { id: "shared", group: "where", tier: "partial", label: "Avoid shared walking and cycling paths",
      hint: "Where mapped as shared." },
    { id: "underpass", group: "where", tier: "partial", label: "Avoid underpasses",
      hint: "Only where mapped as a tunnel." },
    { id: "passage", group: "where", tier: "partial", label: "Avoid enclosed passages",
      hint: "Only where mapped as covered." },
    { id: "nightlife", group: "where", tier: "partial", label: "Avoid nightlife areas",
      hint: "Near mapped pubs, bars and clubs." },
    { id: "crime", group: "where", tier: "ready", label: "Avoid streets with more recorded crime",
      hint: "Uses Police UK counts to rank routes. Counts are always shown as info either way." },

    { id: "shorter", group: "style", tier: "ready", excludes: "further", label: "Shorter walk",
      hint: "Keeps the route close to the fastest." },
    { id: "further", group: "style", tier: "ready", excludes: "shorter", label: "Happy to go further",
      hint: "Removes the extra-time limit." },
    { id: "turns", group: "style", tier: "ready", label: "Fewer turns, simpler route",
      hint: "Fewer direction changes at junctions." },

    { id: "slopes", group: "soon", tier: "soon", label: "Avoid steep slopes", hint: "No elevation data yet." },
    { id: "narrow", group: "soon", tier: "soon", label: "Avoid narrow paths", hint: "Width is rarely mapped." },
    { id: "crossings", group: "soon", tier: "soon", label: "Fewer, easier road crossings", hint: "Crossing points aren't mapped yet." },
    { id: "kerbs", group: "soon", tier: "soon", label: "Dropped kerbs", hint: "Almost never mapped." },
    { id: "rest", group: "soon", tier: "soon", label: "Places to rest along the way", hint: "Not checked yet." },
    { id: "staffed", group: "soon", tier: "soon", label: "Routes past staffed places", hint: "Locations and hours not verified." },
    { id: "busy", group: "soon", tier: "soon", label: "Busy streets with people around", hint: "No footfall data." },
    { id: "isolated", group: "soon", tier: "soon", label: "Avoid isolated stretches", hint: "No reliable data yet." },
  ];

  const toggleById = (id) => TOGGLES.find(t => t.id === id);

  /* ------------------------------ defaults ------------------------------ */
  function defaultPrefs() {
    const on = {};
    for (const t of TOGGLES) on[t.id] = false;          // everything off until turned on
    return {
      v: PREFS_VERSION,
      on,
      extraMin: 10,                                      // minutes; null = no limit
      departure: { mode: "now", time: "" },              // time = "YYYY-MM-DDTHH:MM", local
      large: false,
      ride: { on: true, minutes: 20 },                   // suggest a ride for long walks
      save: true,
    };
  }

  const clone = (o) => JSON.parse(JSON.stringify(o));

  /* Accepts anything (old or hand-edited saved data) and returns a valid,
   * complete prefs object. Invalid values fall back to defaults. */
  function sanitize(raw) {
    const d = defaultPrefs();
    if (!raw || typeof raw !== "object") return d;
    if (raw.on && typeof raw.on === "object") {
      for (const t of TOGGLES) {                         // list order decides which of a pair wins
        if (raw.on[t.id] !== true) continue;
        if (t.excludes && d.on[t.excludes]) continue;
        d.on[t.id] = true;
      }
    }
    if (EXTRA_MIN_STOPS.includes(raw.extraMin)) d.extraMin = raw.extraMin;
    if (raw.departure && raw.departure.mode === "time" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(raw.departure.time || ""))) {
      d.departure = { mode: "time", time: raw.departure.time };
    }
    d.large = raw.large === true;
    if (raw.ride && typeof raw.ride === "object") {
      if (typeof raw.ride.on === "boolean") d.ride.on = raw.ride.on;
      if (RIDE_MINUTES.includes(raw.ride.minutes)) d.ride.minutes = raw.ride.minutes;
    }
    if (typeof raw.save === "boolean") d.save = raw.save;
    return d;
  }

  /* Turn one button on or off. Turning on a button whose partner is on turns
   * the partner off. Returns { on, switchedOff } (switchedOff = partner id or null). */
  function setToggle(on, id, value) {
    const t = toggleById(id);
    const next = { ...on };
    let switchedOff = null;
    if (!t) return { on: next, switchedOff };
    next[id] = !!value;
    if (value && t.excludes && next[t.excludes]) { next[t.excludes] = false; switchedOff = t.excludes; }
    return { on: next, switchedOff };
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

  /* The buttons that are on, for the summary card. */
  function summarise(prefs) {
    const p = sanitize(prefs);
    return TOGGLES.filter(t => p.on[t.id]).map(t => ({ id: t.id, text: t.label, soon: t.tier === "soon" }));
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
    PREFS_KEY, PREFS_VERSION, TIERS, GROUPS, TOGGLES,
    EXTRA_MIN_STOPS, EXTRA_MIN_LABELS, RIDE_MINUTES,
    toggleById, defaultPrefs, sanitize, clone, setToggle, departureMs, summarise, stored,
  };
  if (typeof module !== "undefined") module.exports = api;
  else root.OdysseyPrefs = api;
})(typeof window !== "undefined" ? window : globalThis);
