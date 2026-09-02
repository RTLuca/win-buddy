/**
 * win-buddy · contratti condivisi tra le superfici.
 *
 * Specchiano i tipi di `crates/core/src/events.rs`: il core emette, il
 * renderer ascolta. Il renderer non calcola scadenze, non decide quando è
 * ora di una pausa, non tiene contatori (§ 5).
 */

import type { Group, Scene, Vector3 } from "three";

/** Gli stati che il core può chiedere. Il renderer non ne inventa altri. */
export type BuddyState = "idle" | "focus" | "break" | "alert" | "celebrate" | "sleep";

/**
 * Il colore è la lingua franca degli stati: qualunque creatura scelga
 * l'utente, il suo organo di stato (fiammella, visore, anello) parla con
 * questi colori. Il significato non cambia col personaggio (§ 9.2).
 */
export const STATE_COLOR: Record<BuddyState, number> = {
  idle: 0xbfb3e8,
  focus: 0x57a98b,
  break: 0x9bd4f5,
  alert: 0xf2b441,
  celebrate: 0x8ce0a8,
  sleep: 0x4a4270,
};

export interface BuddyMeta {
  id: string;
  name: string;
  species: string;
  trait: string;
}

/** Il bestiario (§ 9): dati statici, condivisi da overlay e pannello. */
export const CREATURE_META: BuddyMeta[] = [
  { id: "lume", name: "Lume", species: "spirito da lanterna", trait: "mani staccate" },
  { id: "cotone", name: "Cotone", species: "draghetto di nuvola", trait: "galleggia, orecchie lunghe" },
  { id: "bolete", name: "Bolete", species: "folletto fungo", trait: "silhouette a tappo" },
  { id: "quarzo", name: "Quarzo", species: "golem di cristallo", trait: "un occhio solo" },
  { id: "brace", name: "Brace", species: "draghetto sputafuoco", trait: "faccettato low-poly" },
  { id: "ottone", name: "Ottone", species: "automa da tavolo", trait: "visore programmabile" },
  { id: "roberto", name: "Roberto", species: "ospite importato", trait: "sta in piedi, ha le mani" },
];

/** Contratto delle creature (§ 9.1): quattro metodi e nient'altro. */
export interface Buddy {
  readonly meta: BuddyMeta;
  /** Costruisce la gerarchia e la aggiunge alla scena. Chiamato una volta. */
  mount(scene: Scene): Group;
  /** Idempotente: due chiamate con lo stesso stato non producono scatti. */
  setState(state: BuddyState): void;
  /**
   * Avanza l'animazione. Non legge l'orologio da sé: se il loop è in pausa
   * perché l'overlay è occluso, la creatura si congela, non recupera.
   */
  update(t: number, dt: number): void;
  /** Il punto 3D a cui si aggancia la nuvoletta. */
  getAnchor(): Vector3;
  /** Rilascia geometrie, materiali e texture (§ 9.4). */
  dispose(): void;
}

export type BuddyFactory = () => Buddy;

// ------------------------------------------------------------- eventi § 12

export const EVT_STATE_CHANGED = "state:changed";
export const EVT_BUBBLE_SHOW = "bubble:show";
export const EVT_BUBBLE_DISMISS = "bubble:dismiss";
export const EVT_BUDDY_CHANGED = "buddy:changed";
export const EVT_MODE_CHANGED = "mode:changed";
export const EVT_NOTES_CHANGED = "notes:changed";
export const EVT_POMODORO_PRESENTATION = "pomodoro:presentation";
export const EVT_FOCUS_CHANGED = "focus:changed";

export type ActiveSessionPhase = "running" | "paused" | "ready_to_close" | "overtime";

export interface StateChanged {
  state: BuddyState;
  phase?: ActiveSessionPhase;
  /**
   * Scadenza assoluta (epoch ms) del countdown, se c'è. Il renderer
   * ricalcola `until − Date.now()` a ogni aggiornamento: nessun contatore.
   */
  until?: number;
  remaining_ms?: number;
  overtime_ms?: number;
  label?: string;
}

export type BubbleKind = "reminder" | "info" | "summary" | "break_prompt";

export interface BubbleShow {
  id: number;
  text: string;
  kind: BubbleKind;
  urgent: boolean;
  position?: [number, number];
}

