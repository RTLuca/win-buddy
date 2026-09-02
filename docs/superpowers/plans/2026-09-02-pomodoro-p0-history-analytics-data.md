# Pomodoro P0 History Analytics and Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consegnare registro correggibile, statistiche sul tempo reale, export CSV/JSON, backup, ripristino e cancellazione trasparente.

**Architecture:** Query e serializzazione vivono nel core e restituiscono DTO neutrali. Il pannello renderizza aggregazioni già calcolate; la shell gestisce soltanto file picker e scrittura atomica. Le correzioni conservano un audit locale minimo.

**Tech Stack:** Rust 2021, rusqlite 0.32, serde/serde_json, csv, Tauri 2 dialog plugin, TypeScript 5.9

**Spec:** `docs/superpowers/specs/2026-09-02-pomodoro-p0-design.md`

## Global Constraints

- Dipende dai piani Core Engine e Intent/Interruptions; può procedere in parallelo all'integrazione Windows.
- Le statistiche usano focus reale, non numero di timer avviati.
- Le correzioni non cancellano la traccia del valore precedente.
- Giorno/settimana/mese/anno sono intervalli civili calcolati dalla shell e passati al core come epoch UTC.
- CSV è una riga per sessione; JSON è versionato e include relazioni.
- Backup e restore validano integrità e versione prima di modificare lo store vivo.
- La cancellazione completa richiede conferma esplicita e non usa path ampi o glob.

---

### Task 1: Migrazione v5 e modifica storica auditabile

**Files:**
- Modify: `crates/core/src/migrations.rs`
- Modify: `crates/core/sql/schema.sql`
- Modify: `docs/sql/schema.sql`
- Modify: `crates/core/src/model.rs`
- Modify: `crates/core/src/store.rs`
- Create: `crates/core/src/test_support.rs`
- Modify: `crates/core/src/lib.rs`
- Test: `crates/core/src/store.rs`

**Interfaces:**
- Consumes: sessioni chiuse schema v4.
- Produces: schema v5, `SessionPatch`, `update_session`, `create_manual_session`, `session_edits`.

- [ ] **Step 1: Scrivere test per modifica e inserimento manuale**

```rust
use crate::test_support::{completed_focus_store, manual_request};

#[test]
fn editing_a_session_updates_value_and_writes_audit_row() {
    let s = completed_focus_store();
    s.update_session(1, SessionPatch { intention: Some("Spec corretta".into()), ..Default::default() }, 9_000).unwrap();
    assert_eq!(s.get_session(1).unwrap().unwrap().intention, "Spec corretta");
    let edits = s.session_edits(1).unwrap();
    assert_eq!((edits[0].field.as_str(), edits[0].old_value.as_deref()), ("intention", Some("Spec")));
}

#[test]
fn manual_session_requires_closed_interval() {
    let s = store();
    let err = s.create_manual_session(manual_request(2_000, 1_000), 3_000).unwrap_err();
    assert!(matches!(err, CoreError::InvalidState(_)));
}
```

- [ ] **Step 2: Verificare il fallimento**

Run: `cargo test -p win-buddy-core editing_a_session_updates_value_and_writes_audit_row`

Expected: FAIL.

- [ ] **Step 3: Aggiungere schema audit**

```sql
CREATE TABLE pomodoro_session_edits (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES pomodoro_sessions(id) ON DELETE CASCADE,
  changed_at INTEGER NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT
);
CREATE INDEX idx_pomo_edits_session ON pomodoro_session_edits(session_id,changed_at);
PRAGMA user_version = 5;
```

Nella stessa transazione aggiornare anche `settings['schema.version']` a `5`.

- [ ] **Step 4: Implementare whitelist e transazione**

`SessionPatch` espone soltanto `intention`, `category`, `started_at`, `resolved_at`, `planned_duration_ms`, `estimated_ms`, `next_step`, `outcome`, `interruption_reason`. Validare `started_at < resolved_at`, durata reale non negativa e sessione chiusa. Per ogni valore cambiato inserire una riga audit e aggiornare la sessione nella stessa transazione.

Definire inoltre il tipo usato dall'inserimento manuale:

```rust
pub struct ManualSessionRequest {
    pub started_at: i64,
    pub resolved_at: i64,
    pub intention: String,
    pub category: Option<String>,
    pub estimated_ms: Option<i64>,
    pub outcome: SessionOutcome,
}
```

In `test_support.rs` creare helper riusabili dai moduli test:

