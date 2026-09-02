# Pomodoro P0 Buddy and Surfaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rendere le azioni quotidiane buddy-first e distribuire preparazione, registro, statistiche e configurazione nelle superfici approvate.

**Architecture:** Le superfici consumano `FocusStatus` e la lista `allowed_actions` prodotta dal core; nessuna vista inventa transizioni. Il buddy mantiene un indicatore compatto, rivela il dock soltanto al passaggio e offre percorsi equivalenti tramite pannello, tray e scorciatoie.

**Tech Stack:** TypeScript 5.9, HTML/CSS, Three.js 0.185, Tauri 2, Rust 2021

**Spec:** `docs/superpowers/specs/2026-09-02-pomodoro-p0-design.md`

## Global Constraints

- Dipende da `2026-09-02-pomodoro-p0-core-engine.md` completato.
- Il pannello deve funzionare a 380 × 640 px e al minimo 320 × 420 px.
- Il dock del buddy è invisibile senza hover, ma nessuna azione è disponibile esclusivamente via hover.
- Nuvolette automatiche soltanto a fine prevista, rientro, errore o promemoria urgente.
- Etichetta, icona e testo accompagnano sempre il colore.
- Le superfici inviano comandi; il core decide stato e azioni valide.

---

### Task 1: View model condiviso e contratto di azione

**Files:**
- Create: `ui/shared/focus-view-model.ts`
- Modify: `ui/shared/contracts.ts:90-180`
- Modify: `ui/shared/ipc.ts:35-70`
- Modify: `package.json:8-13`
- Test: `tests/focus-view-model.test.ts`

**Interfaces:**
- Consumes: `FocusStatus`, `FocusAction`, `SessionPhase` del piano core.
- Produces: `focusClock(status, now)`, `focusLabel(status)`, `buddyActions(status)` e wrapper IPC tipizzati.

- [ ] **Step 1: Scrivere test puri per tempo e azioni**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { buddyActions, focusClock } from "../ui/shared/focus-view-model.ts";
import type { FocusStatus, PomodoroSession, SessionPhase } from "../ui/shared/contracts.ts";

const actionsByPhase: Record<SessionPhase, FocusStatus["allowed_actions"]> = {
  running: ["focus.pause", "focus.extend_5", "focus.capture", "focus.finish"],
  paused: ["focus.resume", "focus.capture", "focus.finish"],
  ready_to_close: ["focus.overtime", "focus.extend_5", "focus.finish"],
  overtime: ["focus.capture", "focus.finish"],
  closed: [],
};

function fixture(patch: Partial<PomodoroSession>): FocusStatus {
  const active: PomodoroSession = {
    id: 1,
    kind: "focus",
    preset_id: 1,
    phase: "running",
    started_at: 0,
    deadline_at: 1_500_000,
    paused_remaining_ms: null,
    overtime_started_at: null,
    intention: "Spec",
    category: null,
    planned_duration_ms: 1_500_000,
    estimated_ms: null,
    next_step: null,
    outcome: null,
    interruption_reason: null,
    resolved_at: null,
    transition_revision: 0,
    ...patch,
  };
  return {
    active,
    effective_focus_ms: 0,
    remaining_ms: null,
    overtime_ms: null,
    allowed_actions: actionsByPhase[active.phase],
    pending_captures: 0,
    transition_revision: active.transition_revision,
  };
}

test("overtime counts upward and exposes only relevant actions", () => {
  const status = fixture({ phase: "overtime", overtime_started_at: 1_000 });
  assert.equal(focusClock(status, 71_000), "+1:10");
  assert.deepEqual(buddyActions(status).map((a) => a.id), ["focus.capture", "focus.finish"]);
});

test("paused clock uses frozen remaining time", () => {
  const status = fixture({ phase: "paused", paused_remaining_ms: 90_000 });
  assert.equal(focusClock(status, 500_000), "1:30");
});
```

- [ ] **Step 2: Verificare il fallimento**

Run: `node --test tests/focus-view-model.test.ts`

Expected: FAIL perché il modulo non esiste.

- [ ] **Step 3: Implementare il view model senza stato proprio**

```ts
export function focusClock(status: FocusStatus, now: number): string {
  const s = status.active;
  if (!s) return "";
  if (s.phase === "paused") return fmtCountdown(s.paused_remaining_ms ?? 0);
  if (s.phase === "overtime") return `+${fmtCountdown(now - (s.overtime_started_at ?? now))}`;
  return fmtCountdown(Math.max(0, s.deadline_at - now));
}

