import assert from "node:assert/strict";
import test from "node:test";

import {
  buddyActions,
  focusClock,
  focusIndicator,
  focusLabel,
} from "../ui/shared/focus-view-model.ts";
import type {
  FocusAction,
  FocusStatus,
  PomodoroSession,
  SessionKind,
  SessionPhase,
} from "../ui/shared/contracts.ts";

const focusActionsByPhase: Record<SessionPhase, FocusAction[]> = {
  running: ["focus.pause", "focus.extend_5", "focus.capture", "focus.finish"],
  paused: ["focus.resume", "focus.capture", "focus.finish"],
  ready_to_close: ["focus.overtime", "focus.extend_5", "focus.finish"],
  overtime: ["focus.capture", "focus.finish"],
  closed: [],
};

function fixture(
  patch: Partial<PomodoroSession> = {},
  allowedActions?: FocusAction[],
): FocusStatus {
  const active: PomodoroSession = {
    id: 1,
    kind: "focus",
    preset_id: 1,
    phase: "running",
    started_at: 0,
    deadline_at: 1_500_000,
    paused_remaining_ms: null,
    overtime_started_at: null,
    intention: "Spec",
    category: null,
    planned_duration_ms: 1_500_000,
    estimated_ms: null,
    next_step: null,
    outcome: null,
    interruption_reason: null,
    resolved_at: null,
    edited_at: null,
    transition_revision: 0,
    ends_at: 1_500_000,
    label: "Spec",
    ...patch,
  };

  return {
    snapshot_cursor: 1,
    active,
    effective_focus_ms: 0,
    remaining_ms: null,
    overtime_ms: null,
    allowed_actions: allowedActions ?? focusActionsByPhase[active.phase],
    pending_captures: 0,
    transition_revision: active.transition_revision,
  };
}

function breakFixture(
  kind: Exclude<SessionKind, "focus">,
  phase: "running" | "ready_to_close",
): FocusStatus {
  return fixture(
    { kind, phase, intention: "" },
    ["break.skip", "focus.extend_5", "focus.finish"],
  );
}

test("an idle status has a ready label, no clock, and the quick-start action", () => {
  const status: FocusStatus = {
    snapshot_cursor: 1,
    active: null,
    effective_focus_ms: 0,
    remaining_ms: null,
    overtime_ms: null,
    allowed_actions: ["focus.start_last"],
    pending_captures: 0,
    transition_revision: null,
  };

  assert.equal(focusLabel(status), "Pronto");
  assert.equal(focusClock(status, 100_000), "");
  assert.deepEqual(buddyActions(status), [
    {
      id: "focus.start_last",
      label: "Avvia",
      ariaLabel: "Avvia ultimo preset",
    },
  ]);
});

for (const testCase of [
  { phase: "running", now: 60_001, clock: "24:00", label: "Focus" },
  { phase: "paused", now: 500_000, clock: "1:30", label: "In pausa" },
  { phase: "ready_to_close", now: 2_000_000, clock: "00:00", label: "decidi" },
  { phase: "overtime", now: 71_000, clock: "+1:10", label: "" },
  { phase: "closed", now: 2_000_000, clock: "", label: "Pronto" },
] as const) {
  test(`${testCase.phase} exposes its approved focus clock and label`, () => {
    const status = fixture({
      phase: testCase.phase,
      paused_remaining_ms: testCase.phase === "paused" ? 90_000 : null,
      overtime_started_at: testCase.phase === "overtime" ? 1_000 : null,
    });

    assert.equal(focusClock(status, testCase.now), testCase.clock);
    assert.equal(focusLabel(status), testCase.label);
  });
}

for (const kind of ["short_break", "long_break"] as const) {
  test(`${kind} uses the compact break label, countdown, and contextual actions`, () => {
    const status = breakFixture(kind, "running");

    assert.equal(focusLabel(status), "Pausa");
    assert.equal(focusClock(status, 1_410_000), "1:30");
    assert.deepEqual(buddyActions(status), [
      { id: "break.skip", label: "Salta", ariaLabel: "Salta pausa" },
      {
        id: "focus.extend_5",
        label: "+5",
        ariaLabel: "Aggiungi 5 minuti alla pausa",
      },
      {
        id: "focus.finish",
        label: "Concludi",
        ariaLabel: "Concludi pausa",
      },
    ]);
  });

  test(`${kind} ready to close is ready to return without a clock`, () => {
    const status = breakFixture(kind, "ready_to_close");

    assert.equal(focusLabel(status), "Pronto a tornare");
    assert.equal(focusClock(status, 2_000_000), "");
  });
}

