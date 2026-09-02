//! Le superfici e i loro cicli di vita (§ 5.1). L'overlay è effimero:
//! nasce quando c'è qualcosa da mostrare, muore in DND o inattività.

use std::sync::atomic::Ordering;

use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

use crate::platform;
use crate::state::AppState;

pub const OVERLAY: &str = "overlay";
pub const PANEL: &str = "panel";
pub const CAPTURE: &str = "capture";

const OVERLAY_BASE_W: f64 = 330.0;
const OVERLAY_BASE_H: f64 = 360.0;
const MARGIN: f64 = 14.0;
/// Spazio riservato alla barra applicazioni quando l'area di lavoro
/// non è disponibile.
const TASKBAR: f64 = 52.0;

#[derive(Clone, Copy, Debug)]
struct MonitorRect {
    width: f64,
    height: f64,
    x: f64,
    y: f64,
    scale: f64,
    bottom_inset: f64,
}

fn position_bounds(monitor: MonitorRect, size: (f64, f64)) -> (f64, f64, f64, f64) {
    let margin = MARGIN * monitor.scale;
    let left = monitor.x + margin;
    let top = monitor.y + margin;
    let right = (monitor.x + monitor.width - size.0 - margin).max(left);
    let bottom = (monitor.y + monitor.height - size.1 - monitor.bottom_inset).max(top);
    (left, right, top, bottom)
}

fn position_from_relative(
    monitor: MonitorRect,
    size: (f64, f64),
    relative: (f64, f64),
) -> (f64, f64) {
    let (left, right, top, bottom) = position_bounds(monitor, size);
    (
        left + relative.0.clamp(0.0, 1.0) * (right - left),
        top + relative.1.clamp(0.0, 1.0) * (bottom - top),
    )
}

