import type {
  FocusCommandError,
  FocusStatus,
  PomodoroPreset,
  PomodoroSession,
  SessionOutcome,
  StartSession,
} from "../shared/contracts";

export type FocusPane = "prepare" | "history" | "stats";

export interface PanelFocusState {
  pane: FocusPane;
  localTabLabel: "Prepara" | "In corso";
  showPreparationForm: boolean;
  showRunningControls: boolean;
}

export interface FocusPreparation {
  intention: string;
  durationMinutes: number | null;
  estimateMinutes: number | null;
  category: string;
  nextStep: string;
}

export interface ClockBoundaryDecision {
  shouldRefresh: boolean;
  latch: string | null;
}

export interface FocusCommandFailure {
  message: string;
  current: FocusStatus | null;
}

export interface FocusMutationTarget {
  sessionId: number;
  expectedRevision: number;
}

export interface FocusMutationRequest {
  sequence: number;
  domainIdentity: string;
}

export interface FocusRequestSequencer {
  beginStatus(): number;
  beginHistory(): number;
  beginMutation(status: FocusStatus | null): FocusMutationRequest;
  authoritativeSnapshotArrived(): void;
  statusSnapshotAccepted(previous: FocusStatus | null, next: FocusStatus): void;
  isCurrentStatus(token: number): boolean;
  isCurrentHistory(token: number): boolean;
  isCurrentMutation(token: FocusMutationRequest, status: FocusStatus | null): boolean;
}

export interface FocusSurfaceBootstrap {
  start(): Promise<void>;
}

interface FocusSurfaceBootstrapDependencies {
  registerListener(): Promise<unknown>;
  loadInitialState(): Promise<unknown>;
  markSurfaceReady(): Promise<unknown>;
}

interface FocusClockAccessibilityTarget {
  setAttribute(name: string, value: string): void;
}

export interface FocusTransientChoices {
  durationChoicesOpen: boolean;
  finishChoicesOpen: boolean;
  interruptionReasonOpen: boolean;
}

export type FocusSnapshotSource = "status" | "authoritative";

export interface FocusSnapshotFeedback {
  actionError: string | null;
  domainChanged: boolean;
}

export interface HistorySummary {
  loadedSessions: number;
  closedFocusSessions: number;
  plannedFocusMs: number;
  recordedFocusSpanMs: number;
  outcomes: Record<SessionOutcome, number>;
  periodStart: number | null;
  periodEnd: number | null;
}

export function panelState(status: FocusStatus, pane: FocusPane): PanelFocusState {
  const active = status.active !== null && status.active.phase !== "closed";
  return {
    pane,
    localTabLabel: active ? "In corso" : "Prepara",
    showPreparationForm: pane === "prepare" && !active,
    showRunningControls: pane === "prepare" && active,
  };
}

export function focusMutationTarget(status: FocusStatus): FocusMutationTarget | null {
  const active = status.active;
  return active
    ? { sessionId: active.id, expectedRevision: active.transition_revision }
    : null;
}

/** Accetta soltanto snapshot catturati più tardi dal backend. */
export function focusSnapshotIsNewer(
  previous: FocusStatus | null,
  next: FocusStatus,
): boolean {
  return previous === null || next.snapshot_cursor > previous.snapshot_cursor;
}

export function createFocusRequestSequencer(): FocusRequestSequencer {
  let statusVersion = 0;
  let historyVersion = 0;
  let mutationVersion = 0;
  return {
    beginStatus: () => ++statusVersion,
    beginHistory: () => ++historyVersion,
    beginMutation: (status) => {
      statusVersion += 1;
      historyVersion += 1;
      return {
        sequence: ++mutationVersion,
        domainIdentity: focusSnapshotIdentity(status),
      };
    },
    authoritativeSnapshotArrived: () => {
      statusVersion += 1;
      historyVersion += 1;
      mutationVersion += 1;
    },
    statusSnapshotAccepted: (previous, next) => {
      if (focusSnapshotChanged(previous, next)) mutationVersion += 1;
    },
    isCurrentStatus: (token) => token === statusVersion,
    isCurrentHistory: (token) => token === historyVersion,
    isCurrentMutation: (token, status) =>
      token.sequence === mutationVersion &&
      token.domainIdentity === focusSnapshotIdentity(status),
  };
}

export function createFocusSurfaceBootstrap(
  dependencies: FocusSurfaceBootstrapDependencies,
): FocusSurfaceBootstrap {
  let started: Promise<void> | null = null;
  return {
    start() {
      started ??= (async () => {
        await dependencies.registerListener();
        await Promise.all([
          dependencies.loadInitialState(),
          dependencies.markSurfaceReady(),
        ]);
      })();
      return started;
    },
  };
}

export function configureFocusClockAccessibility(
  clock: FocusClockAccessibilityTarget,
): void {
  clock.setAttribute("role", "timer");
  clock.setAttribute("aria-live", "off");
  clock.setAttribute("aria-label", "Tempo della sessione");
}

function focusSnapshotIdentity(status: FocusStatus | null): string {
  const active = status?.active;
  return active
    ? `${active.id}:${active.transition_revision}:${active.phase}`
    : "idle";
}

function focusSnapshotChanged(
  previous: FocusStatus | null,
  next: FocusStatus,
): boolean {
  return focusSnapshotIdentity(previous) !== focusSnapshotIdentity(next);
}

