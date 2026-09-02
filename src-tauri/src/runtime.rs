//! I tre meccanismi dello scheduler che si coprono a vicenda (§ 7), più i
//! watcher: divario da sospensione, DND automatico, hit-test del cursore,
//! spegnimento dell'overlay inattivo.

use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use win_buddy_core::dnd::DndLevel;
use win_buddy_core::pomodoro::{self, EventKind, PomodoroConfig, PomodoroEvent};
use win_buddy_core::scheduler::{self, RESUME_GAP_MS, TICK_MS};

use crate::platform;
use crate::presenter;
use crate::state::{day_start_ms, now_ms, AppState};
use crate::surfaces;

pub fn start(app: AppHandle) {
    // heartbeat: tick lento + rilevamento della sospensione dal divario
    {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut every = tokio::time::interval(Duration::from_secs(5));
            every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                every.tick().await;
                heartbeat(&app);
            }
        });
    }
    // DND automatico (§ 10.4): interrogazione, non hook — niente antivirus
    {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut every = tokio::time::interval(Duration::from_secs(10));
            every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                every.tick().await;
                poll_auto_dnd(&app);
            }
        });
    }
    // click-through con hit-test (§ 10.2): GetCursorPos ogni 100 ms
    {
        tauri::async_runtime::spawn(async move {
            let mut every = tokio::time::interval(Duration::from_millis(100));
            every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                every.tick().await;
                poll_cursor(&app);
            }
        });
    }
}

/// Recupero all'avvio (§ 7.3, § 8.3): l'app potrebbe essere stata spenta
/// per giorni, o riavviata a metà di un pomodoro.
pub fn startup_recovery(app: &AppHandle) {
    let last_alive = {
        let state = app.state::<AppState>();
        let store = state.store.lock().unwrap();
        // l'ultimo battito registrato prima dello spegnimento
        store
            .setting("core.last_alive")
            .ok()
            .flatten()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0)
    };
    recovery(app, last_alive);
}

fn heartbeat(app: &AppHandle) {
    let now = now_ms();
    let state = app.state::<AppState>();
    let prev = state.last_beat.swap(now, Ordering::Relaxed);

    // persisti il battito: al prossimo avvio è il «last_alive» del recupero
    {
        let store = state.store.lock().unwrap();
        let _ = store.set_setting("core.last_alive", &now.to_string());
    }

    if prev > 0 && now - prev > RESUME_GAP_MS {
        // la macchina era sospesa: entro 15 s dalla ripresa si recupera (§ 7.4)
        recovery(app, prev);
        return;
    }

    if now - state.last_tick.load(Ordering::Relaxed) >= TICK_MS {
        do_tick(app);
    }
}

/// Il giro completo: scheduler + pomodoro, poi presentazione e timer mirato.
pub fn do_tick(app: &AppHandle) {
    let now = now_ms();
    let state = app.state::<AppState>();
    state.last_tick.store(now, Ordering::Relaxed);

    let (out, pomo_events) = {
        let store = state.store.lock().unwrap();
        let out = scheduler::tick(&store, now);
        let ev = pomodoro::tick(&store, now);
        (out.unwrap_or_else(|_| scheduler::TickOutcome { newly_fired: vec![], arm_timer_ms: None }),
         ev.unwrap_or_default())
    };

    handle_pomodoro_events(app, &pomo_events);
    presenter::toast_for_new_fired(app, &out.newly_fired);
    if !out.newly_fired.is_empty() {
        use tauri::Emitter;
        let _ = app.emit(win_buddy_core::events::EVT_NOTES_CHANGED, ());
    }
    arm_targeted_timer(app, now, out.arm_timer_ms);
    presenter::sync(app);
}

