import assert from "node:assert/strict";
import test from "node:test";

import { normalizeScale } from "../ui/overlay/scale.ts";

test("normalizeScale clamps and snaps values to the supported ten-percent steps", () => {
  // Regressione coperta: pulsanti e slider non devono salvare scale che il
  // backend interpreterebbe diversamente o che renderebbero il buddy enorme.
  assert.equal(normalizeScale(46), 50);
  assert.equal(normalizeScale(154), 150);
  assert.equal(normalizeScale(206), 200);
});

test("normalizeScale recovers from a corrupt non-numeric setting", () => {
  assert.equal(normalizeScale(Number.NaN), 100);
});
