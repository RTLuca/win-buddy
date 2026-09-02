//! Store SQLite (§ 6). Un'unica connessione, WAL, foreign keys.
//!
//! Principi (§ 6.1): nessun contatore incrementale, lo snooze non crea record,
//! niente cancellazioni — le note chiuse cambiano stato, non spariscono.

use crate::model::{Note, NoteState, PomodoroSession, SessionKind, SessionOutcome};
use crate::Result;
use rusqlite::{params, Connection, OptionalExtension, Row};
use std::path::Path;

const SCHEMA: &str = include_str!("../sql/schema.sql");

pub struct Store {
    conn: Connection,
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

fn session_from_row(row: &Row) -> rusqlite::Result<PomodoroSession> {
    let kind: String = row.get("kind")?;
    let outcome: Option<String> = row.get("outcome")?;
    Ok(PomodoroSession {
        id: row.get("id")?,
        kind: SessionKind::parse(&kind).unwrap_or(SessionKind::Focus),
        started_at: row.get("started_at")?,
        ends_at: row.get("deadline_at")?,
        outcome: outcome.as_deref().and_then(|value| {
            if value == "interrupted" {
                Some(SessionOutcome::Aborted)
            } else {
                SessionOutcome::parse(value)
            }
        }),
        resolved_at: row.get("resolved_at")?,
        label: row.get("intention")?,
    })
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

    pub fn start_session(
        &self,
        kind: SessionKind,
        started_at: i64,
        ends_at: i64,
        label: Option<&str>,
    ) -> Result<PomodoroSession> {
        self.conn.execute(
            "INSERT INTO pomodoro_sessions(
               kind, phase, started_at, deadline_at, intention, planned_duration_ms
             ) VALUES (?1, 'running', ?2, ?3, COALESCE(?4, ''), ?3 - ?2)",
            params![kind.as_str(), started_at, ends_at, label],
        )?;
        let id = self.conn.last_insert_rowid();
        Ok(self.get_session(id)?.expect("sessione appena inserita"))
    }

    pub fn get_session(&self, id: i64) -> Result<Option<PomodoroSession>> {
        Ok(self
            .conn
            .query_row(
                "SELECT id,kind,started_at,deadline_at,outcome,resolved_at,intention
                 FROM pomodoro_sessions WHERE id = ?1",
                [id],
                session_from_row,
            )
            .optional()?)
    }

    /// Sessioni senza esito, da risolvere all'avvio o alla ripresa (§ 8.3).
    pub fn open_sessions(&self) -> Result<Vec<PomodoroSession>> {
        let mut stmt = self.conn.prepare(
            "SELECT id,kind,started_at,deadline_at,outcome,resolved_at,intention
             FROM pomodoro_sessions WHERE outcome IS NULL ORDER BY started_at",
        )?;
        let rows = stmt.query_map([], session_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn resolve_session(&self, id: i64, outcome: SessionOutcome, now: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE pomodoro_sessions
             SET outcome = CASE ?2 WHEN 'aborted' THEN 'interrupted' ELSE ?2 END,
                 phase = 'closed', resolved_at = ?3
             WHERE id = ?1 AND outcome IS NULL",
            params![id, outcome.as_str(), now],
        )?;
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
            "SELECT id,kind,started_at,deadline_at,outcome,resolved_at,intention
             FROM pomodoro_sessions WHERE outcome IS NOT NULL
             ORDER BY started_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit], session_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
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

    fn store() -> Store {
        Store::open_in_memory().unwrap()
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

        s.resolve_session(sess.id, SessionOutcome::Completed, day + 25 * 60_000).unwrap();
        assert!(s.open_sessions().unwrap().is_empty());
        assert_eq!(s.completed_focus_since(day).unwrap(), 1);
        // le invalidate non contano nelle statistiche
        let s2 = s.start_session(SessionKind::Focus, day + 1, day + 2, None).unwrap();
        s.resolve_session(s2.id, SessionOutcome::Invalidated, day + 2).unwrap();
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
        s.resolve_session(sess.id, SessionOutcome::Aborted, 50).unwrap();
        s.resolve_session(sess.id, SessionOutcome::Completed, 100).unwrap();
        let sess = s.get_session(sess.id).unwrap().unwrap();
        assert_eq!(sess.outcome, Some(SessionOutcome::Aborted));
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
