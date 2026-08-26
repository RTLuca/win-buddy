//! win-buddy · shell Tauri.
//!
//! Un solo processo, quattro superfici con cicli di vita indipendenti (§ 5).
//! Il core resta acceso senza alcuna finestra: è la condizione in cui l'app
//! passa la maggior parte del tempo, e il motivo della scelta di stack (§ 4).
//!
//! Regola dell'avvio: l'unico errore che ferma l'app è un database che non
//! si apre. Tutto il resto — tray, scorciatoie occupate, overlay — degrada
//! con un log, mai con un abort silenzioso.

mod commands;
mod logging;
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
    logging::init();
    log::info!("win-buddy {} in avvio", env!("CARGO_PKG_VERSION"));

    let app = tauri::Builder::default()
        // una sola istanza: la seconda apre il pannello della prima
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            log::info!("seconda istanza: apro il pannello");
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
            commands::monitors_list,
            commands::dnd_status,
            commands::dnd_set_manual,
            commands::hittest_update,
            commands::surface_ready,
            commands::open_panel,
            commands::close_panel,
            commands::open_capture,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            let state = match AppState::new(&handle) {
                Ok(s) => s,
                Err(e) => {
                    let msg = format!("Impossibile aprire il database: {e}");
                    log::error!("{msg}");
                    platform::fatal_dialog("win-buddy — errore", &msg);
                    return Err(msg.into());
                }
            };
            app.manage(state);
            log::info!("store aperto in {}", logging::log_dir().display());

            if let Err(e) = tray::setup(&handle) {
                // senza tray l'app resta usabile via scorciatoie: si continua
                log::error!("icona di tray non creata: {e}");
            } else {
                log::info!("tray pronta");
            }

            register_shortcuts(&handle);
            enable_autostart_once(&handle);

            // recupero all'avvio (§ 7.3): un promemoria scaduto mentre l'app
            // era spenta viene notificato adesso, non perso
            runtime::startup_recovery(&handle);
            runtime::start(handle);
            log::info!("core avviato");
            Ok(())
        })
        .build(tauri::generate_context!());

    let app = match app {
        Ok(a) => a,
        Err(e) => {
            let msg = format!("Avvio fallito: {e}");
            log::error!("{msg}");
            platform::fatal_dialog("win-buddy — errore", &msg);
            return;
        }
    };

    app.run(|_app, event| {
        // residente in tray: chiudere le finestre non chiude l'app
        if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
            if code.is_none() {
                api.prevent_exit();
            }
        }
    });
}

/// Le scorciatoie globali sono comodità, non prerequisiti: se un'altra app
/// tiene occupata una combinazione, si logga e si va avanti — il tray copre
/// le stesse azioni.
fn register_shortcuts(app: &tauri::AppHandle) {
    // Ctrl+Alt+Spazio: cattura rapida (§ 11)
    let r = app
        .global_shortcut()
        .on_shortcut("ctrl+alt+space", |app, _sc, ev| {
            if ev.state() == ShortcutState::Pressed {
                surfaces::open_capture(app);
            }
        });
    match r {
        Ok(()) => log::info!("scorciatoia cattura registrata (Ctrl+Alt+Spazio)"),
        Err(e) => log::warn!("Ctrl+Alt+Spazio non registrata: {e}"),
    }
    // Ctrl+Alt+H: DND manuale, più veloce di qualunque euristica (§ 10.4)
    let r = app
        .global_shortcut()
        .on_shortcut("ctrl+alt+h", |app, _sc, ev| {
            if ev.state() == ShortcutState::Pressed {
                commands::toggle_dnd(app);
            }
        });
    match r {
        Ok(()) => log::info!("scorciatoia DND registrata (Ctrl+Alt+H)"),
        Err(e) => log::warn!("Ctrl+Alt+H non registrata: {e}"),
    }
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
        match app.autolaunch().enable() {
            Ok(()) => log::info!("avvio automatico attivato"),
            Err(e) => log::warn!("avvio automatico non attivato: {e}"),
        }
    }
}