export interface BubbleDismiss {
  id: number;
}

export interface BuddyChanged {
  creature_id: string;
}

export interface ModeChanged {
  mode: "full" | "sober";
}

// --------------------------------------------------------- viste dal core

export type NoteState = "pending" | "fired" | "done" | "dismissed";

export interface Note {
  id: number;
  body: string;
  created_at: number;
  due_at: number | null;
  urgent: boolean;
  state: NoteState;
  fired_at: number | null;
  snooze_count: number;
  completed_at: number | null;
}

/** Una nota con l'etichetta della scadenza già formattata dal core. */
export interface NoteView {
  note: Note;
  due_label: string | null;
  overdue: boolean;
}

export interface CapturePreview {
  body: string;
  matched: string | null;
  due_label: string | null;
  urgent: boolean;
}

export type SessionKind = "focus" | "short_break" | "long_break";
export type SessionPhase = ActiveSessionPhase | "closed";
export type SessionOutcome = "completed" | "partial" | "interrupted" | "invalidated";
export type FocusAction =
  | "focus.start_last"
  | "focus.pause"
  | "focus.resume"
  | "focus.extend_5"
  | "focus.capture"
  | "focus.finish"
  | "focus.overtime"
  | "break.start"
  | "break.skip";
export type PomodoroEventKind =
  | "prewarning"
  | "ready_to_close"
  | "return_prompt"
  | "recovery_needed";

/** Evento outbox arricchito soltanto con il tipo di sessione da presentare. */
export interface PomodoroPresentation {
  id: number;
  session_id: number;
  kind: PomodoroEventKind;
  transition_revision: number;
  session_kind: SessionKind;
}

export interface PomodoroSession {
  id: number;
  kind: SessionKind;
  preset_id: number | null;
  phase: SessionPhase;
  started_at: number;
  deadline_at: number;
  paused_remaining_ms: number | null;
  overtime_started_at: number | null;
  intention: string;
  category: string | null;
  planned_duration_ms: number;
  estimated_ms: number | null;
  next_step: string | null;
  outcome: SessionOutcome | null;
  interruption_reason: string | null;
  resolved_at: number | null;
  edited_at: number | null;
  transition_revision: number;
  /** Bridge temporaneo per le superfici non ancora migrate. */
  ends_at: number;
  /** Bridge temporaneo per le superfici non ancora migrate. */
  label: string | null;
}

export interface StartSession {
  kind: SessionKind;
  preset_id: number | null;
  intention: string;
  category: string | null;
  planned_duration_ms: number;
  estimated_ms: number | null;
  next_step: string | null;
}

export interface FocusStatus {
  active: PomodoroSession | null;
  effective_focus_ms: number;
  remaining_ms: number | null;
  overtime_ms: number | null;
  allowed_actions: FocusAction[];
  pending_captures: number;
  transition_revision: number | null;
}

/** Contratto legacy conservato soltanto durante il piano Buddy/Surfaces. */
export interface PomodoroStatus {
  active: PomodoroSession | null;
  focus_done_today: number;
  config: {
    focus_min: number;
    short_min: number;
    long_min: number;
    long_every: number;
    stale_sec: number;
  };
}

export interface DndStatus {
  manual: boolean;
  effective: "normal" | "discreet" | "hidden";
  queued: number;
}

/** Stato iniziale dell'overlay, risposto da `surface_ready` (niente race). */
export interface OverlayBoot {
  creature_id: string;
  mode: "full" | "sober";
  state: StateChanged | null;
  bubble: BubbleShow | null;
  presentations: PomodoroPresentation[];
}

export interface MonitorInfo {
  index: number;
  id: string;
  name: string;
  width: number;
  height: number;
  primary: boolean;
}

export const KIND_LABEL: Record<SessionKind, string> = {
  focus: "Focus",
  short_break: "Pausa breve",
  long_break: "Pausa lunga",
};

export const OUTCOME_LABEL: Record<SessionOutcome, string> = {
  completed: "completata",
  partial: "parziale",
  interrupted: "interrotta",
  invalidated: "invalidata",
};

/** mm:ss (o h:mm:ss oltre l'ora) da un residuo in millisecondi. */
export function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}
