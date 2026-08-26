/**
 * Involucro tipizzato su invoke/listen di Tauri. Tutte le superfici passano
 * di qui: il renderer chiede, il core decide.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  CapturePreview,
  DndStatus,
  MonitorInfo,
  NoteView,
  OverlayBoot,
  PomodoroStatus,
  SessionKind,
} from "./contracts";

export function on<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  return listen<T>(event, (e) => handler(e.payload));
}

// ------------------------------------------------------------------ note

export const capturePreview = (text: string) =>
  invoke<CapturePreview>("capture_preview", { text });

export const captureSubmit = (text: string, dueAtMs?: number | null) =>
  invoke<NoteView>("capture_submit", { text, dueAtMs: dueAtMs ?? null });

export const captureCancel = () => invoke<void>("capture_cancel");

export const notesOpen = () => invoke<NoteView[]>("notes_open");
export const notesArchive = (limit = 200) => invoke<NoteView[]>("notes_archive", { limit });
export const notesSearch = (query: string, limit = 100) =>
  invoke<NoteView[]>("notes_search", { query, limit });

export const noteComplete = (id: number) => invoke<void>("note_complete", { id });
export const noteDismiss = (id: number) => invoke<void>("note_dismiss", { id });
export const noteSnooze = (id: number, minutes: number) =>
  invoke<void>("note_snooze", { id, minutes });

// -------------------------------------------------------------- pomodoro

export const pomodoroStart = (kind: SessionKind, label?: string) =>
  invoke<PomodoroStatus>("pomodoro_start", { kind, label: label ?? null });
export const pomodoroAbort = () => invoke<PomodoroStatus>("pomodoro_abort");
export const pomodoroStatus = () => invoke<PomodoroStatus>("pomodoro_status");
export const pomodoroHistory = (limit = 50) =>
  invoke<import("./contracts").PomodoroSession[]>("pomodoro_history", { limit });

// ------------------------------------------------------- impostazioni/DND

export const settingsAll = () => invoke<Record<string, string>>("settings_all");
export const settingSet = (key: string, value: string) =>
  invoke<void>("setting_set", { key, value });

export const dndStatus = () => invoke<DndStatus>("dnd_status");
export const dndSetManual = (hidden: boolean) => invoke<DndStatus>("dnd_set_manual", { hidden });

// ---------------------------------------------------------------- overlay

/** Il renderer comunica il rettangolo occupato, normalizzato 0..1 (§ 10.2). */
export const hittestUpdate = (x: number, y: number, w: number, h: number) =>
  invoke<void>("hittest_update", { x, y, w, h });

/** La superficie è pronta: per l'overlay il core risponde con lo stato iniziale. */
export const surfaceReady = (surface: "overlay" | "panel" | "capture") =>
  invoke<OverlayBoot | null>("surface_ready", { surface });

/** Gli schermi disponibili, per le impostazioni. */
export const monitorsList = () => invoke<MonitorInfo[]>("monitors_list");

export const openPanel = () => invoke<void>("open_panel");
export const closePanel = () => invoke<void>("close_panel");

/** Azione sulla bolla in cima alla pila: il core decide cosa mostrare dopo. */
export const breakAccept = () => invoke<PomodoroStatus>("break_accept");
export const breakSkip = () => invoke<PomodoroStatus>("break_skip");
