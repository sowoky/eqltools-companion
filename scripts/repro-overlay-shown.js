/* End-to-end regression test for "the overlay never auto-restores after a
 * clean quit" (upstream issue #6).
 *
 *   node scripts/repro-overlay-shown.js
 *
 * Runs the REAL app: seeds a disposable userData with `overlay.shown: true`,
 * lets the app boot (which opens the overlay), lets the dev harness quit it
 * cleanly (EQLC_SHOT quits via app.quit(), the same path as closing the main
 * window), then asserts settings.json still says shown:true.
 *
 * Old code fails: the overlay's 'closed' handler fires during quit teardown and
 * persists shown:false, so the restore never survives a clean exit.
 * Exit 0 = pass, 1 = fail.
 */
"use strict";
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.join(__dirname, "..");
const electron = path.join(root, "node_modules", ".bin",
  process.platform === "win32" ? "electron.cmd" : "electron");

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "eqlc-shown-"));
const logDir = path.join(userData, "logs"); fs.mkdirSync(logDir);
const shot = path.join(userData, "shot.png");
fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
  overlay: { shown: true },
  logDir,
}, null, 2));

console.log("userData:", userData);
console.log("launching the real app; the harness will quit it cleanly...");

const child = spawn(electron, ["."], {
  cwd: root,
  env: {
    ...process.env,
    EQLC_USERDATA: userData,
    EQLC_TAB: "zone",          // arms the dev harness (harnessRun)
    EQLC_SHOT: shot,           // harness takes a shot then app.quit()s
    EQLC_SHOT_DELAY: "1500",
  },
  stdio: "ignore",
  shell: process.platform === "win32", // .cmd shim needs a shell on Windows
});

const killTimer = setTimeout(() => {
  console.error("FAIL: app did not quit within 60s");
  child.kill("SIGKILL");
  process.exit(1);
}, 60000);

child.on("exit", () => {
  clearTimeout(killTimer);
  let saved;
  try { saved = JSON.parse(fs.readFileSync(path.join(userData, "settings.json"), "utf8")); }
  catch (e) { console.error("FAIL: could not read back settings.json:", e.message); process.exit(1); }
  const shown = saved && saved.overlay && saved.overlay.shown;
  console.log("persisted overlay.shown =", shown);
  if (shown === true) { console.log("PASS: a clean quit kept the user's shown intent"); process.exit(0); }
  console.error("FAIL: quit clobbered overlay.shown (the restore can never fire)");
  process.exit(1);
});