fn position_to_relative(
    monitor: MonitorRect,
    size: (f64, f64),
    position: (f64, f64),
) -> (f64, f64) {
    let (left, right, top, bottom) = position_bounds(monitor, size);
    let x = if right > left {
        ((position.0 - left) / (right - left)).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let y = if bottom > top {
        ((position.1 - top) / (bottom - top)).clamp(0.0, 1.0)
    } else {
        0.0
    };
    (x, y)
}

fn resolve_overlay_position(
    monitor: MonitorRect,
    size: (f64, f64),
    corner: &str,
    manual: Option<(f64, f64)>,
) -> (f64, f64) {
    if let Some(relative) = manual {
        return position_from_relative(monitor, size, relative);
    }

    let (left, right, top, bottom) = position_bounds(monitor, size);
    match corner {
        "bottom-left" => (left, bottom),
        "top-left" => (left, top),
        "top-right" => (right, top),
        _ => (right, bottom),
    }
}

fn parse_manual_position(mode: &str, x: Option<&str>, y: Option<&str>) -> Option<(f64, f64)> {
    if mode != "manual" {
        return None;
    }
    let position = (x?.parse::<f64>().ok()?, y?.parse::<f64>().ok()?);
    (position.0.is_finite() && position.1.is_finite()).then_some(position)
}

fn position_changed(current: (f64, f64), target: (f64, f64)) -> bool {
    (current.0 - target.0).abs() > 0.5 || (current.1 - target.1).abs() > 0.5
}

fn physical_overlay_size(logical: (f64, f64), scale: f64) -> (f64, f64) {
    (logical.0 * scale, logical.1 * scale)
}

fn drag_save_due(generation: u64, current_generation: u64, left_mouse_down: bool) -> bool {
    generation == current_generation && !left_mouse_down
}

fn monitor_choice_matches(
    choice: &str,
    index: usize,
    stable_id: &str,
    legacy_id: &str,
    is_primary: bool,
) -> bool {
    choice == "primary" && is_primary
        || choice.strip_prefix("name:").is_some_and(|chosen| {
            chosen.eq_ignore_ascii_case(stable_id) || chosen.eq_ignore_ascii_case(legacy_id)
        })
        || choice.parse::<usize>().ok() == Some(index)
}

/// Dimensione dell'overlay: la base per la scala scelta dall'utente
/// (`overlay.scale`, percentuale 50–200).
fn overlay_size(app: &AppHandle) -> (f64, f64) {
    let scale = {
        let state = app.state::<AppState>();
        let store = state.store.lock().unwrap();
        store.setting_i64("overlay.scale", 100).clamp(50, 200) as f64 / 100.0
    };
    (OVERLAY_BASE_W * scale, OVERLAY_BASE_H * scale)
}

fn legacy_monitor_id(monitor: &tauri::Monitor) -> String {
    monitor
        .name()
        .map(|name| name.trim_start_matches("\\\\.\\").to_string())
        .unwrap_or_else(|| {
            format!(
                "{}x{}@{},{}",
                monitor.size().width,
                monitor.size().height,
                monitor.position().x,
                monitor.position().y
            )
        })
}

pub(crate) fn monitor_id(monitor: &tauri::Monitor) -> String {
    platform::monitor_device_path(monitor).unwrap_or_else(|| legacy_monitor_id(monitor))
}

fn physical_monitor(monitor: &tauri::Monitor) -> MonitorRect {
    let scale = monitor.scale_factor();
    if let Some((x, y, width, height)) = platform::monitor_work_area(monitor) {
        return MonitorRect {
            width: width as f64,
            height: height as f64,
            x: x as f64,
            y: y as f64,
            scale,
            bottom_inset: MARGIN * scale,
        };
    }

    MonitorRect {
        width: monitor.size().width as f64,
        height: monitor.size().height as f64,
        x: monitor.position().x as f64,
        y: monitor.position().y as f64,
        scale,
        bottom_inset: TASKBAR * scale,
    }
}

/// Risolve la scelta persistita con un nome stabile. Gli indici numerici
/// delle versioni precedenti restano accettati come migrazione trasparente.
fn selected_monitor(app: &AppHandle) -> Option<tauri::Monitor> {
    let choice = {
        let state = app.state::<AppState>();
        let store = state.store.lock().unwrap();
        store
            .setting("overlay.monitor")
            .ok()
            .flatten()
            .unwrap_or_else(|| "primary".into())
    };

    let primary = app.primary_monitor().ok().flatten();
    let primary_position = primary.as_ref().map(|monitor| *monitor.position());
    let monitors = app.available_monitors().ok().unwrap_or_default();
    let selected = monitors.iter().enumerate().find(|(index, monitor)| {
        let is_primary = primary_position == Some(*monitor.position());
        monitor_choice_matches(
            &choice,
            *index,
            &monitor_id(monitor),
            &legacy_monitor_id(monitor),
            is_primary,
        )
    });

    selected.map(|(_, monitor)| monitor.clone()).or_else(|| {
        log::warn!("schermo '{choice}' non trovato: uso il primario");
        primary
    })
}

fn fallback_monitor() -> MonitorRect {
    MonitorRect {
        width: 1920.0,
        height: 1080.0,
        x: 0.0,
        y: 0.0,
        scale: 1.0,
        bottom_inset: TASKBAR,
    }
}

pub fn overlay(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(OVERLAY)
}

/// Crea l'overlay se non esiste. Il tempo di comparsa sta sotto il mezzo
/// secondo e non cade mai durante un'interazione (§ 10.5).
pub fn ensure_overlay(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(w) = overlay(app) {
        return Some(w);
    }
    let logical_size = overlay_size(app);
    let (physical_size, position) = overlay_layout(app);
    let started = std::time::Instant::now();
    let built =
        WebviewWindowBuilder::new(app, OVERLAY, WebviewUrl::App("overlay/index.html".into()))
            .title("win-buddy")
            .inner_size(logical_size.0, logical_size.1)
            .visible(false)
            .transparent(true)
            .decorations(false)
            .shadow(false)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .closable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .accept_first_mouse(true)
            .build();
    let win = match built {
        Ok(w) => {
            log::info!("overlay creata in {} ms", started.elapsed().as_millis());
            w
        }
        Err(e) => {
            log::error!("overlay non creata: {e}");
            return None;
        }
    };

    if let Err(error) = apply_window_layout(&win, physical_size, position) {
        log::error!("layout iniziale dell'overlay non applicato: {error}");
        let _ = win.destroy();
        return None;
    }

    platform::harden_overlay(&win);
    // trasparente ai clic per impostazione predefinita (§ 10.2), altrimenti
    // è un rettangolo morto sopra le finestre di lavoro
    let _ = win.set_ignore_cursor_events(true);
    if let Some(state) = app.try_state::<AppState>() {
        state
            .overlay_interactive
            .store(false, std::sync::atomic::Ordering::Relaxed);
        *state.hitbox.lock().unwrap() = None;
    }
    if let Err(error) = win.show() {
        log::error!("overlay non mostrata: {error}");
        let _ = win.destroy();
        return None;
    }
    Some(win)
}

pub fn destroy_overlay(app: &AppHandle) {
    cancel_overlay_drag(app);
    if let Some(w) = overlay(app) {
        let _ = w.destroy();
    }
}

fn overlay_layout(app: &AppHandle) -> ((f64, f64), (f64, f64)) {
    let (corner, manual) = {
        let state = app.state::<AppState>();
        let store = state.store.lock().unwrap();
        let corner = store
            .setting("buddy.corner")
            .ok()
            .flatten()
            .unwrap_or_else(|| "bottom-right".into());
        let mode = store
            .setting("overlay.position.mode")
            .ok()
            .flatten()
            .unwrap_or_else(|| "corner".into());
        let x = store.setting("overlay.position.x").ok().flatten();
        let y = store.setting("overlay.position.y").ok().flatten();
        let manual = parse_manual_position(&mode, x.as_deref(), y.as_deref());
        (corner, manual)
    };

    let monitor = selected_monitor(app);
    let rect = monitor
        .as_ref()
        .map(physical_monitor)
        .unwrap_or_else(fallback_monitor);
    let size = physical_overlay_size(overlay_size(app), rect.scale);
    let position = resolve_overlay_position(rect, size, &corner, manual);
    (size, position)
}

fn apply_window_layout(
    window: &WebviewWindow,
    size: (f64, f64),
    position: (f64, f64),
) -> Result<(), String> {
    window
        .set_position(PhysicalPosition::new(
            position.0.round() as i32,
            position.1.round() as i32,
        ))
        .map_err(|error| error.to_string())?;
    // Il cambio monitor può generare WM_DPICHANGED e Tao preserva la
    // dimensione logica. La misura fisica va quindi applicata dopo lo
    // spostamento, quando il nuovo fattore DPI è già quello effettivo.
    window
        .set_size(PhysicalSize::new(
            size.0.round().max(1.0) as u32,
            size.1.round().max(1.0) as u32,
        ))
        .map_err(|error| error.to_string())
}

/// Applica a caldo dimensione, schermo e angolo: chiamata quando cambiano
/// `overlay.scale`, `overlay.monitor` o `buddy.corner`.
pub fn apply_overlay_layout(app: &AppHandle) -> Result<(), String> {
    if let Some(w) = overlay(app) {
        let (size, position) = overlay_layout(app);
        apply_window_layout(&w, size, position)?;
    }
    Ok(())
}

// ---------------------------------------------------------------- pannello

pub fn open_panel(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(PANEL) {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    if let Err(e) =
        WebviewWindowBuilder::new(app, PANEL, WebviewUrl::App("panel/index.html".into()))
            .title("win-buddy")
            .inner_size(380.0, 640.0)
            .min_inner_size(320.0, 420.0)
            .center()
            .build()
    {
        log::error!("pannello non creato: {e}");
    }
}

pub fn close_panel(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(PANEL) {
        let _ = w.close();
    }
}

// ---------------------------------------------------------- cattura rapida

/// Scorciatoia globale, una riga, Invio (§ 11). Perde il focus → sparisce.
pub fn open_capture(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(CAPTURE) {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let (mw, mh, ox, oy) = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| {
            let s = m.scale_factor();
            (
                m.size().width as f64 / s,
                m.size().height as f64 / s,
                m.position().x as f64 / s,
                m.position().y as f64 / s,
            )
        })
        .unwrap_or((1920.0, 1080.0, 0.0, 0.0));
    let w = 560.0_f64.min(mw - 40.0);
    let built =
        WebviewWindowBuilder::new(app, CAPTURE, WebviewUrl::App("capture/index.html".into()))
            .title("Cattura rapida")
            .inner_size(w, 170.0)
            .position(ox + (mw - w) / 2.0, oy + mh * 0.24)
            .transparent(true)
            .decorations(false)
            .shadow(false)
            .resizable(false)
            .skip_taskbar(true)
            .always_on_top(true)
            .focused(true)
            .build();

    match built {
        Ok(win) => {
            let app = app.clone();
            win.on_window_event(move |e| {
                if matches!(e, WindowEvent::Focused(false)) {
                    close_capture(&app);
                }
            });
        }
        Err(e) => log::error!("cattura rapida non creata: {e}"),
    }
}

pub fn close_capture(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(CAPTURE) {
        let _ = w.destroy();
    }
}

/// Avvia il trascinamento nativo: il sistema conserva il mouse capture anche
/// quando il puntatore esce dalla piccola area interattiva del buddy.
pub fn start_overlay_drag(app: &AppHandle) -> Result<(), String> {
    let window = overlay(app).ok_or_else(|| "overlay non disponibile".to_string())?;
    let generation = app
        .state::<AppState>()
        .overlay_drag_generation
        .fetch_add(1, Ordering::AcqRel)
        .wrapping_add(1);
    window.start_dragging().map_err(|error| error.to_string())?;

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(75)).await;
            let current_generation = app
                .state::<AppState>()
                .overlay_drag_generation
                .load(Ordering::Acquire);
            if generation != current_generation {
                return;
            }
            if drag_save_due(
                generation,
                current_generation,
                platform::left_mouse_button_down(),
            ) {
                if let Err(error) = persist_overlay_position(&app, Some(generation)) {
                    log::warn!("posizione dell'overlay non salvata: {error}");
                }
                return;
            }
        }
    });
    Ok(())
}

