//! Il presenter: l'unico posto che decide cosa c'è a schermo.
//!
//! Riconcilia database, DND e pomodoro con le superfici: ciclo di vita
//! dell'overlay, stato della creatura, bolla in cima alla pila, toast di
//! ripiego, icona di tray. Chiamalo dopo ogni fatto nuovo; è idempotente.

use std::sync::atomic::Ordering;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use win_buddy_core::dnd::DndLevel;
use win_buddy_core::events::{
    BubbleDismiss, BubbleKind, BubbleShow, BuddyChanged, BuddyState, ModeChanged, StateChanged,
    EVT_BUBBLE_DISMISS, EVT_BUBBLE_SHOW, EVT_BUDDY_CHANGED, EVT_MODE_CHANGED, EVT_STATE_CHANGED,
};
use win_buddy_core::model::SessionKind;
use win_buddy_core::scheduler::{presentation, Presentation};
use win_buddy_core::{pomodoro, Store};

use crate::state::{now_ms, AppState};
use crate::surfaces;
use crate::tray;

/// Dopo quanto la creatura si addormenta (metà del tempo di spegnimento).
const SLEEP_FRACTION: i64 = 2;

/// Il livello DND effettivo: il più severo tra manuale e automatico (§ 10.3).
pub fn effective_dnd(app: &AppHandle) -> DndLevel {
    let state = app.state::<AppState>();
    let manual = {
        let store = state.store.lock().unwrap();
        store.setting("dnd.manual").ok().flatten().as_deref() == Some("1")
    };
    let auto_enabled = {
        let store = state.store.lock().unwrap();
        store.setting("dnd.auto_fullscreen").ok().flatten().as_deref() != Some("0")
    };
    let manual_level = if manual { DndLevel::Hidden } else { DndLevel::Normal };
    let auto_level = if auto_enabled {
        *state.auto_dnd.lock().unwrap()
    } else {
        DndLevel::Normal
    };
    DndLevel::strictest(manual_level, auto_level)
}

fn sober_mode(store: &Store, dnd: DndLevel) -> bool {
    dnd.policy().force_sober
        || store.setting("buddy.mode").ok().flatten().as_deref() == Some("sober")
}

