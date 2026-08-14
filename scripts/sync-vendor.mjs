/* Vendor sync — the companion app never forks the site's domain logic.
   public/kills/shared.js (credit rules, state shape) and public/kills/parse.js
   (log grammar, KillStream) are the ONLY implementations; this script copies
   them into companion/vendor/ so dev runs and packaged builds use the exact
   shipped code. It also snapshots the wiki-derived datasets (gitignored,
   built by `uv run eqlt wiki build`) into data-snapshot/ for bundling — the
   packaged app ships whatever data was on disk at build time and refreshes
   itself from eqltools.com at runtime. */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const companion = resolve(here, "..");
const repo = resolve(companion, "..");

/* Standalone checkout (the exported public GitHub repo) has no ../public —
   vendor/ and data-snapshot/ are baked in at export time. Detect and skip. */
if (!existsSync(join(repo, "public", "kills"))) {
  if (existsSync(join(companion, "vendor", "parse.js"))) {
    console.log("sync-vendor: standalone checkout — using baked-in vendor/ and data-snapshot/");
    process.exit(0);
  }
  console.error("sync-vendor: no ../public/kills and no baked vendor/ — broken checkout");
  process.exit(1);
}

const HEADER = (rel) =>
  `/* DO NOT EDIT — generated copy of ${rel} (companion/scripts/sync-vendor.mjs).\n` +
  `   Edit the original; both the site and this app load the same logic. */\n`;

mkdirSync(join(companion, "vendor"), { recursive: true });
/* gear-score.js comes along for baseName — the Sky core resolves an upgraded
   "Efreeti Magi Staff +1" to its base through it, and a second copy of that
   rule is exactly the fork this script exists to prevent. attributes/data.js
   is gear-score's own load-time dependency. */
const VENDOR_JS = {
  "public/kills/shared.js": "shared.js",
  "public/kills/parse.js": "parse.js",
  "public/gear/tier.js": "tier.js",
  "public/attributes/data.js": "attributes-data.js", // basename would collide
  "public/_shared/gear-score.js": "gear-score.js",
  "public/_shared/char-state.js": "char-state.js",   // gear-score's nakedStats() calls EQLChar.name
  "public/sky/sky-core.js": "sky-core.js",
  "public/valet/valet-core.js": "valet-core.js",
  "public/_shared/achievements.js": "achievements.js",
};
for (const [rel, name] of Object.entries(VENDOR_JS)) {
  const src = join(repo, rel);
  if (!existsSync(src)) {
    console.error(`sync-vendor: missing ${rel} — cannot build without it`);
    process.exit(1);
  }
  const out = join(companion, "vendor", name);
  writeFileSync(out, HEADER(rel) + readFileSync(src, "utf8"));
  console.log(`vendor  ${rel}`);
}

mkdirSync(join(companion, "data-snapshot"), { recursive: true });
let missing = 0;
/* sky.json is the one dataset here that is COMMITTED rather than wiki-synced
   (see docs/tools/sky.md) — it is always on disk, and it ships to the site with
   the deploy rather than through the hourly R2 upload. */
for (const rel of ["public/kills/data/kills-data.json", "public/companion/data/quest-items.json", "public/companion/data/item-tooltips.json", "public/gear/data/gear-data.json", "public/sky/data/sky.json"]) {
  const src = join(repo, rel);
  const out = join(companion, "data-snapshot", rel.split("/").pop());
  if (existsSync(src)) {
    copyFileSync(src, out);
    console.log(`data    ${rel}`);
  } else {
    // Wiki-derived data is gitignored; a fresh checkout may not have it. The
    // app still runs (it fetches from eqltools.com), so warn, don't fail.
    console.warn(`sync-vendor: WARNING — ${rel} not on disk; bundle will lack this snapshot`);
    missing++;
  }
}
if (missing) console.warn("sync-vendor: build the wiki data (cd pipeline && uv run eqlt wiki build) for a full snapshot");

/* Per-zone mobs & drops files (the atlas widget's data) — bundled whole so
   the Zone tab works offline; refreshed per-zone from the site at runtime. */
