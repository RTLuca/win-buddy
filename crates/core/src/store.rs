//! Store SQLite (§ 6). Un'unica connessione, WAL, foreign keys.
//!
//! Principi (§ 6.1): nessun contatore incrementale, lo snooze non crea record,
//! niente cancellazioni — le note chiuse cambiano stato, non spariscono.

use crate::model::{
    Note, NoteState, PomodoroPreset, PomodoroSession, PresentationEvent, SessionKind,
    SessionOutcome, SessionPhase, StartSession,
};
use crate::{CoreError, Result};
use rusqlite::{params, Connection, OptionalExtension, Row};
use std::path::Path;

const SCHEMA: &str = include_str!("../sql/schema.sql");

pub struct Store {
    conn: Connection,
}

pub(crate) struct SessionAdjustment {
    pub phase: SessionPhase,
    pub deadline_at: i64,
    pub paused_remaining_ms: Option<i64>,
    pub adjusted_at: i64,
    pub close_open_pause: bool,
}

fn note_from_row(row: &Row) -> rusqlite::Result<Note> {
    let state: String = row.get("state")?;
    Ok(Note {
        id: row.get("id")?,
        body: row.get("body")?,
        created_at: row.get("created_at")?,
        due_at: row.get("due_at")?,
        urgent: row.get::<_, i64>("urgent")? != 0,
        state: NoteState::parse(&state).unwrap_or(NoteState::Pending),
        fired_at: row.get("fired_at")?,
        snooze_count: row.get("snooze_count")?,
        completed_at: row.get("completed_at")?,
    })
}

struct SessionRow {
    id: i64,
    kind: String,
    preset_id: Option<i64>,
    phase: String,
    started_at: i64,
    deadline_at: i64,
    paused_remaining_ms: Option<i64>,
    overtime_started_at: Option<i64>,
    intention: String,
    category: Option<String>,
    planned_duration_ms: i64,
    estimated_ms: Option<i64>,
    next_step: Option<String>,
    outcome: Option<String>,
    interruption_reason: Option<String>,
    resolved_at: Option<i64>,
    edited_at: Option<i64>,
    transition_revision: i64,
}

fn session_row(row: &Row) -> rusqlite::Result<SessionRow> {
    Ok(SessionRow {
        id: row.get("id")?,
        kind: row.get("kind")?,
        preset_id: row.get("preset_id")?,
        phase: row.get("phase")?,
        started_at: row.get("started_at")?,
        deadline_at: row.get("deadline_at")?,
        paused_remaining_ms: row.get("paused_remaining_ms")?,
        overtime_started_at: row.get("overtime_started_at")?,
        intention: row.get("intention")?,
        category: row.get("category")?,
        planned_duration_ms: row.get("planned_duration_ms")?,
        estimated_ms: row.get("estimated_ms")?,
        next_step: row.get("next_step")?,
        outcome: row.get("outcome")?,
        interruption_reason: row.get("interruption_reason")?,
        resolved_at: row.get("resolved_at")?,
        edited_at: row.get("edited_at")?,
        transition_revision: row.get("transition_revision")?,
    })
}

fn decode_session(row: SessionRow) -> Result<PomodoroSession> {
    let kind = SessionKind::parse(&row.kind)?;
    let phase = SessionPhase::parse(&row.phase)?;
    let outcome = row
        .outcome
        .as_deref()
        .map(SessionOutcome::parse)
        .transpose()?;
    let label = (!row.intention.is_empty()).then(|| row.intention.clone());
    Ok(PomodoroSession {
        id: row.id,
        kind,
        preset_id: row.preset_id,
        phase,
        started_at: row.started_at,
        deadline_at: row.deadline_at,
        paused_remaining_ms: row.paused_remaining_ms,
        overtime_started_at: row.overtime_started_at,
        intention: row.intention,
        category: row.category,
        planned_duration_ms: row.planned_duration_ms,
        estimated_ms: row.estimated_ms,
        next_step: row.next_step,
        outcome,
        interruption_reason: row.interruption_reason,
        resolved_at: row.resolved_at,
        edited_at: row.edited_at,
        transition_revision: row.transition_revision,
        ends_at: row.deadline_at,
        label,
    })
}

