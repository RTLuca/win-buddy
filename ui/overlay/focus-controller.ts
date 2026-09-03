import type {
  FocusAction,
  FocusCommandError,
  FocusFinishOutcome,
  FocusStatus,
} from "../shared/contracts";

export interface FocusMutationTarget {
  sessionId: number;
  expectedRevision: number;
}

export type OverlayActionCommand =
  | { type: "start-last" }
  | { type: "pause"; sessionId: number; expectedRevision: number }
  | { type: "resume"; sessionId: number; expectedRevision: number }
  | {
      type: "adjust";
      sessionId: number;
      expectedRevision: number;
      deltaMs: number;
    }
  | { type: "overtime"; sessionId: number; expectedRevision: number }
  | { type: "capture" }
  | { type: "choose-finish" }
  | {
      type: "finish";
      sessionId: number;
      expectedRevision: number;
      outcome: FocusFinishOutcome;
    };

export interface FocusSnapshotGate {
  beginRequest(): FocusSnapshotRequest;
  isCurrent(token: FocusSnapshotRequest): boolean;
  applyResponse(token: FocusSnapshotRequest, status: FocusStatus): boolean;
  applyEvent(status: FocusStatus): boolean;
}

export interface FocusSnapshotRequest {
  sequence: number;
  snapshotCursor: number;
  sessionId: number | null;
  revision: number | null;
}

export interface FocusPresentationState {
  status: FocusStatus | null;
  statusError: string | null;
  feedback: string | null;
  finishChooserOpen: boolean;
}

export interface FocusPresentationController {
  readonly state: FocusPresentationState;
  applySnapshot(status: FocusStatus): void;
  showFailure(message: string): void;
  clearFeedback(): void;
  openFinishChooser(): void;
  closeFinishChooser(restoreFocus?: boolean): void;
}

export interface FocusPresentationEffects {
  render(
    state: Readonly<FocusPresentationState>,
    options: { restoreFinishFocus: boolean },
  ): void;
  reportHitbox(): void;
}

export interface OverlayVisibilityInput {
  pointerInside: boolean;
  focusWithin: boolean;
}

export interface FocusRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FocusHitboxInput {
  base: FocusRect | null;
  chip: FocusRect | null;
  dock: FocusRect | null;
  chooser: FocusRect | null;
  scale: FocusRect | null;
}

export interface OverlayCommandFailure {
  message: string;
  current: FocusStatus | null;
}

function mutationTarget(status: FocusStatus): FocusMutationTarget | null {
  const active = status.active;
  return active
    ? { sessionId: active.id, expectedRevision: active.transition_revision }
    : null;
}

/** Traduce una capability del core in un intento IPC, senza inventare azioni. */
export function overlayActionCommand(
  status: FocusStatus,
  action: FocusAction,
): OverlayActionCommand | null {
  if (!status.allowed_actions.includes(action)) return null;
  if (action === "focus.start_last") return { type: "start-last" };
  if (action === "focus.capture") return { type: "capture" };

  const target = mutationTarget(status);
  if (!target) return null;
  switch (action) {
    case "focus.pause":
      return { type: "pause", ...target };
    case "focus.resume":
      return { type: "resume", ...target };
    case "focus.extend_5":
      return { type: "adjust", ...target, deltaMs: 5 * 60_000 };
    case "focus.overtime":
      return { type: "overtime", ...target };
    case "focus.finish":
      return status.active?.kind === "focus"
        ? { type: "choose-finish" }
        : { type: "finish", ...target, outcome: "partial" };
    case "break.skip":
      return { type: "finish", ...target, outcome: "partial" };
    case "break.start":
      return null;
    default:
      return null;
  }
}

export function focusFinishCommand(
  status: FocusStatus,
  outcome: FocusFinishOutcome,
): OverlayActionCommand | null {
  if (
    status.active?.kind !== "focus" ||
    !status.allowed_actions.includes("focus.finish")
  ) {
    return null;
  }
  const target = mutationTarget(status);
  return target ? { type: "finish", ...target, outcome } : null;
}

function snapshotIdentity(status: FocusStatus | null): {
  sessionId: number | null;
  revision: number | null;
} {
  return status?.active
    ? {
        sessionId: status.active.id,
        revision: status.active.transition_revision,
      }
    : { sessionId: null, revision: null };
}

