//! Tipi del modello dati (§ 6 della specifica).

use crate::{CoreError, Result};
use serde::{Deserialize, Serialize};

/// Stati di una nota (§ 6.2).
///
/// ```text
/// pending ──(scadenza)──▶ fired ──(fatto)──▶ done
///    ▲                      │
///    └──────(rinvia)────────┘
///                           └──(ignora)──▶ dismissed
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoteState {
    Pending,
    Fired,
    Done,
    Dismissed,
}

impl NoteState {
    pub fn as_str(&self) -> &'static str {
        match self {
            NoteState::Pending => "pending",
            NoteState::Fired => "fired",
            NoteState::Done => "done",
            NoteState::Dismissed => "dismissed",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "pending" => Some(NoteState::Pending),
            "fired" => Some(NoteState::Fired),
            "done" => Some(NoteState::Done),
            "dismissed" => Some(NoteState::Dismissed),
            _ => None,
        }
    }

    /// Le note aperte compaiono nella lista; quelle chiuse nell'archivio.
    pub fn is_open(&self) -> bool {
        matches!(self, NoteState::Pending | NoteState::Fired)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Note {
    pub id: i64,
    pub body: String,
    pub created_at: i64,
    /// `None` = appunto senza promemoria: resta pending per sempre e non notifica mai.
    pub due_at: Option<i64>,
    pub urgent: bool,
    pub state: NoteState,
    pub fired_at: Option<i64>,
    pub snooze_count: i64,
    pub completed_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionKind {
    Focus,
    ShortBreak,
    LongBreak,
}

impl SessionKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            SessionKind::Focus => "focus",
            SessionKind::ShortBreak => "short_break",
            SessionKind::LongBreak => "long_break",
        }
    }

    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "focus" => Ok(SessionKind::Focus),
            "short_break" => Ok(SessionKind::ShortBreak),
            "long_break" => Ok(SessionKind::LongBreak),
            value => Err(CoreError::InvalidState(format!(
                "tipo sessione sconosciuto: {value}"
            ))),
        }
    }

    pub fn is_break(&self) -> bool {
        matches!(self, SessionKind::ShortBreak | SessionKind::LongBreak)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionPhase {
    Running,
    Paused,
    ReadyToClose,
    Overtime,
    Closed,
}

impl SessionPhase {
    pub fn as_str(&self) -> &'static str {
        match self {
            SessionPhase::Running => "running",
            SessionPhase::Paused => "paused",
            SessionPhase::ReadyToClose => "ready_to_close",
            SessionPhase::Overtime => "overtime",
            SessionPhase::Closed => "closed",
        }
    }

    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "running" => Ok(SessionPhase::Running),
            "paused" => Ok(SessionPhase::Paused),
            "ready_to_close" => Ok(SessionPhase::ReadyToClose),
            "overtime" => Ok(SessionPhase::Overtime),
            "closed" => Ok(SessionPhase::Closed),
            value => Err(CoreError::InvalidState(format!(
                "fase sessione sconosciuta: {value}"
            ))),
        }
    }
}

/// Esito di una sessione. Le sessioni invalidate restano a database ma non
/// contano nelle statistiche.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionOutcome {
    Completed,
    Partial,
    Interrupted,
    Invalidated,
}

impl SessionOutcome {
    /// Alias sorgente temporaneo per i chiamanti legacy. Lo storage v2 usa
    /// sempre `interrupted`.
    #[allow(non_upper_case_globals)]
    pub const Aborted: Self = Self::Interrupted;

    pub fn as_str(&self) -> &'static str {
        match self {
            SessionOutcome::Completed => "completed",
            SessionOutcome::Partial => "partial",
            SessionOutcome::Interrupted => "interrupted",
            SessionOutcome::Invalidated => "invalidated",
        }
    }

    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "completed" => Ok(SessionOutcome::Completed),
            "partial" => Ok(SessionOutcome::Partial),
            "interrupted" => Ok(SessionOutcome::Interrupted),
            "invalidated" => Ok(SessionOutcome::Invalidated),
            value => Err(CoreError::InvalidState(format!(
                "esito sessione sconosciuto: {value}"
            ))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PomodoroPreset {
    pub id: i64,
    pub name: String,
    pub focus_ms: i64,
    pub short_break_ms: i64,
    pub long_break_ms: i64,
    pub long_every: i64,
    pub auto_start_break: bool,
    pub auto_start_focus: bool,
    pub is_default: bool,
    pub sort_order: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartSession {
    pub kind: SessionKind,
    pub preset_id: Option<i64>,
    pub intention: String,
    pub category: Option<String>,
    pub planned_duration_ms: i64,
    pub estimated_ms: Option<i64>,
    pub next_step: Option<String>,
}

impl StartSession {
    pub fn focus(preset_id: i64, intention: &str, planned_duration_ms: i64) -> Self {
        Self {
            kind: SessionKind::Focus,
            preset_id: Some(preset_id),
            intention: intention.to_owned(),
            category: None,
            planned_duration_ms,
            estimated_ms: None,
            next_step: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PomodoroSession {
    pub id: i64,
    pub kind: SessionKind,
    pub preset_id: Option<i64>,
    pub phase: SessionPhase,
    pub started_at: i64,
    pub deadline_at: i64,
    pub paused_remaining_ms: Option<i64>,
    pub overtime_started_at: Option<i64>,
    pub intention: String,
    pub category: Option<String>,
    pub planned_duration_ms: i64,
    pub estimated_ms: Option<i64>,
    pub next_step: Option<String>,
    pub outcome: Option<SessionOutcome>,
    pub interruption_reason: Option<String>,
    pub resolved_at: Option<i64>,
    pub edited_at: Option<i64>,
    pub transition_revision: i64,
    /// Campo compatibile con i chiamanti legacy; equivale a `deadline_at`.
    #[serde(default)]
    pub ends_at: i64,
    /// Campo compatibile con i chiamanti legacy; deriva da `intention`.
    pub label: Option<String>,
}

/// Nome stabile usato dai DTO della shell per una fotografia della sessione.
pub type SessionSnapshot = PomodoroSession;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PresentationEvent {
    pub id: i64,
    pub session_id: i64,
    pub kind: String,
    pub transition_revision: i64,
    pub created_at: i64,
    pub acknowledged_at: Option<i64>,
}
