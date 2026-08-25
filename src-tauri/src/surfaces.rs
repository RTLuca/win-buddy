//! Le superfici e i loro cicli di vita (§ 5.1). L'overlay è effimero:
//! nasce quando c'è qualcosa da mostrare, muore in DND o inattività.

use tauri::{
    AppHandle, LogicalPosition, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};

use crate::platform;
use crate::state::AppState;

pub const OVERLAY: &str = "overlay";
pub const PANEL: &str = "panel";
pub const CAPTURE: &str = "capture";

const OVERLAY_W: f64 = 330.0;
const OVERLAY_H: f64 = 360.0;
const MARGIN: f64 = 14.0;
/// Spazio riservato alla barra applicazioni quando l'area di lavoro
/// non è disponibile.
const TASKBAR: f64 = 52.0;

pub fn overlay(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(OVERLAY)
}

/// Crea l'overlay se non esiste. Il tempo di comparsa sta sotto il mezzo
/// secondo e non cade mai durante un'interazione (§ 10.5).
pub fn ensure_overlay(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(w) = overlay(app) {
        return Some(w);
    }
    let (x, y) = overlay_position(app);
    let win = WebviewWindowBuilder::new(app, OVERLAY, WebviewUrl::App("overlay/index.html".into()))
        .title("win-buddy")
        .inner_size(OVERLAY_W, OVERLAY_H)
        .position(x, y)
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
        .build()
        .ok()?;

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
    Some(win)
}

pub fn destroy_overlay(app: &AppHandle) {
    if let Some(w) = overlay(app) {
        let _ = w.destroy();
    }
}

/// Angolo scelto dall'utente (§ 10.1), in coordinate logiche del monitor
/// primario. L'area di lavoro tiene fuori la barra applicazioni.
fn overlay_position(app: &AppHandle) -> (f64, f64) {
    let corner = {
        let state = app.state::<AppState>();
        let store = state.store.lock().unwrap();
        store
            .setting("buddy.corner")
            .ok()
            .flatten()
            .unwrap_or_else(|| "bottom-right".into())
    };

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

    let left = ox + MARGIN;
    let right = ox + mw - OVERLAY_W - MARGIN;
    let top = oy + MARGIN;
    let bottom = oy + mh - OVERLAY_H - TASKBAR;

    match corner.as_str() {
        "bottom-left" => (left, bottom),
        "top-left" => (left, top),
        "top-right" => (right, top),
        _ => (right, bottom),
    }
}

pub fn reposition_overlay(app: &AppHandle) {
    if let Some(w) = overlay(app) {
        let (x, y) = overlay_position(app);
        let _ = w.set_position(LogicalPosition::new(x, y));
    }
}

// ---------------------------------------------------------------- pannello

pub fn open_panel(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(PANEL) {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, PANEL, WebviewUrl::App("panel/index.html".into()))
        .title("win-buddy")
        .inner_size(380.0, 640.0)
        .min_inner_size(320.0, 420.0)
        .center()
        .build();
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
    let built = WebviewWindowBuilder::new(app, CAPTURE, WebviewUrl::App("capture/index.html".into()))
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

    if let Ok(win) = built {
        let app = app.clone();
        win.on_window_event(move |e| {
            if matches!(e, WindowEvent::Focused(false)) {
                close_capture(&app);
            }
        });
    }
}

pub fn close_capture(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(CAPTURE) {
        let _ = w.destroy();
    }
}
