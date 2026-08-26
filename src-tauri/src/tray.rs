//! Icona di tray: la casa del core quando non c'è nessuna finestra.
//! Il pallino ambra sull'icona dice che in DND si è accumulata una pila.

use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};
use win_buddy_core::dnd::DndLevel;
use win_buddy_core::model::SessionKind;

use crate::commands;
use crate::state::AppState;
use crate::surfaces;

const TRAY_ID: &str = "main";

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app, false, false)?;

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

fn build_menu(app: &AppHandle, dnd_on: bool, sober_on: bool) -> tauri::Result<Menu<tauri::Wry>> {
    let panel = MenuItem::with_id(app, "panel", "Apri il pannello", true, None::<&str>)?;
    let capture = MenuItem::with_id(
        app,
        "capture",
        "Cattura rapida",
        true,
        Some("Ctrl+Alt+Space"),
    )?;
    let focus = MenuItem::with_id(app, "focus", "Avvia un focus", true, None::<&str>)?;
    let abort = MenuItem::with_id(app, "abort", "Interrompi la sessione", true, None::<&str>)?;
    let dnd = CheckMenuItem::with_id(
        app,
        "dnd",
        "Nascosto (DND)",
        true,
        dnd_on,
        Some("Ctrl+Alt+H"),
    )?;
    let sober = CheckMenuItem::with_id(app, "sober", "Modalità sobria", true, sober_on, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Esci", true, None::<&str>)?;

    Menu::with_items(
        app,
        &[
            &panel,
            &capture,
            &PredefinedMenuItem::separator(app)?,
            &focus,
            &abort,
            &PredefinedMenuItem::separator(app)?,
            &dnd,
            &sober,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )
}

fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "panel" => surfaces::open_panel(app),
        "capture" => surfaces::open_capture(app),
        "focus" => {
            let _ = commands::do_pomodoro_start(app, SessionKind::Focus, None);
        }
        "abort" => {
            let _ = commands::do_pomodoro_abort(app);
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
    if let Ok(menu) = build_menu(app, dnd_on, sober_on) {
        let _ = tray.set_menu(Some(menu));
    }
}

fn icon_normal() -> Image<'static> {
    tauri::include_image!("icons/tray.png")
}

fn icon_alert() -> Image<'static> {
    tauri::include_image!("icons/tray-alert.png")
}
