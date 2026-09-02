# Pomodoro P0 Intent and Interruptions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aggiungere intenzione, stima, recenti/preferiti, prossimo passo e cattura classificata delle interruzioni senza spezzare il focus.

**Architecture:** Intenzione e stima appartengono alla sessione; i preset recenti si derivano dall'uso e i preferiti sono una proprietà esplicita. La cattura riusa la finestra esistente: crea una nota e, nella stessa transazione, un collegamento leggero alla sessione corrente.

**Tech Stack:** Rust 2021, rusqlite 0.32, Tauri 2, TypeScript 5.9, HTML/CSS

**Spec:** `docs/superpowers/specs/2026-09-02-pomodoro-p0-design.md`

## Global Constraints

- Dipende dai piani Core Engine e Buddy/Surfaces completati.
- La cattura non deve cambiare la finestra di lavoro attiva più del comportamento già previsto dalla superficie rapida.
- Il testo della cattura vive in `notes`; `pomodoro_interruptions` conserva solo relazione e categoria.
- Categorie ammesse: `thought`, `notification`, `person`, `call`, `technical`.
- Intenzione, stima, categoria e prossimo passo sono facoltativi; l'avvio rapido resta sempre disponibile.
- Nessun titolo finestra o nome applicazione viene rilevato automaticamente.

---

### Task 1: Migrazione v3 e repository delle interruzioni

**Files:**
- Modify: `crates/core/src/migrations.rs`
- Modify: `crates/core/sql/schema.sql`
- Modify: `docs/sql/schema.sql`
- Modify: `crates/core/src/model.rs`
- Modify: `crates/core/src/store.rs`
- Create: `crates/core/tests/fixtures/schema-v2.sql`
- Test: `crates/core/src/migrations.rs`
- Test: `crates/core/src/store.rs`

**Interfaces:**
- Consumes: schema v2 e `Note`/`PomodoroSession`.
- Produces: `InterruptionKind`, `PomodoroInterruption`, `capture_interruption`, `session_interruptions`, preset favoriti/recente.

- [ ] **Step 1: Scrivere test di migrazione e transazione**

```rust
fn v2_connection() -> Connection {
    let mut conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(include_str!("../tests/fixtures/schema-v2.sql")).unwrap();
    conn
}

#[test]
fn migrates_v2_to_interruptions_without_touching_sessions() {
    let mut conn = v2_connection();
    apply(&mut conn).unwrap();
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    let tables: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='pomodoro_interruptions'",
        [], |r| r.get(0)
    ).unwrap();
    assert_eq!((version, tables), (3, 1));
}

#[test]
fn capture_creates_note_and_interruption_atomically() {
    let s = Store::open_in_memory().unwrap();
    let session = s.start_focus(StartSession::focus(1, "Spec", 25 * 60_000), 0).unwrap();
    let captured = s.capture_interruption(
        session.id, InterruptionKind::Thought, "Scrivere a Marta", 4_000
    ).unwrap();
    assert_eq!(s.get_note(captured.note_id).unwrap().unwrap().body, "Scrivere a Marta");
    assert_eq!(s.session_interruptions(session.id).unwrap().len(), 1);
}
```

- [ ] **Step 2: Verificare il fallimento**

Run: `cargo test -p win-buddy-core migrates_v2_to_interruptions_without_touching_sessions`

Expected: FAIL.

Run: `cargo test -p win-buddy-core capture_creates_note_and_interruption_atomically`

Expected: FAIL.

- [ ] **Step 3: Implementare schema e tipi**

```sql
ALTER TABLE pomodoro_presets ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0
  CHECK(is_favorite IN (0,1));
ALTER TABLE pomodoro_presets ADD COLUMN last_used_at INTEGER;

CREATE TABLE pomodoro_interruptions (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES pomodoro_sessions(id) ON DELETE CASCADE,
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK(kind IN ('thought','notification','person','call','technical')),
  captured_at INTEGER NOT NULL
);
CREATE INDEX idx_pomo_interruptions_session
  ON pomodoro_interruptions(session_id,captured_at);
PRAGMA user_version = 3;
```

Nella stessa transazione aggiornare anche `settings['schema.version']` a `3`.

