/* Integration repro for "overlay grows while dragging", run against a REAL
 * Electron window so it exercises the actual DIP<->physical rounding. Needs a
 * display, so it is not part of `npm test`; run it manually:
 *
 *     node_modules/.bin/electron scripts/repro-overlay-geometry.js
 *
 * Exit 0 = pass. It drives a frameless/transparent window (same options as the
 * overlay) through 120 simulated pointermoves two ways:
 *   OLD  — setBounds({ ...getBounds(), x }) : re-sends size, expected to DRIFT
 *   NEW  — moveGeom() from overlay-geom.js  : size held constant, must be stable
 * On a fractional-scale display (e.g. 4K @ 175%) OLD grows tens of px; NEW does
 * not. On an integer-scale display OLD may not drift — the real assertion is NEW.
 */
const { app, BrowserWindow, screen } = require("electron");
const { moveGeom } = require("../overlay-geom");

const STEPS = 120;
const START = { x: 300, y: 300, width: 341, height: 247 };
const near = (a, b) => Math.abs(a - b) <= 1;

const makeWin = () => new BrowserWindow({
  ...START, show: false, transparent: true, frame: false, resizable: true,
  hasShadow: false, skipTaskbar: true,
});

app.whenReady().then(() => {
  const scale = screen.getPrimaryDisplay().scaleFactor;
  let pass = true;
  const rows = [];

  // OLD shape — documents the bug
  {
    const win = makeWin();
    const b0 = win.getBounds();
    for (let i = 0; i < STEPS; i++) {
      const b = win.getBounds();
      win.setBounds({ ...b, x: b.x + 1, y: b.y });
    }
    const b1 = win.getBounds();
    rows.push(["OLD setBounds(size)", `${b0.width}x${b0.height}`, `${b1.width}x${b1.height}`, `dW=${b1.width - b0.width}`]);
    win.destroy();
  }

  // NEW shape — the fix, using the shipped moveGeom
  {
    const win = makeWin();
    const b0 = win.getBounds();
    let g = { x: b0.x, y: b0.y, width: b0.width, height: b0.height };
    for (let i = 0; i < STEPS; i++) {
      g = moveGeom(g, 1, 0);
      win.setBounds({ x: g.x, y: g.y, width: g.width, height: g.height });
    }
    const b1 = win.getBounds();
    const ok = near(b1.width, b0.width) && near(b1.height, b0.height);
    pass = pass && ok;
    rows.push([`NEW moveGeom ${ok ? "PASS" : "FAIL"}`, `${b0.width}x${b0.height}`, `${b1.width}x${b1.height}`, `dW=${b1.width - b0.width}`]);
    win.destroy();
  }

  console.log(`\nscaleFactor = ${scale}${scale % 1 ? " (fractional — the bug's trigger)" : " (integer)"}`);
  for (const r of rows) console.log(r[0].padEnd(24), r[1].padEnd(11), "->", r[2].padEnd(11), r[3]);
  console.log(pass ? "\nRESULT: PASS\n" : "\nRESULT: FAIL\n");
  app.exit(pass ? 0 : 1);
});