export function buddyActions(status: FocusStatus): FocusActionView[] {
  const labels: Record<FocusAction, string> = {
    "focus.start_last": "Avvia",
    "focus.pause": "Pausa",
    "focus.resume": "Riprendi",
    "focus.extend_5": "+5",
    "focus.capture": "Cattura",
    "focus.finish": "Concludi",
    "focus.overtime": "Continua",
    "break.start": "Pausa",
    "break.skip": "Salta",
  };
  return status.allowed_actions.map((id) => ({ id, label: labels[id] }));
}
```

Aggiornare `package.json` a `"test:ui": "node --test tests/*.test.ts"` e aggiungere in `ipc.ts` una funzione per ogni comando `focus_*`, sempre con `expectedRevision` per le mutazioni.

- [ ] **Step 4: Eseguire test e typecheck**

Run: `npm run test:ui`

Expected: PASS.

Run: `npm run check`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/shared/focus-view-model.ts ui/shared/contracts.ts ui/shared/ipc.ts tests/focus-view-model.test.ts package.json
git commit -m "feat(ui): add shared focus view model"
```

### Task 2: Architettura della scheda Focus

**Files:**
- Modify: `ui/panel/index.html:38-78`
- Modify: `ui/panel/main.ts:114-220`
- Modify: `ui/panel/panel.css:180-270`
- Create: `ui/panel/focus-controller.ts`
- Test: `tests/focus-controller.test.ts`

**Interfaces:**
- Consumes: wrapper IPC e view model della Task 1.
- Produces: viste locali `prepare`, `history`, `stats`; stato contestuale `Prepara/In corso`.

- [ ] **Step 1: Testare la vista iniziale e le azioni di stato**

```ts
function status(phase: SessionPhase | null): FocusStatus {
  if (phase === null) {
    return { active: null, effective_focus_ms: 0, remaining_ms: null, overtime_ms: null,
      allowed_actions: ["focus.start_last"], pending_captures: 0, transition_revision: null };
  }
  return {
    active: {
      id: 1, kind: "focus", preset_id: 1, phase, started_at: 0, deadline_at: 1_500_000,
      paused_remaining_ms: null, overtime_started_at: null, intention: "Spec", category: null,
      planned_duration_ms: 1_500_000, estimated_ms: null, next_step: null, outcome: null,
      interruption_reason: null, resolved_at: null, transition_revision: 0,
    },
    effective_focus_ms: 0,
    remaining_ms: 1_500_000,
    overtime_ms: null,
    allowed_actions: [],
    pending_captures: 0,
    transition_revision: 0,
  };
}

test("an active session opens the prepare pane as in-progress", () => {
  const vm = panelState(status("running"), "prepare");
  assert.equal(vm.localTabLabel, "In corso");
  assert.equal(vm.showPreparationForm, false);
  assert.equal(vm.showRunningControls, true);
});

test("idle focus keeps preparation fields", () => {
  const vm = panelState(status(null), "prepare");
  assert.equal(vm.localTabLabel, "Prepara");
  assert.equal(vm.showPreparationForm, true);
});
```

- [ ] **Step 2: Verificare il fallimento**

Run: `node --test tests/focus-controller.test.ts`

Expected: FAIL per modulo mancante.

- [ ] **Step 3: Implementare il controller puro**

```ts
export type FocusPane = "prepare" | "history" | "stats";

export function panelState(status: FocusStatus, pane: FocusPane): PanelFocusState {
  const active = status.active !== null;
  return {
    pane,
    localTabLabel: active ? "In corso" : "Prepara",
    showPreparationForm: pane === "prepare" && !active,
    showRunningControls: pane === "prepare" && active,
  };
}
```

- [ ] **Step 4: Costruire il markup nelle dimensioni reali**

Sostituire l'attuale blocco Pomodoro con:

```html
<nav class="focus-tabs" aria-label="Focus">
  <button type="button" data-focus-pane="prepare" aria-selected="true">Prepara</button>
  <button type="button" data-focus-pane="history" aria-selected="false">Registro</button>
  <button type="button" data-focus-pane="stats" aria-selected="false">Statistiche</button>
</nav>
<section id="focusPrepare" aria-live="polite"></section>
<section id="focusHistory" hidden></section>
<section id="focusStats" hidden></section>
```

Nel form Prepara usare campi etichettati per intenzione, preset, override una tantum, stima, categoria e prossimo passo. Nello stato In corso mostrare tempo, intenzione e soltanto i pulsanti restituiti da `allowed_actions`. Il comando “Modifica durata” apre un gruppo compatto `−10`, `−5`, `−1`, `+1`, `+5`, `+10`; ogni scelta invia `focus_adjust(deltaMs, expectedRevision)` e usa il nuovo snapshot restituito. Registro e Statistiche possono inizialmente mostrare i dati esistenti; saranno completati dal piano analytics.

