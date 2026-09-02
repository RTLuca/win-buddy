# Pomodoro P0 Core Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sostituire il timer lineare con una macchina a stati persistente che supporta preset, pausa/ripresa, variazioni di durata, chiusura esplicita, overtime e recupero affidabile.

**Architecture:** SQLite conserva stato e intervalli; `win-buddy-core` è l'unica autorità sulle transizioni e usa un orologio iniettato. Tauri espone comandi sottili e mantiene temporaneamente compatibili i vecchi ingressi mentre le superfici vengono migrate dal piano successivo.

**Tech Stack:** Rust 2021, rusqlite 0.32, serde, Tauri 2, SQLite, TypeScript 5.9

**Spec:** `docs/superpowers/specs/2026-09-02-pomodoro-p0-design.md`

## Global Constraints

- Tutti gli istanti sono epoch millisecondi UTC; nessun contatore incrementale.
- Al massimo una sessione e un intervallo di pausa possono essere aperti.
- Il tempo previsto concluso entra in `ready_to_close`; non completa automaticamente il focus.
- Il tempo di focus reale esclude le pause e include l'overtime.
- Ogni transizione è atomica, revisionata e idempotente.
- Il crate core non dipende da Tauri o API Windows.
- Lo schema v1 e il suo storico devono migrare senza perdita.

---

### Task 1: Infrastruttura di migrazione e schema v2

**Files:**
- Create: `crates/core/src/migrations.rs`
- Create: `crates/core/tests/fixtures/schema-v1.sql`
- Modify: `crates/core/src/lib.rs:1-25`
- Modify: `crates/core/src/store.rs:35-57`
- Modify: `crates/core/sql/schema.sql:1-61`
- Modify: `docs/sql/schema.sql:1-61`
- Test: `crates/core/src/migrations.rs` (`#[cfg(test)]`)

**Interfaces:**
- Consumes: una `rusqlite::Connection` appena aperta.
- Produces: `pub(crate) fn apply(conn: &mut Connection) -> Result<()>` e schema `PRAGMA user_version = 2`.

- [ ] **Step 1: Scrivere il test di migrazione dal database v1**

```rust
#[test]
fn migrates_v1_sessions_and_seeds_classic_preset() {
    let mut conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(include_str!("../tests/fixtures/schema-v1.sql")).unwrap();
    conn.execute(
        "INSERT INTO pomodoro_sessions(kind,started_at,ends_at,outcome,resolved_at,label)
         VALUES ('focus',1000,1501000,'completed',1501000,'Spec')",
        [],
    ).unwrap();

    apply(&mut conn).unwrap();

    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    let preset_count: i64 = conn.query_row("SELECT COUNT(*) FROM pomodoro_presets", [], |r| r.get(0)).unwrap();
    let intention: String = conn.query_row(
        "SELECT intention FROM pomodoro_sessions WHERE id = 1", [], |r| r.get(0)
    ).unwrap();
    assert_eq!(version, 2);
    assert_eq!(preset_count, 3);
    assert_eq!(intention, "Spec");
}
```

Create anche `crates/core/tests/fixtures/schema-v1.sql` copiando esattamente le definizioni v1 di `settings` e `pomodoro_sessions` dallo schema attuale.

- [ ] **Step 2: Eseguire il test e verificare il fallimento**

Run: `cargo test -p win-buddy-core migrations::tests::migrates_v1_sessions_and_seeds_classic_preset -- --exact`

Expected: FAIL perché il modulo `migrations` e la fixture non esistono.

- [ ] **Step 3: Implementare la migrazione atomica**

In `migrations.rs`, rilevare lo schema legacy tramite `PRAGMA table_info(pomodoro_sessions)`. Se esiste la colonna `ends_at`, eseguire la ricostruzione della tabella nella stessa transazione; se esiste già `deadline_at`, saltare la ricostruzione e limitarsi a seed/indici/versione. Il file `schema.sql` non deve impostare `user_version` prima di `apply`, altrimenti un database legacy verrebbe marcato come migrato troppo presto. La transazione usa:

