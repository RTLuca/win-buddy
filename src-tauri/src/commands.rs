//! I comandi invocabili dalle superfici: le azioni dell'utente, l'unico
//! flusso che risale dal renderer al core (§ 12).

use std::sync::atomic::Ordering;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use win_buddy_core::events::{HitBox, EVT_NOTES_CHANGED};
use win_buddy_core::model::{Note, NoteState, PomodoroSession, SessionKind};
use win_buddy_core::pomodoro::{self, PomodoroConfig};
use win_buddy_core::parse;

use crate::presenter;
use crate::runtime;
use crate::state::{
    day_start_ms, epoch_ms_to_local, local_naive_now, local_to_epoch_ms, now_ms, AppState,
};
use crate::surfaces;

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn touch(state: &State<AppState>) {
    state.last_interaction.store(now_ms(), Ordering::Relaxed);
}

fn notes_changed(app: &AppHandle) {
    let _ = app.emit(EVT_NOTES_CHANGED, ());
}

// ------------------------------------------------------------------- viste

#[derive(Serialize)]
pub struct NoteView {
    note: Note,
    due_label: Option<String>,
    overdue: bool,
}

fn view(note: Note) -> NoteView {
    let now = now_ms();
    let due_label = note
        .due_at
        .map(|ms| parse::format_due_label(epoch_ms_to_local(ms), local_naive_now()));
    let overdue = note.state.is_open() && note.due_at.map(|d| d <= now).unwrap_or(false);
    NoteView { note, due_label, overdue }
}

#[derive(Serialize)]
pub struct CapturePreviewDto {
    body: String,
    matched: Option<String>,
    due_label: Option<String>,
    urgent: bool,
}

#[derive(Serialize)]
pub struct PomodoroStatusDto {
    active: Option<PomodoroSession>,
    focus_done_today: i64,
    config: PomodoroConfig,
}

#[derive(Serialize)]
pub struct DndStatusDto {
    manual: bool,
    effective: &'static str,
    queued: usize,
}

fn pomodoro_status_dto(app: &AppHandle) -> CmdResult<PomodoroStatusDto> {
    let state = app.state::<AppState>();
    let store = state.store.lock().unwrap();
    let now = now_ms();
    Ok(PomodoroStatusDto {
        active: pomodoro::active_session(&store, now).map_err(err)?,
        focus_done_today: store.completed_focus_since(day_start_ms()).map_err(err)?,
        config: PomodoroConfig::load(&store),
    })
}

fn dnd_status_dto(app: &AppHandle) -> CmdResult<DndStatusDto> {
    let state = app.state::<AppState>();
    let (manual, queued) = {
        let store = state.store.lock().unwrap();
        (
            store.setting("dnd.manual").map_err(err)?.as_deref() == Some("1"),
            store.fired_notes().map_err(err)?.len(),
        )
    };
    Ok(DndStatusDto {
        manual,
        effective: presenter::effective_dnd(app).as_str(),
        queued,
    })
}

// ----------------------------------------------------------------- cattura

#[tauri::command]
pub fn capture_preview(text: String) -> CapturePreviewDto {
    let now = local_naive_now();
    let p = parse::parse_capture(&text, now);
    CapturePreviewDto {
        body: p.body,
        matched: p.matched,
        due_label: p.due_local.map(|d| parse::format_due_label(d, now)),
        urgent: p.urgent,
    }
}

#[tauri::command]
pub fn capture_submit(
    app: AppHandle,
    state: State<AppState>,
    text: String,
    due_at_ms: Option<i64>,
) -> CmdResult<NoteView> {
    touch(&state);
    let now_local = local_naive_now();
    let p = parse::parse_capture(&text, now_local);
    // il selettore esplicito vince sul pattern nel testo
    let (body, due) = match due_at_ms {
        Some(ms) => (p.body, Some(ms)),
        None => (p.body, p.due_local.map(local_to_epoch_ms)),
    };
    let body = if body.is_empty() { text.trim().to_string() } else { body };
    let note = {
        let store = state.store.lock().unwrap();
        store.insert_note(&body, due, p.urgent, now_ms()).map_err(err)?
    };
    surfaces::close_capture(&app);
    notes_changed(&app);
    // una scadenza vicina può richiedere il timer mirato: si ripianifica ora
    runtime::do_tick(&app);
    Ok(view(note))
}

