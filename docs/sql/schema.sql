-- win-buddy · schema v2
-- Tutti gli istanti e le durate sono espressi in millisecondi.

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  due_at INTEGER,
  urgent INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK(state IN ('pending','fired','done','dismissed')),
  fired_at INTEGER,
  snooze_count INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_notes_due ON notes(state,due_at);
CREATE INDEX IF NOT EXISTS idx_notes_state ON notes(state,created_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts
  USING fts5(body,content='notes',content_rowid='id');

CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid,body) VALUES(new.id,new.body);
END;
CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts,rowid,body) VALUES('delete',old.id,old.body);
END;
CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE OF body ON notes BEGIN
  INSERT INTO notes_fts(notes_fts,rowid,body) VALUES('delete',old.id,old.body);
  INSERT INTO notes_fts(rowid,body) VALUES(new.id,new.body);
END;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO settings(key,value) VALUES
  ('buddy.creature','cotone'),
  ('buddy.mode','full'),
  ('buddy.corner','bottom-right'),
  ('dnd.manual','0'),
  ('dnd.auto_fullscreen','1'),
  ('pomodoro.focus_min','25'),
  ('pomodoro.short_min','5'),
  ('pomodoro.long_min','20'),
  ('pomodoro.long_every','4'),
  ('pomodoro.stale_sec','120'),
  ('overlay.idle_sleep_min','20'),
  ('overlay.scale','100'),
  ('overlay.monitor','primary'),
  ('overlay.position.mode','corner'),
  ('schema.version','2');

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
);

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
  (3,'Sprint',900000,180000,900000,4,0,0,0,2,0,0);

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
);

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
);

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
  ON pomodoro_presentation_events(created_at) WHERE acknowledged_at IS NULL;

