//! Log su file + aggancio dei panic.
//!
//! L'eseguibile è compilato senza console (`windows_subsystem = "windows"`):
//! senza questo modulo un errore fatale all'avvio uccide il processo senza
//! lasciare traccia. Tutto ciò che conta finisce in
//! `%APPDATA%\com.raintonic.winbuddy\win-buddy.log`, e il primo panic
//! mostra anche una finestra di errore.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

struct FileLogger {
    file: Mutex<File>,
}

static LOGGER: OnceLock<FileLogger> = OnceLock::new();

pub fn log_dir() -> PathBuf {
    #[cfg(windows)]
    {
        PathBuf::from(std::env::var("APPDATA").unwrap_or_else(|_| ".".into()))
            .join("com.raintonic.winbuddy")
    }
    #[cfg(not(windows))]
    {
        PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into()))
            .join(".local/share/com.raintonic.winbuddy")
    }
}

pub fn log_file() -> PathBuf {
    log_dir().join("win-buddy.log")
}

impl log::Log for FileLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::Level::Info
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let line = format!(
            "{} [{:5}] {}: {}\n",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
            record.level(),
            record.target(),
            record.args()
        );
        if let Ok(mut f) = self.file.lock() {
            let _ = f.write_all(line.as_bytes());
            let _ = f.flush();
        }
        eprint!("{line}");
    }

    fn flush(&self) {}
}

pub fn init() {
    let dir = log_dir();
    let _ = fs::create_dir_all(&dir);
    let path = log_file();

    // rotazione grezza: oltre i 5 MB si riparte da zero
    if let Ok(md) = fs::metadata(&path) {
        if md.len() > 5_000_000 {
            let _ = fs::remove_file(&path);
        }
    }

    if let Ok(file) = OpenOptions::new().create(true).append(true).open(&path) {
        let logger = LOGGER.get_or_init(|| FileLogger { file: Mutex::new(file) });
        if log::set_logger(logger).is_ok() {
            log::set_max_level(log::LevelFilter::Info);
        }
    }

    // qualunque panic finisce nel log; il primo apre anche una finestra,
    // così «non parte e basta» diventa un messaggio leggibile
    static DIALOG_SHOWN: AtomicBool = AtomicBool::new(false);
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let msg = format!("{info}");
        log::error!("panic: {msg}");
        if !DIALOG_SHOWN.swap(true, Ordering::SeqCst) {
            crate::platform::fatal_dialog(
                "win-buddy — errore",
                &format!("L'app si è fermata per un errore interno:\n\n{msg}\n\nLog: {}", log_file().display()),
            );
        }
        default_hook(info);
    }));
}
