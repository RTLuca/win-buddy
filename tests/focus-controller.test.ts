import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFocusStart,
  clockBoundaryRefresh,
  configureFocusClockAccessibility,
  createFocusRequestSequencer,
  createFocusSurfaceBootstrap,
  focusCommandFailure,
  focusMutationTarget,
  focusPhaseHeading,
  focusChoicesAfterSnapshot,
  focusSnapshotIsNewer,
  historySummary,
  panelState,
  presetTimingLabel,
} from "../ui/panel/focus-controller.ts";
import type {
  FocusAction,
  FocusStatus,
  PomodoroSession,
  SessionPhase,
} from "../ui/shared/contracts.ts";

const MINUTE = 60_000;

const actionsByPhase: Record<SessionPhase, FocusAction[]> = {
  running: ["focus.pause", "focus.extend_5", "focus.capture", "focus.finish"],
  paused: ["focus.resume", "focus.capture", "focus.finish"],
  ready_to_close: ["focus.overtime", "focus.extend_5", "focus.finish"],
  overtime: ["focus.capture", "focus.finish"],
  closed: [],
};

function session(patch: Partial<PomodoroSession> = {}): PomodoroSession {
  return {
    id: 8,
    kind: "focus",
    preset_id: 2,
    phase: "running",
    started_at: 1_000,
    deadline_at: 61_000,
    paused_remaining_ms: null,
    overtime_started_at: null,
    intention: "Scrivere la specifica",
    category: null,
    planned_duration_ms: MINUTE,
    estimated_ms: null,
    next_step: null,
    outcome: null,
    interruption_reason: null,
    resolved_at: null,
    edited_at: null,
    transition_revision: 4,
    ends_at: 61_000,
    label: "Scrivere la specifica",
    ...patch,
  };
}

function status(phase: SessionPhase | null, snapshotCursor = 1): FocusStatus {
  if (phase === null) {
    return {
      snapshot_cursor: snapshotCursor,
      active: null,
      effective_focus_ms: 0,
      remaining_ms: null,
      overtime_ms: null,
      allowed_actions: ["focus.start_last"],
      pending_captures: 0,
      transition_revision: null,
    };
  }
  const active = session({ phase });
  return {
    snapshot_cursor: snapshotCursor,
    active,
    effective_focus_ms: 0,
    remaining_ms: phase === "overtime" ? null : MINUTE,
    overtime_ms: phase === "overtime" ? 0 : null,
    allowed_actions: actionsByPhase[phase],
    pending_captures: 0,
    transition_revision: active.transition_revision,
  };
}

test("an active session opens the prepare pane as in-progress", () => {
  const vm = panelState(status("running"), "prepare");

  assert.equal(vm.localTabLabel, "In corso");
  assert.equal(vm.showPreparationForm, false);
  assert.equal(vm.showRunningControls, true);
});

test("idle focus keeps preparation fields", () => {
  const vm = panelState(status(null), "prepare");

  assert.equal(vm.localTabLabel, "Prepara");
  assert.equal(vm.showPreparationForm, true);
  assert.equal(vm.showRunningControls, false);
});

test("panel phase headings do not repeat the session kind", () => {
  const runningFocus = status("running");
  const pausedFocus = status("paused");
  const runningBreak = status("running");
  runningBreak.active!.kind = "short_break";

  assert.equal(focusPhaseHeading(runningFocus), "Focus");
  assert.equal(focusPhaseHeading(pausedFocus), "Focus · In pausa");
  assert.equal(focusPhaseHeading(runningBreak), "Pausa breve");
});

test("preset timing copy expresses saved durations in minutes", () => {
  assert.equal(
    presetTimingLabel({ focus_ms: 1_500_000, short_break_ms: 300_000 }),
    "25 min focus · 5 min pausa breve",
  );
});