```rust
pub(crate) fn manual_request(started_at: i64, resolved_at: i64) -> ManualSessionRequest {
    ManualSessionRequest {
        started_at,
        resolved_at,
        intention: "Spec".into(),
        category: Some("Lavoro".into()),
        estimated_ms: Some(25 * 60_000),
        outcome: SessionOutcome::Completed,
    }
}

pub(crate) fn completed_focus_store() -> Store {
    let s = Store::open_in_memory().unwrap();
    s.create_manual_session(manual_request(0, 25 * 60_000), 25 * 60_000).unwrap();
    s
}
```

Esportare il modulo soltanto nei test con `#[cfg(test)] pub(crate) mod test_support;`.

- [ ] **Step 5: Eseguire suite core**

Run: `cargo test -p win-buddy-core`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/core/src/migrations.rs crates/core/sql/schema.sql docs/sql/schema.sql crates/core/src/model.rs crates/core/src/store.rs crates/core/src/test_support.rs crates/core/src/lib.rs
git commit -m "feat(history): add audited session corrections"
```

### Task 2: API Registro e interfaccia di correzione

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `ui/shared/contracts.ts`
- Modify: `ui/shared/ipc.ts`
- Modify: `ui/panel/index.html`
- Modify: `ui/panel/main.ts`
- Modify: `ui/panel/panel.css`
- Create: `ui/panel/history-controller.ts`
- Test: `tests/history-controller.test.ts`

**Interfaces:**
- Consumes: `SessionPatch`, `update_session`, `create_manual_session`.
- Produces: `focus_history_query`, `focus_session_update`, `focus_session_create` e dialog accessibile.

- [ ] **Step 1: Testare validazione client per feedback immediato**

```ts
test("history editor rejects an end before start", () => {
  const result = validateSessionEdit({ startedAt: 5_000, resolvedAt: 4_000, outcome: "completed" });
  assert.deepEqual(result, { field: "resolvedAt", message: "La fine deve essere successiva all’inizio." });
});
```

- [ ] **Step 2: Verificare il fallimento**

Run: `node --test tests/history-controller.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implementare comandi con validazione server**

```rust
#[tauri::command]
pub fn focus_session_update(
    state: State<AppState>, id: i64, patch: SessionPatchDto
) -> CmdResult<PomodoroSession> {
    state.store.lock().unwrap().update_session(id, patch.try_into()?, now_ms()).map_err(err)
}
```

La shell converte date locali in epoch usando le funzioni esistenti; il core ripete tutte le validazioni.

- [ ] **Step 4: Implementare Registro**

Ogni riga mostra data/ora, intenzione, focus reale, esito e numero interruzioni. Il pulsante Modifica apre un `<dialog>` con etichette visibili; Inserisci sessione usa lo stesso form vuoto. Salva resta disabilitato finché `validateSessionEdit` restituisce errore. Nessuna eliminazione rapida nella lista.

- [ ] **Step 5: Verificare test e layout**

Run: `npm run test:ui`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

Verificare tastiera completa del dialog e layout a 320 × 420.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs ui/shared/contracts.ts ui/shared/ipc.ts ui/panel/index.html ui/panel/main.ts ui/panel/panel.css ui/panel/history-controller.ts tests/history-controller.test.ts
git commit -m "feat(history): add editable focus register"
```

### Task 3: Motore analytics e indici

**Files:**
- Create: `crates/core/src/analytics.rs`
- Modify: `crates/core/src/lib.rs`
- Modify: `crates/core/sql/schema.sql`
- Modify: `docs/sql/schema.sql`
- Modify: `crates/core/src/store.rs`
- Test: `crates/core/src/analytics.rs` (`#[cfg(test)]`)

**Interfaces:**
- Consumes: `Store`, intervallo `[from_ms, to_ms)`, granularità e filtri opzionali.
- Produces: `FocusStats`, `FocusBucket`, `OutcomeCount`, `EstimateAccuracy`, `InterruptionCount`.

- [ ] **Step 1: Scrivere dataset e asserzioni aggregate**

```rust
use crate::test_support::{analytics_store, estimated_store};
const MIN: i64 = 60_000;
const DAY: i64 = 24 * 60 * MIN;

#[test]
fn stats_use_actual_time_and_group_outcomes() {
    let s = analytics_store();
    let stats = query(&s, StatsQuery::new(0, DAY, Granularity::Day)).unwrap();
    assert_eq!(stats.actual_focus_ms, 30 * MIN);
    assert_eq!(stats.outcomes.completed, 1);
    assert_eq!(stats.outcomes.partial, 1);
    assert_eq!(stats.interruptions.total, 2);
}

#[test]
fn estimate_delta_is_real_minus_estimated() {
    let stats = query(&estimated_store(), StatsQuery::new(0, DAY, Granularity::Day)).unwrap();
    assert_eq!(stats.estimate.delta_ms, -5 * MIN);
}
```

