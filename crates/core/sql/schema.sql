-- win-buddy · schema v1
--
-- Regola che governa tutto: nessun contatore incrementale. Ogni durata è una
-- coppia di istanti assoluti in epoch millisecondi UTC, e lo stato si ricalcola
-- come "scadenza meno adesso". Un contatore che scala di un secondo alla volta
-- salta con la sospensione e mente dopo un riavvio.

CREATE TABLE IF NOT EXISTS notes (
  id             INTEGER PRIMARY KEY,
  body           TEXT    NOT NULL,
  created_at     INTEGER NOT NULL,          -- epoch ms UTC
  due_at         INTEGER,                   -- NULL = appunto senza promemoria
  urgent         INTEGER NOT NULL DEFAULT 0,-- 1 = può interrompere un focus
  state          TEXT    NOT NULL DEFAULT 'pending'
                 CHECK (state IN ('pending','fired','done','dismissed')),
  fired_at       INTEGER,
  snooze_count   INTEGER NOT NULL DEFAULT 0,
  completed_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_notes_due   ON notes(state, due_at);
CREATE INDEX IF NOT EXISTS idx_notes_state ON notes(state, created_at DESC);

-- Ricerca nell'archivio: full-text e basta.
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts
  USING fts5(body, content='notes', content_rowid='id');

CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, body) VALUES (new.id, new.body);
END;

CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, body) VALUES ('delete', old.id, old.body);
END;

CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE OF body ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, body) VALUES ('delete', old.id, old.body);
  INSERT INTO notes_fts(rowid, body) VALUES (new.id, new.body);
END;

CREATE TABLE IF NOT EXISTS pomodoro_sessions (
  id           INTEGER PRIMARY KEY,
  kind         TEXT    NOT NULL CHECK (kind IN ('focus','short_break','long_break')),
  started_at   INTEGER NOT NULL,
  ends_at      INTEGER NOT NULL,
  -- NULL = sessione ancora in corso. All'avvio ogni riga con outcome NULL
  -- viene risolta secondo le regole del § 8.3 della specifica.
  outcome      TEXT    CHECK (outcome IN ('completed','aborted','invalidated')),
  resolved_at  INTEGER,
  label        TEXT                          -- su cosa stavi lavorando, facoltativo
);

CREATE INDEX IF NOT EXISTS idx_pomo_open ON pomodoro_sessions(outcome, ends_at);
CREATE INDEX IF NOT EXISTS idx_pomo_day  ON pomodoro_sessions(started_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO settings(key, value) VALUES
  ('buddy.creature',        'cotone'),
  ('buddy.mode',            'full'),      -- full | sober
  ('buddy.corner',          'bottom-right'),
  ('dnd.manual',            '0'),
  ('dnd.auto_fullscreen',   '1'),
  ('pomodoro.focus_min',    '25'),
  ('pomodoro.short_min',    '5'),
  ('pomodoro.long_min',     '20'),
  ('pomodoro.long_every',   '4'),
  ('pomodoro.stale_sec',    '120'),       -- oltre questo divario la sessione è invalidata
  ('overlay.idle_sleep_min','20'),        -- dopo quanto si distrugge la webview
  ('schema.version',        '1');
