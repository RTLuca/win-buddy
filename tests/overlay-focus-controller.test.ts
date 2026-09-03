import assert from "node:assert/strict";
import test from "node:test";

import {
  createFocusPresentationController,
  createFocusSnapshotGate,
  focusFinishCommand,
  focusHitbox,
  overlayCommandFailure,
  overlayActionCommand,
  overlayVisibility,
  presentOverlayCommandFailure,
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
  id = 19,
  revision = 7,
): FocusStatus {
  const active: PomodoroSession = {
    id,
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
    transition_revision: revision,
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
    transition_revision: revision,
  };
}

function idleStatus(): FocusStatus {
  return {
    active: null,
    effective_focus_ms: 60_000,
    remaining_ms: null,
    overtime_ms: null,
    allowed_actions: ["focus.start_last", "focus.capture"],
    pending_captures: 0,
    transition_revision: null,
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
  const initial = gate.beginRequest();
  const event = status("focus", ["focus.resume"], 19, 8);
  event.active!.phase = "paused";

  gate.applyEvent(event);
  gate.applyResponse(initial, status("focus", ["focus.pause"]));

  assert.deepEqual(applied, [event]);
});

test("a late mutation response cannot replace a newer cross-session event", () => {
  const applied: FocusStatus[] = [];
  const gate = createFocusSnapshotGate((snapshot) => applied.push(snapshot));
  const firstSession = status("focus", ["focus.pause"], 19, 7);
  const nextSession = status("short_break", ["break.skip"], 20, 0);
  const oldResponse = status("focus", ["focus.resume"], 19, 8);

  gate.applyEvent(firstSession);
  const mutation = gate.beginRequest();
  gate.applyEvent(nextSession);

  assert.equal(gate.applyResponse(mutation, oldResponse), false);
  assert.deepEqual(applied, [firstSession, nextSession]);
});

test("request sequencing survives an idle-active-idle ABA change", () => {
  const applied: FocusStatus[] = [];
  const gate = createFocusSnapshotGate((snapshot) => applied.push(snapshot));
  const idle = idleStatus();
  const started = status("focus", ["focus.pause"], 20, 0);
  gate.applyEvent(idle);
  const startRequest = gate.beginRequest();
  gate.applyEvent(started);
  gate.applyEvent(idle);

  assert.equal(gate.applyResponse(startRequest, started), false);
  assert.deepEqual(applied, [idle, started, idle]);
});

test("a current finish response may close the captured active session", () => {
  const applied: FocusStatus[] = [];
  const gate = createFocusSnapshotGate((snapshot) => applied.push(snapshot));
  const running = status("focus", ["focus.finish"]);
  const idle = idleStatus();
  gate.applyEvent(running);
  const finish = gate.beginRequest();

  assert.equal(gate.applyResponse(finish, idle), true);
  assert.deepEqual(applied, [running, idle]);
});

test("an event cannot regress the revision of the same focus session", () => {
  const applied: FocusStatus[] = [];
  const gate = createFocusSnapshotGate((snapshot) => applied.push(snapshot));
  const newer = status("focus", ["focus.resume"], 19, 8);
  newer.active!.phase = "paused";
  const older = status("focus", ["focus.pause"], 19, 7);

  assert.equal(gate.applyEvent(newer), true);
  assert.equal(gate.applyEvent(older), false);
  assert.deepEqual(applied, [newer]);
});

test("an accepted snapshot clears stale feedback and closes the chooser", () => {
  const controller = createFocusPresentationController({
    render: () => undefined,
    reportHitbox: () => undefined,
  });
  controller.showFailure("La richiesta precedente non è riuscita.");
  controller.openFinishChooser();

  controller.applySnapshot(status("focus", ["focus.pause"]));

  assert.equal(controller.state.feedback, null);
  assert.equal(controller.state.statusError, null);
  assert.equal(controller.state.finishChooserOpen, false);
});

test("closing the finish chooser reports the hitbox after it is hidden", () => {
  let chooserVisible = false;
  const visibilityObservedByHitbox: boolean[] = [];
  const controller = createFocusPresentationController({
    render: (state) => {
      chooserVisible = state.finishChooserOpen;
    },
    reportHitbox: () => visibilityObservedByHitbox.push(chooserVisible),
  });
  controller.openFinishChooser();
  visibilityObservedByHitbox.length = 0;

  controller.closeFinishChooser();

  assert.deepEqual(visibilityObservedByHitbox, [false]);
});

test("a late error without a snapshot is not shown after a newer event", () => {
  const controller = createFocusPresentationController({
    render: () => undefined,
    reportHitbox: () => undefined,
  });
  const gate = createFocusSnapshotGate((snapshot) =>
    controller.applySnapshot(snapshot),
  );
  gate.applyEvent(status("focus", ["focus.pause"], 19, 7));
  const mutation = gate.beginRequest();
  const newer = status("short_break", ["break.skip"], 20, 0);
  gate.applyEvent(newer);

  assert.equal(
    presentOverlayCommandFailure(
      gate,
      controller,
      mutation,
      new Error("risposta vecchia"),
    ),
    false,
  );
  assert.equal(controller.state.status, newer);
  assert.equal(controller.state.feedback, null);
});

test("a current typed stale response may reveal a replacement session", () => {
  const controller = createFocusPresentationController({
    render: () => undefined,
    reportHitbox: () => undefined,
  });
  const gate = createFocusSnapshotGate((snapshot) =>
    controller.applySnapshot(snapshot),
  );
  gate.applyEvent(status("focus", ["focus.pause"], 19, 7));
  const mutation = gate.beginRequest();
  const replacement = status("short_break", ["break.skip"], 20, 0);

  assert.equal(
    presentOverlayCommandFailure(gate, controller, mutation, {
      code: "stale_revision",
      message: "revisione obsoleta",
      current: replacement,
    }),
    true,
  );
  assert.equal(controller.state.status, replacement);
  assert.equal(
    controller.state.feedback,
    "La sessione è cambiata altrove. Stato aggiornato.",
  );
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