export function focusFeedbackAfterSnapshot(
  previous: FocusStatus | null,
  next: FocusStatus,
  source: FocusSnapshotSource,
  actionError: string | null,
): FocusSnapshotFeedback {
  const domainChanged = focusSnapshotChanged(previous, next);
  return {
    actionError: source === "authoritative" || domainChanged ? null : actionError,
    domainChanged,
  };
}

export function focusChoicesAfterSnapshot(
  previous: FocusStatus | null,
  next: FocusStatus,
  current: FocusTransientChoices,
): FocusTransientChoices {
  return focusSnapshotChanged(previous, next)
    ? {
        durationChoicesOpen: false,
        finishChoicesOpen: false,
        interruptionReasonOpen: false,
      }
    : current;
}

export function focusPhaseHeading(status: FocusStatus): string {
  const active = status.active;
  if (!active) return "Pronto";
  const kind =
    active.kind === "focus"
      ? "Focus"
      : active.kind === "short_break"
        ? "Pausa breve"
        : "Pausa lunga";
  const phase =
    active.phase === "paused"
      ? "In pausa"
      : active.phase === "ready_to_close"
        ? active.kind === "focus"
          ? "decidi"
          : "Pronto a tornare"
        : "";
  return phase ? `${kind} · ${phase}` : kind;
}

export function presetTimingLabel(
  preset: Pick<PomodoroPreset, "focus_ms" | "short_break_ms">,
): string {
  const focusMinutes = Math.max(0, Math.round(preset.focus_ms / 60_000));
  const breakMinutes = Math.max(0, Math.round(preset.short_break_ms / 60_000));
  return `${focusMinutes} min focus · ${breakMinutes} min pausa breve`;
}

function optionalText(value: string): string | null {
  const text = value.trim();
  return text.length > 0 ? text : null;
}

function minutesToMs(value: number | null, field: string): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${field} deve essere maggiore di zero.`);
  }
  return Math.round(value * 60_000);
}

export function buildFocusStart(
  preset: PomodoroPreset,
  preparation: FocusPreparation,
): StartSession {
  const durationOverride = minutesToMs(preparation.durationMinutes, "La durata");
  const estimate = minutesToMs(preparation.estimateMinutes, "La stima");
  return {
    kind: "focus",
    preset_id: preset.id,
    intention: preparation.intention.trim(),
    category: optionalText(preparation.category),
    planned_duration_ms: durationOverride ?? preset.focus_ms,
    estimated_ms: estimate,
    next_step: optionalText(preparation.nextStep),
  };
}

export function clockBoundaryRefresh(
  status: FocusStatus,
  now: number,
  currentLatch: string | null,
): ClockBoundaryDecision {
  const active = status.active;
  if (
    !active ||
    active.phase !== "running" ||
    !Number.isFinite(active.deadline_at) ||
    active.deadline_at > now
  ) {
    return { shouldRefresh: false, latch: null };
  }
  const latch = [active.id, active.transition_revision, active.phase, active.deadline_at].join(":");
  return { shouldRefresh: currentLatch !== latch, latch };
}

function isFocusStatus(value: unknown): value is FocusStatus {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<FocusStatus>;
  return (
    Number.isSafeInteger(candidate.snapshot_cursor) &&
    (candidate.snapshot_cursor ?? -1) >= 0 &&
    (candidate.active === null || typeof candidate.active === "object") &&
    Array.isArray(candidate.allowed_actions) &&
    (candidate.transition_revision === null ||
      typeof candidate.transition_revision === "number")
  );
}

export function focusCommandFailure(error: unknown): FocusCommandFailure {
  if (error && typeof error === "object" && "code" in error) {
    const typed = error as Partial<FocusCommandError> & { current?: unknown };
    const current = isFocusStatus(typed.current) ? typed.current : null;
    if (typed.code === "stale_revision") {
      return {
        message: "La sessione è cambiata altrove. Stato aggiornato.",
        current,
      };
    }
    if (typed.code === "invalid_request") {
      return {
        message: "Questa azione non è disponibile nello stato corrente.",
        current,
      };
    }
    if (typed.code === "internal") {
      return { message: "Impossibile completare l’azione.", current };
    }
  }
  return {
    message: error instanceof Error ? error.message : "Impossibile completare l’azione.",
    current: null,
  };
}

export function historySummary(sessions: PomodoroSession[]): HistorySummary {
  const outcomes: Record<SessionOutcome, number> = {
    completed: 0,
    partial: 0,
    interrupted: 0,
    invalidated: 0,
  };
  const closedFocus = sessions.filter(
    (session) => session.kind === "focus" && session.phase === "closed",
  );

  let plannedFocusMs = 0;
  let recordedFocusSpanMs = 0;
  for (const session of closedFocus) {
    plannedFocusMs += Math.max(0, session.planned_duration_ms);
    if (session.resolved_at !== null) {
      recordedFocusSpanMs += Math.max(0, session.resolved_at - session.started_at);
    }
    if (session.outcome) outcomes[session.outcome] += 1;
  }

  const starts = sessions.map((session) => session.started_at).filter(Number.isFinite);
  const ends = sessions
    .map((session) => session.resolved_at ?? session.started_at)
    .filter(Number.isFinite);

  return {
    loadedSessions: sessions.length,
    closedFocusSessions: closedFocus.length,
    plannedFocusMs,
    recordedFocusSpanMs,
    outcomes,
    periodStart: starts.length > 0 ? Math.min(...starts) : null,
    periodEnd: ends.length > 0 ? Math.max(...ends) : null,
  };
}
