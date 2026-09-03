//! Icona di tray: la casa del core quando non c'è nessuna finestra.
//! Il pallino ambra sull'icona dice che in DND si è accumulata una pila.

use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuBuilder, MenuItem, SubmenuBuilder};
use tauri::tray::{TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};
use win_buddy_core::dnd::DndLevel;

use crate::commands::{self, FocusAction, FocusFinishOutcome};
use crate::state::AppState;
use crate::surfaces;

const TRAY_ID: &str = "main";

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let (actions, active_is_break) = commands::focus_shell_status(app)
        .map(|status| (status.allowed_actions().to_vec(), status.active_is_break()))
        .unwrap_or_default();
    let menu = build_menu(app, false, false, &actions, active_is_break)?;

    let _tray: TrayIcon = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon_normal())
        .tooltip("win-buddy")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button, .. } = event {
                if button == tauri::tray::MouseButton::Left {
                    surfaces::open_panel(tray.app_handle());
                }
            }
        })
        .build(app)?;
    Ok(())
}

fn focus_action_id(action: FocusAction) -> &'static str {
    match action {
        FocusAction::StartLast => "focus.start_last",
        FocusAction::Pause => "focus.pause",
        FocusAction::Resume => "focus.resume",
        FocusAction::Extend5 => "focus.extend_5",
        FocusAction::Capture => "focus.capture",
        FocusAction::Finish => "focus.finish",
        FocusAction::Overtime => "focus.overtime",
        FocusAction::StartBreak => "break.start",
        FocusAction::SkipBreak => "break.skip",
    }
}

fn focus_menu_ids(actions: &[FocusAction]) -> Vec<&'static str> {
    actions.iter().copied().map(focus_action_id).collect()
}

fn focus_action_label(action: FocusAction) -> &'static str {
    match action {
        FocusAction::StartLast => "Avvia l’ultimo focus",
        FocusAction::Pause => "Metti in pausa",
        FocusAction::Resume => "Riprendi il focus",
        FocusAction::Extend5 => "Aggiungi 5 minuti",
        FocusAction::Capture => "Cattura per il focus",
        FocusAction::Finish => "Concludi…",
        FocusAction::Overtime => "Continua in overtime",
        FocusAction::StartBreak => "Avvia la pausa",
        FocusAction::SkipBreak => "Salta la pausa (parziale)",
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TrayFocusRequest {
    Action(FocusAction),
    Finish(FocusFinishOutcome),
}

fn tray_focus_request(id: &str, allowed: &[FocusAction]) -> Option<TrayFocusRequest> {
    let finish = match id {
        "focus.finish.completed" => Some(FocusFinishOutcome::Completed),
        "focus.finish.partial" => Some(FocusFinishOutcome::Partial),
        "focus.finish.interrupted" => Some(FocusFinishOutcome::Interrupted),
        "break.finish.partial" => Some(FocusFinishOutcome::Partial),
        _ => None,
    };
    if let Some(outcome) = finish {
        return allowed
            .contains(&FocusAction::Finish)
            .then_some(TrayFocusRequest::Finish(outcome));
    }
    let action = match id {
        "focus.start_last" => FocusAction::StartLast,
        "focus.pause" => FocusAction::Pause,
        "focus.resume" => FocusAction::Resume,
        "focus.extend_5" => FocusAction::Extend5,
        "focus.capture" => FocusAction::Capture,
        "focus.overtime" => FocusAction::Overtime,
        "break.start" => FocusAction::StartBreak,
        "break.skip" => FocusAction::SkipBreak,
        _ => return None,
    };
    allowed
        .contains(&action)
        .then_some(TrayFocusRequest::Action(action))
}

fn build_menu(
    app: &AppHandle,
    dnd_on: bool,
    sober_on: bool,
    actions: &[FocusAction],
    active_is_break: bool,
) -> tauri::Result<Menu<tauri::Wry>> {
    let panel = MenuItem::with_id(app, "panel", "Apri il pannello", true, None::<&str>)?;
    let capture = MenuItem::with_id(app, "capture", "Cattura rapida", true, None::<&str>)?;
    let dnd = CheckMenuItem::with_id(
        app,
        "dnd",
        "Nascosto (DND)",
        true,
        dnd_on,
        Some("Ctrl+Alt+H"),
    )?;
    let sober = CheckMenuItem::with_id(
        app,
        "sober",
        "Modalità sobria",
        true,
        sober_on,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Esci", true, None::<&str>)?;

    let mut menu = MenuBuilder::new(app)
        .item(&panel)
        .item(&capture)
        .separator();
    for (action, id) in actions.iter().zip(focus_menu_ids(actions)) {
        // La cattura rapida è già sempre presente nella sezione shell.
        if *action == FocusAction::Capture {
            continue;
        }
        if *action == FocusAction::Finish {
            if active_is_break {
                let finish = MenuItem::with_id(
                    app,
                    "break.finish.partial",
                    "Concludi la pausa (parziale)",
                    true,
                    None::<&str>,
                )?;
                menu = menu.item(&finish);
                continue;
            }
            let completed = MenuItem::with_id(
                app,
                "focus.finish.completed",
                "Completata",
                true,
                None::<&str>,
            )?;
            let partial =
                MenuItem::with_id(app, "focus.finish.partial", "Parziale", true, None::<&str>)?;
            let interrupted = MenuItem::with_id(
                app,
                "focus.finish.interrupted",
                "Interrotta",
                true,
                None::<&str>,
            )?;
            let finish = SubmenuBuilder::with_id(app, "focus.finish", "Concludi…")
                .item(&completed)
                .item(&partial)
                .item(&interrupted)
                .build()?;
            menu = menu.item(&finish);
        } else {
            let item = MenuItem::with_id(app, id, focus_action_label(*action), true, None::<&str>)?;
            menu = menu.item(&item);
        }
    }
    menu.separator()
        .item(&dnd)
        .item(&sober)
        .separator()
        .item(&quit)
        .build()
}

fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "panel" => surfaces::open_panel(app),
        "capture" => surfaces::open_capture(app),
        id if id.starts_with("focus.") || id.starts_with("break.") => {
            let request = commands::focus_shell_status(app)
                .ok()
                .and_then(|status| tray_focus_request(id, status.allowed_actions()));
            match request {
                Some(TrayFocusRequest::Action(action)) => {
                    if let Err(error) = commands::dispatch_focus_action(app, action) {
                        log::warn!("azione tray Focus rifiutata: {error:?}");
                    }
                }
                Some(TrayFocusRequest::Finish(outcome)) => {
                    if let Err(error) = commands::dispatch_focus_finish(app, outcome) {
                        log::warn!("conclusione tray Focus rifiutata: {error:?}");
                    }
                }
                None => log::info!("azione tray Focus ignorata: non più disponibile"),
            }
        }
        "dnd" => commands::toggle_dnd(app),
        "sober" => {
            let next = {
                let state = app.state::<AppState>();
                let store = state.store.lock().unwrap();
                if store.setting("buddy.mode").ok().flatten().as_deref() == Some("sober") {
                    "full"
                } else {
                    "sober"
                }
            };
            let _ = commands::do_setting_set(app, "buddy.mode", next);
        }
        "quit" => app.exit(0),
        _ => {}
    }
    rebuild_menu_state(app);
}

