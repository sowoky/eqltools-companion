"use strict";
/* Pure geometry model for the overlay window.
 *
 * The bug this module exists to prevent: the old title-bar drag handler did
 *
 *     win.setBounds({ ...win.getBounds(), x: x + dx, y: y + dy });
 *
 * on every pointermove — re-sending width/height through the getBounds ->
 * setBounds round-trip each event. On Windows at a fractional display scale
 * (e.g. 4K @ 175%, scaleFactor 1.75) that round-trip is NOT a fixed point:
 * DIP -> physical -> DIP rounding biases outward, so the window grew a little
 * every event and ballooned across a single drag. (setPosition has the same
 * flaw — on Windows it is implemented as setBounds(getBounds().size).)
 *
 * The cure is to treat geometry as a value we OWN and only ever WRITE to the OS.
 * A move advances x/y and returns the SAME width/height — the size is never read
 * back from the live window, so a move mathematically cannot resize it. These
 * are pure functions so the invariant is unit-testable without Electron.
 */

const MIN_W = 180, MAX_W = 900, MIN_H = 70, MAX_H = 900;

const clamp = (v, min, max) => Math.min(max, Math.max(min, Math.round(Number(v) || 0)));

/* Move by a pointer delta (DIP). Width/height come straight through unchanged —
 * that invariance is the whole point; assert it in tests. */
function moveGeom(geom, dx, dy) {
  return {
    x: Math.round(geom.x + (Number(dx) || 0)),
    y: Math.round(geom.y + (Number(dy) || 0)),
    width: geom.width,
    height: geom.height,
  };
}

/* Resize to an absolute target (DIP), clamped to sane bounds. Position is left
 * untouched — a resize from the corner grip must not walk the window. */
function resizeGeom(geom, width, height) {
  return {
    x: geom.x,
    y: geom.y,
    width: clamp(width, MIN_W, MAX_W),
    height: clamp(height, MIN_H, MAX_H),
  };
}

module.exports = { moveGeom, resizeGeom, MIN_W, MAX_W, MIN_H, MAX_H };
