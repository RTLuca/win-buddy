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
  beginRead(): number;
  applyRead(token: number, status: FocusStatus): void;
  applyAuthoritative(status: FocusStatus): void;
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

/** Un evento o una mutazione autorevole rende obsoleta ogni lettura pendente. */
export function createFocusSnapshotGate(
  apply: (status: FocusStatus) => void,
): FocusSnapshotGate {
  let version = 0;
  return {
    beginRead: () => ++version,
    applyRead(token, status) {
      if (token === version) apply(status);
    },
    applyAuthoritative(status) {
      version += 1;
      apply(status);
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
