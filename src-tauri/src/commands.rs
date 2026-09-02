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
use win_buddy_core::events::{
    BubbleShow, HitBox, StateChanged, EVT_FOCUS_CHANGED, EVT_NOTES_CHANGED,
};
use win_buddy_core::model::{
    Note, NoteState, PomodoroSession, SessionKind, SessionOutcome, SessionPhase, StartSession,
};
use win_buddy_core::parse;
use win_buddy_core::pomodoro::{self, PomodoroConfig};
use win_buddy_core::Store;

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum FocusAction {
    #[serde(rename = "focus.start_last")]
    StartLast,
    #[serde(rename = "focus.pause")]
    Pause,
    #[serde(rename = "focus.resume")]
    Resume,
    #[serde(rename = "focus.extend_5")]
    Extend5,
    #[serde(rename = "focus.capture")]
    Capture,
    #[serde(rename = "focus.finish")]
    Finish,
    #[serde(rename = "focus.overtime")]
    Overtime,
    #[allow(dead_code)] // Contratto anticipato per il prompt pausa della slice superfici.
    #[serde(rename = "break.start")]
    StartBreak,
    #[serde(rename = "break.skip")]
    SkipBreak,
}

pub(crate) fn allowed_actions(phase: SessionPhase) -> Vec<FocusAction> {
    match phase {
        SessionPhase::Running => vec![
            FocusAction::Pause,
            FocusAction::Extend5,
            FocusAction::Capture,
            FocusAction::Finish,
        ],
        SessionPhase::Paused => vec![
            FocusAction::Resume,
            FocusAction::Capture,
            FocusAction::Finish,
        ],
        SessionPhase::ReadyToClose => vec![
            FocusAction::Overtime,
            FocusAction::Extend5,
            FocusAction::Finish,
        ],
        SessionPhase::Overtime => vec![FocusAction::Capture, FocusAction::Finish],
        SessionPhase::Closed => vec![],
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct FocusStatusDto {
    active: Option<PomodoroSession>,
    effective_focus_ms: i64,
    remaining_ms: Option<i64>,
    overtime_ms: Option<i64>,
    allowed_actions: Vec<FocusAction>,
    pending_captures: i64,
    transition_revision: Option<i64>,
}

fn session_actions(session: &PomodoroSession) -> Vec<FocusAction> {
    if session.kind == SessionKind::Focus {
        return allowed_actions(session.phase);
    }
    match session.phase {
        SessionPhase::Running | SessionPhase::ReadyToClose => vec![
            FocusAction::SkipBreak,
            FocusAction::Extend5,
            FocusAction::Finish,
        ],
        SessionPhase::Closed | SessionPhase::Paused | SessionPhase::Overtime => vec![],
    }
}

fn focus_status_from_store(store: &Store, now: i64) -> win_buddy_core::Result<FocusStatusDto> {
    let active = pomodoro::active_session(store, now)?;
    let effective_focus_ms = match active.as_ref() {
        Some(session) if session.kind == SessionKind::Focus => {
            store.effective_focus_ms(session.id, now)?.max(0)
        }
        _ => 0,
    };
    let remaining_ms = active.as_ref().and_then(|session| match session.phase {
        SessionPhase::Running => Some(session.deadline_at.saturating_sub(now).max(0)),
        SessionPhase::Paused => session
            .paused_remaining_ms
            .map(|remaining| remaining.max(0)),
        SessionPhase::ReadyToClose => Some(0),
        SessionPhase::Overtime | SessionPhase::Closed => None,
    });
    let overtime_ms = active.as_ref().and_then(|session| {
        (session.phase == SessionPhase::Overtime).then(|| {
            session
                .overtime_started_at
                .map(|started| now.saturating_sub(started).max(0))
                .unwrap_or(0)
        })
    });
    let allowed_actions = active
        .as_ref()
        .map(session_actions)
        .unwrap_or_else(|| vec![FocusAction::StartLast]);
    let transition_revision = active.as_ref().map(|session| session.transition_revision);

    Ok(FocusStatusDto {
        active,
        effective_focus_ms,
        remaining_ms,
        overtime_ms,
        allowed_actions,
        // Le catture collegate alla sessione arrivano nella slice dedicata;
        // il contratto nasce ora con un valore neutro e stabile.
        pending_captures: 0,
        transition_revision,
    })
}

fn focus_status_dto(app: &AppHandle) -> CmdResult<FocusStatusDto> {
    let state = app.state::<AppState>();
    let store = state.store.lock().unwrap();
    focus_status_from_store(&store, now_ms()).map_err(err)
}

fn sync_and_emit_focus_changed(app: &AppHandle) -> CmdResult<FocusStatusDto> {
    presenter::sync(app);
    let status = focus_status_dto(app)?;
    if let Err(error) = app.emit(EVT_FOCUS_CHANGED, &status) {
        log::warn!("emissione {EVT_FOCUS_CHANGED} fallita: {error}");
    }
    Ok(status)
}

enum FocusMutation<'a> {
    Pause {
        expected_revision: i64,
        reason: Option<&'a str>,
    },
    Resume {
        expected_revision: i64,
    },
    Adjust {
        expected_revision: i64,
        delta_ms: i64,
    },
    Overtime {
        expected_revision: i64,
    },
    Finish {
        expected_revision: i64,
        outcome: SessionOutcome,
        interruption_reason: Option<&'a str>,
    },
}

fn apply_focus_mutation(
    store: &Store,
    mutation: FocusMutation<'_>,
    now: i64,
) -> win_buddy_core::Result<pomodoro::TransitionResult> {
    let active = store
        .open_session()?
        .ok_or_else(|| win_buddy_core::CoreError::InvalidState("sessione non trovata".into()))?;
    match mutation {
        FocusMutation::Pause {
            expected_revision,
            reason,
        } => pomodoro::pause(store, active.id, expected_revision, now, reason),
        FocusMutation::Resume { expected_revision } => {
            pomodoro::resume(store, active.id, expected_revision, now)
        }
        FocusMutation::Adjust {
            expected_revision,
            delta_ms,
        } => pomodoro::adjust_duration(store, active.id, expected_revision, delta_ms, now),
        FocusMutation::Overtime { expected_revision } => {
            pomodoro::start_overtime(store, active.id, expected_revision, now)
        }
        FocusMutation::Finish {
            expected_revision,
            outcome,
            interruption_reason,
        } => pomodoro::finish(
            store,
            active.id,
            expected_revision,
            outcome,
            interruption_reason,
            now,
        ),
    }
}

fn apply_focus_start(
    store: &Store,
    request: StartSession,
    now: i64,
) -> win_buddy_core::Result<pomodoro::TransitionResult> {
    pomodoro::start(store, request, now)
}

fn apply_legacy_abort(store: &Store, now: i64) -> win_buddy_core::Result<()> {
    let Some(session) = store.open_session()? else {
        return Ok(());
    };
    apply_focus_mutation(
        store,
        FocusMutation::Finish {
            expected_revision: session.transition_revision,
            outcome: SessionOutcome::Interrupted,
            interruption_reason: None,
        },
        now,
    )?;
    Ok(())
}

fn do_focus_mutation(app: &AppHandle, mutation: FocusMutation<'_>) -> CmdResult<FocusStatusDto> {
    touch(app);
    {
        let state = app.state::<AppState>();
        let store = state.store.lock().unwrap();
        apply_focus_mutation(&store, mutation, now_ms()).map_err(err)?;
    }
    sync_and_emit_focus_changed(app)
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
    presentations: Vec<presenter::PomodoroPresentationDto>,
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
    let body = if p.body.is_empty() {
        text.trim().to_string()
    } else {
        p.body
    };
    let note = {
        let state = app.state::<AppState>();
        let store = state.store.lock().unwrap();
        store
            .insert_note(&body, due, p.urgent, now_ms())
            .map_err(err)?
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
    Ok(store
        .open_notes()
        .map_err(err)?
        .into_iter()
        .map(view)
        .collect())
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

#[tauri::command]
pub async fn focus_start(app: AppHandle, request: StartSession) -> CmdResult<FocusStatusDto> {
    touch(&app);
    {
        let state = app.state::<AppState>();
        let store = state.store.lock().unwrap();
        apply_focus_start(&store, request, now_ms()).map_err(err)?;
    }
    sync_and_emit_focus_changed(&app)
}

#[tauri::command]
pub async fn focus_pause(
    app: AppHandle,
    expected_revision: i64,
    reason: Option<String>,
) -> CmdResult<FocusStatusDto> {
    do_focus_mutation(
        &app,
        FocusMutation::Pause {
            expected_revision,
            reason: reason.as_deref(),
        },
    )
}

#[tauri::command]
pub async fn focus_resume(app: AppHandle, expected_revision: i64) -> CmdResult<FocusStatusDto> {
    do_focus_mutation(&app, FocusMutation::Resume { expected_revision })
}

#[tauri::command]
pub async fn focus_adjust(
    app: AppHandle,
    delta_ms: i64,
    expected_revision: i64,
) -> CmdResult<FocusStatusDto> {
    do_focus_mutation(
        &app,
        FocusMutation::Adjust {
            expected_revision,
            delta_ms,
        },
    )
}

#[tauri::command]
pub async fn focus_overtime(app: AppHandle, expected_revision: i64) -> CmdResult<FocusStatusDto> {
    do_focus_mutation(&app, FocusMutation::Overtime { expected_revision })
}

#[tauri::command]
pub async fn focus_finish(
    app: AppHandle,
    expected_revision: i64,
    outcome: SessionOutcome,
    interruption_reason: Option<String>,
) -> CmdResult<FocusStatusDto> {
    do_focus_mutation(
        &app,
        FocusMutation::Finish {
            expected_revision,
            outcome,
            interruption_reason: interruption_reason.as_deref(),
        },
    )
}

#[tauri::command]
pub fn focus_status(app: AppHandle) -> CmdResult<FocusStatusDto> {
    focus_status_dto(&app)
}

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
            apply_focus_start(&store, request, now).map_err(err)?;
        } else {
            pomodoro::start_break(&store, kind, cfg.duration_ms(kind), now).map_err(err)?;
        }
    }
    let _ = sync_and_emit_focus_changed(app)?;
    pomodoro_status_dto(app)
}

