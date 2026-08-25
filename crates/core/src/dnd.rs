//! Livelli di Do-Not-Disturb (§ 10.3, § 10.4).
//!
//! | Livello   | Overlay   | Toast | Scheduler | Promemoria scaduti |
//! |-----------|-----------|-------|-----------|--------------------|
//! | Normale   | visibile  | ripiego | attivo  | notificati subito  |
//! | Discreto  | sobrio    | sì    | attivo    | notificati subito  |
//! | Nascosto  | distrutto | no    | **attivo**| **accodati**       |
//!
//! In DND lo scheduler non si ferma mai: continua a marcare le note come
//! `fired` e le accumula. Fermarlo significherebbe perdere promemoria.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DndLevel {
    /// Tutto visibile.
    Normal,
    /// Modalità sobria: pillola al posto della creatura, toast attivi.
    Discreet,
    /// Overlay distrutto, niente toast, promemoria accodati.
    Hidden,
}

/// Cosa può esistere a schermo con un certo livello.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SurfacePolicy {
    /// La finestra overlay può esistere.
    pub overlay_alive: bool,
    /// Se esiste, va mostrata in modalità sobria invece che con la creatura.
    pub force_sober: bool,
    /// I toast nativi sono ammessi.
    pub toast_allowed: bool,
    /// I promemoria scaduti si notificano subito (altrimenti si accodano).
    pub notify_immediately: bool,
}

impl DndLevel {
    pub fn policy(self) -> SurfacePolicy {
        match self {
            DndLevel::Normal => SurfacePolicy {
                overlay_alive: true,
                force_sober: false,
                toast_allowed: true,
                notify_immediately: true,
            },
            DndLevel::Discreet => SurfacePolicy {
                overlay_alive: true,
                force_sober: true,
                toast_allowed: true,
                notify_immediately: true,
            },
            DndLevel::Hidden => SurfacePolicy {
                overlay_alive: false,
                force_sober: false,
                toast_allowed: false,
                notify_immediately: false,
            },
        }
    }

    /// Tra manuale e automatico vince il più severo: l'interruttore nel tray
    /// non può essere scavalcato da un'euristica, e viceversa una
    /// presentazione rilevata non si spegne togliendo il DND manuale.
    pub fn strictest(a: DndLevel, b: DndLevel) -> DndLevel {
        a.max(b)
    }

    /// Mappa lo stato di `SHQueryUserNotificationState()` (§ 10.4).
    /// I valori sono quelli dell'enum `QUERY_USER_NOTIFICATION_STATE`.
    pub fn from_quns(v: i32) -> DndLevel {
        match v {
            // QUNS_BUSY = 2 · QUNS_RUNNING_D3D_FULL_SCREEN = 3 (gioco o app a
            // schermo intero) · QUNS_PRESENTATION_MODE = 4
            2..=4 => DndLevel::Hidden,
            // QUNS_QUIET_TIME = 6
            6 => DndLevel::Discreet,
            // QUNS_NOT_PRESENT = 1 (sessione bloccata): l'overlay non serve
            // a nessuno, i toast li gestisce Windows all'sblocco
            1 => DndLevel::Hidden,
            // QUNS_ACCEPTS_NOTIFICATIONS = 5 e qualunque valore ignoto:
            // meglio un buddy di troppo che un promemoria accodato per errore
            _ => DndLevel::Normal,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            DndLevel::Normal => "normal",
            DndLevel::Discreet => "discreet",
            DndLevel::Hidden => "hidden",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policies_match_the_spec_table() {
        let n = DndLevel::Normal.policy();
        assert!(n.overlay_alive && !n.force_sober && n.toast_allowed && n.notify_immediately);

        let d = DndLevel::Discreet.policy();
        assert!(d.overlay_alive && d.force_sober && d.toast_allowed && d.notify_immediately);

        let h = DndLevel::Hidden.policy();
        assert!(!h.overlay_alive && !h.toast_allowed && !h.notify_immediately);
    }

    #[test]
    fn strictest_wins() {
        use DndLevel::*;
        assert_eq!(DndLevel::strictest(Normal, Hidden), Hidden);
        assert_eq!(DndLevel::strictest(Discreet, Normal), Discreet);
        assert_eq!(DndLevel::strictest(Normal, Normal), Normal);
    }

    #[test]
    fn quns_mapping() {
        assert_eq!(DndLevel::from_quns(2), DndLevel::Hidden); // busy
        assert_eq!(DndLevel::from_quns(3), DndLevel::Hidden); // d3d fullscreen
        assert_eq!(DndLevel::from_quns(4), DndLevel::Hidden); // presentazione
        assert_eq!(DndLevel::from_quns(6), DndLevel::Discreet); // quiet time
        assert_eq!(DndLevel::from_quns(5), DndLevel::Normal); // accetta notifiche
        assert_eq!(DndLevel::from_quns(1), DndLevel::Hidden); // sessione bloccata
        assert_eq!(DndLevel::from_quns(99), DndLevel::Normal); // ignoto
    }
}