```rust
pub enum InterruptionKind { Thought, Notification, Person, Call, Technical }

pub struct PomodoroInterruption {
    pub id: i64,
    pub session_id: i64,
    pub note_id: i64,
    pub kind: InterruptionKind,
    pub captured_at: i64,
}
```

Estendere `PomodoroPreset` con `is_favorite: bool` e `last_used_at: Option<i64>` e aggiornare il mapper SQLite; nessun chiamante deve leggere colonne per indice numerico.

- [ ] **Step 4: Implementare la transazione repository**

`capture_interruption` deve verificare che la sessione sia focus e aperta, inserire la nota con `urgent = 0`, inserire la relazione e fare commit. In caso di categoria invalida o sessione chiusa, nessuna delle due righe deve esistere.

- [ ] **Step 5: Eseguire suite core**

Run: `cargo test -p win-buddy-core`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/core/src/migrations.rs crates/core/sql/schema.sql docs/sql/schema.sql crates/core/src/model.rs crates/core/src/store.rs crates/core/tests/fixtures/schema-v2.sql
git commit -m "feat(focus): persist intentions and interruptions"
```

### Task 2: Modalità focus della finestra di cattura

**Files:**
- Modify: `src-tauri/src/state.rs:14-61`
- Modify: `src-tauri/src/surfaces.rs:380-435`
- Modify: `src-tauri/src/commands.rs:130-260`
- Modify: `src-tauri/src/lib.rs:42-75`
- Modify: `ui/shared/contracts.ts`
- Modify: `ui/shared/ipc.ts`
- Modify: `ui/capture/index.html`
- Modify: `ui/capture/main.ts`
- Modify: `ui/capture/capture.css`
- Test: `src-tauri/src/commands.rs` (`#[cfg(test)]`)

**Interfaces:**
- Consumes: `Store::capture_interruption` e sessione aperta.
- Produces: `open_focus_capture`, `CaptureContext`, `capture_submit(text, kind)`.

- [ ] **Step 1: Testare la risoluzione del contesto**

```rust
#[test]
fn focus_capture_defaults_to_thought_and_active_session() {
    let context = resolve_capture_context(Some(42), None);
    assert_eq!(context.session_id, Some(42));
    assert_eq!(context.kind, InterruptionKind::Thought);
}
```

- [ ] **Step 2: Verificare il fallimento**

Run: `cargo test -p win-buddy commands::tests::focus_capture_defaults_to_thought_and_active_session`

Expected: FAIL.

- [ ] **Step 3: Aggiungere contesto esplicito nello stato shell**

```rust
pub struct CaptureContext {
    pub session_id: Option<i64>,
    pub kind: InterruptionKind,
}

pub capture_context: Mutex<CaptureContext>,
```

`open_focus_capture` legge la sessione aperta, imposta il contesto e apre la superficie. `open_capture` normale azzera `session_id` per non classificare una nota comune come interruzione.

- [ ] **Step 4: Estendere submit e UI**

Quando `session_id` è presente, mostrare una riga di radio button raggiungibile da tastiera:

```html
<fieldset id="interruptionKinds" hidden>
  <legend>Che cosa ti ha interrotto?</legend>
  <label><input type="radio" name="kind" value="thought" checked /> Pensiero</label>
  <label><input type="radio" name="kind" value="notification" /> Notifica</label>
  <label><input type="radio" name="kind" value="person" /> Persona</label>
  <label><input type="radio" name="kind" value="call" /> Telefonata</label>
  <label><input type="radio" name="kind" value="technical" /> Problema tecnico</label>
</fieldset>
```

Invio salva; Escape annulla; dopo il salvataggio il focus torna all'applicazione precedente come già avviene oggi. Il core ignora un `session_id` client-provided e usa il contesto salvato nella shell.

- [ ] **Step 5: Verificare build e flusso manuale**

Run: `cargo test -p win-buddy`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