```sql
CREATE TABLE pomodoro_presets (
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

ALTER TABLE pomodoro_sessions RENAME TO pomodoro_sessions_v1;
CREATE TABLE pomodoro_sessions (
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

INSERT INTO pomodoro_sessions(
  id,kind,phase,started_at,deadline_at,intention,planned_duration_ms,
  outcome,resolved_at,transition_revision
)
SELECT id,kind,CASE WHEN outcome IS NULL THEN 'running' ELSE 'closed' END,
       started_at,ends_at,COALESCE(label,''),ends_at-started_at,
       CASE outcome WHEN 'aborted' THEN 'interrupted' ELSE outcome END,
       resolved_at,0
FROM pomodoro_sessions_v1;
DROP TABLE pomodoro_sessions_v1;

CREATE TABLE pomodoro_pause_intervals (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES pomodoro_sessions(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  reason TEXT
);

CREATE TABLE pomodoro_presentation_events (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES pomodoro_sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  transition_revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  acknowledged_at INTEGER,
  UNIQUE(session_id,kind,transition_revision)
);
```

Derivare il preset Classico dalle chiavi `pomodoro.*` attuali; aggiungere Deep Work 50/10 e Sprint 15/3. Creare indici su sessioni aperte, data, pause aperte ed eventi non confermati. Impostare `PRAGMA user_version = 2` e aggiornare `settings['schema.version']` a `2`. Aggiornare entrambi i file `schema.sql` alla stessa struttura finale e includere i tre seed con `INSERT OR IGNORE`, senza `PRAGMA user_version` nel bootstrap.

- [ ] **Step 4: Collegare la migrazione all'apertura dello store**

```rust
fn init(mut conn: Connection) -> Result<Self> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.execute_batch(SCHEMA)?;
    crate::migrations::apply(&mut conn)?;
    Ok(Store { conn })
}
```

- [ ] **Step 5: Eseguire migrazione e suite core**

Run: `cargo test -p win-buddy-core migrations::tests::migrates_v1_sessions_and_seeds_classic_preset -- --exact`

Expected: PASS.

Run: `cargo test -p win-buddy-core`

Expected: suite verde; i vecchi test Pomodoro che assumono la chiusura automatica possono fallire soltanto fino a Task 3 e vanno temporaneamente marcati con il nuovo comportamento nello stesso commit.

- [ ] **Step 6: Commit**

```bash
git add crates/core/src/migrations.rs crates/core/src/lib.rs crates/core/src/store.rs crates/core/sql/schema.sql crates/core/tests/fixtures/schema-v1.sql docs/sql/schema.sql
git commit -m "feat(pomodoro): add versioned session schema"
```

### Task 2: Tipi di dominio e repository transazionale

**Files:**
- Modify: `crates/core/src/model.rs:53-117`
- Modify: `crates/core/src/lib.rs:10-20`
- Modify: `crates/core/src/store.rs:20-275`
- Test: `crates/core/src/store.rs` (`#[cfg(test)]`)

**Interfaces:**
- Consumes: schema v2 della Task 1.
- Produces: `PomodoroPreset`, `SessionPhase`, `SessionOutcome`, `StartSession`, `SessionSnapshot`; metodi store per preset, sessioni, pause, revisioni e tempo effettivo.

- [ ] **Step 1: Scrivere test repository per preset e tempo reale**