/// Salva la posizione corrente come percentuale dello spazio percorribile sul
/// monitor attuale. In questo modo resize e cambi di risoluzione non spingono
/// il buddy fuori schermo.
fn persist_overlay_position(
    app: &AppHandle,
    required_generation: Option<u64>,
) -> Result<(), String> {
    let window = overlay(app).ok_or_else(|| "overlay non disponibile".to_string())?;
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .or_else(|| app.primary_monitor().ok().flatten())
        .ok_or_else(|| "nessun monitor disponibile".to_string())?;
    let physical_position = (position.x as f64, position.y as f64);
    let physical_size = (size.width as f64, size.height as f64);
    let rect = physical_monitor(&monitor);
    let relative = position_to_relative(rect, physical_size, physical_position);

    let primary_position = app.primary_monitor().ok().flatten().map(|m| *m.position());
    let monitor_choice = if primary_position == Some(*monitor.position()) {
        "primary".to_string()
    } else {
        format!("name:{}", monitor_id(&monitor))
    };
    let x = format!("{:.6}", relative.0);
    let y = format!("{:.6}", relative.1);
    let clamped = position_from_relative(rect, physical_size, relative);

    {
        let state = app.state::<AppState>();
        let store = state.store.lock().unwrap();
        if required_generation.is_some_and(|required| {
            state.overlay_drag_generation.load(Ordering::Acquire) != required
        }) {
            return Ok(());
        }
        if position_changed(physical_position, clamped) {
            window
                .set_position(PhysicalPosition::new(
                    clamped.0.round() as i32,
                    clamped.1.round() as i32,
                ))
                .map_err(|error| error.to_string())?;
        }
        store
            .set_settings(&[
                ("overlay.position.x", x.as_str()),
                ("overlay.position.y", y.as_str()),
                ("overlay.monitor", monitor_choice.as_str()),
                ("overlay.position.mode", "manual"),
            ])
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn nudge_overlay_position(app: &AppHandle, x: i32, y: i32) -> Result<(), String> {
    cancel_overlay_drag(app);
    let window = overlay(app).ok_or_else(|| "overlay non disponibile".to_string())?;
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    window
        .set_position(PhysicalPosition::new(
            position.x + (x as f64 * scale).round() as i32,
            position.y + (y as f64 * scale).round() as i32,
        ))
        .map_err(|error| error.to_string())?;
    persist_overlay_position(app, None)
}

pub fn reset_overlay_position(app: &AppHandle) -> Result<(), String> {
    cancel_overlay_drag(app);
    {
        let state = app.state::<AppState>();
        let store = state.store.lock().unwrap();
        store
            .set_setting("overlay.position.mode", "corner")
            .map_err(|e| e.to_string())?;
    }
    apply_overlay_layout(app)
}

pub fn cancel_overlay_drag(app: &AppHandle) {
    app.state::<AppState>()
        .overlay_drag_generation
        .fetch_add(1, Ordering::AcqRel);
}

#[cfg(test)]
mod tests {
    use super::*;

    const MONITOR: MonitorRect = MonitorRect {
        width: 1920.0,
        height: 1080.0,
        x: 0.0,
        y: 0.0,
        scale: 1.0,
        bottom_inset: TASKBAR,
    };

    #[test]
    fn relative_position_roundtrips_inside_the_visible_work_area() {
        // Regressione coperta: salvare coordinate assolute romperebbe la
        // posizione al cambio di scala o risoluzione.
        let size = (330.0, 360.0);
        let placed = position_from_relative(MONITOR, size, (0.25, 0.75));
        assert_eq!(placed, (404.5, 504.5));

        let saved = position_to_relative(MONITOR, size, placed);
        assert!((saved.0 - 0.25).abs() < f64::EPSILON);
        assert!((saved.1 - 0.75).abs() < f64::EPSILON);
    }

    #[test]
    fn restored_position_clamps_corrupt_or_stale_values() {
        // Regressione coperta: valori fuori range non devono lasciare il
        // controllo del buddy irraggiungibile fuori dallo schermo.
        let placed = position_from_relative(MONITOR, (330.0, 360.0), (-2.0, 4.0));
        assert_eq!(placed, (14.0, 668.0));
    }

    #[test]
    fn oversized_overlay_stays_at_the_safe_origin() {
        // Regressione coperta: con schermo piccolo o scala 200% i limiti
        // possono invertirsi; la posizione deve restare finita e visibile.
        let tiny = MonitorRect {
            width: 400.0,
            height: 300.0,
            x: -400.0,
            y: 20.0,
            scale: 1.0,
            bottom_inset: TASKBAR,
        };
        assert_eq!(
            position_from_relative(tiny, (660.0, 720.0), (0.8, 0.2)),
            (-386.0, 34.0)
        );
    }

    #[test]
    fn manual_position_wins_over_the_configured_corner() {
        // Regressione coperta: una ricreazione dell'overlay non deve
        // dimenticare il trascinamento e riapplicare l'angolo configurato.
        assert_eq!(
            resolve_overlay_position(MONITOR, (330.0, 360.0), "top-left", Some((0.5, 0.5)),),
            (795.0, 341.0)
        );
    }

    #[test]
    fn reset_falls_back_to_the_selected_corner() {
        // Regressione coperta: disattivare la posizione manuale deve usare
        // davvero monitor e angolo scelti, non una coordinata predefinita.
        assert_eq!(
            resolve_overlay_position(MONITOR, (330.0, 360.0), "bottom-left", None),
            (14.0, 668.0)
        );
    }

    #[test]
    fn manual_settings_require_mode_and_finite_coordinates() {
        // Regressione coperta: un valore parziale o non finito nel database
        // non deve produrre coordinate NaN né scavalcare il reset.
        assert_eq!(
            parse_manual_position("manual", Some("0.35"), Some("0.8")),
            Some((0.35, 0.8))
        );
        assert_eq!(
            parse_manual_position("corner", Some("0.35"), Some("0.8")),
            None
        );
        assert_eq!(
            parse_manual_position("manual", Some("NaN"), Some("0.8")),
            None
        );
        assert_eq!(parse_manual_position("manual", Some("0.35"), None), None);
    }

    #[test]
    fn save_repositions_only_when_clamping_changed_a_physical_pixel() {
        // Regressione coperta: un set_position incondizionato emette un nuovo
        // evento moved, che richiamerebbe il salvataggio in ciclo.
        assert!(!position_changed((510.0, 240.0), (510.4, 239.6)));
        assert!(position_changed((510.0, 240.0), (511.0, 240.0)));
    }

    #[test]
    fn overlay_size_is_converted_for_the_target_monitor_dpi() {
        // Regressione coperta: le coordinate globali di un monitor al 150%
        // restano fisiche e non vengono moltiplicate una seconda volta.
        assert_eq!(physical_overlay_size((330.0, 360.0), 1.5), (495.0, 540.0));
        let monitor = MonitorRect {
            width: 3840.0,
            height: 2160.0,
            x: 1920.0,
            y: 0.0,
            scale: 1.5,
            bottom_inset: TASKBAR * 1.5,
        };
        assert_eq!(
            resolve_overlay_position(monitor, (495.0, 540.0), "bottom-right", None),
            (5244.0, 1542.0)
        );
    }

    #[test]
    fn drag_save_waits_for_release_and_cannot_override_a_newer_action() {
        assert!(!drag_save_due(7, 7, true));
        assert!(drag_save_due(7, 7, false));
        assert!(!drag_save_due(7, 8, false));
    }

    #[test]
    fn monitor_choice_supports_stable_names_and_legacy_indices() {
        let stable = r"\\?\DISPLAY#ACR1234#stable";
        assert!(monitor_choice_matches(
            "primary", 2, stable, "DISPLAY3", true
        ));
        assert!(monitor_choice_matches(
            r"name:\\?\DISPLAY#ACR1234#stable",
            2,
            stable,
            "DISPLAY3",
            false
        ));
        assert!(monitor_choice_matches(
            "name:DISPLAY3",
            2,
            stable,
            "DISPLAY3",
            false
        ));
        assert!(monitor_choice_matches("2", 2, stable, "DISPLAY3", false));
        assert!(!monitor_choice_matches(
            "name:DISPLAY2",
            2,
            stable,
            "DISPLAY3",
            false
        ));
    }
}
