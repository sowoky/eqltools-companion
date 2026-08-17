#!/usr/bin/env node
/* Drives main.js's tail engine and dataset refresh without Electron.
   `electron` is stubbed just far enough for main.js to load; the functions
   under test come off its exports and run against real temp files.

     node scripts/main-check.mjs

   Exits non-zero on the first failed assertion. Covers:
   - readRange / readTail / readAppended: a file that shrinks between the poll's
     stat and the read must not inject NULs or skip bytes once it regrows.
   - refreshDatasets: per-file clocks — a failed or partial pass never marks a
     file refreshed; failed files retry after REFRESH_RETRY_MS, good ones wait
     REFRESH_MS; a legacy single-number settings value still loads.
   - MIN_SCHEMA: a cached gear-data below the floor yields to the bundle. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const Module = require("node:module");

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "eqlc-userdata-"));
const noop = () => {};
const chain = new Proxy(function () {}, { get: () => chain, apply: () => chain });
const electron = {
  app: {
    isPackaged: false, getPath: () => userData, getVersion: () => "0.0.0-check",
    requestSingleInstanceLock: () => false, quit: noop, on: noop, whenReady: () => Promise.resolve(),
  },
  ipcMain: { handle: noop, on: noop },
  protocol: { registerSchemesAsPrivileged: noop, handle: noop },
  BrowserWindow: chain, Menu: chain, dialog: chain, shell: chain, globalShortcut: chain, screen: chain,
};
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return electron;
  return realLoad.call(this, request, ...rest);
};
const M = require(path.join(here, "..", "main.js"));

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("ok   ", name); }
  catch (e) { failed++; console.log("FAIL ", name, "\n     ", e.message); }
}
const j = (v) => JSON.stringify(v);

/* ── A: tail engine vs a file that shrinks in the poll gap ─────────────── */
const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "eqlc-logs-"));
const f = path.join(logDir, "eqlog_Check_eql.txt");

fs.writeFileSync(f, "line1\n");
const t = { offset: fs.statSync(f).size, remainder: "" };   // bootstrapped at byte 6
fs.appendFileSync(f, "line2-long-long\n");                  // 22 bytes
let size = fs.statSync(f).size;                             // the poll stats 22 ...
fs.writeFileSync(f, "line1\nline2\n");                       // ... and the file shrinks to 12 before the read
let lines = M.readAppended(f, t, size);
check("readAppended: short read yields only the bytes present, no NULs", () => {
  assert.deepEqual(lines, ["line2"]);
  assert.equal(t.remainder, "");
  assert.ok(!lines.join("").includes("\0"));
});
check("readAppended: cursor advances by bytes read (12), not the stale stat (22)", () => assert.equal(t.offset, 12));

fs.appendFileSync(f, "line3\nline4\n");                      // regrows to 24
size = fs.statSync(f).size;
if (size < t.offset) { t.offset = 0; t.remainder = ""; }   // pollTail's shrink rule
lines = size > t.offset ? M.readAppended(f, t, size) : [];
check("readAppended: nothing skipped once the file regrows", () => {
  assert.deepEqual(lines, ["line3", "line4"]);
  assert.equal(t.offset, 24);
});

fs.writeFileSync(f, "a\nb\nc\n");
const tail = M.readTail(f, fs.statSync(f).size + 5);        // stat stale by 5 bytes
check("readTail: stale size gives the real bytes and the real end", () => {
  assert.equal(tail.text, "a\nb\nc\n");
  assert.equal(tail.end, 6);
});
check("readRange: never pads to the requested length", () => {
  const b = M.readRange(f, 2, 100);
  assert.equal(b.length, 4);
  assert.equal(b.toString("utf8"), "b\nc\n");
});
check("readAppended: unreadable file leaves the cursor alone and returns []", () => {
  const u = { offset: 3, remainder: "x" };
  assert.deepEqual(M.readAppended(path.join(logDir, "missing.txt"), u, 10), []);
  assert.deepEqual(u, { offset: 3, remainder: "x" });
});

/* ── B: per-file refresh clocks ────────────────────────────────────────── */
const H = 3600 * 1000, MIN = 60 * 1000;
const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;

const legacyTs = clock - 13 * H;   // an old install: one number, 13 h ago
fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ dataRefreshedAt: legacyTs }));
M.loadSettings();
check("settings: legacy dataRefreshedAt number loads", () => assert.equal(M.settings().dataRefreshedAt, legacyTs));