function snapshotCursor(status: FocusStatus | null): number {
  return status?.snapshot_cursor ?? 0;
}

function sameIdentity(
  left: { sessionId: number | null; revision: number | null },
  right: { sessionId: number | null; revision: number | null },
): boolean {
  return left.sessionId === right.sessionId && left.revision === right.revision;
}

function snapshotIsNewer(current: FocusStatus | null, next: FocusStatus): boolean {
  return current === null || next.snapshot_cursor > current.snapshot_cursor;
}

/**
 * Ordina snapshot pull, risposte di mutazione ed eventi push usando il cursore
 * assegnato dal backend mentre cattura lo stato. Il token conserva anche
 * l'identità locale per invalidare gli errori IPC che non portano uno snapshot.
 */
export function createFocusSnapshotGate(
  apply: (status: FocusStatus) => void,
): FocusSnapshotGate {
  let sequence = 0;
  let current: FocusStatus | null = null;
  const isCurrent = (token: FocusSnapshotRequest): boolean =>
    token.sequence === sequence &&
    token.snapshotCursor === snapshotCursor(current) &&
    sameIdentity(token, snapshotIdentity(current));
  return {
    beginRequest() {
      const identity = snapshotIdentity(current);
      return {
        sequence: ++sequence,
        snapshotCursor: snapshotCursor(current),
        ...identity,
      };
    },
    isCurrent,
    applyResponse(token, status) {
      if (
        status.snapshot_cursor <= token.snapshotCursor ||
        !snapshotIsNewer(current, status)
      ) {
        return false;
      }
      sequence += 1;
      current = status;
      apply(status);
      return true;
    },
    applyEvent(status) {
      if (!snapshotIsNewer(current, status)) return false;
      sequence += 1;
      current = status;
      apply(status);
      return true;
    },
  };
}

export function createFocusPresentationController(
  effects: FocusPresentationEffects,
): FocusPresentationController {
  let state: FocusPresentationState = {
    status: null,
    statusError: null,
    feedback: null,
    finishChooserOpen: false,
  };

  const commit = (
    next: FocusPresentationState,
    restoreFinishFocus = false,
  ): void => {
    state = next;
    effects.render(state, { restoreFinishFocus });
    effects.reportHitbox();
  };

  return {
    get state() {
      return state;
    },
    applySnapshot(status) {
      commit({
        status,
        statusError: null,
        feedback: null,
        finishChooserOpen: false,
      });
    },
    showFailure(message) {
      commit({ ...state, statusError: message, feedback: message });
    },
    clearFeedback() {
      if (state.feedback === null) return;
      commit({ ...state, feedback: null });
    },
    openFinishChooser() {
      if (state.finishChooserOpen) return;
      commit({ ...state, finishChooserOpen: true });
    },
    closeFinishChooser(restoreFocus = false) {
      if (!state.finishChooserOpen) return;
      commit({ ...state, finishChooserOpen: false }, restoreFocus);
    },
  };
}

export function overlayVisibility(
  input: OverlayVisibilityInput,
): { dockVisible: boolean } {
  return { dockVisible: input.pointerInside || input.focusWithin };
}

function union(a: FocusRect | null, b: FocusRect | null): FocusRect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

export function focusHitbox(input: FocusHitboxInput): FocusRect | null {
  return [input.base, input.chip, input.dock, input.chooser, input.scale].reduce<FocusRect | null>(
    union,
    null,
  );
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

export function overlayCommandFailure(error: unknown): OverlayCommandFailure {
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
    message:
      error instanceof Error ? error.message : "Impossibile completare l’azione.",
    current: null,
  };
}

/** Mostra un errore IPC soltanto se appartiene ancora alla richiesta corrente. */
export function presentOverlayCommandFailure(
  gate: FocusSnapshotGate,
  presentation: FocusPresentationController,
  request: FocusSnapshotRequest,
  error: unknown,
): boolean {
  const failure = overlayCommandFailure(error);
  const responseIsCurrent = failure.current
    ? gate.applyResponse(request, failure.current)
    : gate.isCurrent(request);
  if (!responseIsCurrent) return false;
  presentation.showFailure(failure.message);
  return true;
}
