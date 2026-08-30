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

  /* Presets — one-click override bundles for the three gearing camps the
     player corpus actually argues from (2026-08 study). Each REPLACES the
     current overrides with a few stats; everything unnamed stays computed.
     A value that matches the computed one is dropped, so the "(N custom)"
     count stays honest. Two are trio-conditional: mana only moves when the
     trio has a counted pool, haste is left at 0 for a cast-heavy trio. */
  const PRESETS = [
    { k: "tank", label: "Tank / solo",
      title: "Sets AC to 4 and each resist to 0.8; everything else stays computed. For tanking or soloing, where mitigation is the buy.",
      w: () => ({ ac: 4, sv: 0.8 }) },
    /* No haste override here: zeroing the weight would also devalue the one
       item that gets a character TO the 75% cap, and the scorer has no
       current-haste plumbing to price only the excess. */
    { k: "geared50", label: "Geared at 50",
      title: "Sets AC to 1, resists to 0.6, and mana to 1.3 if your trio has a pool; everything else stays computed. Past the softcap AC buys less, and at 50 the pools keep paying.",
      w: (auto) => Object.assign({ ac: 1, sv: 0.6 }, auto.mana > 0 ? { mana: 1.3 } : {}) },
    { k: "leveling", label: "Leveling",
      title: "Sets AC to 3, and haste to 3 unless your trio is cast-heavy. Below the caps, AC and haste are the strongest buys.",
      w: (auto) => Object.assign({ ac: 3 }, auto.haste > 0 ? { haste: 3 } : {}) },
  ];

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
      const bundleOf = (p) => {
        const b = p.w(auto), out = {};
        for (const k in b) if (b[k] !== auto[k]) out[k] = b[k];
        return out;
      };
      const active = (b) => {
        const ks = Object.keys(b);
        return ks.length === Object.keys(cur).length && ks.every((k) => cur[k] === b[k]);
      };
      const presets = PRESETS.map((p) => {
        const b = bundleOf(p);
        return `<button type="button" class="${esc(opts.btnClass || "btn-sm")} prio-preset${active(b) ? " is-on" : ""}"
          data-preset="${p.k}" title="${esc(p.title)}" aria-pressed="${active(b)}">${esc(p.label)}</button>`;
      }).join(" ");
      el.innerHTML = (note ? `<p class="fine prio-note">${esc(note)}</p>` : "")
        + `<div class="prio-presets">${presets}<span class="fine">a preset replaces your custom weights; unlisted stats stay computed</span></div>`
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
      const pb = e.target.closest("[data-preset]");
      if (pb) {
        const p = PRESETS.find((x) => x.k === pb.dataset.preset);
        const auto = opts.scorer().computed || {}, b = p.w(auto), out = {};
        for (const k in b) if (b[k] !== auto[k]) out[k] = b[k];
        write(out, store);
        return;
      }
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
