import assert from "node:assert/strict";
import test from "node:test";

import {
  buddyActions,
  focusClock,
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
      ariaLabel: "Avvia ultimo focus",
    },
  ]);
});

for (const testCase of [
  { phase: "running", now: 60_001, clock: "24:00", label: "Focus" },
  { phase: "paused", now: 500_000, clock: "1:30", label: "In pausa" },
  { phase: "ready_to_close", now: 2_000_000, clock: "0:00", label: "Decidi" },
  { phase: "overtime", now: 71_000, clock: "+1:10", label: "Overtime" },
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

for (const testCase of [
  { kind: "short_break", label: "Pausa breve" },
  { kind: "long_break", label: "Pausa lunga" },
] as const) {
  test(`${testCase.kind} uses the break label, countdown, and contextual actions`, () => {
    const status = breakFixture(testCase.kind, "running");

    assert.equal(focusLabel(status), testCase.label);
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

  test(`${testCase.kind} ready to close is ready to return at zero`, () => {
    const status = breakFixture(testCase.kind, "ready_to_close");

    assert.equal(focusLabel(status), "Pronto a tornare");
    assert.equal(focusClock(status, 2_000_000), "0:00");
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
      { id: "focus.start_last", label: "Avvia", ariaLabel: "Avvia ultimo focus" },
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