```rust
const MIN: i64 = 60_000;

fn store() -> Store {
    Store::open_in_memory().unwrap()
}

#[test]
fn effective_focus_excludes_pause_and_includes_overtime() {
    let s = store();
    let started = s.start_focus(StartSession::focus(1, "Spec", 25 * MIN), 0).unwrap();
    s.open_pause(started.id, 5 * MIN, None).unwrap();
    s.close_pause(started.id, 10 * MIN).unwrap();
    s.set_phase(started.id, SessionPhase::Overtime, 1, 30 * MIN).unwrap();
    assert_eq!(s.effective_focus_ms(started.id, 35 * MIN).unwrap(), 30 * MIN);
}

#[test]
fn only_one_open_session_is_allowed() {
    let s = store();
    s.start_focus(StartSession::focus(1, "A", 25 * MIN), 0).unwrap();
    let err = s.start_focus(StartSession::focus(1, "B", 25 * MIN), MIN).unwrap_err();
    assert!(matches!(err, CoreError::InvalidState(_)));
}
```

- [ ] **Step 2: Eseguire i test e verificare il fallimento**

Run: `cargo test -p win-buddy-core store::tests::effective_focus_excludes_pause_and_includes_overtime`

Expected: FAIL per tipi e metodi mancanti.

Run: `cargo test -p win-buddy-core store::tests::only_one_open_session_is_allowed`

Expected: FAIL per tipi e metodi mancanti.

- [ ] **Step 3: Definire i tipi esatti**

```rust
pub enum SessionPhase { Running, Paused, ReadyToClose, Overtime, Closed }
pub enum SessionOutcome { Completed, Partial, Interrupted, Invalidated }

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
}
```

Aggiungere conversioni `as_str/parse` totali; stringhe sconosciute devono produrre `CoreError::InvalidState`, non fallback silenziosi.

- [ ] **Step 4: Implementare repository e revisioni ottimistiche**

Implementare `default_preset`, `list_presets`, `start_focus`, `open_session`, `open_pause`, `close_pause`, `set_phase`, `finish_session`, `effective_focus_ms` e `pending_presentation_events`. Ogni `UPDATE` usa:

```sql
UPDATE pomodoro_sessions
SET phase = ?2, transition_revision = transition_revision + 1
WHERE id = ?1 AND transition_revision = ?3 AND outcome IS NULL
```

Se `changed_rows != 1`, restituire `CoreError::InvalidState("sessione già aggiornata")`. `effective_focus_ms` usa `min(COALESCE(resolved_at, at_ms), at_ms) - started_at - SUM(pause_duration)`.

- [ ] **Step 5: Eseguire test mirati e suite**

Run: `cargo test -p win-buddy-core store::tests::effective_focus_excludes_pause_and_includes_overtime`

Expected: PASS.

Run: `cargo test -p win-buddy-core`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/core/src/model.rs crates/core/src/lib.rs crates/core/src/store.rs
git commit -m "feat(pomodoro): add session repository and timing model"
```

### Task 3: Macchina a stati flessibile

**Files:**
- Rewrite: `crates/core/src/pomodoro.rs:1-260`
- Test: `crates/core/src/pomodoro.rs` (`#[cfg(test)]`)

**Interfaces:**
- Consumes: repository e tipi della Task 2.
- Produces: `start`, `pause`, `resume`, `adjust_duration`, `start_overtime`, `finish`, `start_break`, `skip_break`, `tick`, `resolve_open`, `PomodoroEvent`.

- [ ] **Step 1: Scrivere i test delle transizioni principali**