for (const testCase of [
  {
    description: "a NaN deadline",
    patch: { deadline_at: Number.NaN },
    now: 0,
    clock: "0:00",
  },
  {
    description: "an infinite paused remainder",
    patch: { phase: "paused", paused_remaining_ms: Number.POSITIVE_INFINITY },
    now: 0,
    clock: "0:00",
  },
  {
    description: "an infinite overtime instant",
    patch: { phase: "overtime", overtime_started_at: 1_000 },
    now: Number.POSITIVE_INFINITY,
    clock: "+0:00",
  },
] as const) {
  test(`${testCase.description} falls back to a stable zero clock`, () => {
    const status = fixture(testCase.patch);

    assert.equal(focusClock(status, testCase.now), testCase.clock);
  });
}

for (const phase of [
  "running",
  "paused",
  "ready_to_close",
  "overtime",
  "closed",
] as const) {
  test(`${phase} preserves the core-approved buddy action order`, () => {
    const expected = focusActionsByPhase[phase];
    const actions = buddyActions(fixture({ phase }));

    assert.deepEqual(
      actions.map((action) => action.id),
      expected,
    );
    assert.ok(actions.every((action) => action.label && action.ariaLabel));
  });
}

test("every semantic action has a visible and accessible label", () => {
  const allActions: FocusAction[] = [
    "focus.start_last",
    "focus.pause",
    "focus.resume",
    "focus.extend_5",
    "focus.capture",
    "focus.finish",
    "focus.overtime",
    "break.start",
    "break.skip",
  ];
  const actions = buddyActions(fixture({}, allActions));

  assert.deepEqual(
    actions.map(({ id, label, ariaLabel }) => ({ id, label, ariaLabel })),
    [
      { id: "focus.start_last", label: "Avvia", ariaLabel: "Avvia ultimo preset" },
      { id: "focus.pause", label: "Pausa", ariaLabel: "Metti in pausa il focus" },
      { id: "focus.resume", label: "Riprendi", ariaLabel: "Riprendi il focus" },
      {
        id: "focus.extend_5",
        label: "+5",
        ariaLabel: "Aggiungi 5 minuti al focus",
      },
      {
        id: "focus.capture",
        label: "Cattura",
        ariaLabel: "Cattura un'interruzione",
      },
      { id: "focus.finish", label: "Concludi", ariaLabel: "Concludi focus" },
      {
        id: "focus.overtime",
        label: "Continua",
        ariaLabel: "Continua in overtime",
      },
      { id: "break.start", label: "Pausa", ariaLabel: "Avvia pausa" },
      { id: "break.skip", label: "Salta", ariaLabel: "Salta pausa" },
    ],
  );
});

test("the persistent chip composes every approved phase without duplicate segments", () => {
  const idle: FocusStatus = {
    snapshot_cursor: 1,
    active: null,
    effective_focus_ms: 0,
    remaining_ms: null,
    overtime_ms: null,
    allowed_actions: ["focus.start_last"],
    pending_captures: 0,
    transition_revision: null,
  };
  const paused = fixture({ phase: "paused", paused_remaining_ms: 90_000 });
  const ready = fixture({ phase: "ready_to_close" });
  const overtime = fixture({ phase: "overtime", overtime_started_at: 1_000 });
  const runningBreak = breakFixture("short_break", "running");
  const readyBreak = breakFixture("short_break", "ready_to_close");

  assert.equal(focusIndicator(idle, 71_000), "Pronto");
  assert.equal(focusIndicator(fixture(), 60_001), "Focus · 24:00");
  assert.equal(focusIndicator(paused, 500_000), "In pausa · 1:30");
  assert.equal(focusIndicator(ready, 2_000_000), "00:00 · decidi");
  assert.equal(focusIndicator(overtime, 71_000), "+1:10");
  assert.equal(focusIndicator(runningBreak, 1_410_000), "Pausa · 1:30");
  assert.equal(focusIndicator(readyBreak, 2_000_000), "Pronto a tornare");
});
