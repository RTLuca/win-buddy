//! Eventi tra core e renderer (§ 12). Il core emette, il renderer ascolta.
//! Nessun flusso inverso a parte le azioni dell'utente (che viaggiano come
//! comandi Tauri, non come eventi).

use serde::{Deserialize, Serialize};

pub const EVT_STATE_CHANGED: &str = "state:changed";
pub const EVT_BUBBLE_SHOW: &str = "bubble:show";
pub const EVT_BUBBLE_DISMISS: &str = "bubble:dismiss";
pub const EVT_BUDDY_CHANGED: &str = "buddy:changed";
pub const EVT_MODE_CHANGED: &str = "mode:changed";
pub const EVT_NOTES_CHANGED: &str = "notes:changed";
pub const EVT_FOCUS_CHANGED: &str = "focus:changed";

/// Gli stati che il core può chiedere. Il renderer non ne inventa altri.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BuddyState {
    Idle,
    Focus,
    Break,
    Alert,
    Celebrate,
    Sleep,
}

/// Fase di una sessione ancora aperta. `closed` non attraversa mai il
/// contratto del buddy: quando una sessione chiude, il campo viene omesso.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActiveSessionPhase {
    Running,
    Paused,
    ReadyToClose,
    Overtime,
}

/// `state:changed` — core → overlay.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateChanged {
    pub state: BuddyState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<ActiveSessionPhase>,
    /// Scadenza assoluta (epoch ms) del countdown mostrato, se c'è.
    /// Il renderer ricalcola `until − now` a ogni frame: nessun contatore.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub until: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overtime_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BubbleKind {
    /// Un promemoria con le azioni Fatto / Rinvia.
    Reminder,
    /// Un'informazione senza azioni (fine pausa, sessione chiusa).
    Info,
    /// Riepilogo numerico che rimanda al pannello (più di dieci in pila).
    Summary,
    /// Proposta di pausa a fine focus: accetta o salta.
    BreakPrompt,
}

/// `bubble:show` — core → overlay.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BubbleShow {
    /// Id della nota per le Reminder; 0 per le bolle informative.
    pub id: i64,
    pub text: String,
    pub kind: BubbleKind,
    pub urgent: bool,
    /// Posizione nella pila («2 di 5»), se la bolla fa parte di una.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<(usize, usize)>,
}

/// `bubble:dismiss` — core → overlay.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BubbleDismiss {
    pub id: i64,
}

/// `buddy:changed` — core → overlay.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuddyChanged {
    pub creature_id: String,
}

/// `mode:changed` — core → overlay (full ⇄ sober).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModeChanged {
    pub mode: String,
}

/// Rettangolo di hit-test comunicato dal renderer al core a ogni cambio di
/// posa (§ 10.2): coordinate normalizzate 0..1 rispetto alla finestra.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct HitBox {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payloads_serialize_as_documented() {
        let s = serde_json::to_value(StateChanged {
            state: BuddyState::Focus,
            phase: Some(ActiveSessionPhase::Running),
            until: Some(123),
            remaining_ms: Some(123),
            overtime_ms: None,
            label: None,
        })
        .unwrap();
        assert_eq!(s["state"], "focus");
        assert_eq!(s["phase"], "running");
        assert_eq!(s["until"], 123);
        assert_eq!(s["remaining_ms"], 123);
        assert!(s.get("label").is_none());

        let b = serde_json::to_value(BubbleShow {
            id: 7,
            text: "Chiamare Fabio".into(),
            kind: BubbleKind::Reminder,
            urgent: true,
            position: Some((1, 3)),
        })
        .unwrap();
        assert_eq!(b["kind"], "reminder");
        assert_eq!(b["position"][0], 1);
    }

    #[test]
    fn focus_state_serializes_typed_phase_and_server_clock_values() {
        let state = StateChanged {
            state: BuddyState::Focus,
            phase: Some(ActiveSessionPhase::Overtime),
            until: None,
            remaining_ms: None,
            overtime_ms: Some(70_000),
            label: Some("Spec".into()),
        };

        assert_eq!(
            serde_json::to_value(state).unwrap(),
            serde_json::json!({
                "state": "focus",
                "phase": "overtime",
                "overtime_ms": 70_000,
                "label": "Spec"
            })
        );
    }
}