Aggiungere a `test_support.rs` fixture deterministiche costruite soltanto con API pubbliche:

```rust
pub(crate) fn analytics_store() -> Store {
    let s = Store::open_in_memory().unwrap();
    let first = pomodoro::start(&s, StartSession::focus(1, "Spec", 25 * MIN), 0).unwrap().session;
    pomodoro::pause(&s, first.id, 0, 5 * MIN, None).unwrap();
    pomodoro::resume(&s, first.id, 1, 10 * MIN).unwrap();
    s.capture_interruption(first.id, InterruptionKind::Thought, "Marta", 12 * MIN).unwrap();
    pomodoro::finish(&s, first.id, 2, SessionOutcome::Completed, None, 25 * MIN).unwrap();

    let second = pomodoro::start(&s, StartSession::focus(1, "Mail", 25 * MIN), 30 * MIN).unwrap().session;
    s.capture_interruption(second.id, InterruptionKind::Notification, "Email", 32 * MIN).unwrap();
    pomodoro::finish(&s, second.id, 0, SessionOutcome::Partial, None, 40 * MIN).unwrap();
    s
}

pub(crate) fn estimated_store() -> Store {
    let s = Store::open_in_memory().unwrap();
    let mut request = StartSession::focus(1, "Spec", 25 * MIN);
    request.estimated_ms = Some(25 * MIN);
    let session = pomodoro::start(&s, request, 0).unwrap().session;
    pomodoro::finish(&s, session.id, 0, SessionOutcome::Partial, None, 20 * MIN).unwrap();
    s
}
```

- [ ] **Step 2: Verificare il fallimento**

Run: `cargo test -p win-buddy-core analytics::tests::stats_use_actual_time_and_group_outcomes`

Expected: FAIL.

- [ ] **Step 3: Implementare query e tipi**

```rust
pub struct StatsQuery {
    pub from_ms: i64,
    pub to_ms: i64,
    pub granularity: Granularity,
    pub category: Option<String>,
    pub preset_id: Option<i64>,
}

pub struct FocusStats {
    pub actual_focus_ms: i64,
    pub paused_ms: i64,
    pub outcomes: OutcomeCount,
    pub estimate: EstimateAccuracy,
    pub interruptions: InterruptionCount,
    pub buckets: Vec<FocusBucket>,
}
```

Usare intervalli half-open e query parametrizzate. Aggiungere indici su `(kind,resolved_at,outcome)`, `category` e `preset_id`. Le sessioni invalidate non contribuiscono al tempo, ma compaiono nel conteggio esiti.

- [ ] **Step 4: Testare dataset pluriennale sintetico**

Inserire 20.000 sessioni in memoria e misurare la query annuale in un test ignorato:

```rust
#[test]
#[ignore]
fn annual_query_stays_under_200_ms_on_reference_machine() {
    let s = Store::open_in_memory().unwrap();
    for i in 0..20_000 {
        let start = i * 30 * MIN;
        s.create_manual_session(manual_request(start, start + 25 * MIN), start + 25 * MIN).unwrap();
    }
    let before = std::time::Instant::now();
    let stats = query(&s, StatsQuery::new(0, 365 * DAY, Granularity::Month)).unwrap();
    assert_eq!(stats.outcomes.completed, 17_520);
    assert!(before.elapsed() < std::time::Duration::from_millis(200));
}
```

Run: `cargo test -p win-buddy-core annual_query_stays_under_200_ms_on_reference_machine -- --ignored`

Expected: PASS sulla macchina di riferimento; registrare il tempo nel messaggio di commit o PR.

- [ ] **Step 5: Eseguire suite**

Run: `cargo test -p win-buddy-core`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/core/src/analytics.rs crates/core/src/lib.rs crates/core/sql/schema.sql docs/sql/schema.sql crates/core/src/store.rs
git commit -m "feat(analytics): aggregate real focus time and outcomes"
```

### Task 4: Vista Statistiche

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `ui/shared/contracts.ts`
- Modify: `ui/shared/ipc.ts`
- Modify: `ui/panel/index.html`
- Modify: `ui/panel/main.ts`
- Modify: `ui/panel/panel.css`
- Create: `ui/panel/stats-controller.ts`
- Test: `tests/stats-controller.test.ts`

**Interfaces:**
- Consumes: `FocusStats` della Task 3.
- Produces: selettore giorno/settimana/mese/anno, grafico compatto e riepiloghi accessibili.

- [ ] **Step 1: Testare intervalli civili e label**

```ts
test("week range starts Monday in local time", () => {
  const range = localRange("week", new Date("2026-09-02T12:00:00+02:00"));
  assert.equal(new Date(range.fromMs).getDay(), 1);
  assert.equal(range.toMs - range.fromMs, 7 * 24 * 60 * 60_000);
});
```

Per settimane che attraversano l'ora legale, asserire invece le date locali di inizio/fine, non 168 ore.

- [ ] **Step 2: Verificare il fallimento**

Run: `node --test tests/stats-controller.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implementare range e chiamata**

