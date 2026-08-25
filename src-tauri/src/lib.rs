//! win-buddy · shell Tauri.
//!
//! Un solo processo, quattro superfici con cicli di vita indipendenti (§ 5).
//! Il core resta acceso senza alcuna finestra: è la condizione in cui l'app
//! passa la maggior parte del tempo, e il motivo della scelta di stack (§ 4).

mod commands;
mod platform;
mod presenter;
mod runtime;
mod state;
mod surfaces;
mod tray;

use tauri::Manager;
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use state::AppState;

pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    tauri::Builder::default()
        // una sola istanza: la seconda apre il pannello della prima
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            surfaces::open_panel(app);
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::capture_preview,
            commands::capture_submit,
            commands::capture_cancel,
            commands::notes_open,
            commands::notes_archive,
            commands::notes_search,
            commands::note_complete,
            commands::note_dismiss,
            commands::note_snooze,
            commands::pomodoro_start,
            commands::pomodoro_abort,
            commands::pomodoro_status,
            commands::pomodoro_history,
            commands::break_accept,
            commands::break_skip,
            commands::settings_all,
            commands::setting_set,
            commands::dnd_status,
            commands::dnd_set_manual,
            commands::hittest_update,
            commands::surface_ready,
            commands::open_panel,
            commands::close_panel,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(AppState::new(&handle)?);

            tray::setup(&handle)?;
            register_shortcuts(&handle)?;
            enable_autostart_once(&handle);

            // recupero all'avvio (§ 7.3): un promemoria scaduto mentre l'app
            // era spenta viene notificato adesso, non perso
            runtime::startup_recovery(&handle);
            runtime::start(handle);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("avvio di win-buddy")
        .run(|_app, event| {
            // residente in tray: chiudere le finestre non chiude l'app
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}

fn register_shortcuts(app: &tauri::AppHandle) -> tauri::Result<()> {
    // Ctrl+Alt+Spazio: cattura rapida (§ 11)
    app.global_shortcut()
        .on_shortcut("ctrl+alt+space", |app, _sc, ev| {
            if ev.state() == ShortcutState::Pressed {
                surfaces::open_capture(app);
            }
        })
        .map_err(|e| tauri::Error::Anyhow(e.into()))?;
    // Ctrl+Alt+H: DND manuale, più veloce di qualunque euristica (§ 10.4)
    app.global_shortcut()
        .on_shortcut("ctrl+alt+h", |app, _sc, ev| {
            if ev.state() == ShortcutState::Pressed {
                commands::toggle_dnd(app);
            }
        })
        .map_err(|e| tauri::Error::Anyhow(e.into()))?;
    Ok(())
}

/// Avvio automatico al login (§ 2), attivato una volta sola: se l'utente
/// lo spegne dalle impostazioni di sistema, non glielo riaccendiamo.
fn enable_autostart_once(app: &tauri::AppHandle) {
    use tauri_plugin_autostart::ManagerExt;
    let state = app.state::<AppState>();
    let first_run = {
        let store = state.store.lock().unwrap();
        let missing = store.setting("app.autostart_set").ok().flatten().is_none();
        if missing {
            let _ = store.set_setting("app.autostart_set", "1");
        }
        missing
    };
    if first_run {
        let _ = app.autolaunch().enable();
    }
}
