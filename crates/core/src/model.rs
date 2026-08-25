//! Tipi del modello dati (§ 6 della specifica).

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

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "focus" => Some(SessionKind::Focus),
            "short_break" => Some(SessionKind::ShortBreak),
            "long_break" => Some(SessionKind::LongBreak),
            _ => None,
        }
    }

    pub fn is_break(&self) -> bool {
        matches!(self, SessionKind::ShortBreak | SessionKind::LongBreak)
    }
}

/// Esito di una sessione (§ 6.3). Le sessioni invalidate restano a database
/// ma non contano nelle statistiche.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionOutcome {
    Completed,
    Aborted,
    Invalidated,
}

impl SessionOutcome {
    pub fn as_str(&self) -> &'static str {
        match self {
            SessionOutcome::Completed => "completed",
            SessionOutcome::Aborted => "aborted",
            SessionOutcome::Invalidated => "invalidated",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "completed" => Some(SessionOutcome::Completed),
            "aborted" => Some(SessionOutcome::Aborted),
            "invalidated" => Some(SessionOutcome::Invalidated),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PomodoroSession {
    pub id: i64,
    pub kind: SessionKind,
    pub started_at: i64,
    pub ends_at: i64,
    pub outcome: Option<SessionOutcome>,
    pub resolved_at: Option<i64>,
    pub label: Option<String>,
}
