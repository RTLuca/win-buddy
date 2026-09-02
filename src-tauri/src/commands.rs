//! I comandi invocabili dalle superfici: le azioni dell'utente, l'unico
//! flusso che risale dal renderer al core (§ 12).
//!
//! Ogni comando che può creare o distruggere una finestra è `async`: un
//! comando sincrono viene eseguito dentro la callback IPC della webview
//! chiamante, e su Windows creare una WebView2 da lì non completa mai
//! l'inizializzazione (finestra bianca, poi stallo). Da `async` il comando
//! gira sul thread pool e la creazione arriva all'event loop pulita.
//! Il tray e le scorciatoie girano già sull'event loop: usano gli helper
//! sincroni `do_*`.

use std::sync::atomic::Ordering;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use win_buddy_core::events::{BubbleShow, HitBox, StateChanged, EVT_NOTES_CHANGED};
use win_buddy_core::model::{
    Note, NoteState, PomodoroSession, SessionKind, SessionOutcome, StartSession,
};
use win_buddy_core::parse;
use win_buddy_core::pomodoro::{self, PomodoroConfig};

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

fn touch(app: &AppHandle) {
    app.state::<AppState>()
        .last_interaction
        .store(now_ms(), Ordering::Relaxed);
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

/// Lo stato iniziale dell'overlay, restituito da `surface_ready`: la
/// superficie lo *chiede* invece di sperare che gli eventi arrivino dopo
/// la registrazione dei listener. Niente race, niente creatura mancante.
#[derive(Serialize)]
pub struct OverlayBoot {
    creature_id: String,
    mode: String,
    state: Option<StateChanged>,
    bubble: Option<BubbleShow>,
}

#[derive(Serialize)]
pub struct MonitorInfo {
    index: usize,
    id: String,
    name: String,
    width: u32,
    height: u32,
    primary: bool,
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
pub async fn capture_submit(
    app: AppHandle,
    text: String,
    due_at_ms: Option<i64>,
) -> CmdResult<NoteView> {
    touch(&app);
    let now_local = local_naive_now();
    let p = parse::parse_capture(&text, now_local);
    // il selettore esplicito vince sul pattern nel testo
    let due = match due_at_ms {
        Some(ms) => Some(ms),
        None => p.due_local.map(local_to_epoch_ms),
    };
    let body = if p.body.is_empty() { text.trim().to_string() } else { p.body };
    let note = {
        let state = app.state::<AppState>();
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
pub async fn capture_cancel(app: AppHandle) -> CmdResult<()> {
    surfaces::close_capture(&app);
    Ok(())
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
pub fn notes_search(
    state: State<AppState>,
    query: String,
    limit: Option<i64>,
) -> CmdResult<Vec<NoteView>> {
    let store = state.store.lock().unwrap();
    Ok(store
        .search_notes(&query, limit.unwrap_or(100))
        .map_err(err)?
        .into_iter()
        .map(view)
        .collect())
}

#[tauri::command]
pub async fn note_complete(app: AppHandle, id: i64) -> CmdResult<()> {
    touch(&app);
    {
        let state = app.state::<AppState>();
        let store = state.store.lock().unwrap();
        store.complete_note(id, now_ms()).map_err(err)?;
    }
    notes_changed(&app);
    presenter::sync(&app);
    Ok(())
}

#[tauri::command]
pub async fn note_dismiss(app: AppHandle, id: i64) -> CmdResult<()> {
    touch(&app);
    {
        let state = app.state::<AppState>();
        let store = state.store.lock().unwrap();
        store.dismiss_note(id, now_ms()).map_err(err)?;
    }
    notes_changed(&app);
    presenter::sync(&app);
    Ok(())
}

#[tauri::command]
pub async fn note_snooze(app: AppHandle, id: i64, minutes: i64) -> CmdResult<()> {
    touch(&app);
    {
        let state = app.state::<AppState>();
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

pub fn do_pomodoro_start(
    app: &AppHandle,
    kind: SessionKind,
    label: Option<&str>,
) -> CmdResult<PomodoroStatusDto> {
    touch(app);
    {
        let state = app.state::<AppState>();
        let store = state.store.lock().unwrap();
        let cfg = PomodoroConfig::load(&store);
        let now = now_ms();
        if kind == SessionKind::Focus {
            let preset_id = store.default_preset().map_err(err)?.id;
            let request = StartSession::focus(
                preset_id,
                label.unwrap_or_default(),
                cfg.duration_ms(SessionKind::Focus),
            );
            pomodoro::start(&store, request, now).map_err(err)?;
        } else {
            pomodoro::start_break(&store, kind, cfg.duration_ms(kind), now).map_err(err)?;
        }
    }
    *app.state::<AppState>().break_prompt.lock().unwrap() = None;
    presenter::sync(app);
    pomodoro_status_dto(app)
}

pub fn do_pomodoro_abort(app: &AppHandle) -> CmdResult<PomodoroStatusDto> {
    touch(app);
    {
        let state = app.state::<AppState>();
        let store = state.store.lock().unwrap();
        if let Some(session) = store.open_session().map_err(err)? {
            pomodoro::finish(
                &store,
                session.id,
                session.transition_revision,
                SessionOutcome::Interrupted,
                None,
                now_ms(),
            )
            .map_err(err)?;
        }
    }
    presenter::sync(app);
    pomodoro_status_dto(app)
}

#[tauri::command]
pub async fn pomodoro_start(
    app: AppHandle,
    kind: SessionKind,
    label: Option<String>,
) -> CmdResult<PomodoroStatusDto> {
    do_pomodoro_start(&app, kind, label.as_deref())
}

#[tauri::command]
pub async fn pomodoro_abort(app: AppHandle) -> CmdResult<PomodoroStatusDto> {
    do_pomodoro_abort(&app)
}

#[tauri::command]
pub fn pomodoro_status(app: AppHandle) -> CmdResult<PomodoroStatusDto> {
    pomodoro_status_dto(&app)
}

#[tauri::command]
pub fn pomodoro_history(
    state: State<AppState>,
    limit: Option<i64>,
) -> CmdResult<Vec<PomodoroSession>> {
    let store = state.store.lock().unwrap();
    store.session_history(limit.unwrap_or(50)).map_err(err)
}

#[tauri::command]
pub async fn break_accept(app: AppHandle) -> CmdResult<PomodoroStatusDto> {
    touch(&app);
    let kind = app.state::<AppState>().break_prompt.lock().unwrap().take();
    if let Some(kind) = kind {
        let state = app.state::<AppState>();
        let store = state.store.lock().unwrap();
        let cfg = PomodoroConfig::load(&store);
        pomodoro::start_break(&store, kind, cfg.duration_ms(kind), now_ms()).map_err(err)?;
    }
    presenter::sync(&app);
    pomodoro_status_dto(&app)
}

#[tauri::command]
pub async fn break_skip(app: AppHandle) -> CmdResult<PomodoroStatusDto> {
    touch(&app);
    *app.state::<AppState>().break_prompt.lock().unwrap() = None;
    presenter::sync(&app);
    pomodoro_status_dto(&app)
}

// ------------------------------------------------------------ impostazioni

#[tauri::command]
pub fn settings_all(state: State<AppState>) -> CmdResult<std::collections::HashMap<String, String>> {
    let store = state.store.lock().unwrap();
    Ok(store.all_settings().map_err(err)?.into_iter().collect())
}

pub fn do_setting_set(app: &AppHandle, key: &str, value: &str) -> CmdResult<()> {
    touch(app);
    if matches!(key, "buddy.corner" | "overlay.monitor") {
        surfaces::cancel_overlay_drag(app);
    }
    {
        let state = app.state::<AppState>();
        let store = state.store.lock().unwrap();
        if key == "buddy.corner" {
            store
                .set_settings(&[
                    ("buddy.corner", value),
                    ("overlay.position.mode", "corner"),
                ])
                .map_err(err)?;
        } else {
            store.set_setting(key, value).map_err(err)?;
        }
    }
    match key {
        "buddy.corner" | "overlay.scale" | "overlay.monitor" => {
            surfaces::apply_overlay_layout(app)?;
        }
        _ => {}
    }
    // creatura, modalità, DND, durate: la sync riallinea tutto
    presenter::sync(app);
    crate::tray::rebuild_menu_state(app);
    Ok(())
}

#[tauri::command]
pub async fn setting_set(app: AppHandle, key: String, value: String) -> CmdResult<()> {
    do_setting_set(&app, &key, &value)
}

#[tauri::command]
pub fn dnd_status(app: AppHandle) -> CmdResult<DndStatusDto> {
    dnd_status_dto(&app)
}

pub fn do_dnd_set_manual(app: &AppHandle, hidden: bool) -> CmdResult<DndStatusDto> {
    touch(app);
    {
        let state = app.state::<AppState>();
        let store = state.store.lock().unwrap();
        store
            .set_setting("dnd.manual", if hidden { "1" } else { "0" })
            .map_err(err)?;
    }
    // all'uscita dal DND la sync applica il recupero della pila (§ 10.3)
    presenter::sync(app);
    crate::tray::rebuild_menu_state(app);
    dnd_status_dto(app)
}

#[tauri::command]
pub async fn dnd_set_manual(app: AppHandle, hidden: bool) -> CmdResult<DndStatusDto> {
    do_dnd_set_manual(&app, hidden)
}

/// DND manuale via scorciatoia o tray: alterna nascosto/normale.
pub fn toggle_dnd(app: &AppHandle) {
    let hidden = {
        let state = app.state::<AppState>();
        let store = state.store.lock().unwrap();
        store.setting("dnd.manual").ok().flatten().as_deref() == Some("1")
    };
    if let Err(e) = do_dnd_set_manual(app, !hidden) {
        log::warn!("toggle DND fallito: {e}");
    }
}

// ------------------------------------------------------------------ schermi

#[tauri::command]
pub fn monitors_list(app: AppHandle) -> CmdResult<Vec<MonitorInfo>> {
    let primary_pos = app.primary_monitor().ok().flatten().map(|m| *m.position());
    let monitors = app.available_monitors().map_err(err)?;
    Ok(monitors
        .iter()
        .enumerate()
        .map(|(index, m)| MonitorInfo {
            index,
            id: surfaces::monitor_id(m),
            name: m
                .name()
                .map(|n| n.trim_start_matches("\\\\.\\").to_string())
                .unwrap_or_else(|| format!("Schermo {}", index + 1)),
            width: m.size().width,
            height: m.size().height,
            primary: primary_pos.map(|p| p == *m.position()).unwrap_or(index == 0),
        })
        .collect())
}

// ----------------------------------------------------------------- overlay

#[tauri::command]
pub fn hittest_update(state: State<AppState>, x: f64, y: f64, w: f64, h: f64) {
    *state.hitbox.lock().unwrap() = Some(HitBox { x, y, w, h });
}

#[tauri::command]
pub fn overlay_drag_start(app: AppHandle) -> CmdResult<()> {
    touch(&app);
    surfaces::start_overlay_drag(&app)
}

#[tauri::command]
pub fn overlay_position_reset(app: AppHandle) -> CmdResult<()> {
    touch(&app);
    surfaces::reset_overlay_position(&app)
}

#[tauri::command]
pub fn overlay_position_nudge(app: AppHandle, x: i32, y: i32) -> CmdResult<()> {
    touch(&app);
    surfaces::nudge_overlay_position(&app, x.clamp(-1, 1) * 10, y.clamp(-1, 1) * 10)
}

/// La superficie è pronta. Per l'overlay risponde con lo stato iniziale
/// completo (§ 10.5): il replay a eventi non basta, perché la webview
/// potrebbe non avere ancora registrato i listener quando gli eventi partono.
#[tauri::command]
pub async fn surface_ready(app: AppHandle, surface: String) -> CmdResult<Option<OverlayBoot>> {
    if surface != "overlay" {
        return Ok(None);
    }
    // riallinea le cache (bolla, stato) e il ciclo di vita
    presenter::sync(&app);

    let state = app.state::<AppState>();
    let (creature_id, sober) = {
        let store = state.store.lock().unwrap();
        let creature = store
            .setting("buddy.creature")
            .ok()
            .flatten()
            .unwrap_or_else(|| "cotone".into());
        let sober = store.setting("buddy.mode").ok().flatten().as_deref() == Some("sober");
        (creature, sober)
    };
    let force_sober = presenter::effective_dnd(&app).policy().force_sober;
    let last_state = state.last_state.lock().unwrap().clone();
    let bubble = state.bubble.lock().unwrap().clone();
    Ok(Some(OverlayBoot {
        creature_id,
        mode: if sober || force_sober { "sober".into() } else { "full".into() },
        state: last_state,
        bubble,
    }))
}

#[tauri::command]
pub async fn open_panel(app: AppHandle) -> CmdResult<()> {
    touch(&app);
    surfaces::open_panel(&app);
    Ok(())
}

#[tauri::command]
pub async fn close_panel(app: AppHandle) -> CmdResult<()> {
    surfaces::close_panel(&app);
    Ok(())
}

/// La cattura rapida dalla barra vicino al buddy: stessa finestra della
/// scorciatoia globale.
#[tauri::command]
pub async fn open_capture(app: AppHandle) -> CmdResult<()> {
    touch(&app);
    surfaces::open_capture(&app);
    Ok(())
}