// A fake site: kills/gear/tooltips + the page files are fine; quest-items
// 404s; sky serves an HTML error page; con-bands is offline.
const calls = [];
const outcome = (url) => {
  if (url.endsWith("quest-items.json")) return { ok: false, status: 404, text: async () => "nope" };
  if (url.endsWith("sky.json")) return { ok: true, status: 200, text: async () => "<html>502</html>" };
  if (url.endsWith("con-bands.json")) throw new TypeError("fetch failed");
  return { ok: true, status: 200, text: async () => JSON.stringify({ schema: 99, from: url }) };
};
globalThis.fetch = async (url) => { calls.push(url); return outcome(url); };
const names = (urls) => urls.map(u => u.replace("https://eqltools.com/", "")).sort();
const FAILING = ["companion/data/quest-items.json", "log-parser/data/con-bands.json", "sky/data/sky.json"];

await M.refreshDatasets(false);
const at = () => M.settings().dataRefreshedAt;
check("pass 1 (13 h stale): every file is fetched", () => assert.equal(calls.length, 9));
check("pass 1: only validated+cached files advance their clock", () => {
  assert.equal(typeof at(), "object");
  assert.equal(at()["kills-data.json"], clock);
  assert.equal(at()["gear-data.json"], clock);
  assert.equal(at()["quest-items.json"], legacyTs, "404 must not advance");
  assert.equal(at()["sky.json"], legacyTs, "non-JSON must not advance");
  assert.equal(at()["log-parser/data/con-bands.json"], legacyTs, "offline must not advance");
});
check("pass 1: cache holds only the good files", () => {
  assert.ok(fs.existsSync(path.join(userData, "data", "kills-data.json")));
  assert.ok(!fs.existsSync(path.join(userData, "data", "quest-items.json")));
  assert.ok(!fs.existsSync(path.join(userData, "data", "sky.json")));
});
check("settings on disk: dataRefreshedAt is the per-file map", () => {
  const disk = JSON.parse(fs.readFileSync(path.join(userData, "settings.json"), "utf8"));
  assert.equal(typeof disk.dataRefreshedAt, "object");
  assert.equal(disk.dataRefreshedAt["gear-data.json"], clock);
});

calls.length = 0;
await M.refreshDatasets(false);
check("pass 2 (immediately): nothing is due, nothing fetched", () => assert.equal(calls.length, 0));

clock += M.REFRESH_RETRY_MS + MIN;
calls.length = 0;
await M.refreshDatasets(false);
check(`pass 3 (+${M.REFRESH_RETRY_MS / MIN + 1} min): only the three failed files retry`, () =>
  assert.deepEqual(names(calls), FAILING));

clock += M.REFRESH_MS + MIN;
calls.length = 0;
await M.refreshDatasets(false);
check("pass 4 (+12 h): every file is due again", () => assert.equal(calls.length, 9));

calls.length = 0;
await M.refreshDatasets(true);
check("force: every file, whatever the clocks say", () => assert.equal(calls.length, 9));

Date.now = realNow;

/* ── C: gear-data schema floor ─────────────────────────────────────────── */
check("MIN_SCHEMA carries a gear-data floor of 2", () => assert.equal(M.MIN_SCHEMA["gear-data.json"], 2));
const gearCache = path.join(userData, "data", "gear-data.json");
fs.writeFileSync(gearCache, JSON.stringify({ schema: 1, items: {} }));
let ds = M.loadDatasets();
check("schema-1 gear cache yields to the bundled snapshot", () => {
  assert.equal(ds["gear-data.json"].source, "bundled (cache too old)");
  assert.equal(ds["gear-data.json"].data.schema, 2);
  assert.ok(ds["gear-data.json"].data.effects && ds["gear-data.json"].data.zone_oe);
});
fs.writeFileSync(gearCache, JSON.stringify({ schema: 2, items: {}, effects: {}, zone_oe: [] }));
ds = M.loadDatasets();
check("schema-2 gear cache is used", () => assert.equal(ds["gear-data.json"].source, "cached"));

fs.rmSync(userData, { recursive: true, force: true });
fs.rmSync(logDir, { recursive: true, force: true });
console.log(failed ? `\n${failed} FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);   // the refresh timer is armed; don't wait 15 min for it