- [ ] **Step 5: Collegare interazioni e aggiornamenti**

Ascoltare `focus:changed`, sostituire lo snapshot e renderizzare. Usare un solo intervallo locale per il testo dell'orologio; al raggiungimento dello zero chiedere `focusStatus()` invece di decidere la transizione.

- [ ] **Step 6: Verificare layout e build**

Run: `npm run test:ui`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

Aprire il pannello a 380 × 640 e 320 × 420: nessun controllo deve sovrapporsi; Prepara/In corso, Registro e Statistiche devono essere raggiungibili da tastiera in ordine logico.

- [ ] **Step 7: Commit**

```bash
git add ui/panel/index.html ui/panel/main.ts ui/panel/panel.css ui/panel/focus-controller.ts tests/focus-controller.test.ts
git commit -m "feat(panel): add focus prepare history and stats views"
```

### Task 3: Indicatore persistente e dock buddy al passaggio

**Files:**
- Modify: `ui/overlay/index.html:13-67`
- Modify: `ui/overlay/main.ts:18-180`
- Modify: `ui/overlay/overlay.css:145-250`
- Modify: `src-tauri/src/surfaces.rs:230-275`
- Test: `tests/focus-view-model.test.ts`

**Interfaces:**
- Consumes: `buddyActions(status)` e `focusClock(status, now)`.
- Produces: indicatore sempre visibile; pulsanti semantici generati dal solo stato core.

- [ ] **Step 1: Aggiungere il test della mappa completa degli stati**

```ts
for (const [phase, expected] of [
  ["running", ["focus.pause", "focus.extend_5", "focus.capture", "focus.finish"]],
  ["paused", ["focus.resume", "focus.capture", "focus.finish"]],
  ["ready_to_close", ["focus.overtime", "focus.extend_5", "focus.finish"]],
] as const) {
  test(`${phase} exposes the approved buddy actions`, () => {
    assert.deepEqual(buddyActions(fixture({ phase })).map((a) => a.id), expected);
  });
}
```

- [ ] **Step 2: Verificare il fallimento per le mappe incomplete**

Run: `node --test tests/focus-view-model.test.ts`

Expected: FAIL finché tutte le fasi non sono mappate.

- [ ] **Step 3: Rendere il dock data-driven**

Mantenere sposta, ridimensiona e pannello come utility secondarie. Aggiungere contenitori distinti:

```html
<output id="focusChip" class="focus-chip" aria-live="off"></output>
<div id="focusActions" class="focus-actions" aria-label="Azioni focus"></div>
```

Creare veri `<button>` da `buddyActions`; ogni click chiama la funzione IPC corrispondente usando la revisione corrente. Per `focus.finish` aprire una piccola bolla con Completata, Parziale, Interrotta invece di scegliere un esito implicitamente.

- [ ] **Step 4: Applicare il comportamento solo al passaggio**

Usare la hitbox esistente e queste condizioni, senza apertura automatica durante il focus:

```ts
function setDockVisible(visible: boolean): void {
  focusActions.classList.toggle("on", visible);
  focusActions.toggleAttribute("inert", !visible);
  reportHitbox(lastCreatureRect, true);
}

document.body.addEventListener("pointerenter", () => setDockVisible(true));
document.body.addEventListener("pointerleave", () => {
  if (!focusActions.matches(":focus-within")) setDockVisible(false);
});
```

Il chip resta visibile. Il dock usa `opacity` e `transform`, rispetta `prefers-reduced-motion` e resta dentro la finestra overlay. Estendere la hitbox quando dock o scelta esito sono aperti.

- [ ] **Step 5: Verificare input e click-through**

Run: `npm run test:ui`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

Verifica manuale Windows: fuori dalla hitbox i clic attraversano l'overlay; dentro, il dock appare; spostando il puntatore fuori scompare; la scelta esito resta cliccabile finché ha focus.

- [ ] **Step 6: Commit**

```bash
git add ui/overlay/index.html ui/overlay/main.ts ui/overlay/overlay.css src-tauri/src/surfaces.rs tests/focus-view-model.test.ts
git commit -m "feat(overlay): add hover-only focus controls"
```

### Task 4: Tray e scorciatoie globali coerenti