pub fn do_pomodoro_abort(app: &AppHandle) -> CmdResult<PomodoroStatusDto> {
    touch(app);
    {
        let state = app.state::<AppState>();
        let store = state.store.lock().unwrap();
        apply_legacy_abort(&store, now_ms()).map_err(err)?;
    }
    let _ = sync_and_emit_focus_changed(app)?;
    pomodoro_status_dto(app)
}

/// Bridge legacy per il piano Buddy/Surfaces. I nuovi chiamanti usano
/// `focus_start`, che accetta direttamente il DTO di dominio.
#[tauri::command]
pub async fn pomodoro_start(
    app: AppHandle,
    kind: SessionKind,
    label: Option<String>,
) -> CmdResult<PomodoroStatusDto> {
    do_pomodoro_start(&app, kind, label.as_deref())
}

/// Bridge legacy per il piano Buddy/Surfaces. Mappa l'abort storico
/// sull'esito persistente `interrupted` tramite la stessa funzione core.
#[tauri::command]
pub async fn pomodoro_abort(app: AppHandle) -> CmdResult<PomodoroStatusDto> {
    do_pomodoro_abort(&app)
}

/// Bridge legacy di sola lettura; `focus_status` è il contratto revisionato.
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
pub fn pomodoro_presentation_ack(state: State<AppState>, id: i64) -> CmdResult<()> {
    let store = state.store.lock().unwrap();
    store
        .acknowledge_presentation_event(id, now_ms())
        .map_err(err)
}

