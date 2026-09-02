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
  ('overlay.scale',         '100'),       -- percentuale 50–200
  ('overlay.monitor',       'primary'),   -- "primary" o name:<id dispositivo>
  ('overlay.position.mode', 'corner'),    -- corner | manual
  ('schema.version',        '1');