`localRange` costruisce mezzanotte locale con `new Date(y,m,d)` e passa epoch al core. `focus_stats_query` accetta solo range positivi entro dieci anni e granularità enum.

- [ ] **Step 4: Renderizzare senza dashboard ridondante**

Mostrare focus reale, distribuzione temporale a barre, esiti, delta previsto/reale e interruzioni. Usare elementi HTML/SVG con testo alternativo; categorie e preset sono filtri facoltativi, non progetti. Se non ci sono dati, mostrare una sola frase e nessun grafico vuoto.

- [ ] **Step 5: Verificare test, screen reader summary e layout**

Run: `npm run test:ui`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

Verificare a 380 × 640 e 320 × 420 che barre e label non si sovrappongano e che il riepilogo testuale contenga gli stessi numeri.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs ui/shared/contracts.ts ui/shared/ipc.ts ui/panel/index.html ui/panel/main.ts ui/panel/panel.css ui/panel/stats-controller.ts tests/stats-controller.test.ts
git commit -m "feat(panel): add focus statistics views"
```

### Task 5: Export CSV e JSON versionato

**Files:**
- Create: `crates/core/src/export.rs`
- Modify: `crates/core/src/lib.rs`
- Modify: `crates/core/Cargo.toml`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/capabilities/default.json`
- Modify: `package.json`
- Modify: `ui/shared/ipc.ts`
- Modify: `ui/panel/main.ts`
- Test: `crates/core/src/export.rs` (`#[cfg(test)]`)

**Interfaces:**
- Consumes: sessioni, pause, interruzioni e preset.
- Produces: `export_csv(store, query) -> Vec<u8>` e `export_json(store, query) -> Vec<u8>`.

- [ ] **Step 1: Scrivere golden test piccoli**

```rust
use crate::test_support::analytics_store;

#[test]
fn csv_has_one_row_per_session_and_real_duration() {
    let bytes = export_csv(&analytics_store(), ExportQuery::all()).unwrap();
    let text = String::from_utf8(bytes).unwrap();
    assert!(text.starts_with("id,kind,started_at,resolved_at,planned_ms,actual_ms"));
    assert_eq!(text.lines().count(), 3); // header + due sessioni
    assert!(text.contains(",1200000,")); // 20 minuti reali
}

#[test]
fn json_declares_schema_and_relations() {
    let value: serde_json::Value = serde_json::from_slice(&export_json(&analytics_store(), ExportQuery::all()).unwrap()).unwrap();
    assert_eq!(value["schema_version"], 1);
    assert!(value["sessions"].is_array());
    assert!(value["pause_intervals"].is_array());
    assert!(value["interruptions"].is_array());
}
```

- [ ] **Step 2: Verificare il fallimento**

Run: `cargo test -p win-buddy-core export::tests`

Expected: FAIL.

- [ ] **Step 3: Implementare serializzazione**

Aggiungere `csv = "1"` al core. CSV usa UTF-8, header stabili e RFC 3339 UTC oltre agli epoch ms. JSON usa una struct `FocusExportV1`, non `serde_json::Value`, per mantenere il contratto compilabile.

- [ ] **Step 4: Collegare file picker e scrittura atomica**

Aggiungere `tauri-plugin-dialog = "2"` alla shell e `@tauri-apps/plugin-dialog` al frontend con permessi minimi. Il picker restituisce un path scelto dall'utente; Rust scrive prima `.<nome>.tmp` nello stesso parent e rinomina solo dopo `sync_all`. Non accettare directory o path non selezionati dal picker.

- [ ] **Step 5: Verificare file prodotti**

Run: `cargo test -p win-buddy-core export::tests`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

Esportare CSV e JSON in una directory temporanea scelta dal picker; riaprire entrambi e confrontare conteggio sessioni e durata totale con il pannello.

- [ ] **Step 6: Commit**

```bash
git add crates/core/src/export.rs crates/core/src/lib.rs crates/core/Cargo.toml src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/capabilities/default.json package.json package-lock.json ui/shared/ipc.ts ui/panel/main.ts
git commit -m "feat(data): export focus history as CSV and JSON"
```