#[tauri::command]
pub fn capture_cancel(app: AppHandle) {
    surfaces::close_capture(&app);
}

// -------------------------------------------------------------------- note

#[tauri::command]
pub fn notes_open(state: State<AppState>) -> CmdResult<Vec<NoteView>> {
    let store = state.store.lock().unwrap();
    Ok(store.open_notes().map_err(err)?.into_iter().map(view).collect())
}

#[tauri::command]
pub fn notes_archive(state: State<AppState>, limit: Option<i64>) -> CmdResult<Vec<NoteView>> {
    let store = state.store.lock().unwrap();
    Ok(store
        .archive(limit.unwrap_or(200))
        .map_err(err)?
        .into_iter()
        .map(|n| {
            let mut v = view(n);
            v.due_label = match v.note.state {
                NoteState::Done => Some("completata".into()),
                NoteState::Dismissed => Some("ignorata".into()),
                _ => v.due_label,
            };
            v
        })
        .collect())
}

#[tauri::command]
pub fn notes_search(state: State<AppState>, query: String, limit: Option<i64>) -> CmdResult<Vec<NoteView>> {
    let store = state.store.lock().unwrap();
    Ok(store
        .search_notes(&query, limit.unwrap_or(100))
        .map_err(err)?
        .into_iter()
        .map(view)
        .collect())
}

#[tauri::command]
pub fn note_complete(app: AppHandle, state: State<AppState>, id: i64) -> CmdResult<()> {
    touch(&state);
    {
        let store = state.store.lock().unwrap();
        store.complete_note(id, now_ms()).map_err(err)?;
    }
    notes_changed(&app);
    presenter::sync(&app);
    Ok(())
}

#[tauri::command]
pub fn note_dismiss(app: AppHandle, state: State<AppState>, id: i64) -> CmdResult<()> {
    touch(&state);
    {
        let store = state.store.lock().unwrap();
        store.dismiss_note(id, now_ms()).map_err(err)?;
    }
    notes_changed(&app);
    presenter::sync(&app);
    Ok(())
}

#[tauri::command]
pub fn note_snooze(app: AppHandle, state: State<AppState>, id: i64, minutes: i64) -> CmdResult<()> {
    touch(&state);
    {
        let store = state.store.lock().unwrap();
        store
            .snooze_note(id, now_ms() + minutes.max(1) * 60_000)
            .map_err(err)?;
    }
    notes_changed(&app);
    runtime::do_tick(&app); // il rinvio breve può voler dire timer mirato
    Ok(())
}

// ---------------------------------------------------------------- pomodoro

#[tauri::command]
pub fn pomodoro_start(
    app: AppHandle,
    state: State<AppState>,
    kind: SessionKind,
    label: Option<String>,
) -> CmdResult<PomodoroStatusDto> {
    touch(&state);
    {
        let store = state.store.lock().unwrap();
        let cfg = PomodoroConfig::load(&store);
        pomodoro::start(&store, kind, label.as_deref(), now_ms(), &cfg).map_err(err)?;
    }
    *state.break_prompt.lock().unwrap() = None;
    presenter::sync(&app);
    pomodoro_status_dto(&app)
}

#[tauri::command]
pub fn pomodoro_abort(app: AppHandle, state: State<AppState>) -> CmdResult<PomodoroStatusDto> {
    touch(&state);
    {
        let store = state.store.lock().unwrap();
        pomodoro::abort(&store, now_ms()).map_err(err)?;
    }
    presenter::sync(&app);
    pomodoro_status_dto(&app)
}

#[tauri::command]
pub fn pomodoro_status(app: AppHandle) -> CmdResult<PomodoroStatusDto> {
    pomodoro_status_dto(&app)
}

#[tauri::command]
pub fn pomodoro_history(state: State<AppState>, limit: Option<i64>) -> CmdResult<Vec<PomodoroSession>> {
    let store = state.store.lock().unwrap();
    store.session_history(limit.unwrap_or(50)).map_err(err)
}

