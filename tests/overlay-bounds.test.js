"use strict";
/* Unit tests for overlay work-area clamping — the fix for "the overlay can be
 * dragged off the top of the screen" and "a saved size bigger than the screen
 * comes back". Pure functions, no Electron, runs under `node --test`.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { clampToDisplay, sanitizeBounds, MIN_W, MIN_H } = require("../overlay-bounds");

// a 2194x1186 work area at the origin, like a 4K@175% desktop minus the taskbar
const WA = { x: 0, y: 0, width: 2194, height: 1186 };

test("clampToDisplay pins the top when dragged above the screen", () => {
  const { x, y } = clampToDisplay(400, -500, 340, 240, WA);
  assert.equal(y, 0, "top must not go above the work area");
  assert.equal(x, 400);
});

test("clampToDisplay pins the far edge when dragged past the right/bottom", () => {
  const r = clampToDisplay(999999, 999999, 340, 240, WA);
  assert.equal(r.x, WA.width - 340);   // 1854
  assert.equal(r.y, WA.height - 240);  // 946
});

test("clampToDisplay leaves an in-bounds window alone", () => {
  const r = clampToDisplay(100, 80, 340, 240, WA);
  assert.deepEqual(r, { x: 100, y: 80 });
});

test("clampToDisplay respects a non-zero work-area origin (second monitor)", () => {
  const wa = { x: -1920, y: 0, width: 1920, height: 1040 };
  const r = clampToDisplay(-5000, -5000, 300, 200, wa);
  assert.equal(r.x, -1920);
  assert.equal(r.y, 0);
});

test("clampToDisplay keeps a too-tall window's title bar on-screen", () => {
  // window taller than the work area: top-left pins to origin, not off the top
  const r = clampToDisplay(50, -300, 300, 5000, WA);
  assert.equal(r.y, 0);
  assert.equal(r.x, 50);
});

test("sanitizeBounds caps an oversized saved bounds to the screen", () => {
  const corrupt = { x: 248, y: -144, width: 1384, height: 1424 }; // the real bug report
  const s = sanitizeBounds(corrupt, WA);
  assert.ok(s.height <= WA.height, `height ${s.height} must fit ${WA.height}`);
  assert.ok(s.width <= WA.width);
  assert.equal(s.y, 0, "off-top y must be pulled on-screen");
  assert.ok(s.x >= 0 && s.x + s.width <= WA.width);
});

test("sanitizeBounds enforces a usable minimum size", () => {
  const s = sanitizeBounds({ x: 10, y: 10, width: 5, height: 5 }, WA);
  assert.equal(s.width, MIN_W);
  assert.equal(s.height, MIN_H);
});

test("sanitizeBounds leaves a sane bounds unchanged", () => {
  const good = { x: 100, y: 100, width: 340, height: 240 };
  assert.deepEqual(sanitizeBounds(good, WA), good);
});

/* settings.json is user-editable and survives crashes mid-write: fields can
   come back as strings, null, or missing. One NaN reaching BrowserWindow
   throws, so every field must coerce to a finite number. */
test("sanitizeBounds survives type-corrupted saved bounds without NaN", () => {
  const cases = [
    { x: "abc", y: null, width: "1384", height: undefined },
    { x: NaN, y: -144, width: NaN, height: 1424 },
    {},                                        // all fields missing
    { x: "248", y: "-144", width: "340", height: "240" }, // numeric strings OK
  ];
  for (const c of cases) {
    const s = sanitizeBounds(c, WA);
    for (const k of ["x", "y", "width", "height"])
      assert.ok(Number.isFinite(s[k]), `${k} must be finite for ${JSON.stringify(c)}, got ${s[k]}`);
    assert.ok(s.width >= MIN_W && s.height >= MIN_H, "size floor holds");
    assert.ok(s.x >= WA.x && s.y >= WA.y, "position pulled on-screen");
  }
  // numeric strings should coerce to their values, not fall back
  const s = sanitizeBounds({ x: "248", y: "-144", width: "340", height: "240" }, WA);
  assert.deepEqual(s, { x: 248, y: 0, width: 340, height: 240 });
});

test("sanitizeBounds handles negative and zero sizes", () => {
  const s = sanitizeBounds({ x: 10, y: 10, width: -50, height: 0 }, WA);
  assert.equal(s.width, MIN_W);
  assert.equal(s.height, MIN_H);
});

test("clampToDisplay coerces junk x/y to the work-area origin", () => {
  const r = clampToDisplay(undefined, "junk", 340, 240, WA);
  assert.deepEqual(r, { x: WA.x, y: WA.y });
});