fn preset_from_row(row: &Row) -> rusqlite::Result<PomodoroPreset> {
    Ok(PomodoroPreset {
        id: row.get("id")?,
        name: row.get("name")?,
        focus_ms: row.get("focus_ms")?,
        short_break_ms: row.get("short_break_ms")?,
        long_break_ms: row.get("long_break_ms")?,
        long_every: row.get("long_every")?,
        auto_start_break: row.get::<_, i64>("auto_start_break")? != 0,
        auto_start_focus: row.get::<_, i64>("auto_start_focus")? != 0,
        is_default: row.get::<_, i64>("is_default")? != 0,
        sort_order: row.get("sort_order")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn presentation_event_from_row(row: &Row) -> rusqlite::Result<PresentationEvent> {
    Ok(PresentationEvent {
        id: row.get("id")?,
        session_id: row.get("session_id")?,
        kind: row.get("kind")?,
        transition_revision: row.get("transition_revision")?,
        created_at: row.get("created_at")?,
        acknowledged_at: row.get("acknowledged_at")?,
    })
}

#[allow(dead_code)] // Primitive revisionale consumata dalla macchina a stati del core.
fn session_already_updated() -> CoreError {
    CoreError::InvalidState("sessione già aggiornata".into())
}

fn invalid_session_write(error: rusqlite::Error) -> CoreError {
    match error {
        rusqlite::Error::SqliteFailure(ref sqlite, _)
            if sqlite.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            CoreError::InvalidState("sessione non valida o già aperta".into())
        }
        other => CoreError::Db(other),
    }
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        Self::init(conn)
    }

    fn init(mut conn: Connection) -> Result<Self> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        crate::migrations::apply(&mut conn)?;
        conn.execute_batch(SCHEMA)?;
        Ok(Store { conn })
    }

    // ------------------------------------------------------------- note

    pub fn insert_note(
        &self,
        body: &str,
        due_at: Option<i64>,
        urgent: bool,
        now: i64,
    ) -> Result<Note> {
        self.conn.execute(
            "INSERT INTO notes(body, created_at, due_at, urgent) VALUES (?1, ?2, ?3, ?4)",
            params![body, now, due_at, urgent as i64],
        )?;
        let id = self.conn.last_insert_rowid();
        Ok(self.get_note(id)?.expect("nota appena inserita"))
    }

    pub fn get_note(&self, id: i64) -> Result<Option<Note>> {
        Ok(self
            .conn
            .query_row("SELECT * FROM notes WHERE id = ?1", [id], note_from_row)
            .optional()?)
    }

    /// Note aperte (pending + fired): con scadenza prima, per scadenza; poi
    /// gli appunti senza scadenza, per data di creazione.
    pub fn open_notes(&self) -> Result<Vec<Note>> {
        let mut stmt = self.conn.prepare(
            "SELECT * FROM notes WHERE state IN ('pending','fired')
             ORDER BY due_at IS NULL, due_at ASC, created_at DESC",
        )?;
        let rows = stmt.query_map([], note_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// La query del tick (§ 7.1): promemoria pending già scaduti.
    pub fn due_notes(&self, now: i64) -> Result<Vec<Note>> {
        let mut stmt = self.conn.prepare(
            "SELECT * FROM notes
             WHERE state = 'pending' AND due_at IS NOT NULL AND due_at <= ?1
             ORDER BY due_at ASC",
        )?;
        let rows = stmt.query_map([now], note_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Prossima scadenza futura, per decidere se armare il timer mirato (§ 7.2).
    pub fn next_due(&self, now: i64) -> Result<Option<i64>> {
        Ok(self.conn.query_row(
            "SELECT MIN(due_at) FROM notes
             WHERE state = 'pending' AND due_at IS NOT NULL AND due_at > ?1",
            [now],
            |r| r.get::<_, Option<i64>>(0),
        )?)
    }

    /// Note già scattate e non ancora smaltite: è la pila che si presenta
    /// all'uscita dal DND o all'inizio di una pausa (§ 7.3, § 8.4).
    pub fn fired_notes(&self) -> Result<Vec<Note>> {
        let mut stmt = self.conn.prepare(
            "SELECT * FROM notes WHERE state = 'fired' ORDER BY due_at ASC",
        )?;
        let rows = stmt.query_map([], note_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn mark_fired(&self, id: i64, now: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE notes SET state = 'fired', fired_at = ?2
             WHERE id = ?1 AND state = 'pending'",
            params![id, now],
        )?;
        Ok(())
    }

    pub fn complete_note(&self, id: i64, now: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE notes SET state = 'done', completed_at = ?2
             WHERE id = ?1 AND state IN ('pending','fired')",
            params![id, now],
        )?;
        Ok(())
    }

    pub fn dismiss_note(&self, id: i64, now: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE notes SET state = 'dismissed', completed_at = ?2
             WHERE id = ?1 AND state IN ('pending','fired')",
            params![id, now],
        )?;
        Ok(())
    }

    /// Lo snooze non crea record (§ 6.1): aggiorna `due_at` e riporta a pending,
    /// così il recupero tratta rinvii e promemoria mai scattati con lo stesso codice.
    pub fn snooze_note(&self, id: i64, new_due: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE notes
             SET due_at = ?2, state = 'pending', snooze_count = snooze_count + 1
             WHERE id = ?1 AND state IN ('pending','fired')",
            params![id, new_due],
        )?;
        Ok(())
    }

    /// Archivio: note chiuse, le più recenti prima.
    pub fn archive(&self, limit: i64) -> Result<Vec<Note>> {
        let mut stmt = self.conn.prepare(
            "SELECT * FROM notes WHERE state IN ('done','dismissed')
             ORDER BY completed_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit], note_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Ricerca full-text sull'intero corpus (aperte e archivio).
    pub fn search_notes(&self, query: &str, limit: i64) -> Result<Vec<Note>> {
        let q = fts_query(query);
        if q.is_empty() {
            return Ok(vec![]);
        }
        let mut stmt = self.conn.prepare(
            "SELECT n.* FROM notes_fts f JOIN notes n ON n.id = f.rowid
             WHERE notes_fts MATCH ?1 ORDER BY rank LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![q, limit], note_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn counts(&self) -> Result<(i64, i64)> {
        let open = self.conn.query_row(
            "SELECT COUNT(*) FROM notes WHERE state IN ('pending','fired')",
            [],
            |r| r.get(0),
        )?;
        let archived = self.conn.query_row(
            "SELECT COUNT(*) FROM notes WHERE state IN ('done','dismissed')",
            [],
            |r| r.get(0),
        )?;
        Ok((open, archived))
    }

    // --------------------------------------------------------- pomodoro

    pub fn default_preset(&self) -> Result<PomodoroPreset> {
        self.conn
            .query_row(
                "SELECT * FROM pomodoro_presets
                 WHERE is_default = 1 ORDER BY sort_order,id LIMIT 1",
                [],
                preset_from_row,
            )
            .optional()?
            .ok_or_else(|| CoreError::InvalidState("preset predefinito non trovato".into()))
    }

    pub fn list_presets(&self) -> Result<Vec<PomodoroPreset>> {
        let mut statement = self
            .conn
            .prepare("SELECT * FROM pomodoro_presets ORDER BY sort_order,id")?;
        let rows = statement.query_map([], preset_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn start_focus(&self, request: StartSession, started_at: i64) -> Result<PomodoroSession> {
        let deadline_at = started_at
            .checked_add(request.planned_duration_ms)
            .ok_or_else(|| CoreError::InvalidState("durata sessione non valida".into()))?;
        let transaction = self.conn.unchecked_transaction()?;
        transaction
            .execute(
                "INSERT INTO pomodoro_sessions(
                   kind,preset_id,phase,started_at,deadline_at,intention,category,
                   planned_duration_ms,estimated_ms,next_step
                 ) VALUES (?1,?2,'running',?3,?4,?5,?6,?7,?8,?9)",
                params![
                    request.kind.as_str(),
                    request.preset_id,
                    started_at,
                    deadline_at,
                    request.intention,
                    request.category,
                    request.planned_duration_ms,
                    request.estimated_ms,
                    request.next_step,
                ],
            )
            .map_err(invalid_session_write)?;
        let id = transaction.last_insert_rowid();
        transaction.commit()?;
        self.get_session(id)?
            .ok_or_else(|| CoreError::InvalidState("sessione appena creata non trovata".into()))
    }

    /// Bridge compatibile con l'API pomodoro v1. I nuovi chiamanti usano
    /// `start_focus` con un `StartSession` completo.
    pub fn start_session(
        &self,
        kind: SessionKind,
        started_at: i64,
        ends_at: i64,
        label: Option<&str>,
    ) -> Result<PomodoroSession> {
        self.start_focus(
            StartSession {
                kind,
                preset_id: None,
                intention: label.unwrap_or_default().to_owned(),
                category: None,
                planned_duration_ms: ends_at - started_at,
                estimated_ms: None,
                next_step: None,
            },
            started_at,
        )
    }

    pub fn get_session(&self, id: i64) -> Result<Option<PomodoroSession>> {
        let row = self
            .conn
            .query_row(
                "SELECT * FROM pomodoro_sessions WHERE id = ?1",
                [id],
                session_row,
            )
            .optional()?;
        row.map(decode_session).transpose()
    }

    pub fn open_session(&self) -> Result<Option<PomodoroSession>> {
        let row = self
            .conn
            .query_row(
                "SELECT * FROM pomodoro_sessions
                 WHERE phase <> 'closed' ORDER BY started_at,id LIMIT 1",
                [],
                session_row,
            )
            .optional()?;
        row.map(decode_session).transpose()
    }

    /// Sessioni senza esito, da risolvere all'avvio o alla ripresa (§ 8.3).
    pub fn open_sessions(&self) -> Result<Vec<PomodoroSession>> {
        let mut stmt = self.conn.prepare(
            "SELECT * FROM pomodoro_sessions
             WHERE phase <> 'closed' ORDER BY started_at,id",
        )?;
        let rows = stmt
            .query_map([], session_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter().map(decode_session).collect()
    }

    /// Transizione atomica `Running -> Paused`: apre l'intervallo tecnico e
    /// incrementa la revisione una sola volta.
    pub(crate) fn pause_session(
        &self,
        id: i64,
        expected_revision: i64,
        paused_at: i64,
        reason: Option<&str>,
    ) -> Result<PomodoroSession> {
        let transaction = self.conn.unchecked_transaction()?;
        let changed = transaction.execute(
            "UPDATE pomodoro_sessions
             SET phase = 'paused',
                 paused_remaining_ms = MAX(deadline_at - ?3, 0),
                 transition_revision = transition_revision + 1
             WHERE id = ?1 AND transition_revision = ?2
               AND kind = 'focus' AND phase = 'running' AND outcome IS NULL",
            params![id, expected_revision, paused_at],
        )?;
        if changed != 1 {
            return Err(session_already_updated());
        }
        transaction
            .execute(
                "INSERT INTO pomodoro_pause_intervals(session_id,started_at,reason)
                 VALUES (?1,?2,?3)",
                params![id, paused_at, reason],
            )
            .map_err(invalid_session_write)?;
        transaction.commit()?;
        self.get_session(id)?
            .ok_or_else(|| CoreError::InvalidState("sessione aggiornata non trovata".into()))
    }

    /// Transizione atomica `Paused -> Running`: chiude l'intervallo tecnico,
    /// ripristina la deadline dal residuo congelato e revisiona una volta.
    pub(crate) fn resume_session(
        &self,
        id: i64,
        expected_revision: i64,
        resumed_at: i64,
        deadline_at: i64,
    ) -> Result<PomodoroSession> {
        let transaction = self.conn.unchecked_transaction()?;
        let changed = transaction.execute(
            "UPDATE pomodoro_sessions
             SET phase = 'running', deadline_at = ?3,
                 paused_remaining_ms = NULL,
                 transition_revision = transition_revision + 1
             WHERE id = ?1 AND transition_revision = ?2
               AND kind = 'focus' AND phase = 'paused' AND outcome IS NULL",
            params![id, expected_revision, deadline_at],
        )?;
        if changed != 1 {
            return Err(session_already_updated());
        }
        let pause_changed = transaction.execute(
            "UPDATE pomodoro_pause_intervals SET ended_at = ?2
             WHERE session_id = ?1 AND ended_at IS NULL AND started_at <= ?2",
            params![id, resumed_at],
        )?;
        if pause_changed != 1 {
            return Err(CoreError::InvalidState("pausa non aperta".into()));
        }
        transaction.commit()?;
        self.get_session(id)?
            .ok_or_else(|| CoreError::InvalidState("sessione aggiornata non trovata".into()))
    }

    /// Corregge durata e fase come una singola mutazione CAS. Quando una
    /// correzione porta una sessione in pausa a `ReadyToClose`, chiude anche
    /// l'intervallo aperto nello stesso transaction boundary.
    pub(crate) fn adjust_session(
        &self,
        id: i64,
        expected_revision: i64,
        adjustment: SessionAdjustment,
    ) -> Result<PomodoroSession> {
        let transaction = self.conn.unchecked_transaction()?;
        let changed = transaction.execute(
            "UPDATE pomodoro_sessions
             SET phase = ?3, deadline_at = ?4, paused_remaining_ms = ?5,
                 edited_at = ?6,
                 transition_revision = transition_revision + 1
             WHERE id = ?1 AND transition_revision = ?2 AND outcome IS NULL",
            params![
                id,
                expected_revision,
                adjustment.phase.as_str(),
                adjustment.deadline_at,
                adjustment.paused_remaining_ms,
                adjustment.adjusted_at,
            ],
        )?;
        if changed != 1 {
            return Err(session_already_updated());
        }
        if adjustment.close_open_pause {
            let pause_changed = transaction.execute(
                "UPDATE pomodoro_pause_intervals SET ended_at = ?2
                 WHERE session_id = ?1 AND ended_at IS NULL AND started_at <= ?2",
                params![id, adjustment.adjusted_at],
            )?;
            if pause_changed != 1 {
                return Err(CoreError::InvalidState("pausa non aperta".into()));
            }
        }
        transaction.commit()?;
        self.get_session(id)?
            .ok_or_else(|| CoreError::InvalidState("sessione aggiornata non trovata".into()))
    }

    #[allow(dead_code)] // Primitive interna; Task 3 la compone in una transazione di dominio.
    pub(crate) fn open_pause(
        &self,
        session_id: i64,
        started_at: i64,
        reason: Option<&str>,
    ) -> Result<()> {
        let changed = self
            .conn
            .execute(
                "INSERT INTO pomodoro_pause_intervals(session_id,started_at,reason)
                 SELECT id,?2,?3 FROM pomodoro_sessions
                 WHERE id = ?1 AND outcome IS NULL",
                params![session_id, started_at, reason],
            )
            .map_err(invalid_session_write)?;
        if changed != 1 {
            return Err(CoreError::InvalidState("sessione non aperta".into()));
        }
        Ok(())
    }

    #[allow(dead_code)] // Primitive interna; Task 3 la compone in una transazione di dominio.
    pub(crate) fn close_pause(&self, session_id: i64, ended_at: i64) -> Result<()> {
        let changed = self.conn.execute(
            "UPDATE pomodoro_pause_intervals SET ended_at = ?2
             WHERE session_id = ?1 AND ended_at IS NULL",
            params![session_id, ended_at],
        )?;
        if changed != 1 {
            return Err(CoreError::InvalidState("pausa non aperta".into()));
        }
        Ok(())
    }

    #[allow(dead_code)] // Primitive interna; non è parte dell'API pubblica del crate.
    pub(crate) fn set_phase(
        &self,
        id: i64,
        phase: SessionPhase,
        expected_revision: i64,
        at_ms: i64,
    ) -> Result<PomodoroSession> {
        let changed = self.conn.execute(
            "UPDATE pomodoro_sessions
             SET phase = ?2,
                 overtime_started_at = CASE
                   WHEN ?2 = 'overtime' THEN COALESCE(overtime_started_at, ?4)
                   ELSE overtime_started_at
                 END,
                 transition_revision = transition_revision + 1
             WHERE id = ?1 AND transition_revision = ?3 AND outcome IS NULL",
            params![id, phase.as_str(), expected_revision, at_ms],
        )?;
        if changed != 1 {
            return Err(session_already_updated());
        }
        self.get_session(id)?
            .ok_or_else(|| CoreError::InvalidState("sessione aggiornata non trovata".into()))
    }

    #[allow(dead_code)] // Primitive interna; non è parte dell'API pubblica del crate.
    pub(crate) fn finish_session(
        &self,
        id: i64,
        expected_revision: i64,
        outcome: SessionOutcome,
        interruption_reason: Option<&str>,
        resolved_at: i64,
    ) -> Result<PomodoroSession> {
        let transaction = self.conn.unchecked_transaction()?;
        transaction.execute(
            "UPDATE pomodoro_pause_intervals SET ended_at = MAX(started_at, ?2)
             WHERE session_id = ?1 AND ended_at IS NULL",
            params![id, resolved_at],
        )?;
        let changed = transaction.execute(
            "UPDATE pomodoro_sessions
             SET phase = ?2, outcome = ?4, interruption_reason = ?5,
                 resolved_at = MAX(started_at, ?6),
                 transition_revision = transition_revision + 1
             WHERE id = ?1 AND transition_revision = ?3 AND outcome IS NULL",
            params![
                id,
                SessionPhase::Closed.as_str(),
                expected_revision,
                outcome.as_str(),
                interruption_reason,
                resolved_at,
            ],
        )?;
        if changed != 1 {
            return Err(session_already_updated());
        }
        transaction.commit()?;
        self.get_session(id)?
            .ok_or_else(|| CoreError::InvalidState("sessione chiusa non trovata".into()))
    }

    pub fn effective_focus_ms(&self, id: i64, at_ms: i64) -> Result<i64> {
        self.conn
            .query_row(
                "SELECT MAX(MIN(COALESCE(s.resolved_at, ?2), ?2) - s.started_at, 0)
                        - COALESCE(SUM(
                            MAX(MIN(COALESCE(p.ended_at, ?2), ?2) - p.started_at, 0)
                          ), 0)
                 FROM pomodoro_sessions s
                 LEFT JOIN pomodoro_pause_intervals p ON p.session_id = s.id
                 WHERE s.id = ?1
                 GROUP BY s.id,s.started_at,s.resolved_at",
                params![id, at_ms],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| CoreError::InvalidState("sessione non trovata".into()))
    }

    pub fn pending_presentation_events(&self) -> Result<Vec<PresentationEvent>> {
        let mut statement = self.conn.prepare(
            "SELECT * FROM pomodoro_presentation_events
             WHERE acknowledged_at IS NULL ORDER BY created_at,id",
        )?;
        let rows = statement.query_map([], presentation_event_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn resolve_session(
        &self,
        id: i64,
        expected_revision: i64,
        outcome: SessionOutcome,
        now: i64,
    ) -> Result<()> {
        let changed = self.conn.execute(
            "UPDATE pomodoro_sessions
             SET outcome = ?3,
                 phase = 'closed', resolved_at = ?4,
                 transition_revision = transition_revision + 1
             WHERE id = ?1 AND transition_revision = ?2 AND outcome IS NULL",
            params![id, expected_revision, outcome.as_str(), now],
        )?;
        if changed != 1 {
            return Err(session_already_updated());
        }
        Ok(())
    }

    /// Sessioni di focus completate da un certo istante in poi. Il chiamante
    /// passa la mezzanotte locale: il conteggio è per giornata civile (§ 8.1).
    pub fn completed_focus_since(&self, since: i64) -> Result<i64> {
        Ok(self.conn.query_row(
            "SELECT COUNT(*) FROM pomodoro_sessions
             WHERE kind = 'focus' AND outcome = 'completed' AND started_at >= ?1",
            [since],
            |r| r.get(0),
        )?)
    }

    /// Storico per il pannello: le invalidate restano visibili — nascondere
    /// un'interruzione nasconderebbe un'informazione vera (§ 6.3).
    pub fn session_history(&self, limit: i64) -> Result<Vec<PomodoroSession>> {
        let mut stmt = self.conn.prepare(
            "SELECT * FROM pomodoro_sessions WHERE outcome IS NOT NULL
             ORDER BY started_at DESC LIMIT ?1",
        )?;
        let rows = stmt
            .query_map([limit], session_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter().map(decode_session).collect()
    }

    // --------------------------------------------------------- settings

    pub fn setting(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                [key],
                |r| r.get(0),
            )
            .optional()?)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO settings(key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    /// Aggiorna più impostazioni come un'unica unità. È usato per la
    /// posizione manuale, dove coordinate, monitor e modalità devono restare
    /// coerenti anche in caso di arresto tra due scritture.
    pub fn set_settings(&self, settings: &[(&str, &str)]) -> Result<()> {
        let transaction = self.conn.unchecked_transaction()?;
        for (key, value) in settings {
            transaction.execute(
                "INSERT INTO settings(key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn setting_i64(&self, key: &str, default: i64) -> i64 {
        self.setting(key)
            .ok()
            .flatten()
            .and_then(|v| v.parse().ok())
            .unwrap_or(default)
    }

    pub fn all_settings(&self) -> Result<Vec<(String, String)>> {
        let mut stmt = self
            .conn
            .prepare("SELECT key, value FROM settings ORDER BY key")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

/// L'input dell'utente non è sintassi FTS5: ogni termine diventa un prefisso
/// tra virgolette, così `commercial` trova `commercialista` e la punteggiatura
/// non fa esplodere il MATCH.
fn fts_query(raw: &str) -> String {
    raw.split_whitespace()
        .map(|t| t.replace('"', ""))
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{t}\"*"))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: i64 = 60_000;

    fn store() -> Store {
        Store::open_in_memory().unwrap()
    }

    #[test]
    fn effective_focus_excludes_pause_and_includes_overtime() {
        let s = store();
        let started = s
            .start_focus(StartSession::focus(1, "Spec", 25 * MIN), 0)
            .unwrap();
        s.open_pause(started.id, 5 * MIN, None).unwrap();
        s.close_pause(started.id, 10 * MIN).unwrap();
        s.set_phase(started.id, SessionPhase::Overtime, 0, 30 * MIN)
            .unwrap();

        assert_eq!(
            s.effective_focus_ms(started.id, 35 * MIN).unwrap(),
            30 * MIN
        );
    }

    #[test]
    fn only_one_open_session_is_allowed() {
        let s = store();
        s.start_focus(StartSession::focus(1, "A", 25 * MIN), 0)
            .unwrap();

        let err = s
            .start_focus(StartSession::focus(1, "B", 25 * MIN), MIN)
            .unwrap_err();

        assert!(matches!(err, CoreError::InvalidState(_)));
    }

    #[test]
    fn presets_are_loaded_in_stable_order_with_one_default() {
        let s = store();

        let presets = s.list_presets().unwrap();

        assert_eq!(presets.len(), 3);
        assert_eq!(presets[0].name, "Classico");
        assert_eq!(presets[0].focus_ms, 25 * MIN);
        assert_eq!(s.default_preset().unwrap().id, 1);
    }

    #[test]
    fn session_round_trip_preserves_domain_fields() {
        let s = store();
        let mut request = StartSession::focus(1, "Spec", 25 * MIN);
        request.category = Some("engineering".into());
        request.estimated_ms = Some(20 * MIN);
        request.next_step = Some("Review".into());

        let started = s.start_focus(request, 1_000).unwrap();
        let open = s.open_session().unwrap().unwrap();

        assert_eq!(open, started);
        assert_eq!(open.phase, SessionPhase::Running);
        assert_eq!(open.deadline_at, 1_000 + 25 * MIN);
        assert_eq!(open.category.as_deref(), Some("engineering"));
        assert_eq!(open.estimated_ms, Some(20 * MIN));
        assert_eq!(open.next_step.as_deref(), Some("Review"));
        assert_eq!(open.transition_revision, 0);
    }

    #[test]
    fn stale_revision_does_not_mutate_session() {
        let s = store();
        let started = s
            .start_focus(StartSession::focus(1, "Spec", 25 * MIN), 0)
            .unwrap();

        s.set_phase(started.id, SessionPhase::Overtime, 0, 25 * MIN)
            .unwrap();
        let err = s
            .set_phase(started.id, SessionPhase::Paused, 0, 26 * MIN)
            .unwrap_err();

        assert!(
            matches!(err, CoreError::InvalidState(ref message) if message == "sessione già aggiornata")
        );
        let current = s.get_session(started.id).unwrap().unwrap();
        assert_eq!(current.phase, SessionPhase::Overtime);
        assert_eq!(current.transition_revision, 1);
    }

    #[test]
    fn resolve_session_rejects_stale_revision_without_mutating() {
        let s = store();
        let started = s
            .start_focus(StartSession::focus(1, "Spec", 25 * MIN), 0)
            .unwrap();
        s.set_phase(started.id, SessionPhase::Overtime, 0, 25 * MIN)
            .unwrap();

        let err = s
            .resolve_session(started.id, 0, SessionOutcome::Completed, 30 * MIN)
            .unwrap_err();

        assert!(matches!(
            err,
            CoreError::InvalidState(ref message) if message == "sessione già aggiornata"
        ));
        let current = s.get_session(started.id).unwrap().unwrap();
        assert_eq!(current.phase, SessionPhase::Overtime);
        assert_eq!(current.outcome, None);
        assert_eq!(current.resolved_at, None);
        assert_eq!(current.transition_revision, 1);
    }

    #[test]
    fn finish_session_closes_and_caps_effective_time_at_resolution() {
        let s = store();
        let started = s
            .start_focus(StartSession::focus(1, "Spec", 25 * MIN), 0)
            .unwrap();
        s.open_pause(started.id, 5 * MIN, Some("coffee")).unwrap();
        s.close_pause(started.id, 8 * MIN).unwrap();

        let finished = s
            .finish_session(started.id, 0, SessionOutcome::Partial, None, 20 * MIN)
            .unwrap();

        assert_eq!(finished.phase, SessionPhase::Closed);
        assert_eq!(finished.outcome, Some(SessionOutcome::Partial));
        assert_eq!(finished.transition_revision, 1);
        assert_eq!(
            s.effective_focus_ms(started.id, 40 * MIN).unwrap(),
            17 * MIN
        );
        assert!(s.open_session().unwrap().is_none());
    }

    #[test]
    fn unknown_stored_session_enum_is_an_invalid_state() {
        let s = store();
        s.conn
            .pragma_update(None, "ignore_check_constraints", "ON")
            .unwrap();
        s.conn
            .execute(
                "INSERT INTO pomodoro_sessions(
                   kind,phase,started_at,deadline_at,intention,planned_duration_ms
                 ) VALUES ('mystery','running',0,1,'',1)",
                [],
            )
            .unwrap();

        let err = s.get_session(s.conn.last_insert_rowid()).unwrap_err();

        assert!(matches!(err, CoreError::InvalidState(_)));
    }

    #[test]
    fn pending_presentation_events_only_returns_unacknowledged_rows() {
        let s = store();
        let session = s
            .start_focus(StartSession::focus(1, "Spec", MIN), 0)
            .unwrap();
        s.conn
            .execute(
                "INSERT INTO pomodoro_presentation_events(
                   session_id,kind,transition_revision,created_at,acknowledged_at
                 ) VALUES (?1,'ready_to_close',0,?2,NULL),
                          (?1,'prewarning',0,?3,?4)",
                params![session.id, MIN, MIN / 2, MIN / 2],
            )
            .unwrap();

        let events = s.pending_presentation_events().unwrap();

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].session_id, session.id);
        assert_eq!(events[0].kind, "ready_to_close");
        assert_eq!(events[0].transition_revision, 0);
    }

    #[test]
    fn schema_applies_and_settings_seeded() {
        let s = store();
        assert_eq!(s.setting("schema.version").unwrap().unwrap(), "2");
        assert_eq!(s.setting_i64("pomodoro.focus_min", 0), 25);
        assert_eq!(s.setting_i64("pomodoro.stale_sec", 0), 120);
    }

    #[test]
    fn note_lifecycle_pending_fired_done() {
        let s = store();
        let n = s.insert_note("chiamare il commercialista", Some(1_000), false, 500).unwrap();
        assert_eq!(n.state, NoteState::Pending);

        // il tick la vede solo una volta scaduta
        assert!(s.due_notes(999).unwrap().is_empty());
        assert_eq!(s.due_notes(1_000).unwrap().len(), 1);

        s.mark_fired(n.id, 1_001).unwrap();
        let n = s.get_note(n.id).unwrap().unwrap();
        assert_eq!(n.state, NoteState::Fired);
        assert_eq!(n.fired_at, Some(1_001));
        // una nota fired non torna nella query del tick
        assert!(s.due_notes(2_000).unwrap().is_empty());

        s.complete_note(n.id, 1_500).unwrap();
        let n = s.get_note(n.id).unwrap().unwrap();
        assert_eq!(n.state, NoteState::Done);
        assert_eq!(n.completed_at, Some(1_500));
        // niente cancellazioni: la nota sta nell'archivio
        assert_eq!(s.archive(10).unwrap().len(), 1);
    }

    #[test]
    fn snooze_updates_in_place_and_recovers_via_same_path() {
        let s = store();
        let n = s.insert_note("rivedere la PR", Some(1_000), false, 0).unwrap();
        s.mark_fired(n.id, 1_000).unwrap();
        s.snooze_note(n.id, 5_000).unwrap();

        let n = s.get_note(n.id).unwrap().unwrap();
        assert_eq!(n.state, NoteState::Pending);
        assert_eq!(n.due_at, Some(5_000));
        assert_eq!(n.snooze_count, 1);
        // il rinvio rientra nella stessa query del recupero
        assert_eq!(s.due_notes(5_000).unwrap().len(), 1);
        // e nessun record nuovo è stato creato
        assert_eq!(s.counts().unwrap().0, 1);
    }

    #[test]
    fn note_without_due_never_fires() {
        let s = store();
        s.insert_note("appunto libero", None, false, 0).unwrap();
        assert!(s.due_notes(i64::MAX).unwrap().is_empty());
        assert_eq!(s.next_due(0).unwrap(), None);
        assert_eq!(s.open_notes().unwrap().len(), 1);
    }

    #[test]
    fn next_due_ignores_past_and_fired() {
        let s = store();
        s.insert_note("scaduta", Some(100), false, 0).unwrap();
        let b = s.insert_note("futura", Some(9_000), false, 0).unwrap();
        s.insert_note("più lontana", Some(20_000), false, 0).unwrap();
        assert_eq!(s.next_due(1_000).unwrap(), Some(9_000));
        s.mark_fired(b.id, 9_000).unwrap();
        assert_eq!(s.next_due(9_500).unwrap(), Some(20_000));
    }

    #[test]
    fn fts_search_finds_open_and_archived() {
        let s = store();
        let a = s.insert_note("preventivo Venitem da chiudere", Some(100), false, 0).unwrap();
        s.insert_note("aggiornare le migration TypeORM", None, false, 0).unwrap();
        s.complete_note(a.id, 200).unwrap();

        let hits = s.search_notes("venitem", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, a.id);
        // prefisso
        assert_eq!(s.search_notes("migra", 10).unwrap().len(), 1);
        // la punteggiatura non manda in errore il MATCH
        assert!(s.search_notes("c++ \"strano", 10).unwrap().is_empty());
        assert!(s.search_notes("   ", 10).unwrap().is_empty());
    }

    #[test]
    fn fts_stays_in_sync_on_body_update() {
        let s = store();
        let n = s.insert_note("testo vecchio", None, false, 0).unwrap();
        s.conn
            .execute("UPDATE notes SET body = 'testo nuovo' WHERE id = ?1", [n.id])
            .unwrap();
        assert!(s.search_notes("vecchio", 10).unwrap().is_empty());
        assert_eq!(s.search_notes("nuovo", 10).unwrap().len(), 1);
    }

    #[test]
    fn pomodoro_sessions_roundtrip_and_daily_count() {
        let s = store();
        let day = 1_000_000;
        let sess = s.start_session(SessionKind::Focus, day, day + 25 * 60_000, Some("spec")).unwrap();
        assert!(sess.outcome.is_none());
        assert_eq!(s.open_sessions().unwrap().len(), 1);

        s.resolve_session(
            sess.id,
            sess.transition_revision,
            SessionOutcome::Completed,
            day + 25 * 60_000,
        )
        .unwrap();
        assert!(s.open_sessions().unwrap().is_empty());
        assert_eq!(s.completed_focus_since(day).unwrap(), 1);
        // le invalidate non contano nelle statistiche
        let s2 = s.start_session(SessionKind::Focus, day + 1, day + 2, None).unwrap();
        s.resolve_session(
            s2.id,
            s2.transition_revision,
            SessionOutcome::Invalidated,
            day + 2,
        )
        .unwrap();
        assert_eq!(s.completed_focus_since(day).unwrap(), 1);
        // ma restano nello storico
        assert_eq!(s.session_history(10).unwrap().len(), 2);
        // il conteggio riparte dalla mezzanotte successiva
        assert_eq!(s.completed_focus_since(day + 10).unwrap(), 0);
    }

    #[test]
    fn resolve_session_only_once() {
        let s = store();
        let sess = s.start_session(SessionKind::Focus, 0, 100, None).unwrap();
        s.resolve_session(
            sess.id,
            sess.transition_revision,
            SessionOutcome::Aborted,
            50,
        )
        .unwrap();
        let err = s
            .resolve_session(
                sess.id,
                sess.transition_revision,
                SessionOutcome::Completed,
                100,
            )
            .unwrap_err();
        assert!(matches!(err, CoreError::InvalidState(_)));
        let sess = s.get_session(sess.id).unwrap().unwrap();
        assert_eq!(sess.outcome, Some(SessionOutcome::Aborted));
    }

    #[test]
    fn resolving_session_increments_transition_revision() {
        let s = store();
        let sess = s.start_session(SessionKind::Focus, 0, 100, None).unwrap();

        s.resolve_session(
            sess.id,
            sess.transition_revision,
            SessionOutcome::Completed,
            100,
        )
        .unwrap();

        let revision: i64 = s
            .conn
            .query_row(
                "SELECT transition_revision FROM pomodoro_sessions WHERE id = ?1",
                [sess.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(revision, 1);
    }

    #[test]
    fn opens_on_a_real_file_with_wal() {
        let dir = std::env::temp_dir().join(format!("win-buddy-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("buddy.db");
        {
            let s = Store::open(&path).unwrap();
            s.insert_note("persistita", None, false, 0).unwrap();
        }
        let s = Store::open(&path).unwrap();
        assert_eq!(s.open_notes().unwrap().len(), 1);
        drop(s);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn settings_upsert() {
        let s = store();
        s.set_setting("buddy.creature", "brace").unwrap();
        assert_eq!(s.setting("buddy.creature").unwrap().unwrap(), "brace");
    }

    #[test]
    fn settings_batch_is_committed_atomically() {
        let s = store();
        s.set_settings(&[
            ("overlay.position.x", "0.250000"),
            ("overlay.position.y", "0.750000"),
            ("overlay.monitor", "name:DISPLAY2"),
            ("overlay.position.mode", "manual"),
        ])
        .unwrap();

        assert_eq!(
            s.setting("overlay.position.x").unwrap().as_deref(),
            Some("0.250000")
        );
        assert_eq!(
            s.setting("overlay.position.y").unwrap().as_deref(),
            Some("0.750000")
        );
        assert_eq!(
            s.setting("overlay.monitor").unwrap().as_deref(),
            Some("name:DISPLAY2")
        );
        assert_eq!(
            s.setting("overlay.position.mode").unwrap().as_deref(),
            Some("manual")
        );
    }
}