const zwSrc = join(repo, "public", "atlas", "wiki");
if (existsSync(zwSrc)) {
  const zwOut = join(companion, "data-snapshot", "atlas-wiki");
  mkdirSync(zwOut, { recursive: true });
  let n = 0;
  for (const f of readdirSync(zwSrc)) {
    if (!f.endsWith(".json")) continue;
    copyFileSync(join(zwSrc, f), join(zwOut, f));
    n++;
  }
  console.log(`data    public/atlas/wiki (${n} zone files)`);
} else {
  console.warn("sync-vendor: WARNING — public/atlas/wiki missing; Zone tab will be fetch-only");
}

/* /log-parser, split in two so the Parser tab can render the report NATIVELY
   instead of iframing the page: engine.js is the numbers, render.js is the
   panels, and both are the site's own files — same single-implementation rule
   as parse.js. The page's own app.js (intake, drop zone, live watch) is the
   site's host and is deliberately NOT vendored: the app has no file to drop.
   style.css comes over so the panels wear the same clothes. */
const SITE_FILES = [
  "public/log-parser/style.css",
  "public/log-parser/engine.js",
  "public/log-parser/render.js",
  "public/_shared/theme.css",
  "public/_shared/tip.js",
];
/* The parser sheet is written for a whole PAGE: it styles bare th/td/h2/code
   and sets [hidden] globally. Dropped into the app's single document that
   reaches every other tab — it right-aligned the quest table and restyled the
   settings headings. So it is scoped to the Parser pane on the way in, at
   build time rather than by a pile of overrides that go stale the next time
   the site sheet changes.

   The custom properties are the exception: they are declared on :root, which
   is OUTSIDE #tab-parser and so would never match from inside the scope. That
   block is lifted out and kept global. */
function scopeParserCss(css) {
  const roots = [];
  const body = css.replace(/^:root\s*\{[^}]*\}/gm, (m) => { roots.push(m); return ""; });
  return `/* GENERATED by scripts/sync-vendor.mjs from public/log-parser/style.css.\n` +
    `   Do not edit here — edit the site file and re-run \`npm run sync\`.\n` +
    `   Everything but the :root tokens is scoped to the Parser pane. */\n` +
    roots.join("\n") + "\n\n@scope (#tab-parser) {\n" + body.trim() + "\n}\n";
}
for (const rel of SITE_FILES) {
  const src = join(repo, rel);
  if (!existsSync(src)) { console.error(`sync-vendor: missing ${rel}`); process.exit(1); }
  const out = join(companion, "vendor", "site", rel.replace(/^public\//, ""));
  mkdirSync(dirname(out), { recursive: true });
  if (rel === "public/log-parser/style.css") writeFileSync(out, scopeParserCss(readFileSync(src, "utf8")));
  else copyFileSync(src, out);
  console.log(`site    ${rel}`);
}
const fontsSrc = join(repo, "public", "_shared", "fonts");
if (existsSync(fontsSrc)) {
  const fontsOut = join(companion, "vendor", "site", "_shared", "fonts");
  mkdirSync(fontsOut, { recursive: true });
  for (const f of readdirSync(fontsSrc)) if (f.endsWith(".woff2")) copyFileSync(join(fontsSrc, f), join(fontsOut, f));
  console.log("site    public/_shared/fonts");
}

/* Data the parser page fetches — snapshotted under its URL paths; served by
   the eqlt:// protocol (cache first) and refreshed alongside the datasets. */
for (const rel of [
  "public/log-parser/data/con-bands.json",
  "public/log-parser/data/wiki-items.json",
  "public/log-parser/data/wiki-mobs.json",
  "public/spellmaster/data/spells.json",
]) {
  const src = join(repo, rel);
  const out = join(companion, "data-snapshot", rel.replace(/^public\//, ""));
  if (existsSync(src)) {
    mkdirSync(dirname(out), { recursive: true });
    copyFileSync(src, out);
    console.log(`data    ${rel}`);
  } else {
    console.warn(`sync-vendor: WARNING — ${rel} not on disk; parser tab will need the live site for it`);
  }
}