Avviare un focus, usare il pulsante Cattura, salvare “Scrivere a Marta” come Pensiero e verificare che appaia in Aperte senza fermare il timer.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/state.rs src-tauri/src/surfaces.rs src-tauri/src/commands.rs src-tauri/src/lib.rs ui/shared/contracts.ts ui/shared/ipc.ts ui/capture/index.html ui/capture/main.ts ui/capture/capture.css
git commit -m "feat(capture): attach interruptions to active focus"
```

### Task 3: Preparazione con intenzione, stima e preset recenti

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `ui/shared/contracts.ts`
- Modify: `ui/shared/ipc.ts`
- Modify: `ui/panel/index.html`
- Modify: `ui/panel/main.ts`
- Modify: `ui/panel/panel.css`
- Modify: `ui/panel/focus-controller.ts`
- Test: `tests/focus-controller.test.ts`

**Interfaces:**
- Consumes: `focus_start(StartFocusDto)`, `list_presets`, `favorite_preset`.
- Produces: form Prepara completo e avvio rapido ultimo preset.

- [ ] **Step 1: Testare normalizzazione stima e override**

```ts
test("one-off duration does not mutate the selected preset", () => {
  const request = startRequest({
    presetId: 2,
    presetMinutes: 50,
    overrideMinutes: 35,
    estimate: { unit: "pomodoros", value: 3 },
  });
  assert.equal(request.plannedDurationMs, 35 * 60_000);
  assert.equal(request.estimatedMs, 3 * 50 * 60_000);
  assert.equal(request.updatePreset, false);
});
```

- [ ] **Step 2: Verificare il fallimento**

Run: `node --test tests/focus-controller.test.ts`

Expected: FAIL per `startRequest` mancante.

- [ ] **Step 3: Implementare DTO e comandi preset**

```ts
export interface StartFocusRequest {
  presetId: number | null;
  intention: string;
  category: string | null;
  plannedDurationMs: number;
  estimatedMs: number | null;
  nextStep: string | null;
}

export interface StartRequestInput {
  presetId: number | null;
  presetMinutes: number;
  overrideMinutes: number | null;
  estimate: { unit: "minutes" | "pomodoros"; value: number } | null;
  intention?: string;
  category?: string | null;
  nextStep?: string | null;
}

export function startRequest(input: StartRequestInput): StartFocusRequest & { updatePreset: false } {
  const plannedMinutes = input.overrideMinutes ?? input.presetMinutes;
  return {
    presetId: input.presetId,
    intention: input.intention?.trim() ?? "",
    category: input.category ?? null,
    plannedDurationMs: plannedMinutes * 60_000,
    estimatedMs: input.estimate === null
      ? null
      : input.estimate.value
        * (input.estimate.unit === "pomodoros" ? input.presetMinutes : 1)
        * 60_000,
    nextStep: input.nextStep?.trim() || null,
    updatePreset: false,
  };
}
```

Il comando Rust valida durata 1–240 minuti, testi trim e massimo 240 caratteri per intenzione/prossimo passo. All'avvio aggiorna `last_used_at`; il comando preferito modifica soltanto `is_favorite`.

- [ ] **Step 4: Completare Prepara**

Ordine dei controlli: intenzione, selettore preset con preferiti e recenti, durata una tantum, stima, categoria, prossimo passo, Avvia. Premere Invio dall'intenzione avvia con il preset corrente. Il pulsante primario del buddy inattivo chiama `focus_start_last`; se non esiste storico usa il preset predefinito.

- [ ] **Step 5: Verificare test e layout**

Run: `npm run test:ui`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

Verificare 380 × 640 e 320 × 420: il bottone Avvia resta raggiungibile senza sovrapposizioni; lo scroll è soltanto del contenuto del pannello.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs ui/shared/contracts.ts ui/shared/ipc.ts ui/panel/index.html ui/panel/main.ts ui/panel/panel.css ui/panel/focus-controller.ts tests/focus-controller.test.ts
git commit -m "feat(panel): add focus intention estimate and presets"
```

### Task 4: Restituzione delle catture, pausa e segnalibro di rientro

**Files:**
- Modify: `crates/core/src/store.rs`
- Modify: `src-tauri/src/presenter.rs:80-155`
- Modify: `src-tauri/src/commands.rs`
- Modify: `ui/shared/contracts.ts`
- Modify: `ui/panel/main.ts`
- Modify: `ui/overlay/bubbles.ts`
- Test: `crates/core/src/store.rs`
- Test: `tests/focus-view-model.test.ts`

