/* DO NOT EDIT — generated copy of public/kills/shared.js (companion/scripts/sync-vendor.mjs).
   Edit the original; both the site and this app load the same logic. */
// EQLKills — the /kills tracker's state + credit rules, shared verbatim with
// /atlas (KILLS tab, world dots) so the two surfaces can never disagree.
// State is written only by /kills; the atlas reads it. No DOM in here.
//
// Credit rules (docs/tools/kills.md):
//  - a kill in a zone credits that zone's same-named mob row;
//  - a NAMED kill credits every zone listing that name (same individual);
//  - a generic kill credits other zones only with settings.genericEverywhere;
//  - witnessed kills (slain_by with no xp line) live in a separate `wit`
//    bucket and only count while settings.witnessed is on — the toggle is
//    retroactive because the buckets are kept apart.
window.EQLKills = (() => {
  const KEY = "eqlt-kills-v1";
  const UNPLACED = "?";
  const DEFAULTS = { ignoreCities: true, ignoredZones: [], unignoredZones: [], genericEverywhere: false, witnessed: false };

  const blank = () => ({
    v: 1, updatedAt: 0, chars: [], files: {},
    settings: { ...DEFAULTS, ignoredZones: [], unignoredZones: [] },
    kills: {}, wit: {}, unmatched: {},
  });

  // Matching key for a mob name. The log prints some victims without their
  // article ("orc legionnaire" for the roster's "an orc legionnaire") and the
  // wiki drops EQ's backtick apostrophes ("Ambassador Dvinn" for the log's
  // "Ambassador D`Vinn") — so both sides normalize: lowercase, one leading
  // article off, backticks/apostrophes out, whitespace collapsed.
  function normName(n) {
    let s = String(n).toLowerCase().replace(/[`']/g, "").replace(/\s+/g, " ").trim();
    for (const art of ["a ", "an ", "the "]) if (s.startsWith(art)) return s.slice(art.length);
    return s;
  }

  // Re-key a state written before normName existed (raw-lowercase keys).
  // Idempotent: normName of a normalized key is itself.
  function migrateNames(s) {
    for (const bucket of [s.kills, s.wit]) {
      for (const [z, mobs] of Object.entries(bucket)) {
        const out = {};
        for (const [n, e] of Object.entries(mobs)) {
          const k = normName(n);
          if (out[k]) { out[k].c += e.c; out[k].t = Math.min(out[k].t, e.t); }
          else out[k] = e;
        }
        bucket[z] = out;
      }
    }
    for (const [z, mobs] of Object.entries(s.unmatched)) {
      const out = {};
      for (const [n, c] of Object.entries(mobs)) out[normName(n)] = (out[normName(n)] || 0) + c;
      s.unmatched[z] = out;
    }
    return s;
  }

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY));
      if (!s || s.v !== 1) return null;
      s.settings = { ...DEFAULTS, ...s.settings };
      return migrateNames(s);
    } catch { return null; }
  }

  function save(s) {
    s.updatedAt = Date.now();
    try { localStorage.setItem(KEY, JSON.stringify(s)); return true; }
    catch { return false; }
  }

  const clear = () => { try { localStorage.removeItem(KEY); } catch {} };

  // Every killed name (lowercase) across all zones incl. the unplaced bucket;
  // the cross-zone credit pool for named mobs and generic-everywhere.
  function globalKilled(s) {
    const g = new Set();
    for (const z of Object.values(s.kills)) for (const n of Object.keys(z)) g.add(n);
    if (s.settings.witnessed)
      for (const z of Object.values(s.wit)) for (const n of Object.keys(z)) g.add(n);
    return g;
  }

  const inZone = (bucket, zkey, n) => !!(bucket[zkey] && bucket[zkey][n]);

  // row: a roster mob {n, named, ...}. glob: globalKilled(s).
  function credited(s, glob, zkey, row) {
    const n = normName(row.n);
    if (inZone(s.kills, zkey, n)) return true;
    if (s.settings.witnessed && inZone(s.wit, zkey, n)) return true;
    if ((row.named || s.settings.genericEverywhere) && glob.has(n)) return true;
    return false;
  }

  // zoneMeta: kills-data.json zones[key] ({name, city, mobs}); null-safe for
  // callers that only know the key (custom ignores still apply).
  // Per-zone choices beat the city rule: ignoredZones force-ignores any zone,
  // unignoredZones whitelists a city back in without dropping the rule.
  function zoneIgnored(s, zkey, zoneMeta) {
    if (s.settings.ignoredZones.includes(zkey)) return true;
    if (s.settings.unignoredZones.includes(zkey)) return false;
    return !!(s.settings.ignoreCities && zoneMeta && zoneMeta.city);
  }

  // Numeric level for sorting when only the raw wiki string is at hand (the
  // atlas rows have no precomputed lv). First number or range midpoint;
  // tolerates '24 - 26', '34 ~ 38'; null for '?' and prose.
  function lvlNum(raw) {
    if (typeof raw === "number") return raw;
    if (!raw) return null;
    const s = String(raw).replace(/~/g, "-");
    const r = /(\d+)\s*-\s*(\d+)/.exec(s);
    if (r) return (+r[1] + +r[2]) / 2;
    const m = /\d+/.exec(s);
    return m ? +m[0] : null;
  }

  // Kyle's ordering for a missing list: named before generic, level high->low
  // inside each, unknown level last, then name.
  function sortRows(rows) {
    return rows.slice().sort((a, b) => {
      if (!!b.named !== !!a.named) return b.named ? 1 : -1;
      const la = a.lv !== undefined ? a.lv : lvlNum(a.lvl);
      const lb = b.lv !== undefined ? b.lv : lvlNum(b.lvl);
      if (la == null && lb != null) return 1;
      if (lb == null && la != null) return -1;
      if (la != null && lb != null && lb !== la) return lb - la;
      return a.n.toLowerCase() < b.n.toLowerCase() ? -1 : 1;
    });
  }

  // Per-zone and overall completion over the kills-data roster, settings
  // applied. Returns {zones: {key: {done, total, ignored}}, done, total,
  // zonesDone, zonesTotal} — counting only non-ignored zones with mobs.
  function summarize(s, dataZones) {
    const glob = globalKilled(s);
    const zones = {};
    let done = 0, total = 0, zonesDone = 0, zonesTotal = 0;
    for (const [key, z] of Object.entries(dataZones)) {
      if (!z.mobs.length) continue;
      const ig = zoneIgnored(s, key, z);
      let d = 0;
      for (const row of z.mobs) if (credited(s, glob, key, row)) d++;
      zones[key] = { done: d, total: z.mobs.length, ignored: ig };
      if (!ig) {
        done += d; total += z.mobs.length; zonesTotal++;
        if (d === z.mobs.length) zonesDone++;
      }
    }
    return { zones, done, total, zonesDone, zonesTotal, glob };
  }

  return { KEY, UNPLACED, DEFAULTS, blank, load, save, clear, normName,
           globalKilled, credited, zoneIgnored, lvlNum, sortRows, summarize };
})();