test("a one-time duration override builds a complete start request without changing the preset", () => {
  const preset = {
    id: 2,
    name: "Deep Work",
    focus_ms: 50 * MINUTE,
    short_break_ms: 10 * MINUTE,
    long_break_ms: 30 * MINUTE,
    long_every: 4,
    auto_start_break: false,
    auto_start_focus: false,
    is_default: false,
    sort_order: 1,
    created_at: 0,
    updated_at: 0,
  };

  const request = buildFocusStart(preset, {
    intention: "  Chiudere il brief  ",
    durationMinutes: 35,
    estimateMinutes: 30,
    category: "  progetto  ",
    nextStep: "  Chiedere review  ",
  });

  assert.deepEqual(request, {
    kind: "focus",
    preset_id: 2,
    intention: "Chiudere il brief",
    category: "progetto",
    planned_duration_ms: 35 * MINUTE,
    estimated_ms: 30 * MINUTE,
    next_step: "Chiedere review",
  });
  assert.equal(preset.focus_ms, 50 * MINUTE);
});

test("blank optional preparation values use the selected preset duration", () => {
  const request = buildFocusStart(
    {
      id: 3,
      name: "Sprint",
      focus_ms: 15 * MINUTE,
      short_break_ms: 3 * MINUTE,
      long_break_ms: 15 * MINUTE,
      long_every: 4,
      auto_start_break: false,
      auto_start_focus: false,
      is_default: false,
      sort_order: 2,
      created_at: 0,
      updated_at: 0,
    },
    {
      intention: "",
      durationMinutes: null,
      estimateMinutes: null,
      category: "",
      nextStep: "",
    },
  );

  assert.equal(request.planned_duration_ms, 15 * MINUTE);
  assert.equal(request.estimated_ms, null);
  assert.equal(request.category, null);
  assert.equal(request.next_step, null);
});

test("clock boundary refresh is requested once per unchanged snapshot", () => {
  const running = status("running");
  const first = clockBoundaryRefresh(running, 61_000, null);
  const repeated = clockBoundaryRefresh(running, 62_000, first.latch);
  const changed = status("running");
  changed.active!.transition_revision = 5;
  changed.transition_revision = 5;
  const nextSnapshot = clockBoundaryRefresh(changed, 62_000, first.latch);

  assert.deepEqual(first, { shouldRefresh: true, latch: "8:4:running:61000" });
  assert.deepEqual(repeated, { shouldRefresh: false, latch: "8:4:running:61000" });
  assert.deepEqual(nextSnapshot, { shouldRefresh: true, latch: "8:5:running:61000" });
});

test("a focus mutation target carries both the active session identity and revision", () => {
  assert.deepEqual(focusMutationTarget(status("running")), {
    sessionId: 8,
    expectedRevision: 4,
  });
  assert.equal(focusMutationTarget(status(null)), null);
});

test("an authoritative event supersedes in-flight status and history responses", () => {
  const sequencing = createFocusRequestSequencer();
  const statusRequest = sequencing.beginStatus();
  const historyRequest = sequencing.beginHistory();

  sequencing.authoritativeSnapshotArrived();

  assert.equal(sequencing.isCurrentStatus(statusRequest), false);
  assert.equal(sequencing.isCurrentHistory(historyRequest), false);
});

test("a mutation start invalidates a status read that began before it", () => {
  const sequencing = createFocusRequestSequencer();
  const current = status("running", 10);
  const request = sequencing.beginStatus();
  const lateResponse = status("running", 11);

  sequencing.beginMutation(current);

  assert.equal(focusSnapshotIsNewer(current, lateResponse), true);
  assert.equal(sequencing.isCurrentStatus(request), false);
});

test("a same-domain reread does not hide an internal mutation failure", () => {
  const sequencing = createFocusRequestSequencer();
  const mutation = sequencing.beginMutation(status("running", 10));
  const reread = status("running", 11);

  assert.equal(sequencing.isCurrentMutation(mutation, reread), true);
});

test("a real domain event suppresses an older mutation failure", () => {
  const sequencing = createFocusRequestSequencer();
  const mutation = sequencing.beginMutation(status("running", 10));
  const changed = status("paused", 11);
  changed.active!.transition_revision = 5;
  changed.transition_revision = 5;

  sequencing.authoritativeSnapshotArrived();

  assert.equal(sequencing.isCurrentMutation(mutation, changed), false);
});

test("the panel rejects a delayed idle snapshot from an older backend cursor", () => {
  const current = status("running", 12);
  const delayedIdle = status(null, 11);

  assert.equal(focusSnapshotIsNewer(current, delayedIdle), false);
  assert.equal(focusSnapshotIsNewer(delayedIdle, current), true);
});