```rust
const MIN: i64 = 60_000;

fn setup() -> Store {
    Store::open_in_memory().unwrap()
}

fn request(duration_ms: i64) -> StartSession {
    StartSession::focus(1, "Spec", duration_ms)
}

#[test]
fn deadline_requires_explicit_close_or_overtime() {
    let s = setup();
    let active = start(&s, request(25 * MIN), 0).unwrap().session;
    let out = tick(&s, 25 * MIN).unwrap();
    assert_eq!(out[0].kind, EventKind::ReadyToClose);
    assert_eq!(s.get_session(active.id).unwrap().unwrap().phase, SessionPhase::ReadyToClose);
    assert_eq!(s.get_session(active.id).unwrap().unwrap().outcome, None);

    start_overtime(&s, active.id, 1, 25 * MIN).unwrap();
    let closed = finish(&s, active.id, 2, SessionOutcome::Completed, None, 32 * MIN).unwrap();
    assert_eq!(closed.effective_focus_ms, 32 * MIN);
}

#[test]
fn pause_resume_preserves_remaining_time() {
    let s = setup();
    let active = start(&s, request(25 * MIN), 0).unwrap().session;
    pause(&s, active.id, 0, 10 * MIN, None).unwrap();
    let resumed = resume(&s, active.id, 1, 20 * MIN).unwrap();
    assert_eq!(resumed.session.deadline_at, 35 * MIN);
}

#[test]
fn break_deadline_closes_break_and_emits_return_prompt() {
    let s = setup();
    let focus = start(&s, request(MIN), 0).unwrap().session;
    finish(&s, focus.id, 0, SessionOutcome::Completed, None, MIN).unwrap();
    let break_session = start_break(&s, SessionKind::ShortBreak, 5 * MIN, MIN).unwrap().session;
    let events = tick(&s, 6 * MIN).unwrap();
    assert_eq!(s.get_session(break_session.id).unwrap().unwrap().outcome, Some(SessionOutcome::Completed));
    assert!(events.iter().any(|e| e.kind == EventKind::ReturnPrompt));
}
```

- [ ] **Step 2: Verificare che i test falliscano**

Run: `cargo test -p win-buddy-core pomodoro::tests::deadline_requires_explicit_close_or_overtime`

Expected: FAIL per API mancanti.

Run: `cargo test -p win-buddy-core pomodoro::tests::pause_resume_preserves_remaining_time`

Expected: FAIL per API mancanti.

Run: `cargo test -p win-buddy-core pomodoro::tests::break_deadline_closes_break_and_emits_return_prompt`

Expected: FAIL per API mancanti.

- [ ] **Step 3: Implementare comandi e invarianti**

Usare `expected_revision` su ogni mutazione. Applicare questa tabella:

```rust
pub enum EventKind { Prewarning, ReadyToClose, ReturnPrompt, RecoveryNeeded }

pub struct PomodoroEvent {
    pub id: i64,
    pub session_id: i64,
    pub kind: EventKind,
    pub transition_revision: i64,
}

pub struct TransitionResult {
    pub session: PomodoroSession,
    pub effective_focus_ms: i64,
    pub events: Vec<PomodoroEvent>,
}

match (session.phase, command) {
    (Running, Pause) => Paused,
    (Paused, Resume) => Running,
    (Running, DeadlineElapsed) => ReadyToClose,
    (ReadyToClose, StartOvertime) => Overtime,
    (ReadyToClose, Extend(_)) => Running,
    (Running | Paused | ReadyToClose | Overtime, Finish(_)) => Closed,
    _ => return Err(CoreError::InvalidState("transizione non consentita".into())),
}
```

`adjust_duration` accetta millisecondi firmati e usa `max(now, deadline + delta)`. Se il risultato è `now`, entra in `ReadyToClose`. `tick` produce l'evento durevole `ready_to_close` una volta sola. `finish` chiude l'eventuale pausa aperta e richiede una motivazione soltanto per `Interrupted` quando la UI l'ha fornita.

`start_break` accetta solo `ShortBreak` o `LongBreak` e crea una sessione `Running`. Alla deadline di una pausa, `tick` la chiude come `Completed` e produce `ReturnPrompt`; `skip_break` la chiude come `Partial`. Pausa/ripresa tecnica è consentita soltanto per `Focus`, mentre `adjust_duration` vale anche per le pause.

- [ ] **Step 4: Sostituire i vecchi test con la nuova semantica**

Mantenere copertura per pausa lunga ogni N, sospensione breve, assenza lunga e cambio giorno. La vecchia asserzione “deadline = completed” diventa:

```rust
let events = tick(&s, deadline).unwrap();
assert!(matches!(events[0].kind, EventKind::ReadyToClose));
assert_eq!(s.completed_focus_since(0).unwrap(), 0);
finish(&s, id, 1, SessionOutcome::Completed, None, deadline).unwrap();
assert_eq!(s.completed_focus_since(0).unwrap(), 1);
```

- [ ] **Step 5: Eseguire la suite core**

Run: `cargo test -p win-buddy-core`

Expected: PASS, inclusi i quattro rami di recupero.

- [ ] **Step 6: Commit**

```bash
git add crates/core/src/pomodoro.rs crates/core/src/store.rs
git commit -m "feat(pomodoro): implement pause overtime and explicit outcomes"
```

### Task 4: Recupero e outbox di presentazione

**Files:**
- Modify: `crates/core/src/pomodoro.rs`
- Modify: `crates/core/src/store.rs`
- Modify: `src-tauri/src/runtime.rs:58-190`
- Modify: `src-tauri/src/state.rs:14-61`
- Test: `crates/core/src/pomodoro.rs`

**Interfaces:**
- Consumes: `PomodoroEvent { id, session_id, kind, transition_revision }`.
- Produces: recupero deterministico e `acknowledge_presentation_event(id, now)`.

- [ ] **Step 1: Scrivere test di deduplicazione e recupero**

```rust
#[test]
fn ready_event_is_durable_and_not_duplicated() {
    let s = setup();
    start(&s, request(MIN), 0).unwrap();
    tick(&s, MIN).unwrap();
    tick(&s, MIN + 5_000).unwrap();
    let events = s.pending_presentation_events().unwrap();
    assert_eq!(events.iter().filter(|e| e.kind == EventKind::ReadyToClose).count(), 1);
}

#[test]
fn long_gap_marks_running_session_for_review() {
    let s = setup();
    start(&s, request(25 * MIN), 0).unwrap();
    let recovered = resolve_open(&s, 20 * MIN, 5 * MIN, 120_000).unwrap();
    assert!(matches!(recovered, Recovery::NeedsReview(_)));
}
```

- [ ] **Step 2: Eseguire e osservare il fallimento**

Run: `cargo test -p win-buddy-core pomodoro::tests::ready_event_is_durable_and_not_duplicated`

Expected: FAIL.

Run: `cargo test -p win-buddy-core pomodoro::tests::long_gap_marks_running_session_for_review`

Expected: FAIL.

- [ ] **Step 3: Implementare outbox e recupero**

Inserire l'evento nella stessa transazione della transizione con `INSERT OR IGNORE`. Modellare `Recovery` come:

```rust
pub enum Recovery {
    Resumed(PomodoroSession),
    ReadyToClose(PomodoroSession),
    NeedsReview(PomodoroSession),
    Nothing,
}
```

Un gap entro `stale_sec` conserva lo stato. Un gap lungo non modifica l'esito: crea `recovery_needed` e aspetta correzione utente. Un focus già oltre deadline entra in `ReadyToClose` senza celebrarlo se l'evento non è più temporalmente rilevante.

- [ ] **Step 4: Migrare il runtime dall'effimero al persistente**

Rimuovere `break_prompt` come verità primaria da `AppState`. `runtime::do_tick` e `startup_recovery` leggono l'outbox, passano gli eventi al presenter e chiamano `acknowledge_presentation_event` dopo emissione con ID stabile. In caso di retry, riusare lo stesso tag/ID invece di creare una seconda notifica.

- [ ] **Step 5: Verificare core e shell**

Run: `cargo test -p win-buddy-core`

Expected: PASS.