#[tauri::command]
pub fn break_accept(app: AppHandle, state: State<AppState>) -> CmdResult<PomodoroStatusDto> {
    touch(&state);
    let kind = state.break_prompt.lock().unwrap().take();
    if let Some(kind) = kind {
        let store = state.store.lock().unwrap();
        let cfg = PomodoroConfig::load(&store);
        pomodoro::start(&store, kind, None, now_ms(), &cfg).map_err(err)?;
    }
    presenter::sync(&app);
    pomodoro_status_dto(&app)
}

#[tauri::command]
pub fn break_skip(app: AppHandle, state: State<AppState>) -> CmdResult<PomodoroStatusDto> {
    touch(&state);
    *state.break_prompt.lock().unwrap() = None;
    presenter::sync(&app);
    pomodoro_status_dto(&app)
}

// ------------------------------------------------------------ impostazioni

#[tauri::command]
pub fn settings_all(state: State<AppState>) -> CmdResult<std::collections::HashMap<String, String>> {
    let store = state.store.lock().unwrap();
    Ok(store.all_settings().map_err(err)?.into_iter().collect())
}

#[tauri::command]
pub fn setting_set(app: AppHandle, state: State<AppState>, key: String, value: String) -> CmdResult<()> {
    touch(&state);
    {
        let store = state.store.lock().unwrap();
        store.set_setting(&key, &value).map_err(err)?;
    }
    match key.as_str() {
        "buddy.corner" => surfaces::reposition_overlay(&app),
        _ => {}
    }
    // creatura, modalità, DND, durate: la sync riallinea tutto
    presenter::sync(&app);
    Ok(())
}

#[tauri::command]
pub fn dnd_status(app: AppHandle) -> CmdResult<DndStatusDto> {
    dnd_status_dto(&app)
}

#[tauri::command]
pub fn dnd_set_manual(app: AppHandle, state: State<AppState>, hidden: bool) -> CmdResult<DndStatusDto> {
    touch(&state);
    {
        let store = state.store.lock().unwrap();
        store
            .set_setting("dnd.manual", if hidden { "1" } else { "0" })
            .map_err(err)?;
    }
    // all'uscita dal DND la sync applica il recupero della pila (§ 10.3)
    presenter::sync(&app);
    crate::tray::rebuild_menu_state(&app);
    dnd_status_dto(&app)
}

// ----------------------------------------------------------------- overlay

#[tauri::command]
pub fn hittest_update(state: State<AppState>, x: f64, y: f64, w: f64, h: f64) {
    *state.hitbox.lock().unwrap() = Some(HitBox { x, y, w, h });
}

#[tauri::command]
pub fn surface_ready(app: AppHandle, state: State<AppState>, surface: String) {
    if surface == "overlay" {
        // replay dello stato corrente sulla webview appena nata (§ 10.5)
        let bubble = state.bubble.lock().unwrap().clone();
        let last_state = state.last_state.lock().unwrap().clone();
        drop(state);
        presenter::sync(&app);
        if let Some(b) = bubble {
            let _ = app.emit(win_buddy_core::events::EVT_BUBBLE_SHOW, &b);
        }
        if let Some(s) = last_state {
            let _ = app.emit(win_buddy_core::events::EVT_STATE_CHANGED, &s);
        }
    }
}

#[tauri::command]
pub fn open_panel(app: AppHandle, state: State<AppState>) {
    touch(&state);
    surfaces::open_panel(&app);
}

#[tauri::command]
pub fn close_panel(app: AppHandle) {
    surfaces::close_panel(&app);
}

/// DND manuale via scorciatoia o tray: alterna nascosto/normale.
pub fn toggle_dnd(app: &AppHandle) {
    let hidden = {
        let state = app.state::<AppState>();
        let store = state.store.lock().unwrap();
        store.setting("dnd.manual").ok().flatten().as_deref() == Some("1")
    };
    let state = app.state::<AppState>();
    let _ = dnd_set_manual(app.clone(), state, !hidden);
}
