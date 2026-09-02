//! Stato del processo core. Il database è la verità; qui vive solo ciò che
//! è effimero per costruzione (bolla mostrata, hitbox, orologi di servizio).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64};
use std::sync::Mutex;

use chrono::{LocalResult, NaiveDateTime, TimeZone};
use tauri::{AppHandle, Manager};
use win_buddy_core::events::{BubbleShow, HitBox, StateChanged};
use win_buddy_core::{DndLevel, Store};

pub struct AppState {
    pub store: Mutex<Store>,
    /// Livello rilevato da `SHQueryUserNotificationState` (§ 10.4).
    pub auto_dnd: Mutex<DndLevel>,
    /// Ultimo battito del heartbeat: il divario rivela una sospensione.
    pub last_beat: AtomicI64,
    pub last_tick: AtomicI64,
    /// Scadenza per cui è già armato un timer mirato (§ 7.2).
    pub armed_due: Mutex<Option<i64>>,
    /// La bolla attualmente a schermo, per il replay a overlay ricreato.
    pub bubble: Mutex<Option<BubbleShow>>,
    /// L'ultimo `state:changed` emesso, idem.
    pub last_state: Mutex<Option<StateChanged>>,
    /// Fine della finestra di festeggiamento dopo un focus chiuso.
    pub celebrating_until: AtomicI64,
    /// Ultima interazione dell'utente: decide sleep e spegnimento overlay.
    pub last_interaction: AtomicI64,
    /// Rettangolo occupato da creatura+nuvoletta, normalizzato (§ 10.2).
    pub hitbox: Mutex<Option<HitBox>>,
    /// L'overlay sta accettando i clic (il flag va toccato solo ai cambi).
    pub overlay_interactive: AtomicBool,
    /// Generazione effimera del drag: reset e nuovi drag invalidano in modo
    /// atomico ogni salvataggio tardivo senza sporcare le impostazioni.
    pub overlay_drag_generation: AtomicU64,
}

impl AppState {
    pub fn new(app: &AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let dir: PathBuf = app.path().app_data_dir()?;
        std::fs::create_dir_all(&dir)?;
        let store = Store::open(&dir.join("buddy.db"))?;
        let now = now_ms();
        Ok(AppState {
            store: Mutex::new(store),
            auto_dnd: Mutex::new(DndLevel::Normal),
            last_beat: AtomicI64::new(now),
            last_tick: AtomicI64::new(0),
            armed_due: Mutex::new(None),
            bubble: Mutex::new(None),
            last_state: Mutex::new(None),
            celebrating_until: AtomicI64::new(0),
            last_interaction: AtomicI64::new(now),
            hitbox: Mutex::new(None),
            overlay_interactive: AtomicBool::new(false),
            overlay_drag_generation: AtomicU64::new(0),
        })
    }
}

// ------------------------------------------------------------------ tempo

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn local_naive_now() -> NaiveDateTime {
    chrono::Local::now().naive_local()
}

/// Mezzanotte locale di oggi in epoch ms: il conteggio pomodoro è per
/// giornata civile (§ 8.1).
pub fn day_start_ms() -> i64 {
    let midnight = chrono::Local::now()
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .expect("mezzanotte valida");
    local_to_epoch_ms(midnight)
}

/// Orologio a muro → epoch ms UTC. Nelle ambiguità da ora legale vince la
/// prima occorrenza; in un buco orario si scivola avanti di un'ora.
pub fn local_to_epoch_ms(dt: NaiveDateTime) -> i64 {
    match chrono::Local.from_local_datetime(&dt) {
        LocalResult::Single(t) => t.timestamp_millis(),
        LocalResult::Ambiguous(t, _) => t.timestamp_millis(),
        LocalResult::None => chrono::Local
            .from_local_datetime(&(dt + chrono::Duration::hours(1)))
            .earliest()
            .map(|t| t.timestamp_millis())
            .unwrap_or_else(|| dt.and_utc().timestamp_millis()),
    }
}

pub fn epoch_ms_to_local(ms: i64) -> NaiveDateTime {
    chrono::Local
        .timestamp_millis_opt(ms)
        .earliest()
        .map(|t| t.naive_local())
        .unwrap_or_default()
}
