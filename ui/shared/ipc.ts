/**
 * Involucro tipizzato su invoke/listen di Tauri. Tutte le superfici passano
 * di qui: il renderer chiede, il core decide.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  CapturePreview,
  DndStatus,
  FocusFinishOutcome,
  FocusShortcutSettings,
  FocusStatus,
  MonitorInfo,
  NoteView,
  OverlayBoot,
  PomodoroPreset,
  StartSession,
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

export const focusStart = (request: StartSession) =>
  invoke<FocusStatus>("focus_start", { request });
export const focusStartLast = () => invoke<FocusStatus>("focus_start_last");
export const focusPause = (
  sessionId: number,
  expectedRevision: number,
  reason?: string | null,
) =>
  invoke<FocusStatus>("focus_pause", {
    sessionId,
    expectedRevision,
    reason: reason ?? null,
  });
export const focusResume = (sessionId: number, expectedRevision: number) =>
  invoke<FocusStatus>("focus_resume", { sessionId, expectedRevision });
export const focusAdjust = (
  sessionId: number,
  deltaMs: number,
  expectedRevision: number,
) => invoke<FocusStatus>("focus_adjust", { sessionId, deltaMs, expectedRevision });
export const focusOvertime = (sessionId: number, expectedRevision: number) =>
  invoke<FocusStatus>("focus_overtime", { sessionId, expectedRevision });
export const focusFinish = (
  sessionId: number,
  outcome: FocusFinishOutcome,
  expectedRevision: number,
  interruptionReason?: string | null,
) =>
  invoke<FocusStatus>("focus_finish", {
    sessionId,
    outcome,
    expectedRevision,
    interruptionReason: interruptionReason ?? null,
  });
export const focusStatus = () => invoke<FocusStatus>("focus_status");
export const focusPresets = () => invoke<PomodoroPreset[]>("focus_presets");
export const focusCompleteWithBreak = (eventId: number) =>
  invoke<FocusStatus>("focus_complete_with_break", { eventId });
export const focusCompleteWithoutBreak = (eventId: number) =>
  invoke<FocusStatus>("focus_complete_without_break", { eventId });
export const pomodoroHistory = (limit = 50) =>
  invoke<import("./contracts").PomodoroSession[]>("pomodoro_history", { limit });
export const pomodoroPresentationAck = (id: number) =>
  invoke<void>("pomodoro_presentation_ack", { id });

// ------------------------------------------------------- impostazioni/DND

export const settingsAll = () => invoke<Record<string, string>>("settings_all");
export const settingSet = (key: string, value: string) =>
  invoke<void>("setting_set", { key, value });
export const focusShortcutSettings = () =>
  invoke<FocusShortcutSettings>("focus_shortcut_settings");
export const focusShortcutSettingsApply = (settings: FocusShortcutSettings) =>
  invoke<FocusShortcutSettings>("focus_shortcut_settings_apply", { settings });
export const focusFinishIntentTake = () => invoke<boolean>("focus_finish_intent_take");

export const dndStatus = () => invoke<DndStatus>("dnd_status");
export const dndSetManual = (hidden: boolean) => invoke<DndStatus>("dnd_set_manual", { hidden });

// ---------------------------------------------------------------- overlay

/** Il renderer comunica il rettangolo occupato, normalizzato 0..1 (§ 10.2). */
export const hittestUpdate = (x: number, y: number, w: number, h: number) =>
  invoke<void>("hittest_update", { x, y, w, h });

export const overlayDragStart = () => invoke<void>("overlay_drag_start");

export const overlayPositionReset = () => invoke<void>("overlay_position_reset");

export const overlayPositionNudge = (x: number, y: number) =>
  invoke<void>("overlay_position_nudge", { x, y });

/** La superficie è pronta: per l'overlay il core risponde con lo stato iniziale. */
export const surfaceReady = (surface: "overlay" | "panel" | "capture") =>
  invoke<OverlayBoot | null>("surface_ready", { surface });

/** Gli schermi disponibili, per le impostazioni. */
export const monitorsList = () => invoke<MonitorInfo[]>("monitors_list");

export const openPanel = () => invoke<void>("open_panel");
export const closePanel = () => invoke<void>("close_panel");
export const openCapture = () => invoke<void>("open_capture");