test("a newer request supersedes only the older response in the same stream", () => {
  const sequencing = createFocusRequestSequencer();
  const oldStatus = sequencing.beginStatus();
  const oldHistory = sequencing.beginHistory();
  const newStatus = sequencing.beginStatus();
  const newHistory = sequencing.beginHistory();

  assert.equal(sequencing.isCurrentStatus(oldStatus), false);
  assert.equal(sequencing.isCurrentStatus(newStatus), true);
  assert.equal(sequencing.isCurrentHistory(oldHistory), false);
  assert.equal(sequencing.isCurrentHistory(newHistory), true);
});

test("focus surface boot awaits one listener registration before loads and readiness", async () => {
  const calls: string[] = [];
  const bootstrap = createFocusSurfaceBootstrap({
    registerListener: async () => {
      calls.push("listener:start");
      await Promise.resolve();
      calls.push("listener:ready");
    },
    loadInitialState: async () => {
      calls.push("load");
    },
    markSurfaceReady: async () => {
      calls.push("surface-ready");
    },
  });

  await Promise.all([bootstrap.start(), bootstrap.start()]);

  assert.deepEqual(calls, ["listener:start", "listener:ready", "load", "surface-ready"]);
});

test("the half-second clock is a non-announcing timer", () => {
  const attributes = new Map<string, string>();

  configureFocusClockAccessibility({
    setAttribute(name, value) {
      attributes.set(name, value);
    },
  });

  assert.deepEqual(Object.fromEntries(attributes), {
    role: "timer",
    "aria-live": "off",
    "aria-label": "Tempo della sessione",
  });
});

test("external identity, revision, and phase changes close transient action choosers", () => {
  const initial = status("running");
  const otherSession = status("running");
  otherSession.active!.id = 9;
  const nextRevision = status("running");
  nextRevision.active!.transition_revision = 5;
  nextRevision.transition_revision = 5;
  const nextPhase = status("paused");
  const openChoices = {
    durationChoicesOpen: true,
    finishChoicesOpen: true,
    interruptionReasonOpen: true,
  };
  const closedChoices = {
    durationChoicesOpen: false,
    finishChoicesOpen: false,
    interruptionReasonOpen: false,
  };

  assert.deepEqual(focusChoicesAfterSnapshot(initial, otherSession, openChoices), closedChoices);
  assert.deepEqual(focusChoicesAfterSnapshot(initial, nextRevision, openChoices), closedChoices);
  assert.deepEqual(focusChoicesAfterSnapshot(initial, nextPhase, openChoices), closedChoices);
  assert.deepEqual(focusChoicesAfterSnapshot(initial, status("running"), openChoices), openChoices);
});

test("a typed stale error returns the authoritative current snapshot", () => {
  const current = status("paused");
  const failure = focusCommandFailure({
    code: "stale_revision",
    message: "revisione obsoleta",
    current,
  });

  assert.equal(failure.message, "La sessione è cambiata altrove. Stato aggiornato.");
  assert.equal(failure.current, current);
});

test("history statistics use only closed focus data from the loaded period", () => {
  const sessions = [
    session({
      id: 1,
      started_at: 0,
      resolved_at: 30 * MINUTE,
      planned_duration_ms: 25 * MINUTE,
      phase: "closed",
      outcome: "completed",
    }),
    session({
      id: 2,
      started_at: 40 * MINUTE,
      resolved_at: 80 * MINUTE,
      planned_duration_ms: 50 * MINUTE,
      phase: "closed",
      outcome: "partial",
    }),
    session({
      id: 3,
      kind: "short_break",
      started_at: 90 * MINUTE,
      resolved_at: 95 * MINUTE,
      planned_duration_ms: 5 * MINUTE,
      phase: "closed",
      outcome: "completed",
    }),
    session({ id: 4, started_at: 100 * MINUTE, resolved_at: null }),
  ];

  assert.deepEqual(historySummary(sessions), {
    loadedSessions: 4,
    closedFocusSessions: 2,
    plannedFocusMs: 75 * MINUTE,
    recordedFocusSpanMs: 70 * MINUTE,
    outcomes: { completed: 1, partial: 1, interrupted: 0, invalidated: 0 },
    periodStart: 0,
    periodEnd: 100 * MINUTE,
  });
});
