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
  { id: "cotone", name: "Cotone", species: "draghetto di nuvola", trait: "coda a segmenti" },
  { id: "bolete", name: "Bolete", species: "folletto fungo", trait: "silhouette a tappo" },
  { id: "quarzo", name: "Quarzo", species: "golem di cristallo", trait: "un occhio solo" },
  { id: "brace", name: "Brace", species: "draghetto sputafuoco", trait: "faccettato low-poly" },
  { id: "ottone", name: "Ottone", species: "automa da tavolo", trait: "visore programmabile" },
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

export interface StateChanged {
  state: BuddyState;
  /**
   * Scadenza assoluta (epoch ms) del countdown, se c'è. Il renderer
   * ricalcola `until − Date.now()` a ogni aggiornamento: nessun contatore.
   */
  until?: number;
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
export type SessionOutcome = "completed" | "aborted" | "invalidated";

export interface PomodoroSession {
  id: number;
  kind: SessionKind;
  started_at: number;
  ends_at: number;
  outcome: SessionOutcome | null;
  resolved_at: number | null;
  label: string | null;
}

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
}

export interface MonitorInfo {
  index: number;
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
  aborted: "interrotta",
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