#[derive(Clone, Copy)]
enum LegacyBreakAction {
    Accept,
    Skip,
}

fn apply_legacy_break_action(
    store: &win_buddy_core::Store,
    action: LegacyBreakAction,
    event_id: i64,
    now: i64,
    day_start: i64,
) -> win_buddy_core::Result<()> {
    match action {
        LegacyBreakAction::Accept => pomodoro::accept_proposed_break(
            store,
            event_id,
            now,
            day_start,
            &PomodoroConfig::load(store),
        ),
        LegacyBreakAction::Skip => pomodoro::skip_proposed_break(store, event_id, now),
    }
}

#[tauri::command]
pub async fn break_accept(app: AppHandle, event_id: i64) -> CmdResult<PomodoroStatusDto> {
    touch(&app);
    {
        let state = app.state::<AppState>();
        let store = state.store.lock().unwrap();
        apply_legacy_break_action(
            &store,
            LegacyBreakAction::Accept,
            event_id,
            now_ms(),
            day_start_ms(),
        )
        .map_err(err)?;
    }
    let _ = sync_and_emit_focus_changed(&app)?;
    pomodoro_status_dto(&app)
}

#[tauri::command]
pub async fn break_skip(app: AppHandle, event_id: i64) -> CmdResult<PomodoroStatusDto> {
    touch(&app);
    {
        let state = app.state::<AppState>();
        let store = state.store.lock().unwrap();
        apply_legacy_break_action(
            &store,
            LegacyBreakAction::Skip,
            event_id,
            now_ms(),
            day_start_ms(),
        )
        .map_err(err)?;
    }
    let _ = sync_and_emit_focus_changed(&app)?;
    pomodoro_status_dto(&app)
}