**Files:**
- Create: `src-tauri/src/shortcuts.rs`
- Modify: `src-tauri/src/lib.rs:10-130`
- Modify: `src-tauri/src/tray.rs:20-135`
- Modify: `src-tauri/src/commands.rs`
- Modify: `ui/panel/index.html`
- Modify: `ui/panel/main.ts`
- Test: `src-tauri/src/tray.rs` (`#[cfg(test)]`)

**Interfaces:**
- Consumes: `FocusStatus.allowed_actions` e ID semantici.
- Produces: menu tray contestuale e registro di scorciatoie rimappabile.

- [ ] **Step 1: Testare il modello puro del menu**

```rust
#[test]
fn running_focus_menu_contains_pause_extend_capture_finish() {
    let actions = [
        FocusAction::Pause,
        FocusAction::Extend5,
        FocusAction::Capture,
        FocusAction::Finish,
    ];
    let ids = focus_menu_ids(&actions);
    assert_eq!(ids, vec!["focus.pause", "focus.extend_5", "focus.capture", "focus.finish"]);
}
```

- [ ] **Step 2: Eseguire il test e verificare il fallimento**

Run: `cargo test -p win-buddy tray::tests::running_focus_menu_contains_pause_extend_capture_finish`

Expected: FAIL per funzione mancante.

- [ ] **Step 3: Implementare menu e dispatch condiviso**

`focus_menu_ids(actions: &[FocusAction]) -> Vec<&'static str>` deve riflettere l'ordine di `allowed_actions`. `on_menu` chiama un unico:

```rust
pub fn dispatch_focus_action(app: &AppHandle, action: FocusAction) -> CmdResult<FocusStatusDto>
```

Rimuovere le decisioni locali `focus/abort`. Mostrare soltanto azioni valide e mantenere sempre Apri pannello, Cattura rapida, modalità buddy ed Esci.

- [ ] **Step 4: Estrarre il registro scorciatoie**

Definire chiavi impostazione:

```text
shortcut.focus.start_last
shortcut.focus.pause_resume
shortcut.focus.extend_5
shortcut.focus.capture
shortcut.focus.finish
```

`shortcuts::reload(app)` prima esegue parsing e controllo duplicati, poi registra il nuovo set; in caso di conflitto conserva il set precedente e restituisce l'errore al pannello. Aggiungere campi rimappabili in Impostazioni → Accessibilità.

- [ ] **Step 5: Verificare shell e build**

Run: `cargo test -p win-buddy`

Expected: PASS.

Run: `cargo check -p win-buddy`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/shortcuts.rs src-tauri/src/lib.rs src-tauri/src/tray.rs src-tauri/src/commands.rs ui/panel/index.html ui/panel/main.ts
git commit -m "feat(shell): align tray and focus shortcuts"
```

### Task 5: Rimuovere il bridge Pomodoro legacy

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `ui/shared/ipc.ts`
- Modify: `ui/panel/main.ts`
- Modify: `src-tauri/src/tray.rs`

**Interfaces:**
- Consumes: tutte le superfici migrate alle API `focus_*`.
- Produces: nessun riferimento runtime a `pomodoro_start`, `pomodoro_abort`, `break_accept`, `break_skip`.

- [ ] **Step 1: Cercare consumatori legacy**

Run: `rg -n "pomodoro_(start|abort)|break_(accept|skip)|do_pomodoro" ui src-tauri/src`

Expected: risultati soltanto nei wrapper da rimuovere.

- [ ] **Step 2: Rimuovere handler e wrapper**

Eliminare i vecchi export da `ipc.ts`, i comandi da `commands.rs` e la registrazione da `generate_handler!`. Mantenere il nome “Pomodoro” soltanto nei tipi dominio o nella documentazione storica; la scheda utente è “Focus”.

- [ ] **Step 3: Verificare assenza e regressioni**

Run: `rg -n "pomodoro_(start|abort)|break_(accept|skip)|do_pomodoro" ui src-tauri/src`

Expected: nessun risultato.

Run: `cargo test --workspace`

Expected: PASS.

Run: `npm run test:ui`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs ui/shared/ipc.ts ui/panel/main.ts src-tauri/src/tray.rs
git commit -m "refactor(pomodoro): remove legacy surface commands"
```

## Completion Gate

- Il percorso completo è disponibile dal buddy con dock visibile soltanto al passaggio.
- Pannello, tray e scorciatoie presentano la stessa semantica e lo stesso stato.
- Il pannello passa il controllo visivo a 380 × 640 e 320 × 420.
- `cargo test --workspace`, `npm run test:ui` e `npm run build` passano.
- Nessuna nuvoletta automatica viene mostrata durante il focus ordinario.
