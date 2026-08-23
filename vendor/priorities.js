/* DO NOT EDIT — generated copy of public/_shared/priorities.js (companion/scripts/sync-vendor.mjs).
   Edit the original; both the site and this app load the same logic. */
/* Priorities — the one place the stat weights are edited.

   gear-score.js derives a weight per stat from the trio, level and (with a
   race) the character's own totals; a player can override any of them. Those
   overrides are read by every scorer built FOR THE TRIO — /gear's catalogue,
   /valet's walk, slot tables and catalogue gap, /sky's trio comparison — so
   they have to be edited in one place and stored under one key. /gear and
   /valet each carried their own copy of the panel over a field inside /gear's
   prefs, and /sky ignored the field altogether (Kyle, 2026-08-23: "when we
   come up with these rankings, that we use for multiple things. i need to be
   able to tweak these stat priorities in a central place").

   What the overrides do NOT touch: a scorer built for one class on its own —
   the "N of M" catalogue rank of an item for a Cleric, Spare's sixteen
   per-class verdicts. An override says what a point of AC is worth to YOU;
   it says nothing about what it is worth to a class you are not playing.

   ── the store ─────────────────────────────────────────────────────────────
   `eqlt-priorities-v1` holds { w: { stat: weight } }. The first read moves
   any overrides still sitting in `eqlt-gear-v2.w` (where /gear and /valet
   used to keep them) and strips them from there, so a save of /gear's prefs
   blob can never clobber an edit made elsewhere. The companion app is another
   origin and cannot see this store; it mounts the same widget over a store of
   its own (`store` option).

   ── API ───────────────────────────────────────────────────────────────────
     EQLPriorities.read(store?)            -> { stat: weight }
     EQLPriorities.write(w, store?)        persists, then fires "eqlt-priorities"
     EQLPriorities.mount(el, opts)         draws the panel into `el`
       opts.scorer   () => an EQLGearScore.make() result for the trio
       opts.onChange () => called after every edit, reset, or a write from
                     another tab / another mount on the same page
       opts.store    { read(), write(w) } — default: the shared site store
       opts.note     the sentence under the heading; null for none
       opts.summary  an element whose text gets "(3 custom)" / "(computed …)"
       opts.btnClass the host's small-button class (default "btn-sm")
       returns { draw() }  — call draw() after the trio or level changes, so
                     the "auto" values shown track the scorer
     EQLPriorities.summary(w)              -> "(3 custom)" | "(computed for your trio)"

   Requires: window.EQLGearScore (STAT_DEFS); EQLTip if present (the "why"
   tooltips), else each stat name carries its derivation as a title. */
(function () {
  "use strict";
  const KEY = "eqlt-priorities-v1", OLD = "eqlt-gear-v2";
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const getJ = (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } };
  const setJ = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

  function localStore(key) {
    return {
      read() {
        let s = getJ(key);
        if (key === KEY && !s) {
          // first read on this origin: adopt what /gear's blob was holding
          const g = getJ(OLD);
          if (g && g.w && typeof g.w === "object") {
            s = { w: g.w };
            delete g.w; setJ(OLD, g); setJ(KEY, s);
          }
        }
        return (s && s.w && typeof s.w === "object") ? Object.assign({}, s.w) : {};
      },
      write(w) { setJ(key, { w: w || {} }); },
    };
  }
  const SITE = localStore(KEY);
  const read = (store) => (store || SITE).read();
  function write(w, store) {
    (store || SITE).write(w);
    window.dispatchEvent(new CustomEvent("eqlt-priorities", { detail: { store: store || SITE } }));
  }
  const summary = (w) => {
    const n = Object.keys(w || {}).length;
    return n ? `(${n} custom)` : "(computed for your trio)";
  };

  /* The base note. A host that prints a single-class ranking appends the
     sentence saying that ranking keeps the class's own computed weights, in
     the words its own column or mode uses — /gear prints none and says
     nothing. */
  const NOTE = "HP-equivalents per point of the stat. Computed from your trio and level, or from "
    + "your own totals once a race is set. Hover a stat for the derivation. Edits here apply on "
    + "/gear, /valet and /sky.";

  function mount(el, opts) {
    const store = opts.store || SITE;
    const note = opts.note === undefined ? NOTE : opts.note;
    const tip = !!window.EQLTip;
    if (tip) EQLTip.provider("w", (k) => (opts.scorer().why || {})[k] || null);

    function draw() {
      const S = opts.scorer(), auto = S.computed || {}, why = S.why || {}, cur = store.read();
      const rows = window.EQLGearScore.STAT_DEFS.map(([k, label]) => {
        const custom = k in cur;
        const name = tip
          ? `<span class="prio-name tt" data-tip="w:${k}" data-tip-nopin>${esc(label)}</span>`
          : `<span class="prio-name" title="${esc(String(why[k] || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())}">${esc(label)}</span>`;
        return `<label class="prio-row${custom ? " custom" : ""}">
          ${name}
          <input type="number" step="0.1" min="0" max="99" data-w="${k}" value="${custom ? cur[k] : auto[k]}">
          <span class="fine">${custom ? "custom" : "auto"}</span>
        </label>`;
      }).join("");
      el.innerHTML = (note ? `<p class="fine prio-note">${esc(note)}</p>` : "")
        + `<div class="prio-grid">${rows}</div>`
        + `<div class="prio-foot"><button type="button" class="${esc(opts.btnClass || "btn-sm")} prio-reset">reset to computed</button></div>`;
      if (opts.summary) opts.summary.textContent = summary(cur);
      if (tip) EQLTip.decorate();
    }
    el.addEventListener("change", (e) => {
      const inp = e.target.closest("[data-w]");
      if (!inp) return;
      const k = inp.dataset.w, v = parseFloat(inp.value), w = store.read();
      const c = Math.min(99, Math.max(0, v));   // the input's min/max are advisory in Chrome
      if (isNaN(v) || c === opts.scorer().computed[k]) delete w[k]; else w[k] = c;
      write(w, store);
    });
    el.addEventListener("click", (e) => {
      if (!e.target.closest(".prio-reset")) return;
      write({}, store);
    });
    /* Another mount on this page, or this page's own edit: redraw and tell
       the page. The same store edited in another tab arrives as a storage
       event. */
    window.addEventListener("eqlt-priorities", (e) => {
      if (e.detail && e.detail.store !== store) return;
      draw(); if (opts.onChange) opts.onChange();
    });
    window.addEventListener("storage", (e) => {
      if (e.key !== KEY || store !== SITE) return;
      draw(); if (opts.onChange) opts.onChange();
    });
    draw();
    return { draw };
  }

  window.EQLPriorities = { KEY, NOTE, localStore, read, write, mount, summary };
})();
