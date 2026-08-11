/* DO NOT EDIT — generated copy of public/gear/tier.js (companion/scripts/sync-vendor.mjs).
   Edit the original; both the site and this app load the same logic. */
/* Item Upgrade System tier math (wiki-documented rule) — the ONE
   implementation, loaded by /gear and vendor-synced into the companion app
   (companion/scripts/sync-vendor.mjs). Edit here; never fork.
   stat@N = max(floor(base × (1 + N/10)), stat@(N-1) + 1). Negative stats are
   left as-is: the wiki states the rule for increases only. */
(function () {
  "use strict";
  function statAt(base, n) {
    if (base <= 0 || !n) return base;
    let s = base;
    // integer math: base*(1+i/10) hits IEEE-754 traps (45*1.4 = 62.999…)
    for (let i = 1; i <= n; i++) s = Math.max(Math.floor(base * (10 + i) / 10), s + 1);
    return s;
  }
  function statsAt(rec, n) {
    const out = {};
    for (const k in rec.st || {}) out[k] = statAt(rec.st[k], n);
    return out;
  }
  window.EQLTier = { statAt, statsAt };
})();
