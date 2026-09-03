import assert from "node:assert/strict";
import test from "node:test";

import {
  createFocusSnapshotGate,
  focusFinishCommand,
  focusHitbox,
  overlayCommandFailure,
  overlayActionCommand,
  overlayVisibility,
  type FocusRect,
} from "../ui/overlay/focus-controller.ts";
import type {
  FocusAction,
  FocusStatus,
  PomodoroSession,
  SessionKind,
} from "../ui/shared/contracts.ts";

function status(
  kind: SessionKind,
  allowedActions: FocusAction[],
): FocusStatus {
  const active: PomodoroSession = {
    id: 19,
    kind,
    preset_id: 2,
    phase: "running",
    started_at: 1_000,
    deadline_at: 61_000,
    paused_remaining_ms: null,
    overtime_started_at: null,
    intention: "Chiudere il brief",
    category: null,
    planned_duration_ms: 60_000,
    estimated_ms: null,
    next_step: null,
    outcome: null,
    interruption_reason: null,
    resolved_at: null,
    edited_at: null,
    transition_revision: 7,
    ends_at: 61_000,
    label: "Chiudere il brief",
  };
  return {
    active,
    effective_focus_ms: 0,
    remaining_ms: 60_000,
    overtime_ms: null,
    allowed_actions: allowedActions,
    pending_captures: 0,
    transition_revision: 7,
  };
}

test("overlay dispatch carries session identity and revision for each mutation", () => {
  const running = status("focus", [
    "focus.pause",
    "focus.extend_5",
    "focus.capture",
    "focus.finish",
  ]);

  assert.deepEqual(overlayActionCommand(running, "focus.pause"), {
    type: "pause",
    sessionId: 19,
    expectedRevision: 7,
  });
  assert.deepEqual(overlayActionCommand(running, "focus.extend_5"), {
    type: "adjust",
    sessionId: 19,
    expectedRevision: 7,
    deltaMs: 300_000,
  });
  assert.deepEqual(overlayActionCommand(running, "focus.capture"), {
    type: "capture",
  });
  assert.deepEqual(overlayActionCommand(running, "focus.finish"), {
    type: "choose-finish",
  });
  assert.equal(overlayActionCommand(running, "focus.resume"), null);
});

test("break finish and skip close partial without opening the focus outcome chooser", () => {
  const runningBreak = status("short_break", ["break.skip", "focus.finish"]);
  const expected = {
    type: "finish",
    sessionId: 19,
    expectedRevision: 7,
    outcome: "partial",
  };

  assert.deepEqual(overlayActionCommand(runningBreak, "focus.finish"), expected);
  assert.deepEqual(overlayActionCommand(runningBreak, "break.skip"), expected);
});

test("the focus outcome chooser preserves the observed mutation target", () => {
  const running = status("focus", ["focus.finish"]);

  assert.deepEqual(focusFinishCommand(running, "interrupted"), {
    type: "finish",
    sessionId: 19,
    expectedRevision: 7,
    outcome: "interrupted",
  });
});

test("a focus event invalidates a late initial status read", () => {
  const applied: FocusStatus[] = [];
  const gate = createFocusSnapshotGate((snapshot) => applied.push(snapshot));
  const initial = gate.beginRead();
  const event = status("focus", ["focus.resume"]);
  event.active!.phase = "paused";
  event.active!.transition_revision = 8;
  event.transition_revision = 8;

  gate.applyAuthoritative(event);
  gate.applyRead(initial, status("focus", ["focus.pause"]));

  assert.deepEqual(applied, [event]);
});

test("a typed stale error exposes its authoritative snapshot before the message", () => {
  const current = status("focus", ["focus.resume"]);
  const failure = overlayCommandFailure({
    code: "stale_revision",
    message: "revisione obsoleta",
    current,
  });

  assert.equal(failure.current, current);
  assert.equal(failure.message, "La sessione è cambiata altrove. Stato aggiornato.");
});

test("dock visibility follows pointer or focus with no timeout state", () => {
  assert.deepEqual(
    overlayVisibility({ pointerInside: false, focusWithin: false }),
    { dockVisible: false },
  );
  assert.deepEqual(
    overlayVisibility({ pointerInside: true, focusWithin: false }),
    { dockVisible: true },
  );
  assert.deepEqual(
    overlayVisibility({ pointerInside: false, focusWithin: true }),
    { dockVisible: true },
  );
});

test("hitbox includes open controls and shrinks as soon as they close", () => {
  const base: FocusRect = { x: 100, y: 120, w: 80, h: 80 };
  const chip: FocusRect = { x: 80, y: 90, w: 120, h: 24 };
  const dock: FocusRect = { x: 30, y: 40, w: 220, h: 42 };
  const chooser: FocusRect = { x: 50, y: 4, w: 180, h: 32 };

  assert.deepEqual(
    focusHitbox({ base, chip, dock, chooser, scale: null }),
    { x: 30, y: 4, w: 220, h: 196 },
  );
  assert.deepEqual(
    focusHitbox({ base, chip, dock: null, chooser: null, scale: null }),
    { x: 80, y: 90, w: 120, h: 110 },
  );
});
