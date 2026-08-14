"use strict";
/* Pure work-area clamping for the overlay window.
 *
 * Two defects this addresses:
 *   1. The title-bar drag applied the pointer delta with no bound, so the bar
 *      could be dragged off the top/edge of the screen and become unreachable
 *      (settings.json would show e.g. y:-144).
 *   2. A saved bounds could be larger than the display or off-screen (a monitor
 *      was unplugged, or an older build grew the window past the screen), and it
 *      was handed straight back to BrowserWindow on the next launch.
 *
 * Kept free of Electron — callers pass in the target display's workArea (from
 * screen.getDisplayMatching(bounds).workArea) — so the rules are unit-testable.
 */

const MIN_W = 180, MIN_H = 70;

/* Keep a w×h window fully inside workArea: never let the top/left cross it, and
   never push the far edge past it. If the window is bigger than the work area,
   pin the top-left to the work-area origin so at least the title bar stays
   grabbable instead of floating off the top. */
function clampToDisplay(x, y, w, h, workArea) {
  const maxX = workArea.x + Math.max(0, workArea.width - w);
  const maxY = workArea.y + Math.max(0, workArea.height - h);
  return {
    x: Math.min(maxX, Math.max(workArea.x, Math.round(x))),
    y: Math.min(maxY, Math.max(workArea.y, Math.round(y))),
  };
}

/* Cap a saved bounds to the work area and pull it on-screen before it is ever
   handed to BrowserWindow. */
function sanitizeBounds(b, workArea) {
  const width = Math.max(MIN_W, Math.min(b.width, workArea.width));
  const height = Math.max(MIN_H, Math.min(b.height, workArea.height));
  const { x, y } = clampToDisplay(b.x, b.y, width, height, workArea);
  return { x, y, width, height };
}

module.exports = { clampToDisplay, sanitizeBounds, MIN_W, MIN_H };
