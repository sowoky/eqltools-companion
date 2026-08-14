"use strict";
/* Unit tests for the overlay geometry model — the fix for "the overlay grows
 * while you drag it". Pure functions, no Electron, runs under `node --test`.
 *
 * The core guarantee: a move NEVER changes the window size. The old code grew
 * the window because it fed the live (rounded) size back into setBounds every
 * pointermove; moveGeom cannot, because it returns the size unchanged. The
 * `driftModel` test below shows why that matters — it models the lossy
 * fractional-scale round-trip and proves the old "read size back each step"
 * shape accumulates while moveGeom stays put.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { moveGeom, resizeGeom, MIN_W, MAX_W, MIN_H, MAX_H } = require("../overlay-geom");

test("moveGeom updates position by the delta", () => {
  const g = { x: 100, y: 200, width: 340, height: 240 };
  const m = moveGeom(g, 15, -30);
  assert.equal(m.x, 115);
  assert.equal(m.y, 170);
});

test("moveGeom NEVER changes width or height (the anti-growth invariant)", () => {
  let g = { x: 300, y: 300, width: 341, height: 247 }; // deliberately odd sizes
  for (let i = 0; i < 500; i++) {
    g = moveGeom(g, (i % 7) - 3, (i % 5) - 2); // jittery deltas, like a real drag
    assert.equal(g.width, 341, `width drifted at step ${i}`);
    assert.equal(g.height, 247, `height drifted at step ${i}`);
  }
});

test("moveGeom tolerates junk deltas without resizing or NaN", () => {
  const g = { x: 10, y: 10, width: 300, height: 200 };
  for (const bad of [undefined, null, NaN, "x", {}]) {
    const m = moveGeom(g, bad, bad);
    assert.equal(m.width, 300);
    assert.equal(m.height, 200);
    assert.ok(Number.isFinite(m.x) && Number.isFinite(m.y));
  }
});

test("moveGeom keeps integer coords and constant size under fractional deltas", () => {
  // trackpads and high-DPI mice send sub-pixel deltas; coords must stay
  // integers (setBounds wants ints) and the size invariant must still hold
  let g = { x: 100, y: 100, width: 341, height: 247 };
  for (let i = 0; i < 300; i++) {
    g = moveGeom(g, 0.3, -0.7);
    assert.ok(Number.isInteger(g.x) && Number.isInteger(g.y), `non-integer coords at step ${i}`);
    assert.equal(g.width, 341);
    assert.equal(g.height, 247);
  }
});

test("resizeGeom clamps to sane bounds and leaves position alone", () => {
  const g = { x: 50, y: 60, width: 340, height: 240 };
  const tiny = resizeGeom(g, 10, 10);
  assert.equal(tiny.width, MIN_W);
  assert.equal(tiny.height, MIN_H);
  const huge = resizeGeom(g, 5000, 5000);
  assert.equal(huge.width, MAX_W);
  assert.equal(huge.height, MAX_H);
  assert.equal(huge.x, 50); // position untouched by a resize
  assert.equal(huge.y, 60);
});

/* Model the failure the real code hit: at a fractional scale the OS size you
 * read back is a rounding tick off what you wrote. The OLD shape fed that value
 * back in every step, so error accumulated. moveGeom keeps its own size and
 * writes the same value forever, so nothing accumulates. */
test("driftModel: reading size back each step accumulates; moveGeom does not", () => {
  const SCALE = 1.75;
  // what the OS hands back after a write at fractional scale (biases up, like Chromium's rect rounding)
  const readBack = (n) => Math.ceil((n * SCALE + 0.5)) / SCALE;

  // OLD: width is re-derived from the live window every move
  let oldW = 341;
  for (let i = 0; i < 120; i++) oldW = readBack(oldW);
  assert.ok(oldW > 341 + 5, `expected the buggy shape to grow; got ${oldW}`);

  // NEW: moveGeom never touches width
  let g = { x: 0, y: 0, width: 341, height: 247 };
  for (let i = 0; i < 120; i++) g = moveGeom(g, 1, 0);
  assert.equal(g.width, 341);
  assert.equal(g.height, 247);
});