// ------------------------------------------------------------ impostazioni

#[tauri::command]
pub fn settings_all(
    state: State<AppState>,
) -> CmdResult<std::collections::HashMap<String, String>> {
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
                .set_settings(&[("buddy.corner", value), ("overlay.position.mode", "corner")])
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
            primary: primary_pos
                .map(|p| p == *m.position())
                .unwrap_or(index == 0),
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
    let allow_presentations = presenter::effective_dnd(&app).policy().notify_immediately;
    let (creature_id, sober, presentations) = {
        let store = state.store.lock().unwrap();
        let creature = store
            .setting("buddy.creature")
            .ok()
            .flatten()
            .unwrap_or_else(|| "cotone".into());
        let sober = store.setting("buddy.mode").ok().flatten().as_deref() == Some("sober");
        let presentations = if allow_presentations {
            presenter::pomodoro_presentations(&store)?
        } else {
            Vec::new()
        };
        (creature, sober, presentations)
    };
    let force_sober = presenter::effective_dnd(&app).policy().force_sober;
    let last_state = state.last_state.lock().unwrap().clone();
    let bubble = state.bubble.lock().unwrap().clone();
    Ok(Some(OverlayBoot {
        creature_id,
        mode: if sober || force_sober {
            "sober".into()
        } else {
            "full".into()
        },
        state: last_state,
        bubble,
        presentations,
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use win_buddy_core::model::SessionPhase;
    use win_buddy_core::pomodoro::EventKind;
    use win_buddy_core::Store;

    const MIN: i64 = 60_000;

    struct TempDatabase {
        dir: PathBuf,
        path: PathBuf,
    }

    impl TempDatabase {
        fn new() -> Self {
            let unique = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!(
                "win-buddy-task5-restart-{}-{unique}",
                std::process::id()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join("buddy.db");
            Self { dir, path }
        }
    }

    impl Drop for TempDatabase {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn paused_status_only_exposes_valid_actions() {
        let actions = allowed_actions(SessionPhase::Paused);

        assert_eq!(
            actions,
            vec![
                FocusAction::Resume,
                FocusAction::Capture,
                FocusAction::Finish,
            ]
        );
    }

    #[test]
    fn every_focus_phase_exposes_only_valid_actions() {
        let cases = [
            (
                SessionPhase::Running,
                vec![
                    FocusAction::Pause,
                    FocusAction::Extend5,
                    FocusAction::Capture,
                    FocusAction::Finish,
                ],
            ),
            (
                SessionPhase::Paused,
                vec![
                    FocusAction::Resume,
                    FocusAction::Capture,
                    FocusAction::Finish,
                ],
            ),
            (
                SessionPhase::ReadyToClose,
                vec![
                    FocusAction::Overtime,
                    FocusAction::Extend5,
                    FocusAction::Finish,
                ],
            ),
            (
                SessionPhase::Overtime,
                vec![FocusAction::Capture, FocusAction::Finish],
            ),
            (SessionPhase::Closed, vec![]),
        ];

        for (phase, expected) in cases {
            assert_eq!(allowed_actions(phase), expected, "phase {phase:?}");
        }
    }

    #[test]
    fn focus_actions_serialize_to_stable_contract_ids() {
        let actions = [
            FocusAction::StartLast,
            FocusAction::Pause,
            FocusAction::Resume,
            FocusAction::Extend5,
            FocusAction::Capture,
            FocusAction::Finish,
            FocusAction::Overtime,
            FocusAction::StartBreak,
            FocusAction::SkipBreak,
        ];

        assert_eq!(
            serde_json::to_value(actions).unwrap(),
            serde_json::json!([
                "focus.start_last",
                "focus.pause",
                "focus.resume",
                "focus.extend_5",
                "focus.capture",
                "focus.finish",
                "focus.overtime",
                "break.start",
                "break.skip"
            ])
        );
    }

    #[test]
    fn idle_focus_status_serializes_the_exact_contract() {
        let store = Store::open_in_memory().unwrap();

        let status = focus_status_from_store(&store, 42).unwrap();

        assert_eq!(
            serde_json::to_value(status).unwrap(),
            serde_json::json!({
                "active": null,
                "effective_focus_ms": 0,
                "remaining_ms": null,
                "overtime_ms": null,
                "allowed_actions": ["focus.start_last"],
                "pending_captures": 0,
                "transition_revision": null
            })
        );
    }

    #[test]
    fn running_status_uses_the_persisted_deadline() {
        let store = Store::open_in_memory().unwrap();
        pomodoro::start(&store, StartSession::focus(1, "Spec", 25 * MIN), 0).unwrap();

        let status = focus_status_from_store(&store, 5 * MIN).unwrap();

        assert_eq!(status.effective_focus_ms, 5 * MIN);
        assert_eq!(status.remaining_ms, Some(20 * MIN));
        assert_eq!(status.overtime_ms, None);
        assert_eq!(status.transition_revision, Some(0));
    }

    #[test]
    fn paused_status_uses_the_frozen_remaining_time() {
        let store = Store::open_in_memory().unwrap();
        let started = pomodoro::start(&store, StartSession::focus(1, "Spec", 25 * MIN), 0).unwrap();
        pomodoro::pause(&store, started.session.id, 0, 10 * MIN, None).unwrap();

        let status = focus_status_from_store(&store, 20 * MIN).unwrap();

        assert_eq!(status.effective_focus_ms, 10 * MIN);
        assert_eq!(status.remaining_ms, Some(15 * MIN));
        assert_eq!(status.overtime_ms, None);
        assert_eq!(status.transition_revision, Some(1));
    }

    #[test]
    fn ready_status_stays_open_at_zero() {
        let store = Store::open_in_memory().unwrap();
        pomodoro::start(&store, StartSession::focus(1, "Spec", MIN), 0).unwrap();
        pomodoro::tick(&store, MIN).unwrap();

        let status = focus_status_from_store(&store, MIN).unwrap();

        assert_eq!(status.remaining_ms, Some(0));
        assert_eq!(status.overtime_ms, None);
        assert_eq!(status.transition_revision, Some(1));
        assert_eq!(
            status.allowed_actions,
            vec![
                FocusAction::Overtime,
                FocusAction::Extend5,
                FocusAction::Finish,
            ]
        );
    }

    #[test]
    fn overtime_status_counts_up_from_the_persisted_start() {
        let store = Store::open_in_memory().unwrap();
        let started = pomodoro::start(&store, StartSession::focus(1, "Spec", MIN), 0).unwrap();
        pomodoro::tick(&store, MIN).unwrap();
        pomodoro::start_overtime(&store, started.session.id, 1, MIN).unwrap();

        let status = focus_status_from_store(&store, 3 * MIN).unwrap();

        assert_eq!(status.effective_focus_ms, 3 * MIN);
        assert_eq!(status.remaining_ms, None);
        assert_eq!(status.overtime_ms, Some(2 * MIN));
        assert_eq!(status.transition_revision, Some(2));
    }

    #[test]
    fn running_break_exposes_break_actions_instead_of_focus_pause() {
        let store = Store::open_in_memory().unwrap();
        pomodoro::start_break(&store, SessionKind::ShortBreak, 5 * MIN, 0).unwrap();

        let status = focus_status_from_store(&store, MIN).unwrap();

        assert_eq!(
            status.allowed_actions,
            vec![
                FocusAction::SkipBreak,
                FocusAction::Extend5,
                FocusAction::Finish,
            ]
        );
    }

    #[test]
    fn stale_surface_revision_does_not_mutate_the_open_session() {
        let store = Store::open_in_memory().unwrap();
        let started = pomodoro::start(&store, StartSession::focus(1, "Spec", 25 * MIN), 0).unwrap();
        let before = store.get_session(started.session.id).unwrap().unwrap();

        let error = apply_focus_mutation(
            &store,
            FocusMutation::Pause {
                expected_revision: 7,
                reason: None,
            },
            5 * MIN,
        )
        .unwrap_err();

        assert_eq!(
            error.to_string(),
            "stato non valido: sessione già aggiornata"
        );
        assert_eq!(
            store.get_session(started.session.id).unwrap().unwrap(),
            before
        );
    }

    #[test]
    fn adjust_surface_mutation_forwards_signed_delta_and_revision() {
        let store = Store::open_in_memory().unwrap();
        let started = pomodoro::start(&store, StartSession::focus(1, "Spec", 25 * MIN), 0).unwrap();

        let adjusted = apply_focus_mutation(
            &store,
            FocusMutation::Adjust {
                expected_revision: 0,
                delta_ms: -5 * MIN,
            },
            10 * MIN,
        )
        .unwrap();

        assert_eq!(adjusted.session.id, started.session.id);
        assert_eq!(adjusted.session.deadline_at, 20 * MIN);
        assert_eq!(adjusted.session.transition_revision, 1);
    }

    #[test]
    fn legacy_abort_maps_to_the_interrupted_outcome() {
        let store = Store::open_in_memory().unwrap();
        let started =
            pomodoro::start(&store, StartSession::focus(1, "Spec", 25 * MIN), 0).unwrap();

        apply_legacy_abort(&store, 5 * MIN).unwrap();

        let closed = store.get_session(started.session.id).unwrap().unwrap();
        assert_eq!(closed.phase, SessionPhase::Closed);
        assert_eq!(closed.outcome, Some(SessionOutcome::Interrupted));
        assert_eq!(closed.interruption_reason, None);
    }

    #[test]
    fn focus_cycle_survives_restarts_before_overtime_and_completion() {
        let database = TempDatabase::new();
        let session_id;
        {
            let store = Store::open(&database.path).unwrap();
            let started =
                pomodoro::start(&store, StartSession::focus(1, "Spec", 10 * MIN), 0).unwrap();
            session_id = started.session.id;
            apply_focus_mutation(
                &store,
                FocusMutation::Pause {
                    expected_revision: 0,
                    reason: None,
                },
                5 * MIN,
            )
            .unwrap();
        }
        {
            let store = Store::open(&database.path).unwrap();
            let paused = focus_status_from_store(&store, 10 * MIN).unwrap();
            assert_eq!(paused.active.as_ref().unwrap().phase, SessionPhase::Paused);
            apply_focus_mutation(
                &store,
                FocusMutation::Resume {
                    expected_revision: 1,
                },
                10 * MIN,
            )
            .unwrap();
            pomodoro::tick(&store, 15 * MIN).unwrap();
        }
        {
            let store = Store::open(&database.path).unwrap();
            let ready = focus_status_from_store(&store, 15 * MIN).unwrap();
            assert_eq!(
                ready.active.as_ref().unwrap().phase,
                SessionPhase::ReadyToClose
            );
            apply_focus_mutation(
                &store,
                FocusMutation::Overtime {
                    expected_revision: 3,
                },
                15 * MIN,
            )
            .unwrap();
            apply_focus_mutation(
                &store,
                FocusMutation::Finish {
                    expected_revision: 4,
                    outcome: SessionOutcome::Completed,
                    interruption_reason: None,
                },
                20 * MIN,
            )
            .unwrap();
        }

        let store = Store::open(&database.path).unwrap();
        let completed = store.get_session(session_id).unwrap().unwrap();
        assert_eq!(completed.phase, SessionPhase::Closed);
        assert_eq!(completed.outcome, Some(SessionOutcome::Completed));
        assert_eq!(
            store.effective_focus_ms(session_id, 20 * MIN).unwrap(),
            15 * MIN
        );
        assert!(focus_status_from_store(&store, 20 * MIN)
            .unwrap()
            .active
            .is_none());
    }

    #[test]
    fn overlay_boot_replays_pending_event_with_stable_identity() {
        let store = Store::open_in_memory().unwrap();
        pomodoro::start(&store, StartSession::focus(1, "Spec", MIN), 0).unwrap();
        let event = pomodoro::tick(&store, MIN).unwrap().remove(0);

        let presentations = presenter::pomodoro_presentations(&store).unwrap();

        assert_eq!(presentations.len(), 1);
        assert_eq!(presentations[0].id, event.id);
        assert_eq!(presentations[0].session_id, event.session_id);
        assert_eq!(presentations[0].kind, EventKind::ReadyToClose);
        assert_eq!(presentations[0].transition_revision, 1);
        assert_eq!(presentations[0].session_kind, SessionKind::Focus);
    }

    #[test]
    fn legacy_break_accept_completes_ready_focus_and_starts_proposed_break() {
        let store = Store::open_in_memory().unwrap();
        let focus = pomodoro::start(&store, StartSession::focus(1, "Spec", MIN), 0)
            .unwrap()
            .session;
        let event = pomodoro::tick(&store, MIN).unwrap().remove(0);

        apply_legacy_break_action(&store, LegacyBreakAction::Accept, event.id, MIN, 0).unwrap();

        assert_eq!(
            store.get_session(focus.id).unwrap().unwrap().outcome,
            Some(SessionOutcome::Completed)
        );
        let active = store.open_session().unwrap().unwrap();
        assert_eq!(active.kind, SessionKind::ShortBreak);
        assert_eq!(active.phase, win_buddy_core::model::SessionPhase::Running);
        assert!(store.pending_presentation_events().unwrap().is_empty());
    }

    #[test]
    fn legacy_break_skip_completes_ready_focus_without_starting_break() {
        let store = Store::open_in_memory().unwrap();
        let focus = pomodoro::start(&store, StartSession::focus(1, "Spec", MIN), 0)
            .unwrap()
            .session;
        let event = pomodoro::tick(&store, MIN).unwrap().remove(0);

        apply_legacy_break_action(&store, LegacyBreakAction::Skip, event.id, MIN, 0).unwrap();

        assert_eq!(
            store.get_session(focus.id).unwrap().unwrap().outcome,
            Some(SessionOutcome::Completed)
        );
        assert!(store.open_session().unwrap().is_none());
        assert!(store.pending_presentation_events().unwrap().is_empty());
    }
}
