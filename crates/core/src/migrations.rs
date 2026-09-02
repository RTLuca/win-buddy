use crate::Result;
use rusqlite::{Connection, Transaction};

const CREATE_SETTINGS: &str = "
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);";

const CREATE_PRESETS: &str = "
CREATE TABLE IF NOT EXISTS pomodoro_presets (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  focus_ms INTEGER NOT NULL CHECK(focus_ms > 0),
  short_break_ms INTEGER NOT NULL CHECK(short_break_ms > 0),
  long_break_ms INTEGER NOT NULL CHECK(long_break_ms > 0),
  long_every INTEGER NOT NULL CHECK(long_every >= 2),
  auto_start_break INTEGER NOT NULL DEFAULT 0 CHECK(auto_start_break IN (0,1)),
  auto_start_focus INTEGER NOT NULL DEFAULT 0 CHECK(auto_start_focus IN (0,1)),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
  sort_order INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);";

const CREATE_SESSIONS: &str = "
CREATE TABLE IF NOT EXISTS pomodoro_sessions (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('focus','short_break','long_break')),
  preset_id INTEGER REFERENCES pomodoro_presets(id) ON DELETE SET NULL,
  phase TEXT NOT NULL CHECK(phase IN ('running','paused','ready_to_close','overtime','closed')),
  started_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  paused_remaining_ms INTEGER,
  overtime_started_at INTEGER,
  intention TEXT NOT NULL DEFAULT '',
  category TEXT,
  planned_duration_ms INTEGER NOT NULL CHECK(planned_duration_ms > 0),
  estimated_ms INTEGER,
  next_step TEXT,
  outcome TEXT CHECK(outcome IN ('completed','partial','interrupted','invalidated')),
  interruption_reason TEXT,
  resolved_at INTEGER,
  edited_at INTEGER,
  transition_revision INTEGER NOT NULL DEFAULT 0
);";

