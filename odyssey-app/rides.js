/* Odyssey — "get a ride instead" suggestion: when to show it, the Uber / Bolt /
 * share links, and the banner + bottom sheet. No keys, no server.
 *
 * What is and isn't possible (checked Oct 2026):
 *  - Uber publishes deep links that open Uber with pickup and destination
 *    filled in. Uber's examples all carry a developer client_id; whether the
 *    link works without one is undocumented, so test it on a phone. If Uber
 *    ignores the destination, add a free client_id (see uberUrl).
 *  - Bolt has no public pre-fill link or API, so we only open Bolt's site.
 *  - Live nearby drivers, prices and ETAs are not available to outside apps.
 *    They appear inside Uber or Bolt once the person taps through.
 * The wording is deliberately neutral: the data can't prove a route is unsafe.
 */
"use strict";
(function (root) {
  const BOLT_URL = "https://bolt.eu/en-gb/";    // no pre-fill link exists: change here if one does
  const UBER_CLIENT_ID = "";                    // optional free developer client ID
  const LATE_FROM = 22, LATE_TO = 6;            // "late-night" = 22:00 to 05:59
  const LIT_MIN_SHARE = 0.5;                    // late walk + confirmed lighting under this
  const HIGH_BAND_SHARE = 0.25;                 // share of route in Athena's highest band

  /* Why a ride might be worth suggesting. m = route metrics (see analyseRoute
   * in app.js). Returns [] when nothing applies or the setting is off. */
  function rideReasons(m, prefs, departMs) {
    const r = prefs && prefs.ride;
    if (!r || !r.on || !m) return [];
    const out = [];
    const L = Math.max(m.lenM, 1);
    if (m.minutes > r.minutes) {
      out.push({ id: "long", chip: `Over ${r.minutes} min`,
        text: `This is a ${Math.round(m.minutes)}-minute walk.` });
    }
    const hour = new Date(departMs).getHours();
    const lit = m.lit.confirmed / L;
    if ((hour >= LATE_FROM || hour < LATE_TO) && lit < LIT_MIN_SHARE) {
      out.push({ id: "late", chip: "Late start, little confirmed lighting",
        text: `It's a late-night walk and lighting is confirmed on only ${Math.round(lit * 100)}% of this route.` });
    }
    if (m.band.high / L >= HIGH_BAND_SHARE) {
      out.push({ id: "crime", chip: "Higher recorded crime nearby",
        text: "Part of this route is in the area with the most recorded crime." });
    }
    return out;
  }

  /* Uber link. from/to = [lat, lng]. fromIsGps = the start is the person's
   * live location, so Uber can use its own "my location". Brackets stay
   * literal, as in Uber's examples; values are encoded. */
  function uberUrl(to, destName, from, fromIsGps) {
    const enc = encodeURIComponent;
    const name = destName || "Destination";
    const pickup = fromIsGps
      ? "pickup=my_location"
      : `pickup[latitude]=${from[0].toFixed(6)}&pickup[longitude]=${from[1].toFixed(6)}&pickup[nickname]=${enc("Start")}`;
    return "https://m.uber.com/ul/?" + (UBER_CLIENT_ID ? `client_id=${enc(UBER_CLIENT_ID)}&` : "") +
      `action=setPickup&${pickup}` +
      `&dropoff[latitude]=${to[0].toFixed(6)}&dropoff[longitude]=${to[1].toFixed(6)}` +
      `&dropoff[nickname]=${enc(name)}&dropoff[formatted_address]=${enc(name + ", Southampton")}`;
  }

  /* Share the route link: phone share menu if there is one, else copy it. */
  async function shareRoute(url, destName) {
    const data = { title: "My walking route", text: `Walking to ${destName || "my destination"}`, url };
    if (typeof navigator !== "undefined" && navigator.share) {
      try { await navigator.share(data); return "shared"; }
      catch (e) { if (e && e.name === "AbortError") return "cancelled"; }
    }
    try { await navigator.clipboard.writeText(url); return "copied"; } catch (e) { return "failed"; }
  }

  /* ------------------------------- UI ----------------------------------- */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  }

  /* The small banner inside a route card. onOpen() opens the sheet. */
  function banner(reasons, onOpen) {
    return h("div", { class: "ride-banner" },
      h("p", { class: "rb-text" }, `${reasons[0].text} Want a ride instead?`),
      h("div", { class: "rb-chips" }, ...reasons.map(r => h("span", { class: "rb-chip" }, r.chip))),
      h("button", { type: "button", class: "rb-open", onclick: onOpen }, "See ride options"));
  }

  let sheet = null, sheetOpener = null;

  function closeSheet() {
    if (!sheet) return;
    document.removeEventListener("keydown", onKey, true);
    sheet.remove(); sheet = null;
    if (sheetOpener && document.contains(sheetOpener)) sheetOpener.focus();
    sheetOpener = null;
  }

  function onKey(e) {
    if (!sheet) return;
    const sos = document.getElementById("sos-overlay");
    if (sos && !sos.classList.contains("hidden")) return;
    if (e.key === "Escape") { e.preventDefault(); closeSheet(); return; }
    if (e.key !== "Tab") return;
    const f = [...sheet.querySelectorAll("a[href], button:not([disabled]), input")].filter(el => el.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1], inside = sheet.contains(document.activeElement);
    if (e.shiftKey && (!inside || document.activeElement === first)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (!inside || document.activeElement === last)) { e.preventDefault(); first.focus(); }
  }

  /* opts: { from, to, destName, fromIsGps, shareUrl } */
  function openSheet(opts) {
    if (sheet) return;
    sheetOpener = document.activeElement;
    const status = h("p", { class: "rs-status", "aria-live": "polite" });
    const linkBox = h("input", { class: "rs-link hidden", readonly: true, "aria-label": "Route link" });
    const link = (cls, href, name, sub) => h("a", { class: "rs-btn " + cls, href, target: "_blank", rel: "noopener noreferrer" },
      h("span", { class: "rs-name" }, name), h("span", { class: "rs-sub" }, sub));
    const shareBtn = h("button", { type: "button", class: "rs-btn", onclick: async () => {
      const r = await shareRoute(opts.shareUrl, opts.destName);
      status.textContent = { shared: "Shared.", copied: "Link copied. Paste it into a message.",
        cancelled: "", failed: "Couldn't share. Copy the link below." }[r];
      if (r === "failed") { linkBox.value = opts.shareUrl; linkBox.classList.remove("hidden"); linkBox.select(); }
    } }, h("span", { class: "rs-name" }, "Share my route"), h("span", { class: "rs-sub" }, "Send a map link to a friend"));
    const sos = h("button", { type: "button", class: "rs-sos", "aria-label": "Emergency SOS",
      onclick: () => { const b = document.getElementById("sos-open"); if (b) b.click(); } }, "SOS");
    const close = h("button", { type: "button", class: "rs-close", "aria-label": "Close", onclick: closeSheet }, "×");
    sheet = h("div", { id: "ride-sheet", role: "dialog", "aria-modal": "true", "aria-labelledby": "rs-title",
        onclick: (e) => { if (e.target === sheet) closeSheet(); } },
      h("div", { class: "rs-card" },
        h("div", { class: "rs-head" }, h("h2", { id: "rs-title", tabindex: "-1" }, "Get a ride instead"),
          h("div", { class: "rs-head-actions" }, sos, close)),
        h("p", { class: "rs-where" }, `From ${opts.fromIsGps ? "your location" : "your start point"} to ${opts.destName || "your destination"}`),
        link("primary", uberUrl(opts.to, opts.destName, opts.from, opts.fromIsGps), "Open Uber", "Your trip is filled in"),
        link("", BOLT_URL, "Open Bolt", "Opens Bolt's site; you'll enter the destination there"),
        shareBtn, status, linkBox,
        h("p", { class: "rs-foot" }, "Tapping opens that app and shares your pickup and destination with it. Prices and live drivers show there.")));
    document.body.append(sheet);
    document.addEventListener("keydown", onKey, true);
    sheet.querySelector("#rs-title").focus({ preventScroll: true });
  }

  const api = { BOLT_URL, rideReasons, uberUrl, shareRoute, banner, openSheet, closeSheet };
  if (typeof module !== "undefined") module.exports = api;
  else root.OdysseyRides = api;
})(typeof window !== "undefined" ? window : globalThis);