**Interfaces:**
- Consumes: interruzioni della Task 1, `next_step`, eventi `ready_to_close` e `break_completed`.
- Produces: `pending_capture_summary(session_id)` e prompt di rientro non invasivo.

- [ ] **Step 1: Testare il riepilogo senza chiudere le note**

```rust
fn store_with_three_interruptions() -> Store {
    let s = Store::open_in_memory().unwrap();
    let session = s.start_focus(StartSession::focus(1, "Spec", 25 * 60_000), 0).unwrap();
    s.capture_interruption(session.id, InterruptionKind::Thought, "Marta", 1_000).unwrap();
    s.capture_interruption(session.id, InterruptionKind::Thought, "Preventivo", 2_000).unwrap();
    s.capture_interruption(session.id, InterruptionKind::Person, "Collega", 3_000).unwrap();
    s
}

#[test]
fn capture_summary_counts_kinds_and_leaves_notes_open() {
    let s = store_with_three_interruptions();
    let summary = s.pending_capture_summary(1).unwrap();
    assert_eq!(summary.total, 3);
    assert_eq!(summary.by_kind.get(&InterruptionKind::Thought), Some(&2));
    assert_eq!(s.open_notes().unwrap().len(), 3);
}
```

- [ ] **Step 2: Verificare il fallimento**

Run: `cargo test -p win-buddy-core capture_summary_counts_kinds_and_leaves_notes_open`

Expected: FAIL.

- [ ] **Step 3: Implementare riepilogo e payload**

```ts
export interface CaptureSummary {
  total: number;
  byKind: Partial<Record<InterruptionKind, number>>;
}
```

Il presenter non mostra i testi nella celebrazione. La nuvoletta di chiusura aggiunge soltanto “3 catture in attesa”. Focus → Registro espone il dettaglio e apre la nota nella normale scheda Aperte.

- [ ] **Step 4: Implementare il rientro**

All'avvio della pausa mostrare una sola proposta breve scelta ciclicamente da un elenco locale: “Alzati”, “Bevi un po’ d’acqua”, “Guarda lontano”, “Respira”, “Fai due passi”, “Non fare nulla”. Non imporre esercizi o countdown secondari.

Alla conclusione della pausa, il presenter usa un evento durevole `return_prompt` con intenzione e `next_step`. Il controllo principale è Riprendi; Apri Focus è secondario. Se il buddy è nascosto, usare notifica o tray con lo stesso evento ID.

- [ ] **Step 5: Verificare tutto il flusso**

Run: `cargo test --workspace`

Expected: PASS.

Run: `npm run test:ui`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

Test manuale: catturare due pensieri, chiudere come parziale, avviare la pausa, vedere solo il conteggio; alla fine vedere intenzione e prossimo passo; le due note restano in Aperte.

- [ ] **Step 6: Commit**

```bash
git add crates/core/src/store.rs src-tauri/src/presenter.rs src-tauri/src/commands.rs ui/shared/contracts.ts ui/panel/main.ts ui/overlay/bubbles.ts tests/focus-view-model.test.ts
git commit -m "feat(focus): return captures and next step after break"
```

### Task 5: Gestione preset e automazioni indipendenti

**Files:**
- Modify: `crates/core/src/pomodoro.rs`
- Modify: `crates/core/src/store.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `ui/shared/contracts.ts`
- Modify: `ui/shared/ipc.ts`
- Modify: `ui/panel/index.html`
- Modify: `ui/panel/main.ts`
- Modify: `ui/panel/panel.css`
- Test: `crates/core/src/pomodoro.rs`
- Test: `tests/focus-controller.test.ts`

**Interfaces:**
- Consumes: `PomodoroPreset` schema v3.
- Produces: CRUD preset, riordino, default unico e policy separate `auto_start_break`/`auto_start_focus`.

- [ ] **Step 1: Testare automazioni non accoppiate**

```rust
fn preset_with_auto(auto_start_break: bool, auto_start_focus: bool) -> PomodoroPreset {
    PomodoroPreset {
        id: 1,
        name: "Classico".into(),
        focus_ms: 25 * 60_000,
        short_break_ms: 5 * 60_000,
        long_break_ms: 20 * 60_000,
        long_every: 4,
        auto_start_break,
        auto_start_focus,
        is_default: true,
        is_favorite: true,
        sort_order: 0,
        last_used_at: None,
        created_at: 0,
        updated_at: 0,
    }
}