/// Recupero: sessioni aperte risolte con le regole del § 8.3, poi la stessa
/// query del tick per i promemoria scaduti nel frattempo.
pub fn recovery(app: &AppHandle, last_alive: i64) {
    let now = now_ms();
    let state = app.state::<AppState>();
    state.last_tick.store(now, Ordering::Relaxed);
    state.last_beat.store(now, Ordering::Relaxed);

    let (out, pomo_events) = {
        let store = state.store.lock().unwrap();
        let cfg = PomodoroConfig::load(&store);
        let ev = pomodoro::resolve_open(&store, now, last_alive, day_start_ms(), &cfg)
            .unwrap_or_default();
        let out = scheduler::tick(&store, now).unwrap_or_else(|_| scheduler::TickOutcome {
            newly_fired: vec![],
            arm_timer_ms: None,
        });
        (out, ev)
    };

    handle_pomodoro_events(app, &pomo_events);
    presenter::toast_for_new_fired(app, &out.newly_fired);
    if !out.newly_fired.is_empty() {
        use tauri::Emitter;
        let _ = app.emit(win_buddy_core::events::EVT_NOTES_CHANGED, ());
    }
    arm_targeted_timer(app, now, out.arm_timer_ms);
    presenter::sync(app);
}

fn handle_pomodoro_events(app: &AppHandle, events: &[PomodoroEvent]) {
    let state = app.state::<AppState>();
    // in DND nascosto niente toast (§ 10.3)
    let toast_ok = presenter::effective_dnd(app).policy().toast_allowed;
    for ev in events {
        match ev.kind {
            EventKind::ReadyToClose => {
                state.last_interaction.store(now_ms(), Ordering::Relaxed);
                if toast_ok && surfaces::overlay(app).is_none() {
                    presenter::toast(app, "Tempo scaduto", "Chiudi il focus o continua.");
                }
            }
            EventKind::ReturnPrompt => {
                state.last_interaction.store(now_ms(), Ordering::Relaxed);
                if toast_ok && surfaces::overlay(app).is_none() {
                    presenter::toast(app, "Pausa finita", "Si riparte quando vuoi.");
                }
            }
            EventKind::Prewarning | EventKind::RecoveryNeeded => {}
        }
    }
}

/// Timer mirato (§ 7.2): armato solo per scadenze entro 60 s, mai per
/// scadenze lontane — non sopravvivrebbero alla sospensione.
fn arm_targeted_timer(app: &AppHandle, now: i64, delay_ms: Option<i64>) {
    let Some(delay) = delay_ms else { return };
    let due = now + delay;
    let state = app.state::<AppState>();
    {
        let mut armed = state.armed_due.lock().unwrap();
        if *armed == Some(due) {
            return; // già armato per questa scadenza
        }
        *armed = Some(due);
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(delay.max(0) as u64 + 50)).await;
        let state = app.state::<AppState>();
        let still = *state.armed_due.lock().unwrap() == Some(due);
        if still {
            *state.armed_due.lock().unwrap() = None;
            do_tick(&app);
        }
    });
}

fn poll_auto_dnd(app: &AppHandle) {
    let level = DndLevel::from_quns(platform::query_notification_state());
    let state = app.state::<AppState>();
    let changed = {
        let mut cur = state.auto_dnd.lock().unwrap();
        let changed = *cur != level;
        let was_hidden = *cur == DndLevel::Hidden;
        *cur = level;
        changed || (was_hidden && level != DndLevel::Hidden)
    };
    if changed {
        // all'uscita dal DND la sync ripresenta la pila accodata (§ 10.3)
        presenter::sync(app);
    }
}

/// Il core interroga la posizione del cursore e confronta col rettangolo
/// occupato dalla creatura: dentro → la finestra accetta i clic, fuori →
/// torna trasparente. Nessun hook di sistema (§ 10.2).
fn poll_cursor(app: &AppHandle) {
    let Some(win) = surfaces::overlay(app) else { return };
    let state = app.state::<AppState>();

    let inside = (|| -> Option<bool> {
        let hb = (*state.hitbox.lock().ok()?)?;
        let cursor = app.cursor_position().ok()?;
        let pos = win.outer_position().ok()?;
        let size = win.outer_size().ok()?;
        let (w, h) = (size.width as f64, size.height as f64);
        if w <= 0.0 || h <= 0.0 {
            return Some(false);
        }
        let x = pos.x as f64 + hb.x * w;
        let y = pos.y as f64 + hb.y * h;
        let (bw, bh) = (hb.w * w, hb.h * h);
        Some(cursor.x >= x && cursor.x <= x + bw && cursor.y >= y && cursor.y <= y + bh)
    })()
    .unwrap_or(false);

    let was = state.overlay_interactive.swap(inside, Ordering::Relaxed);
    if was != inside {
        let _ = win.set_ignore_cursor_events(!inside);
    }
}