### Task 6: Backup, restore e cancellazione completa

**Files:**
- Modify: `crates/core/Cargo.toml`
- Modify: `crates/core/src/store.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `ui/shared/ipc.ts`
- Modify: `ui/panel/index.html`
- Modify: `ui/panel/main.ts`
- Modify: `ui/panel/panel.css`
- Test: `crates/core/src/store.rs`

**Interfaces:**
- Consumes: path esplicitamente scelto e store bloccato da `AppState`.
- Produces: `backup_to`, `restore_from`, `clear_user_data` e UI di conferma.

- [ ] **Step 1: Scrivere test backup/restore e rollback**

```rust
use crate::test_support::{populated_store, temp_file_with_bytes};

#[test]
fn restore_rejects_corrupt_database_without_changing_live_data() {
    let mut live = populated_store();
    let before = live.counts().unwrap();
    let bad = temp_file_with_bytes(b"not sqlite");
    assert!(live.restore_from(&bad).is_err());
    assert_eq!(live.counts().unwrap(), before);
}

#[test]
fn clear_user_data_keeps_schema_and_default_settings() {
    let mut s = populated_store();
    s.clear_user_data().unwrap();
    assert_eq!(s.session_history(10).unwrap().len(), 0);
    assert_eq!(s.setting_i64("schema.version", 0), 5);
}
```

Completare `test_support.rs` con path isolati e recuperabili:

```rust
static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);

pub(crate) fn temp_path(suffix: &str) -> PathBuf {
    let n = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("win-buddy-test-{}-{n}-{suffix}", std::process::id()))
}

pub(crate) fn temp_file_with_bytes(bytes: &[u8]) -> PathBuf {
    let path = temp_path("input.db");
    std::fs::write(&path, bytes).unwrap();
    path
}

pub(crate) fn populated_store() -> Store {
    let path = temp_path("live.db");
    let s = Store::open(&path).unwrap();
    s.insert_note("Marta", None, false, 1_000).unwrap();
    s.create_manual_session(manual_request(0, 25 * 60_000), 25 * 60_000).unwrap();
    s
}
```

Ogni test rimuove soltanto i path esatti restituiti da `temp_path` al termine; nessuna cancellazione ricorsiva.

- [ ] **Step 2: Verificare il fallimento**

Run: `cargo test -p win-buddy-core restore_rejects_corrupt_database_without_changing_live_data`

Expected: FAIL.

- [ ] **Step 3: Implementare backup e restore SQLite**

Abilitare feature rusqlite `backup`. `backup_to` usa l'API SQLite backup su un file esatto. `restore_from` apre il candidato read-only, richiede `PRAGMA integrity_check = ok` e `user_version <= 5`, quindi copia nel database vivo sotto mutex. Non chiudere o sostituire file tramite glob.

- [ ] **Step 4: Implementare cancellazione in transazione**

Eliminare righe utente in ordine di foreign key e ripristinare preset/impostazioni predefinite; mantenere schema e versione. Il comando richiede la stringa esatta `CANCELLA` validata sia in UI sia in Rust.

- [ ] **Step 5: Collegare UI Dati**

In Impostazioni → Dati aggiungere Mostra dati memorizzati, Esporta, Backup, Ripristina e Cancella tutto. Restore mostra riepilogo file prima della conferma. Dopo restore/cancellazione emettere eventi di refresh per note, Focus e impostazioni.

- [ ] **Step 6: Verificare suite e round trip**

Run: `cargo test --workspace`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

Creare backup, aggiungere una sessione, ripristinare e verificare che la sessione aggiunta dopo il backup scompaia mentre note, preset e storico del backup ritornano.

- [ ] **Step 7: Commit**

```bash
git add crates/core/Cargo.toml crates/core/src/store.rs src-tauri/src/commands.rs src-tauri/src/lib.rs ui/shared/ipc.ts ui/panel/index.html ui/panel/main.ts ui/panel/panel.css
git commit -m "feat(data): add verified backup restore and deletion"
```

## Completion Gate

- Registro modificabile e inserimento manuale conservano un audit.
- Giorno/settimana/mese/anno mostrano focus reale, esiti, stime e interruzioni.
- CSV e JSON rappresentano gli stessi dati del pannello.
- Backup corrotto o futuro viene rifiutato prima di toccare lo store vivo.
- La cancellazione lascia un database valido con default e nessun dato utente.
- `cargo test --workspace`, `npm run test:ui` e `npm run build` passano.