/// Riallinea spunte, tooltip e icona. Chiamato dal presenter a ogni sync.
pub fn refresh(app: &AppHandle, dnd: DndLevel, queued: usize) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    let badge = dnd == DndLevel::Hidden && queued > 0;
    let _ = tray.set_icon(Some(if badge { icon_alert() } else { icon_normal() }));
    let tip = if badge {
        format!("win-buddy · {queued} promemoria in attesa")
    } else {
        "win-buddy".to_string()
    };
    let _ = tray.set_tooltip(Some(tip));
}

pub fn rebuild_menu_state(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    let state = app.state::<AppState>();
    let (dnd_on, sober_on) = {
        let store = state.store.lock().unwrap();
        (
            store.setting("dnd.manual").ok().flatten().as_deref() == Some("1"),
            store.setting("buddy.mode").ok().flatten().as_deref() == Some("sober"),
        )
    };
    let (actions, active_is_break) = commands::focus_shell_status(app)
        .map(|status| (status.allowed_actions().to_vec(), status.active_is_break()))
        .unwrap_or_default();
    if let Ok(menu) = build_menu(app, dnd_on, sober_on, &actions, active_is_break) {
        let _ = tray.set_menu(Some(menu));
    }
}

fn icon_normal() -> Image<'static> {
    tauri::include_image!("icons/tray.png")
}

fn icon_alert() -> Image<'static> {
    tauri::include_image!("icons/tray-alert.png")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::{FocusAction, FocusFinishOutcome};

    #[test]
    fn focus_menu_order_matches_every_core_surface_state() {
        let cases = [
            (vec![FocusAction::StartLast], vec!["focus.start_last"]),
            (
                vec![
                    FocusAction::Pause,
                    FocusAction::Extend5,
                    FocusAction::Capture,
                    FocusAction::Finish,
                ],
                vec![
                    "focus.pause",
                    "focus.extend_5",
                    "focus.capture",
                    "focus.finish",
                ],
            ),
            (
                vec![
                    FocusAction::Resume,
                    FocusAction::Capture,
                    FocusAction::Finish,
                ],
                vec!["focus.resume", "focus.capture", "focus.finish"],
            ),
            (
                vec![
                    FocusAction::Overtime,
                    FocusAction::Extend5,
                    FocusAction::Finish,
                ],
                vec!["focus.overtime", "focus.extend_5", "focus.finish"],
            ),
            (
                vec![FocusAction::Capture, FocusAction::Finish],
                vec!["focus.capture", "focus.finish"],
            ),
            (
                vec![
                    FocusAction::SkipBreak,
                    FocusAction::Extend5,
                    FocusAction::Finish,
                ],
                vec!["break.skip", "focus.extend_5", "focus.finish"],
            ),
        ];

        for (actions, expected) in cases {
            assert_eq!(focus_menu_ids(&actions), expected);
        }
    }

    #[test]
    fn stale_tray_action_is_rejected_against_current_allowed_actions() {
        assert_eq!(
            tray_focus_request("focus.resume", &[FocusAction::Pause]),
            None
        );
    }

    #[test]
    fn finish_menu_ids_preserve_every_explicit_outcome() {
        assert_eq!(
            tray_focus_request("focus.finish.completed", &[FocusAction::Finish]),
            Some(TrayFocusRequest::Finish(FocusFinishOutcome::Completed))
        );
        assert_eq!(
            tray_focus_request("focus.finish.partial", &[FocusAction::Finish]),
            Some(TrayFocusRequest::Finish(FocusFinishOutcome::Partial))
        );
        assert_eq!(
            tray_focus_request("focus.finish.interrupted", &[FocusAction::Finish]),
            Some(TrayFocusRequest::Finish(FocusFinishOutcome::Interrupted))
        );
        assert_eq!(
            tray_focus_request("break.finish.partial", &[FocusAction::Finish]),
            Some(TrayFocusRequest::Finish(FocusFinishOutcome::Partial))
        );
    }
}
