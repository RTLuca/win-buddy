//! Le ~300 righe di piattaforma promesse dal § 4: tutte qui, tutte dietro
//! `cfg(windows)`. Sulle altre piattaforme (sviluppo) valgono gli stub.

#[cfg(windows)]
mod win {
    use tauri::WebviewWindow;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Shell::SHQueryUserNotificationState;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };

    /// `SHQueryUserNotificationState()` (§ 10.4). In caso d'errore si
    /// risponde «accetta notifiche»: meglio un buddy di troppo che un
    /// promemoria accodato per sbaglio.
    pub fn query_notification_state() -> i32 {
        unsafe { SHQueryUserNotificationState().map(|s| s.0).unwrap_or(5) }
    }

    /// Stili estesi dell'overlay (§ 10.1): non ruba il focus e non compare
    /// nella barra applicazioni. Layered e transparent li gestisce Tauri
    /// (`transparent(true)` + `set_ignore_cursor_events`).
    pub fn harden_overlay(window: &WebviewWindow) {
        let Ok(hwnd) = window.hwnd() else { return };
        let hwnd = HWND(hwnd.0);
        unsafe {
            let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let wanted = style | (WS_EX_NOACTIVATE.0 as isize) | (WS_EX_TOOLWINDOW.0 as isize);
            if wanted != style {
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, wanted);
            }
        }
    }
}

#[cfg(windows)]
pub use win::{harden_overlay, query_notification_state};

#[cfg(not(windows))]
pub fn query_notification_state() -> i32 {
    5 // QUNS_ACCEPTS_NOTIFICATIONS
}

#[cfg(not(windows))]
pub fn harden_overlay(_window: &tauri::WebviewWindow) {}

/// Finestra di errore nativa: l'ultima voce dell'app quando qualcosa la
/// uccide prima ancora che esista una finestra.
#[cfg(windows)]
pub fn fatal_dialog(title: &str, msg: &str) {
    use windows::core::PCWSTR;
    use windows::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, MB_ICONERROR, MB_OK, MB_SYSTEMMODAL,
    };
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }
    let t = wide(title);
    let m = wide(msg);
    unsafe {
        MessageBoxW(
            None,
            PCWSTR(m.as_ptr()),
            PCWSTR(t.as_ptr()),
            MB_OK | MB_ICONERROR | MB_SYSTEMMODAL,
        );
    }
}

#[cfg(not(windows))]
pub fn fatal_dialog(title: &str, msg: &str) {
    eprintln!("{title}: {msg}");
}