#[test]
fn auto_start_flags_are_independent() {
    let break_only = preset_with_auto(true, false);
    assert_eq!(next_after_focus(&break_only), NextStep::StartBreak);
    assert_eq!(next_after_break(&break_only), NextStep::PromptFocus);

    let focus_only = preset_with_auto(false, true);
    assert_eq!(next_after_focus(&focus_only), NextStep::PromptBreak);
    assert_eq!(next_after_break(&focus_only), NextStep::StartFocus);
}

#[test]
fn deleting_default_preset_is_rejected() {
    let s = Store::open_in_memory().unwrap();
    let id = s.default_preset().unwrap().id;
    assert!(matches!(s.delete_preset(id), Err(CoreError::InvalidState(_))));
}
```

- [ ] **Step 2: Verificare il fallimento**

Run: `cargo test -p win-buddy-core auto_start_flags_are_independent`

Expected: FAIL.

Run: `cargo test -p win-buddy-core deleting_default_preset_is_rejected`

Expected: FAIL.

- [ ] **Step 3: Implementare repository e policy**

```rust
pub enum NextStep { PromptBreak, StartBreak, PromptFocus, StartFocus }

pub fn next_after_focus(preset: &PomodoroPreset) -> NextStep {
    if preset.auto_start_break { NextStep::StartBreak } else { NextStep::PromptBreak }
}

pub fn next_after_break(preset: &PomodoroPreset) -> NextStep {
    if preset.auto_start_focus { NextStep::StartFocus } else { NextStep::PromptFocus }
}
```

Implementare `create_preset`, `update_preset`, `delete_preset`, `reorder_presets`, `set_default_preset`. Validare nomi unici e non vuoti, durate 1–240 minuti e `long_every` 2–12. Cambiare default in una sola transazione; non cancellare il default né l'ultimo preset.

- [ ] **Step 4: Esporre API e pannello Impostazioni**

Aggiungere `focus_presets_list/create/update/delete/reorder/set_default`. In Impostazioni → Preset e automazioni ogni preset mostra nome, durate, pausa lunga ogni N, preferito/default e due switch distinti. Salva con un unico comando; l'override una tantum resta soltanto in Prepara.

- [ ] **Step 5: Collegare la policy al ciclo**

Dopo `finish`, il presenter applica soltanto `next_after_focus`; dopo fine/skip pausa applica `next_after_break`. Le automazioni possono essere fermate da qualunque superficie e non saltano il prompt di recupero dopo un crash.

- [ ] **Step 6: Verificare suite e layout**

Run: `cargo test --workspace`

Expected: PASS.

Run: `npm run test:ui`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

Verificare a 380 × 640 e 320 × 420 che aggiunta, modifica e riordino siano raggiungibili da tastiera e che i due switch rimangano indipendenti.

- [ ] **Step 7: Commit**

```bash
git add crates/core/src/pomodoro.rs crates/core/src/store.rs src-tauri/src/commands.rs src-tauri/src/lib.rs ui/shared/contracts.ts ui/shared/ipc.ts ui/panel/index.html ui/panel/main.ts ui/panel/panel.css tests/focus-controller.test.ts
git commit -m "feat(settings): manage focus presets and automation"
```

## Completion Gate

- Avvio rapido e avvio preparato convivono senza modifiche involontarie ai preset.
- Preset salvabili e automazioni focus/pausa sono configurabili separatamente.
- Una cattura durante il focus crea una nota e un solo evento associato, senza fermare il timer.
- Catture e prossimo passo ricompaiono soltanto a chiusura/pausa/rientro.
- Nessun dato sull'applicazione attiva viene raccolto.
- `cargo test --workspace`, `npm run test:ui` e `npm run build` passano.