Run: `cargo check -p win-buddy`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/core/src/pomodoro.rs crates/core/src/store.rs src-tauri/src/runtime.rs src-tauri/src/state.rs
git commit -m "feat(pomodoro): persist transitions and recovery events"
```

### Task 5: Contratti Tauri e compatibilità temporanea

**Files:**
- Modify: `src-tauri/src/commands.rs:60-340`
- Modify: `src-tauri/src/lib.rs:42-75`
- Modify: `src-tauri/src/presenter.rs:55-200`
- Modify: `ui/shared/contracts.ts:90-165`
- Modify: `ui/shared/ipc.ts:35-55`
- Test: `src-tauri/src/commands.rs` (`#[cfg(test)]`, funzioni pure estratte)

**Interfaces:**
- Consumes: API core delle Task 2–4.
- Produces: `focus_start`, `focus_pause`, `focus_resume`, `focus_adjust`, `focus_overtime`, `focus_finish`, `focus_status` e evento `focus:changed`.

- [ ] **Step 1: Definire e testare le azioni consentite**

Estrarre una funzione pura e testarla:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
enum FocusAction {
    #[serde(rename = "focus.start_last")]
    StartLast,
    #[serde(rename = "focus.pause")]
    Pause,
    #[serde(rename = "focus.resume")]
    Resume,
    #[serde(rename = "focus.extend_5")]
    Extend5,
    #[serde(rename = "focus.capture")]
    Capture,
    #[serde(rename = "focus.finish")]
    Finish,
    #[serde(rename = "focus.overtime")]
    Overtime,
    #[serde(rename = "break.start")]
    StartBreak,
    #[serde(rename = "break.skip")]
    SkipBreak,
}

#[test]
fn paused_status_only_exposes_valid_actions() {
    let actions = allowed_actions(SessionPhase::Paused);
    assert_eq!(actions, vec![FocusAction::Resume, FocusAction::Capture, FocusAction::Finish]);
}
```

Run: `cargo test -p win-buddy commands::tests::paused_status_only_exposes_valid_actions`

Expected: FAIL finché tipi e funzione non esistono.

- [ ] **Step 2: Aggiungere i DTO esatti**

```rust
#[derive(Serialize)]
struct FocusStatusDto {
    active: Option<PomodoroSession>,
    effective_focus_ms: i64,
    remaining_ms: Option<i64>,
    overtime_ms: Option<i64>,
    allowed_actions: Vec<FocusAction>,
    pending_captures: i64,
    transition_revision: Option<i64>,
}
```

Rispecchiare il tipo in `contracts.ts`; usare un discriminante `phase` e union letterali, non stringhe libere.

- [ ] **Step 3: Implementare i comandi sottili**

Ogni handler prende `expectedRevision`, chiama una sola funzione core, esegue `presenter::sync`, emette `focus:changed` e restituisce `FocusStatusDto`. Mantenere `pomodoro_start/status/abort` come wrapper deprecati fino al completamento del piano superfici; `pomodoro_abort` mappa a esito `interrupted`.

- [ ] **Step 4: Aggiornare presenter e stato buddy**

Estendere `StateChanged` con:

```ts
phase?: "running" | "paused" | "ready_to_close" | "overtime";
remaining_ms?: number;
overtime_ms?: number;
```

Il presenter usa la sessione aperta anche quando la deadline è passata. `ReadyToClose` produce `alert`, `Paused` conserva `focus` con etichetta testuale “In pausa”, `Overtime` produce `focus` e valore crescente.

- [ ] **Step 5: Verificare tutti i target**

Run: `cargo test --workspace`

Expected: PASS.

Run: `npm run check`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/src/presenter.rs ui/shared/contracts.ts ui/shared/ipc.ts
git commit -m "feat(pomodoro): expose flexible focus commands"
```

## Completion Gate

- `cargo test --workspace`, `npm run check` e `npm run build` passano.
- Un database v1 reale copiato in una directory di test apre e conserva lo storico.
- Una sessione può attraversare start → pause → resume → deadline → overtime → completed dopo un riavvio simulato.
- Nessuna superficie calcola o applica transizioni autonomamente.
- I vecchi comandi restano disponibili soltanto come bridge documentato per il piano Buddy/Surfaces.
