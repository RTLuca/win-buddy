//! Le ~300 righe di piattaforma promesse dal § 4: tutte qui, tutte dietro
//! `cfg(windows)`. Sulle altre piattaforme (sviluppo) valgono gli stub.

#[cfg(windows)]
mod win {
    use tauri::WebviewWindow;
    use windows::Win32::Devices::Display::{
        DisplayConfigGetDeviceInfo, GetDisplayConfigBufferSizes, QueryDisplayConfig,
        DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME, DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME,
        DISPLAYCONFIG_DEVICE_INFO_HEADER, DISPLAYCONFIG_MODE_INFO, DISPLAYCONFIG_PATH_INFO,
        DISPLAYCONFIG_SOURCE_DEVICE_NAME, DISPLAYCONFIG_TARGET_DEVICE_NAME, QDC_ONLY_ACTIVE_PATHS,
    };
    use windows::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS, HWND, POINT};
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
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

    /// Stato fisico del pulsante sinistro, indipendente dal mouse capture
    /// della WebView durante il trascinamento nativo.
    pub fn left_mouse_button_down() -> bool {
        unsafe { (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) != 0 }
    }

    /// Area di lavoro fisica del monitor (barra applicazioni esclusa),
    /// inclusi taskbar laterali o superiori.
    pub fn monitor_work_area(monitor: &tauri::Monitor) -> Option<(i32, i32, u32, u32)> {
        let position = monitor.position();
        let size = monitor.size();
        let center = POINT {
            x: position.x.saturating_add((size.width / 2) as i32),
            y: position.y.saturating_add((size.height / 2) as i32),
        };
        unsafe {
            let handle = MonitorFromPoint(center, MONITOR_DEFAULTTONEAREST);
            if handle.is_invalid() {
                return None;
            }
            let mut info = MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                ..Default::default()
            };
            if !GetMonitorInfoW(handle, &mut info).as_bool() {
                return None;
            }
            let work = info.rcWork;
            Some((
                work.left,
                work.top,
                (work.right - work.left).max(0) as u32,
                (work.bottom - work.top).max(0) as u32,
            ))
        }
    }

    fn wide_string(value: &[u16]) -> String {
        let length = value
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(value.len());
        String::from_utf16_lossy(&value[..length])
    }

    /// Device path PnP del monitor associato al nome GDI (`DISPLAYx`). A
    /// differenza del nome GDI resta stabile quando Windows riordina la
    /// topologia degli schermi dopo docking e riconnessioni.
    pub fn monitor_device_path(monitor: &tauri::Monitor) -> Option<String> {
        let wanted = monitor.name()?.trim_start_matches("\\\\.\\");
        unsafe {
            for _ in 0..3 {
                let mut path_count = 0;
                let mut mode_count = 0;
                if GetDisplayConfigBufferSizes(
                    QDC_ONLY_ACTIVE_PATHS,
                    &mut path_count,
                    &mut mode_count,
                ) != ERROR_SUCCESS
                {
                    return None;
                }

                let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); path_count as usize];
                let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); mode_count as usize];
                let result = QueryDisplayConfig(
                    QDC_ONLY_ACTIVE_PATHS,
                    &mut path_count,
                    paths.as_mut_ptr(),
                    &mut mode_count,
                    modes.as_mut_ptr(),
                    None,
                );
                if result == ERROR_INSUFFICIENT_BUFFER {
                    continue;
                }
                if result != ERROR_SUCCESS {
                    return None;
                }
                paths.truncate(path_count as usize);

                for path in paths {
                    let mut source = DISPLAYCONFIG_SOURCE_DEVICE_NAME {
                        header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
                            r#type: DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
                            size: std::mem::size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32,
                            adapterId: path.sourceInfo.adapterId,
                            id: path.sourceInfo.id,
                        },
                        ..Default::default()
                    };
                    if DisplayConfigGetDeviceInfo(&mut source.header) != 0
                        || !wide_string(&source.viewGdiDeviceName)
                            .trim_start_matches("\\\\.\\")
                            .eq_ignore_ascii_case(wanted)
                    {
                        continue;
                    }

                    let mut target = DISPLAYCONFIG_TARGET_DEVICE_NAME {
                        header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
                            r#type: DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME,
                            size: std::mem::size_of::<DISPLAYCONFIG_TARGET_DEVICE_NAME>() as u32,
                            adapterId: path.targetInfo.adapterId,
                            id: path.targetInfo.id,
                        },
                        ..Default::default()
                    };
                    if DisplayConfigGetDeviceInfo(&mut target.header) == 0 {
                        let device_path = wide_string(&target.monitorDevicePath);
                        if !device_path.is_empty() {
                            return Some(device_path);
                        }
                    }
                }
                return None;
            }
        }
        None
    }
}

#[cfg(windows)]
pub use win::{
    harden_overlay, left_mouse_button_down, monitor_device_path, monitor_work_area,
    query_notification_state,
};

#[cfg(not(windows))]
pub fn query_notification_state() -> i32 {
    5 // QUNS_ACCEPTS_NOTIFICATIONS
}

#[cfg(not(windows))]
pub fn harden_overlay(_window: &tauri::WebviewWindow) {}

#[cfg(not(windows))]
pub fn left_mouse_button_down() -> bool {
    false
}

#[cfg(not(windows))]
pub fn monitor_work_area(_monitor: &tauri::Monitor) -> Option<(i32, i32, u32, u32)> {
    None
}

#[cfg(not(windows))]
pub fn monitor_device_path(_monitor: &tauri::Monitor) -> Option<String> {
    None
}

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
