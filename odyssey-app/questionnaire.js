/* Odyssey — route-preferences questionnaire: first-run wizard, Settings, and the
 * summary card in the side panel. Plain DOM, no framework, no build step.
 * Every piece of text is inserted with textContent, never innerHTML.
 *
 * PREVIEW: answers are saved and shown, but routing does not use them yet.
 * Two things already take effect: the start time (arrival times on route
 * cards, via OdysseyQuestionnaire.departureMs) and the large-text mode.
 */
"use strict";
(function () {
  const P = window.OdysseyPrefs;
  if (!P) return;

  const SKIP_KEY = "odyssey_prefs_skipped";
  const OPENING = "Tell us what matters on this walk. We’ll show up to three different routes " +
    "and explain how each matches your choices. Route information may be incomplete, and a " +
    "higher preference match does not mean a route is guaranteed safe.";

  // Browsers can throw when storage is blocked (private mode, site settings).
  const safe = (get) => { try { return get(); } catch (e) { return null; } };
  const local = safe(() => window.localStorage);
  const session = safe(() => window.sessionStorage);

  /* ------------------------------- state -------------------------------- */
  let current = P.defaultPrefs();     // what the app uses right now
  let savedOnDevice = false;
  let sessionSet = false;             // answered this visit without saving
  let modal = null, body = null, foot = null, stepLabel = null, progress = null;
  let draft = null, mode = "wizard", step = 0, opener = null;

  /* ------------------------------ helpers ------------------------------- */
  let uidN = 0;
  const uid = (p) => `${p}-${++uidN}`;

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid);                       // strings become text nodes
    }
    return el;
  }

  const tierBadge = (tier) => h("span", { class: `tier tier-${tier}` }, P.TIERS[tier]);

  function localInputValue(d) {
    const z = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`;
  }
  function nextSlot() {            // roughly 15 minutes from now, on a 5-minute mark
    const d = new Date(Date.now() + 15 * 60000);
    d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
    return d;
  }

  const applyDisplay = () => document.body.classList.toggle("large-text", !!current.display.large);

  /* One radio group drawn as big tappable buttons. Native radios, so arrow
   * keys and screen readers work. Wrap it in a <fieldset> with a <legend>. */
  function segmented({ name, options, value, onChange }) {
    const wrap = h("div", { class: "seg" });
    options.forEach((o) => {
      const id = uid("seg");
      const input = h("input", { type: "radio", name, id, value: o.value, checked: o.value === value });
      input.addEventListener("change", () => { if (input.checked) onChange(o.value); });
      wrap.append(h("label", { class: "seg-opt", for: id }, input, h("span", {}, o.label)));
    });
    return wrap;
  }

  function checkRow({ label, tier, checked, onChange, role }) {
    const id = uid("chk");
    const input = h("input", { type: "checkbox", id, role, checked: !!checked });
    input.addEventListener("change", () => onChange(input.checked));
    return h("label", { class: "opt", for: id }, input, h("span", { class: "opt-text" }, label), tier ? tierBadge(tier) : null);
  }

  /* ------------------------------- steps -------------------------------- */
  const ctx = {
    heading: (t) => mode === "wizard"
      ? h("h2", { id: "pm-title", tabindex: "-1" }, t)
      : h("h3", { class: "pm-sec-title" }, t),
  };

  const previewNote = () => h("p", { class: "pm-preview", role: "note" },
    h("strong", {}, "Preview. "),
    "Your answers are saved on this device, but route matching isn’t switched on yet — routes still use " +
    "Athena’s existing scoring. Your start time (for arrival times) and large text already work.");

  function buildPresets() {
    const status = h("p", { class: "pm-status", "aria-live": "polite" });
    const list = h("div", { class: "presets" });
    P.PRESETS.forEach((p) => {
      const b = h("button", { type: "button", class: "preset", "data-id": p.id, "aria-pressed": "false" },
        h("span", { class: "preset-name" }, p.label), h("span", { class: "preset-blurb" }, p.blurb));
      b.addEventListener("click", () => {
        draft = P.applyPreset(draft, p.id);
        status.textContent = `“${p.label}” applied. You can adjust anything on the other screens.`;
        list.querySelectorAll(".preset").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
        if (mode === "settings") { render({ keepScroll: true, focus: `.preset[data-id="${p.id}"]` }); }
      });
      list.append(b);
    });
    return h("div", {}, list, status,
      h("p", { class: "pm-sub" }, "Presets only fill in answers. Nothing is final."));
  }

  function buildStart() {
    return h("div", {},
      ctx.heading("Tell us what matters on this walk"),
      h("p", { class: "pm-lead" }, OPENING),
      previewNote(),
      h("p", { class: "pm-sub" }, "Every question can be skipped. You can change your answers later with the ⚙ button."),
      h("h3", { class: "pm-sec-title" }, "Start from a preset (optional)"),
      buildPresets());
  }
  const buildPresetsSection = () => h("div", {}, ctx.heading("Quick presets"), buildPresets());

  function buildWhen() {
    const root = h("div", {}, ctx.heading("When, and how much extra time?"));

    /* Q1 — start time */
    const timeInput = h("input", { type: "datetime-local", id: uid("dep"), "aria-label": "Departure date and time" });
    timeInput.min = localInputValue(new Date());
    timeInput.value = draft.departure.time || "";
    const timeRow = h("div", { class: "time-row" }, timeInput);
    const syncTime = () => timeRow.classList.toggle("hidden", draft.departure.mode !== "time");
    syncTime();
    const onTime = () => { draft.departure.time = timeInput.value; };
    timeInput.addEventListener("input", onTime);
    timeInput.addEventListener("change", onTime);
    root.append(h("fieldset", { class: "factor" },
      h("legend", {}, "When will you start walking?"),
      segmented({
        name: "dep-mode", value: draft.departure.mode,
        options: [{ value: "now", label: "Now" }, { value: "time", label: "Choose a departure time" }],
        onChange: (v) => {
          draft.departure.mode = v;
          if (v === "time" && !draft.departure.time) {
            draft.departure.time = localInputValue(nextSlot());
            timeInput.value = draft.departure.time;
          }
          syncTime();
        },
      }),
      timeRow,
      h("p", { class: "f-hint" }, "Used to show arrival times on route cards. We only use time-dependent " +
        "information, such as opening hours, when it is verified and current.")));

    /* Q3 — extra time (slider with +/- buttons and a text value) */
    const range = h("input", { type: "range", min: "0", max: String(P.EXTRA_MIN_STOPS.length - 1), step: "1",
      id: uid("extra"), value: String(P.EXTRA_MIN_STOPS.indexOf(draft.extraMin)) });
    const out = h("output", { class: "slider-value", for: range.id, "aria-live": "polite" });
    const set = (i) => {
      i = Math.max(0, Math.min(P.EXTRA_MIN_STOPS.length - 1, i));
      range.value = String(i);
      draft.extraMin = P.EXTRA_MIN_STOPS[i];
      out.textContent = P.EXTRA_MIN_LABELS[i];
      range.setAttribute("aria-valuetext", P.EXTRA_MIN_LABELS[i]);
    };
    set(P.EXTRA_MIN_STOPS.indexOf(draft.extraMin));
    range.addEventListener("input", () => set(+range.value));
    const stepBtn = (label, sym, d) => h("button", { type: "button", class: "step-btn", "aria-label": label,
      onclick: () => set(+range.value + d) }, sym);
    const ticks = h("div", { class: "ticks", "aria-hidden": "true" },
      ...["None", "5", "10", "15", "No limit"].map(t => h("span", {}, t)));
    root.append(h("fieldset", { class: "factor" },
      h("legend", {}, "How much longer than the fastest route would you walk for a better match?"),
      h("div", { class: "slider-top" }, stepBtn("Less extra time", "−", -1), out, stepBtn("More extra time", "+", 1)),
      range, ticks,
      h("p", { class: "f-hint" }, "If the limit leaves fewer than three meaningfully different routes, we’ll show fewer.")));
    return root;
  }

  function buildPriorities() {
    const root = h("div", {}, ctx.heading("What matters most on this walk?"),
      h("p", { class: "pm-sub" }, "Choose up to three, in order of importance. Tap again to remove one."));
    const status = h("p", { class: "pm-status", "aria-live": "polite" });
    const grid = h("div", { class: "chips" });
    const chips = new Map();

    const refresh = (msg) => {
      P.PRIORITIES.forEach((p) => {
        const chip = chips.get(p.id);
        const rank = draft.priorities.indexOf(p.id);
        const chosen = rank >= 0;
        const blocked = !chosen && (draft.priorities.length >= P.MAX_PRIORITIES ||
          (p.excludes && draft.priorities.includes(p.excludes)));
        chip.setAttribute("aria-pressed", String(chosen));
        chip.setAttribute("aria-disabled", String(!!blocked));
        chip.classList.toggle("is-blocked", !!blocked);
        chip.querySelector(".rank").textContent = chosen ? String(rank + 1) : "";
      });
      status.textContent = msg || `${draft.priorities.length} of ${P.MAX_PRIORITIES} chosen.`;
      updateTags();
    };

    P.PRIORITIES.forEach((p) => {
      const chip = h("button", { type: "button", class: "chip", "aria-pressed": "false" },
        h("span", { class: "rank", "aria-hidden": "true" }),
        h("span", { class: "chip-label" }, p.label),
        p.tier === "ready" ? null : tierBadge(p.tier));
      chip.addEventListener("click", () => {
        const r = P.togglePriority(draft.priorities, p.id);
        draft.priorities = r.priorities;
        const n = draft.priorities.indexOf(p.id) + 1;
        const other = p.excludes && P.PRIORITIES.find(x => x.id === p.excludes);
        const msg = {
          added: `“${p.label}” added as priority ${n}. ${draft.priorities.length} of ${P.MAX_PRIORITIES} chosen.`,
          removed: `“${p.label}” removed. ${draft.priorities.length} of ${P.MAX_PRIORITIES} chosen.`,
          max: `You’ve already chosen ${P.MAX_PRIORITIES}. Tap one to remove it first.`,
          conflict: other ? `You can’t choose both. Tap “${other.label}” again to swap.` : "",
        }[r.result];
        refresh(msg);
      });
      chips.set(p.id, chip);
      grid.append(chip);
    });
    root.append(grid, status,
      h("p", { class: "f-hint" }, "“Main streets” and “side streets” describe road types only. Neither is " +
        "treated as a measure of personal safety or live footfall. Items marked “Coming soon” are saved for later."));
    refresh();
    return root;
  }

  function factorRow(f) {
    const fs = h("fieldset", { class: "factor" + (f.tier === "soon" ? " is-soon" : ""), "data-factor": f.id },
      h("legend", {}, f.label, tierBadge(f.tier), h("span", { class: "prio-tag", "data-factor": f.id })));
    if (f.question) fs.append(h("p", { class: "f-q" }, f.question));
    fs.append(segmented({
      name: `f-${f.id}`, options: f.options, value: draft.levels[f.id],
      onChange: (v) => { draft.levels[f.id] = v; },
    }));
    fs.append(h("p", { class: "f-hint" }, f.hint +
      (f.tier === "soon" ? " Your answer is saved for when this is available." : "")));
    return fs;
  }

  function buildMusts() {
    return h("div", {}, ctx.heading("Your must-haves and nice-to-haves"),
      h("p", { class: "pm-sub" }, "A section marked “lighting unknown” stays available and is shown as unknown. " +
        "It is never described as unlit or dangerous."),
      ...P.FACTORS.filter(f => f.group === "core").map(factorRow));
  }

  function buildMore() {
    const sec = (title, intro, ids) => h("div", { class: "more-group" },
      h("h3", { class: "pm-sec-title" }, title),
      intro ? h("p", { class: "pm-sub" }, intro) : null,
      ...ids.map(id => factorRow(P.FACTORS.find(f => f.id === id))));
    return h("div", {}, ctx.heading("More route preferences (optional)"),
      h("p", { class: "pm-sub" }, "These describe path features, not you. Skip anything you like. If we can’t verify " +
        "a requirement across a whole route, we’ll say “We cannot confirm a route that meets this requirement” " +
        "rather than quietly showing one."),
      sec("Path features", null, ["surface", "slopes", "narrow", "kerbs"]),
      sec("Surroundings", "Shown as a description of the path, not a safety judgement.",
        ["traffic", "underpasses", "passages", "shared"]),
      sec("Resting places", null, ["pauses"]),
      sec("Help nearby", null, ["assist"]));
  }

  function buildShow() {
    const root = h("div", {}, ctx.heading("How should we show routes?"));

    root.append(h("fieldset", { class: "factor" },
      h("legend", {}, "Directions"),
      ...P.DIRECTIONS.map((d) => {
        const id = uid("dir");
        const input = h("input", { type: "radio", name: "directions", id, value: d.value, checked: draft.display.directions === d.value });
        input.addEventListener("change", () => { if (input.checked) draft.display.directions = d.value; });
        return h("label", { class: "opt", for: id }, input, h("span", { class: "opt-text" }, d.label),
          d.tier === "ready" ? null : tierBadge(d.tier));
      }),
      h("p", { class: "f-hint" }, "For now you get the map, a short text summary and a Google Maps button. " +
        "Other choices are saved for when they exist.")));

    root.append(h("div", { class: "factor" },
      checkRow({ label: "Large text and fewer instructions per screen", role: "switch",
        checked: draft.display.large,
        onChange: (v) => { draft.display.large = v; document.body.classList.toggle("large-text", v); } }),
      h("p", { class: "f-hint" }, "Works right away so you can see the effect.")));

    root.append(h("fieldset", { class: "factor" },
      h("legend", {}, "What should each route card show?"),
      ...P.CARD_ITEMS.map(c => checkRow({
        label: c.label, tier: c.tier === "ready" ? null : c.tier, checked: draft.display.cardItems.includes(c.id),
        onChange: (v) => {
          const s = new Set(draft.display.cardItems);
          v ? s.add(c.id) : s.delete(c.id);
          draft.display.cardItems = P.CARD_ITEMS.map(x => x.id).filter(id => s.has(id));
        } })),
      h("p", { class: "f-hint" }, "Everything is on by default; hide what you don’t want. Route cards will use this once route matching is on.")));

    const noteId = uid("note");
    const count = h("span", { class: "count" });
    const note = h("textarea", { id: noteId, rows: "3", maxlength: String(P.NOTE_MAX) });
    note.value = draft.note;
    const upd = () => { draft.note = note.value; count.textContent = `${note.value.length}/${P.NOTE_MAX}`; };
    note.addEventListener("input", upd); upd();
    root.append(h("div", { class: "factor" },
      h("label", { class: "block", for: noteId }, "Is there anything else you want us to consider? You can leave this blank."),
      note, count,
      h("p", { class: "f-hint" }, "Kept privately on this device. Nothing reads it yet.")));

    root.append(h("div", { class: "factor" },
      checkRow({ label: "Save these preferences on this device", role: "switch", checked: draft.save,
        onChange: (v) => { draft.save = v; } }),
      h("p", { class: "f-hint" }, "Stored in your browser only: no account, and your preferences are never sent anywhere. " +
        "Turn this off to use them for this visit only. (Destinations you type are looked up with OpenStreetMap’s " +
        "Nominatim service, a third party; preferences are not part of that request.)")));
    return root;
  }

  const STEPS = [
    { build: buildStart, settings: buildPresetsSection },
    { build: buildWhen }, { build: buildPriorities }, { build: buildMusts },
    { build: buildMore }, { build: buildShow },
  ];

  /* "Top priority #n" tags on the must-have rows follow the ranking. */
  function updateTags() {
    if (!modal || !draft) return;
    modal.querySelectorAll(".prio-tag").forEach((el) => {
      const i = draft.priorities.indexOf(el.dataset.factor);
      el.textContent = i >= 0 ? `Top priority #${i + 1}` : "";
    });
  }

  /* ------------------------------ modal frame --------------------------- */
  const btn = (label, cls, onClick) => h("button", { type: "button", class: `pm-btn ${cls || ""}`, onclick: onClick }, label);

  function buildModal() {
    stepLabel = h("p", { class: "pm-step" });
    progress = h("span");
    body = h("div", { class: "pm-body" });
    foot = h("div", { class: "pm-foot" });
    const sos = h("button", { type: "button", class: "pm-sos", "aria-label": "Emergency SOS",
      onclick: () => { const b = document.getElementById("sos-open"); if (b) b.click(); } }, "SOS");
    const close = h("button", { type: "button", class: "pm-close", "aria-label": mode === "wizard" ? "Skip for now" : "Close without saving",
      onclick: () => cancel() }, "×");
    modal = h("div", { id: "prefs-modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "pm-title" },
      h("div", { class: "pm-card" },
        h("div", { class: "pm-head" },
          h("div", { class: "pm-head-row" }, stepLabel, h("div", { class: "pm-head-actions" }, sos, close)),
          mode === "wizard" ? h("div", { class: "pm-progress", "aria-hidden": "true" }, progress) : null,
          mode === "settings" ? h("h2", { id: "pm-title", class: "pm-title", tabindex: "-1" }, "Route preferences") : null),
        body, foot));
    document.body.append(modal);
  }

  function render(opts) {
    const o = opts || {};
    const y = body.scrollTop;
    if (mode === "wizard") {
      body.replaceChildren(STEPS[step].build());
      stepLabel.textContent = `Step ${step + 1} of ${STEPS.length}`;
      progress.style.width = `${((step + 1) / STEPS.length) * 100}%`;
    } else {
      body.replaceChildren(...STEPS.map((s) => h("section", { class: "pm-section" }, (s.settings || s.build)())));
      stepLabel.textContent = "Settings";
    }
    renderFooter();
    updateTags();
    body.scrollTop = o.keepScroll ? y : 0;
    const target = (o.focus && body.querySelector(o.focus)) || modal.querySelector("#pm-title");
    if (target) target.focus({ preventScroll: true });
  }

  function renderFooter() {
    foot.replaceChildren();
    if (mode === "settings") {
      foot.append(
        h("div", { class: "pm-foot-left" },
          btn("Reset to defaults", "", () => { draft = P.defaultPrefs(); document.body.classList.toggle("large-text", false); render({ keepScroll: true }); }),
          btn("Delete saved preferences", "danger", deleteSaved)),
        h("div", { class: "pm-foot-right" }, btn("Cancel", "", cancel), btn("Save", "primary", commit)));
      return;
    }
    const last = step === STEPS.length - 1;
    foot.append(
      h("div", { class: "pm-foot-left" }, step > 0 ? btn("Back", "", () => go(-1)) : null),
      h("div", { class: "pm-foot-right" },
        step === 0 ? btn("Skip for now", "", cancel) : (last ? null : btn("Skip this screen", "", () => go(1))),
        last ? btn("Finish", "primary", commit) : btn("Next", "primary", () => go(1))));
  }

  const go = (d) => { step = Math.max(0, Math.min(STEPS.length - 1, step + d)); render(); };

  function open(m) {
    if (modal) return;
    mode = m === "settings" ? "settings" : "wizard";
    draft = P.clone(current);
    step = 0;
    opener = document.activeElement;
    buildModal();
    render();
    document.addEventListener("keydown", onKey, true);
  }

  function close() {
    document.removeEventListener("keydown", onKey, true);
    if (modal) modal.remove();
    modal = body = foot = stepLabel = progress = draft = null;
    applyDisplay();                                  // undo any live large-text preview
    if (opener && opener.focus && document.contains(opener)) opener.focus();
    opener = null;
  }

  function cancel() {
    if (mode === "wizard" && !savedOnDevice && !sessionSet && session) { try { session.setItem(SKIP_KEY, "1"); } catch (e) { /* ignore */ } }
    close();
  }

  function commit() {
    const prefs = P.sanitize(draft);
    current = prefs;
    sessionSet = true;
    if (prefs.save) savedOnDevice = !!local && P.stored.save(local, prefs);
    else { if (local) P.stored.clear(local); savedOnDevice = false; }
    close();
    renderCard(prefs.save && !savedOnDevice ? "Couldn’t save on this device (storage is blocked), so these are kept for this visit only." : "");
  }

  function deleteSaved() {
    if (!window.confirm("Delete your saved route preferences from this device?")) return;
    if (local) P.stored.clear(local);
    if (session) { try { session.removeItem(SKIP_KEY); } catch (e) { /* ignore */ } }
    current = P.defaultPrefs(); savedOnDevice = false; sessionSet = false;
    close();
    renderCard();
  }

  function onKey(e) {
    if (!modal) return;
    const sos = document.getElementById("sos-overlay");
    if (sos && !sos.classList.contains("hidden")) return;        // let the SOS screen handle keys
    if (e.key === "Escape") { e.preventDefault(); cancel(); return; }
    if (e.key !== "Tab") return;
    const f = [...modal.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])')]
      .filter(el => el.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1], inside = modal.contains(document.activeElement);
    if (e.shiftKey && (!inside || document.activeElement === first)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (!inside || document.activeElement === last)) { e.preventDefault(); first.focus(); }
  }

  /* --------------------------- summary card ----------------------------- */
  function renderCard(extraNote) {
    const el = document.getElementById("prefs-card");
    if (!el) return;
    const set = savedOnDevice || sessionSet;
    el.replaceChildren(h("div", { class: "pc-head" }, h("h2", {}, "Your route preferences"),
      h("span", { class: "tier tier-soon" }, "Preview")));
    if (set) {
      const items = P.summarise(current);
      const list = h("ul", { class: "pc-chips" });
      items.slice(0, 5).forEach(i => list.append(h("li", {}, i.text)));
      if (items.length > 5) list.append(h("li", { class: "more" }, `+${items.length - 5} more`));
      el.append(list, h("p", { class: "pc-note" },
        (savedOnDevice ? "Saved on this device. " : "Kept for this visit only. ") +
        "Preview: routes aren’t matched to your answers yet; your start time and large text already apply. " + (extraNote || "")));
    } else {
      el.append(h("p", { class: "pc-note" }, "Tell us what matters on your walk. It takes about a minute and every question can be skipped."));
    }
    el.append(h("button", { type: "button", class: "pc-btn", onclick: () => open(set ? "settings" : "wizard") },
      set ? "Edit preferences" : "Set your preferences"));
  }

  /* ------------------------------- start-up ----------------------------- */
  function init() {
    const loaded = P.stored.load(local);
    current = loaded.prefs;
    savedOnDevice = loaded.saved;
    applyDisplay();
    renderCard();
    const gear = document.getElementById("prefs-open");
    if (gear) gear.addEventListener("click", () => open("settings"));
    const skipped = session && safe(() => session.getItem(SKIP_KEY)) === "1";
    if (!savedOnDevice && !skipped) open("wizard");
  }

  window.OdysseyQuestionnaire = {
    open,
    getPrefs: () => P.clone(current),
    departureMs: () => P.departureMs(current, Date.now()),
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