const CREATE_RELATED_TABLES: &str = "
CREATE TABLE IF NOT EXISTS pomodoro_pause_intervals (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES pomodoro_sessions(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  reason TEXT
);

CREATE TABLE IF NOT EXISTS pomodoro_presentation_events (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES pomodoro_sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  transition_revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  acknowledged_at INTEGER,
  UNIQUE(session_id,kind,transition_revision)
);";

const SEED_PRESETS: &str = "
INSERT OR IGNORE INTO pomodoro_presets(
  id,name,focus_ms,short_break_ms,long_break_ms,long_every,
  auto_start_break,auto_start_focus,is_default,sort_order,created_at,updated_at
)
SELECT 1,'Classico',
       CAST(COALESCE((SELECT value FROM settings WHERE key='pomodoro.focus_min'),'25') AS INTEGER)*60000,
       CAST(COALESCE((SELECT value FROM settings WHERE key='pomodoro.short_min'),'5') AS INTEGER)*60000,
       CAST(COALESCE((SELECT value FROM settings WHERE key='pomodoro.long_min'),'20') AS INTEGER)*60000,
       CAST(COALESCE((SELECT value FROM settings WHERE key='pomodoro.long_every'),'4') AS INTEGER),
       0,0,1,0,0,0;

INSERT OR IGNORE INTO pomodoro_presets(
  id,name,focus_ms,short_break_ms,long_break_ms,long_every,
  auto_start_break,auto_start_focus,is_default,sort_order,created_at,updated_at
) VALUES
  (2,'Deep Work',3000000,600000,1800000,4,0,0,0,1,0,0),
  (3,'Sprint',900000,180000,900000,4,0,0,0,2,0,0);";

const CREATE_INDEXES: &str = "
CREATE UNIQUE INDEX IF NOT EXISTS idx_pomo_one_open
  ON pomodoro_sessions((1)) WHERE phase <> 'closed';
CREATE INDEX IF NOT EXISTS idx_pomo_open
  ON pomodoro_sessions(deadline_at) WHERE phase <> 'closed';
CREATE INDEX IF NOT EXISTS idx_pomo_day
  ON pomodoro_sessions(started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pomo_one_pause_open
  ON pomodoro_pause_intervals((1)) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pomo_pause_open
  ON pomodoro_pause_intervals(session_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pomo_events_unacked
  ON pomodoro_presentation_events(created_at) WHERE acknowledged_at IS NULL;";

pub(crate) fn apply(conn: &mut Connection) -> Result<()> {
    let transaction = conn.transaction()?;
    transaction.execute_batch(CREATE_SETTINGS)?;

    let columns = table_columns(&transaction, "pomodoro_sessions")?;
    let is_legacy = columns.iter().any(|column| column == "ends_at");
    let is_v2 = columns.iter().any(|column| column == "deadline_at");

    transaction.execute_batch(CREATE_PRESETS)?;
    if is_legacy {
        migrate_legacy_sessions(&transaction)?;
    } else if !is_v2 {
        transaction.execute_batch(CREATE_SESSIONS)?;
    }

    transaction.execute_batch(CREATE_RELATED_TABLES)?;
    transaction.execute_batch(SEED_PRESETS)?;
    transaction.execute_batch(CREATE_INDEXES)?;
    transaction.execute(
        "INSERT INTO settings(key,value) VALUES ('schema.version','2')
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [],
    )?;
    transaction.pragma_update(None, "user_version", 2)?;
    transaction.commit()?;
    Ok(())
}

fn table_columns(transaction: &Transaction<'_>, table: &str) -> Result<Vec<String>> {
    let mut statement = transaction.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = statement.query_map([], |row| row.get(1))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn migrate_legacy_sessions(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(&format!(
        "ALTER TABLE pomodoro_sessions RENAME TO pomodoro_sessions_v1;
         {CREATE_SESSIONS}
         INSERT INTO pomodoro_sessions(
           id,kind,phase,started_at,deadline_at,intention,planned_duration_ms,
           outcome,resolved_at,transition_revision
         )
         SELECT id,kind,
                CASE WHEN outcome IS NULL AND id = (
                       SELECT id FROM pomodoro_sessions_v1
                       WHERE outcome IS NULL ORDER BY started_at DESC,id DESC LIMIT 1
                     ) THEN 'running' ELSE 'closed' END,
                started_at,ends_at,COALESCE(label,''),
                CASE WHEN ends_at > started_at THEN ends_at-started_at ELSE 1 END,
                CASE
                  WHEN outcome IS NULL AND id <> (
                    SELECT id FROM pomodoro_sessions_v1
                    WHERE outcome IS NULL ORDER BY started_at DESC,id DESC LIMIT 1
                  ) THEN 'invalidated'
                  WHEN outcome = 'aborted' THEN 'interrupted'
                  ELSE outcome
                END,
                CASE
                  WHEN outcome IS NULL AND id <> (
                    SELECT id FROM pomodoro_sessions_v1
                    WHERE outcome IS NULL ORDER BY started_at DESC,id DESC LIMIT 1
                  ) THEN ends_at
                  ELSE resolved_at
                END,
                0
         FROM pomodoro_sessions_v1;
         DROP TABLE pomodoro_sessions_v1;"
    ))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn migrates_v1_sessions_and_seeds_classic_preset() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../tests/fixtures/schema-v1.sql"))
            .unwrap();
        conn.execute(
            "INSERT INTO pomodoro_sessions(kind,started_at,ends_at,outcome,resolved_at,label)
             VALUES ('focus',1000,1501000,'completed',1501000,'Spec')",
            [],
        )
        .unwrap();

        apply(&mut conn).unwrap();

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        let preset_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM pomodoro_presets", [], |r| r.get(0))
            .unwrap();
        let intention: String = conn
            .query_row(
                "SELECT intention FROM pomodoro_sessions WHERE id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(version, 2);
        assert_eq!(preset_count, 3);
        assert_eq!(intention, "Spec");
    }

    #[test]
    fn normalizes_ambiguous_v1_open_sessions_without_losing_timestamps() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../tests/fixtures/schema-v1.sql"))
            .unwrap();
        conn.execute_batch(
            "INSERT INTO pomodoro_sessions(id,kind,started_at,ends_at,outcome,label) VALUES
               (1,'focus',2000,1000,NULL,'older'),
               (2,'focus',3000,3000,NULL,'same-start-older-id'),
               (3,'focus',3000,4000,NULL,'latest-id');",
        )
        .unwrap();

        apply(&mut conn).unwrap();

        let rows = conn
            .prepare(
                "SELECT id,phase,started_at,deadline_at,planned_duration_ms,outcome,resolved_at
                 FROM pomodoro_sessions ORDER BY id",
            )
            .unwrap()
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<i64>>(6)?,
                ))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();

        assert_eq!(
            rows,
            vec![
                (
                    1,
                    "closed".to_string(),
                    2000,
                    1000,
                    1,
                    Some("invalidated".to_string()),
                    Some(1000),
                ),
                (
                    2,
                    "closed".to_string(),
                    3000,
                    3000,
                    1,
                    Some("invalidated".to_string()),
                    Some(3000),
                ),
                (3, "running".to_string(), 3000, 4000, 1000, None, None),
            ]
        );
    }
}