/// Riconcilia tutto. Da chiamare dopo tick, recuperi, azioni utente e
/// cambi di DND.
pub fn sync(app: &AppHandle) {
    let state = app.state::<AppState>();
    let now = now_ms();
    let dnd = effective_dnd(app);
    let policy = dnd.policy();

    // ------------------------------------------------ dati dal database
    let (fired, focus_active, active, sober, idle_sleep_min, creature) = {
        let store = state.store.lock().unwrap();
        (
            store.fired_notes().unwrap_or_default(),
            pomodoro::focus_active(&store, now).unwrap_or(false),
            pomodoro::active_session(&store, now).unwrap_or(None),
            sober_mode(&store, dnd),
            store.setting_i64("overlay.idle_sleep_min", 20),
            store
                .setting("buddy.creature")
                .ok()
                .flatten()
                .unwrap_or_else(|| "cotone".into()),
        )
    };
    let break_prompt = *state.break_prompt.lock().unwrap();
    let celebrating = state.celebrating_until.load(Ordering::Relaxed) > now;
    let queued = fired.len();

    // ------------------------------------------------ ciclo di vita overlay
    let idle_ms = now - state.last_interaction.load(Ordering::Relaxed);
    let has_content = active.is_some() || queued > 0 || break_prompt.is_some() || celebrating;
    let overlay_wanted = policy.overlay_alive
        && (has_content || idle_ms < idle_sleep_min * 60_000);

    if overlay_wanted {
        surfaces::ensure_overlay(app);
    } else {
        surfaces::destroy_overlay(app);
    }

    // ------------------------------------------------ bolla in cima alla pila
    // Priorità: proposta di pausa, poi la pila dei promemoria (§ 8.4: a fine
    // focus, insieme alla pausa, arrivano le note maturate).
    let mut bubble: Option<BubbleShow> = None;
    if let Some(kind) = break_prompt {
        let minutes = {
            let store = state.store.lock().unwrap();
            pomodoro::PomodoroConfig::load(&store).duration_ms(kind) / 60_000
        };
        let text = match kind {
            SessionKind::LongBreak => format!("Focus chiuso · pausa lunga ({minutes}′)?"),
            _ => format!("Focus chiuso · pausa breve ({minutes}′)?"),
        };
        bubble = Some(BubbleShow {
            id: 0,
            text,
            kind: BubbleKind::BreakPrompt,
            urgent: false,
            position: None,
        });
    } else if policy.notify_immediately {
        match presentation(&fired, dnd, focus_active) {
            Presentation::Stack { notes } => {
                let total = notes.len();
                let n = &notes[0];
                bubble = Some(BubbleShow {
                    id: n.id,
                    text: n.body.clone(),
                    kind: BubbleKind::Reminder,
                    urgent: n.urgent,
                    position: Some((1, total)),
                });
            }
            Presentation::Summary { count } => {
                bubble = Some(BubbleShow {
                    id: 0,
                    text: format!("{count} promemoria scaduti"),
                    kind: BubbleKind::Summary,
                    urgent: false,
                    position: None,
                });
            }
            Presentation::Nothing => {}
        }
    }

    let changed = {
        let mut cur = state.bubble.lock().unwrap();
        let changed = !same_bubble(cur.as_ref(), bubble.as_ref());
        if changed {
            *cur = bubble.clone();
        }
        changed
    };
    if changed {
        match &bubble {
            Some(b) => {
                let _ = app.emit(EVT_BUBBLE_SHOW, b);
            }
            None => {
                let _ = app.emit(EVT_BUBBLE_DISMISS, &BubbleDismiss { id: 0 });
            }
        }
    }

    // ------------------------------------------------ stato della creatura
    let buddy_state = if celebrating {
        BuddyState::Celebrate
    } else if bubble.is_some() {
        BuddyState::Alert
    } else if let Some(s) = &active {
        if s.kind == SessionKind::Focus {
            BuddyState::Focus
        } else {
            BuddyState::Break
        }
    } else if idle_ms > idle_sleep_min * 60_000 / SLEEP_FRACTION {
        BuddyState::Sleep
    } else {
        BuddyState::Idle
    };

    let payload = StateChanged {
        state: buddy_state,
        until: active.as_ref().map(|s| s.ends_at),
        label: active.as_ref().and_then(|s| match s.kind {
            SessionKind::Focus => s.label.clone(),
            SessionKind::ShortBreak => Some("Pausa".into()),
            SessionKind::LongBreak => Some("Pausa lunga".into()),
        }),
    };
    {
        let mut last = state.last_state.lock().unwrap();
        let same = last
            .as_ref()
            .map(|l| {
                serde_json::to_value(l).ok() == serde_json::to_value(&payload).ok()
            })
            .unwrap_or(false);
        if !same {
            *last = Some(payload.clone());
            let _ = app.emit(EVT_STATE_CHANGED, &payload);
        }
    }

    // ------------------------------------------------ modalità e tray
    let _ = app.emit(EVT_MODE_CHANGED, &ModeChanged {
        mode: if sober { "sober".into() } else { "full".into() },
    });
    let _ = app.emit(EVT_BUDDY_CHANGED, &BuddyChanged { creature_id: creature });

    tray::refresh(app, dnd, queued);
}

fn same_bubble(a: Option<&BubbleShow>, b: Option<&BubbleShow>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => {
            a.id == b.id && a.text == b.text && a.kind == b.kind && a.position == b.position
        }
        _ => false,
    }
}

/// Toast nativo di ripiego (§ 5): quando l'overlay non può mostrare la
/// nuvoletta ma la policy consente di notificare.
pub fn toast(app: &AppHandle, title: &str, body: &str) {
    let _ = app
        .notification()
        .builder()
        .title(title)
        .body(body)
        .show();
}

/// I promemoria appena scattati generano un toast se l'overlay non è in
/// grado di presentarli (sobrio, distrutto o DND discreto).
pub fn toast_for_new_fired(app: &AppHandle, newly: &[win_buddy_core::Note]) {
    if newly.is_empty() {
        return;
    }
    let dnd = effective_dnd(app);
    let policy = dnd.policy();
    if !policy.toast_allowed || !policy.notify_immediately {
        return;
    }
    let state = app.state::<AppState>();
    let sober = {
        let store = state.store.lock().unwrap();
        sober_mode(&store, dnd)
    };
    let overlay_missing = surfaces::overlay(app).is_none();
    if sober || overlay_missing {
        for n in newly {
            toast(app, "Promemoria", &n.body);
        }
    }
}
