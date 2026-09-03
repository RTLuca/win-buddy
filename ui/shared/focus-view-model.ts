import type { FocusAction, FocusStatus, SessionPhase } from "./contracts";

export interface FocusActionView {
  id: FocusAction;
  label: string;
  ariaLabel: string;
}

interface ActionCopy {
  label: string;
  ariaLabel: string;
}

const ACTION_COPY: Record<FocusAction, ActionCopy> = {
  "focus.start_last": { label: "Avvia", ariaLabel: "Avvia ultimo preset" },
  "focus.pause": { label: "Pausa", ariaLabel: "Metti in pausa il focus" },
  "focus.resume": { label: "Riprendi", ariaLabel: "Riprendi il focus" },
  "focus.extend_5": { label: "+5", ariaLabel: "Aggiungi 5 minuti al focus" },
  "focus.capture": {
    label: "Cattura",
    ariaLabel: "Cattura un'interruzione",
  },
  "focus.finish": { label: "Concludi", ariaLabel: "Concludi focus" },
  "focus.overtime": { label: "Continua", ariaLabel: "Continua in overtime" },
  "break.start": { label: "Pausa", ariaLabel: "Avvia pausa" },
  "break.skip": { label: "Salta", ariaLabel: "Salta pausa" },
};

const FOCUS_PHASE_LABEL: Record<Exclude<SessionPhase, "closed">, string> = {
  running: "Focus",
  paused: "In pausa",
  ready_to_close: "decidi",
  overtime: "",
};

function formatClock(ms: number): string {
  const finiteMs = Number.isFinite(ms) ? ms : 0;
  const seconds = Math.max(0, Math.ceil(finiteMs / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(remainder).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`;
}

/**
 * Deriva il testo dell'orologio dallo snapshot e dall'istante ricevuti.
 * Non conserva tick o scadenze locali: il core rimane l'unica autorità.
 */
export function focusClock(status: FocusStatus, now: number): string {
  const session = status.active;
  if (!session || session.phase === "closed") return "";
  if (session.phase === "paused") {
    return formatClock(session.paused_remaining_ms ?? status.remaining_ms ?? 0);
  }
  if (session.phase === "overtime") {
    return `+${formatClock(now - (session.overtime_started_at ?? now))}`;
  }
  if (session.phase === "ready_to_close") {
    return session.kind === "focus" ? "00:00" : "";
  }
  return formatClock(session.deadline_at - now);
}

/** Etichetta testuale della fase, indipendente dal colore e dal clock. */
export function focusLabel(status: FocusStatus): string {
  const session = status.active;
  if (!session || session.phase === "closed") return "Pronto";
  if (session.kind === "focus") return FOCUS_PHASE_LABEL[session.phase];
  if (session.phase === "ready_to_close") return "Pronto a tornare";
  if (session.phase === "running") return "Pausa";
  return FOCUS_PHASE_LABEL[session.phase];
}

/** Compone i due segmenti approvati nell'ordine specifico della fase. */
export function focusIndicator(status: FocusStatus, now: number): string {
  const label = focusLabel(status);
  const clock = focusClock(status, now);
  if (!clock) return label;
  if (!label) return clock;
  return status.active?.phase === "ready_to_close"
    ? `${clock} · ${label}`
    : `${label} · ${clock}`;
}

/**
 * Presenta nell'ordine ricevuto soltanto le azioni autorizzate dal core.
 * Le etichette accessibili distinguono il contesto focus da quello pausa.
 */
export function buddyActions(status: FocusStatus): FocusActionView[] {
  const isBreak = status.active !== null && status.active.kind !== "focus";

  return status.allowed_actions.map((id) => {
    const copy = ACTION_COPY[id];
    if (!isBreak) return { id, ...copy };
    if (id === "focus.extend_5") {
      return { id, label: copy.label, ariaLabel: "Aggiungi 5 minuti alla pausa" };
    }
    if (id === "focus.finish") {
      return { id, label: copy.label, ariaLabel: "Concludi pausa" };
    }
    return { id, ...copy };
  });
}
