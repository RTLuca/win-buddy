# Pomodoro P0 Windows Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrare Focus di Windows con ripristino sicuro e fornire notifiche azionabili senza dipendere da API desktop non supportate da Tauri.

**Architecture:** Un adapter con capability esplicite separa il dominio dalle API WinRT. Quando il token Limited Access Feature è disponibile, Win Buddy avvia e termina soltanto la propria sessione Focus; negli altri casi rileva lo stato e offre il collegamento ufficiale alle impostazioni. Le notifiche azionabili usano il backend WinRT già presente nella catena Tauri e ritornano agli stessi comandi del core.

**Tech Stack:** Rust 2021, Tauri 2, windows 0.61, tauri-winrt-notification 0.8, Windows Runtime, SQLite

**Spec:** `docs/superpowers/specs/2026-09-02-pomodoro-p0-design.md`

## Global Constraints

- Dipende dal piano Core Engine completato; può procedere in parallelo ai piani UI e analytics.
- Non scrivere chiavi registro non documentate e non modificare Group Policy.
- `FocusSessionManager.TryStartFocusSession`, `FocusSession.End` e `DeactivateFocus` richiedono un token Microsoft Limited Access Feature.
- Non terminare mai una sessione Focus iniziata dall'utente o da un'altra applicazione.
- In assenza di capability di scrittura, il timer continua e mostra uno stato degradato veritiero.
- Il fallback apre soltanto `ms-settings:quiethours` su azione esplicita dell'utente.
- Le notifiche vengono verificate su un'app installata: Tauri documenta che su Windows non sono rappresentative in sviluppo.

**Authoritative references:**
- `https://learn.microsoft.com/en-us/uwp/api/windows.ui.shell.focussessionmanager`
- `https://learn.microsoft.com/en-us/uwp/api/windows.applicationmodel.limitedaccessfeatures`
- `https://learn.microsoft.com/en-us/windows/apps/develop/launch/launch-settings`
- `https://v2.tauri.app/plugin/notification/`
- `https://docs.rs/tauri-winrt-notification/latest/tauri_winrt_notification/struct.Toast.html`

---

### Task 1: Spike compilabile e matrice capability

**Files:**
- Create: `src-tauri/examples/focus_capability_probe.rs`
- Create: `docs/technical/windows-focus-api-spike.md`
- Modify: `src-tauri/Cargo.toml:27-36`

**Interfaces:**
- Consumes: `FocusSessionManager::IsSupported`, `LimitedAccessFeatures::TryUnlockFeature` e variabili build opzionali.
- Produces: decisione misurata `Unavailable | ReadOnly | Controllable` sulle build Windows supportate.

- [ ] **Step 1: Abilitare namespace WinRT richiesti**

In `src-tauri/Cargo.toml`, aggiungere alle feature Windows:

```toml
"ApplicationModel",
"Foundation",
"System",
"UI_Shell",
```

- [ ] **Step 2: Creare il probe senza credenziali nel repository**

```rust
#[cfg(windows)]
fn main() -> windows::core::Result<()> {
    use windows::UI::Shell::FocusSessionManager;
    let supported = FocusSessionManager::IsSupported()?;
    let active = supported && FocusSessionManager::GetDefault()?.IsFocusActive()?;
    println!("supported={supported} active={active}");
    println!("laf_configured={}", option_env!("WIN_BUDDY_FOCUS_FEATURE_ID").is_some());
    Ok(())
}

#[cfg(not(windows))]
fn main() { println!("supported=false active=false"); }
```

- [ ] **Step 3: Compilare ed eseguire sulle build obiettivo**

Run: `cargo run -p win-buddy --example focus_capability_probe`

Expected: stampa tre valori senza panic. Ripetere almeno su Windows 11 23H2 e 24H2/25H2 disponibili al team. Non tentare `TryStartFocusSession` senza token approvato.

- [ ] **Step 4: Registrare la decisione**

In `docs/technical/windows-focus-api-spike.md` riportare per ogni build: numero build, `IsSupported`, lettura stato, disponibilità token LAF. Concludere con questa politica:

```text
Controllable: avvia una sessione propria e conserva il suo ID.
ReadOnly: osserva Focus e offre “Apri impostazioni”; non promette automazione.
Unavailable: usa soltanto la protezione interna di Win Buddy.
```

- [ ] **Step 5: Verificare che il probe resti multipiattaforma**

Run: `cargo check --workspace`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/examples/focus_capability_probe.rs src-tauri/Cargo.toml docs/technical/windows-focus-api-spike.md
git commit -m "spike(windows): verify focus session capabilities"
```

### Task 2: Adapter testabile `SystemFocusGuard`

**Files:**
- Create: `src-tauri/src/system_focus.rs`
- Modify: `src-tauri/src/lib.rs:10-20`
- Test: `src-tauri/src/system_focus.rs` (`#[cfg(test)]`)

**Interfaces:**
- Consumes: un provider di piattaforma e `deadline_at` della sessione.
- Produces: `SystemFocusGuard<P>`, `FocusCapability`, `FocusLease`, `FocusProtectionStatus`.

- [ ] **Step 1: Scrivere test con provider falso**

```rust
#[derive(Default)]
struct FakeProvider {
    active: bool,
    controllable: bool,
    next_id: String,
    ended: Vec<String>,
}

impl FakeProvider {
    fn active_external() -> Self {
        Self { active: true, controllable: true, next_id: String::new(), ended: vec![] }
    }
    fn controllable_inactive(id: &str) -> Self {
        Self { active: false, controllable: true, next_id: id.into(), ended: vec![] }
    }
    fn end_calls(&self) -> usize { self.ended.len() }
    fn ended_ids(&self) -> &[String] { &self.ended }
}

impl FocusProvider for FakeProvider {
    fn capability(&self) -> FocusCapability {
        if self.controllable { FocusCapability::Controllable } else { FocusCapability::ReadOnly }
    }
    fn is_active(&self) -> Result<bool, String> { Ok(self.active) }
    fn start_until(&mut self, _deadline_at: i64) -> Result<String, String> {
        self.active = true;
        Ok(self.next_id.clone())
    }
    fn end(&mut self, id: &str) -> Result<(), String> {
        self.ended.push(id.to_owned());
        self.active = false;
        Ok(())
    }
    fn open_settings(&self) -> Result<(), String> { Ok(()) }
}

#[test]
fn borrowed_focus_is_never_ended() {
    let provider = FakeProvider::active_external();
    let mut guard = SystemFocusGuard::new(provider);
    let lease = guard.acquire(42, 1_000, 60_000).unwrap();
    assert_eq!(lease.ownership, LeaseOwnership::Borrowed);
    guard.restore(&lease).unwrap();
    assert_eq!(guard.provider().end_calls(), 0);
}

#[test]
fn owned_focus_ends_only_its_session() {
    let provider = FakeProvider::controllable_inactive("win-session-7");
    let mut guard = SystemFocusGuard::new(provider);
    let lease = guard.acquire(42, 1_000, 60_000).unwrap();
    guard.restore(&lease).unwrap();
    assert_eq!(guard.provider().ended_ids(), &["win-session-7"]);
}
```

- [ ] **Step 2: Verificare il fallimento**

Run: `cargo test -p win-buddy system_focus::tests::borrowed_focus_is_never_ended`

Expected: FAIL per modulo mancante.

- [ ] **Step 3: Definire interfacce e stati**

```rust
pub enum FocusCapability { Unavailable, ReadOnly, Controllable }
pub enum LeaseOwnership { Owned, Borrowed, None }
pub enum FocusProtectionStatus { Inactive, Active, Degraded, RestorePending }

pub trait FocusProvider {
    fn capability(&self) -> FocusCapability;
    fn is_active(&self) -> Result<bool, String>;
    fn start_until(&mut self, deadline_at: i64) -> Result<String, String>;
    fn end(&mut self, platform_session_id: &str) -> Result<(), String>;
    fn open_settings(&self) -> Result<(), String>;
}
```

`acquire` restituisce `Borrowed` se Focus era già attivo, `Owned` soltanto se `start_until` riesce e `None` con stato degradato altrimenti. `restore` chiama `end` solo per `Owned`.

- [ ] **Step 4: Eseguire i test**

Run: `cargo test -p win-buddy system_focus::tests`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/system_focus.rs src-tauri/src/lib.rs
git commit -m "feat(windows): add focus protection adapter"
```

### Task 3: Provider WinRT con Limited Access Feature e fallback

**Files:**
- Modify: `src-tauri/src/system_focus.rs`
- Modify: `src-tauri/src/platform.rs:1-220`
- Modify: `src-tauri/Cargo.toml`
- Test: `src-tauri/src/system_focus.rs`

**Interfaces:**
- Consumes: `WIN_BUDDY_FOCUS_FEATURE_ID`, `WIN_BUDDY_FOCUS_TOKEN`, `WIN_BUDDY_FOCUS_ATTESTATION` tramite `option_env!`.
- Produces: `WindowsFocusProvider::new()` e stub non-Windows.

- [ ] **Step 1: Testare la matrice capability separando il rilevamento WinRT**

```rust
#[test]
fn capability_requires_support_and_successful_unlock() {
    assert_eq!(classify_capability(false, false), FocusCapability::Unavailable);
    assert_eq!(classify_capability(true, false), FocusCapability::ReadOnly);
    assert_eq!(classify_capability(true, true), FocusCapability::Controllable);
}
```

- [ ] **Step 2: Verificare il fallimento**

Run: `cargo test -p win-buddy system_focus::tests::capability_requires_support_and_successful_unlock`

Expected: FAIL per funzione mancante.

- [ ] **Step 3: Implementare l'unlock e le operazioni proprietarie**

All'avvio, se `IsSupported` è vero e tutte le variabili build esistono, chiamare:

```rust
LimitedAccessFeatures::TryUnlockFeature(feature_id, token, attestation)
```

Classificare `Controllable` solo per un risultato consentito. `start_until` usa `TryStartFocusSession(deadline)` e conserva `FocusSession::Id`; `end(id)` usa `GetSession(id)?.End()`, mai `DeactivateFocus()`.

- [ ] **Step 4: Implementare fallback impostazioni**

`open_settings` lancia `ms-settings:quiethours` tramite API URI Windows. Lo stub non-Windows restituisce `Unavailable` e un errore esplicito per l'apertura.

- [ ] **Step 5: Verificare build con e senza token**

Run senza variabili: `cargo check -p win-buddy`

Expected: PASS e capability runtime `ReadOnly` o `Unavailable`.

Run nella pipeline firmata con variabili LAF approvate: `cargo check -p win-buddy`

Expected: PASS; nessun valore delle variabili compare nei log.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/system_focus.rs src-tauri/src/platform.rs src-tauri/Cargo.toml
git commit -m "feat(windows): implement guarded focus session provider"
```

### Task 4: Lease persistente e recupero dopo crash

**Files:**
- Modify: `crates/core/src/migrations.rs`
- Modify: `crates/core/sql/schema.sql`
- Modify: `docs/sql/schema.sql`
- Modify: `crates/core/src/model.rs`
- Modify: `crates/core/src/store.rs`
- Modify: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/runtime.rs:58-145`
- Modify: `src-tauri/src/commands.rs`
- Test: `crates/core/src/store.rs`
- Test: `src-tauri/src/system_focus.rs`

**Interfaces:**
- Consumes: `FocusLease` della Task 2.
- Produces: schema v4, `save_focus_lease`, `pending_focus_lease`, `mark_focus_lease_restored`, recupero startup.

- [ ] **Step 1: Testare persistenza e idempotenza**

```rust
#[test]
fn pending_owned_lease_survives_restart_until_restored() {
    let s = Store::open_in_memory().unwrap();
    s.save_focus_lease(1, "win-7", "owned", 1000).unwrap();
    assert_eq!(s.pending_focus_lease().unwrap().unwrap().platform_session_id.as_deref(), Some("win-7"));
    s.mark_focus_lease_restored(1, 2000).unwrap();
    assert!(s.pending_focus_lease().unwrap().is_none());
}
```

- [ ] **Step 2: Verificare il fallimento**

Run: `cargo test -p win-buddy-core pending_owned_lease_survives_restart_until_restored`

Expected: FAIL.

- [ ] **Step 3: Aggiungere schema v4**

```sql
CREATE TABLE system_focus_leases (
  id INTEGER PRIMARY KEY,
  pomodoro_session_id INTEGER NOT NULL REFERENCES pomodoro_sessions(id) ON DELETE CASCADE,
  platform_session_id TEXT,
  ownership TEXT NOT NULL CHECK(ownership IN ('owned','borrowed','none')),
  acquired_at INTEGER NOT NULL,
  restored_at INTEGER,
  restore_error TEXT
);
CREATE UNIQUE INDEX idx_focus_lease_open
  ON system_focus_leases((restored_at IS NULL)) WHERE restored_at IS NULL;
PRAGMA user_version = 4;
```

Nella stessa transazione aggiornare anche `settings['schema.version']` a `4`.

- [ ] **Step 4: Collegare lifecycle**

All'avvio di un focus: acquisire, salvare lease, poi avviare il timer; se il timer fallisce, ripristinare immediatamente. Alla chiusura del focus: chiudere la sessione core, ripristinare il lease e registrare il risultato. In `startup_recovery`, tentare prima il lease pendente e poi recuperare il timer. Un errore imposta `RestorePending` e resta visibile in Impostazioni.

- [ ] **Step 5: Eseguire test e crash simulation**

Run: `cargo test --workspace`

Expected: PASS.

Test manuale con provider fake o build Windows controllabile: terminare il processo dopo l'acquisizione, riavviare, verificare che venga terminato soltanto l'ID posseduto e che il lease abbia `restored_at`.

- [ ] **Step 6: Commit**

```bash
git add crates/core/src/migrations.rs crates/core/sql/schema.sql docs/sql/schema.sql crates/core/src/model.rs crates/core/src/store.rs src-tauri/src/state.rs src-tauri/src/runtime.rs src-tauri/src/commands.rs
git commit -m "feat(windows): restore focus protection after crash"
```

### Task 5: Stato e controlli nel pannello

**Files:**
- Modify: `ui/shared/contracts.ts`
- Modify: `ui/shared/ipc.ts`
- Modify: `ui/panel/index.html`
- Modify: `ui/panel/main.ts`
- Modify: `ui/panel/panel.css`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `tests/focus-controller.test.ts`

**Interfaces:**
- Consumes: `FocusProtectionStatus` e capability.
- Produces: impostazioni Protezione Focus, stato attivo/degradato e comando `open_focus_settings`.

- [ ] **Step 1: Testare la copy per capability**

```ts
test("read-only protection never claims automation", () => {
  const vm = protectionView({ capability: "read_only", status: "degraded" });
  assert.equal(vm.title, "Protezione manuale");
  assert.equal(vm.primaryAction, "Apri impostazioni Windows");
  assert.equal(vm.automated, false);
});
```

- [ ] **Step 2: Verificare il fallimento**

Run: `node --test tests/focus-controller.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implementare stato e controlli**

In Impostazioni → Protezione focus mostrare una delle tre copy: “Automatica”, “Manuale” o “Non disponibile”. Rendere il toggle automatico disabilitato se non `controllable`; mostrare il link `Apri impostazioni Windows` soltanto su Windows e solo dopo un click esplicito. Le eccezioni per allarmi, persone e app restano gestite dalla pagina ufficiale di Windows: Win Buddy mostra “Priorità gestite da Windows” e non finge di poterle modificare via API.

- [ ] **Step 4: Verificare UI e build**

Run: `npm run test:ui`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

Run: `cargo check -p win-buddy`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/shared/contracts.ts ui/shared/ipc.ts ui/panel/index.html ui/panel/main.ts ui/panel/panel.css src-tauri/src/commands.rs src-tauri/src/lib.rs tests/focus-controller.test.ts
git commit -m "feat(settings): expose Windows focus protection status"
```

### Task 6: Notifiche Windows azionabili

**Files:**
- Create: `src-tauri/src/focus_notifications.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/presenter.rs:185-230`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/Cargo.toml`
- Test: `src-tauri/src/focus_notifications.rs` (`#[cfg(test)]`)

**Interfaces:**
- Consumes: evento durevole e `FocusAction`.
- Produces: toast con tag stabile e azioni Continua, Pausa/Avvia pausa, Concludi.

- [ ] **Step 1: Testare parsing e dispatch delle azioni**

```rust
#[test]
fn parses_notification_action_with_revision() {
    let action = parse_action("focus.overtime?session=42&revision=3").unwrap();
    assert_eq!(action, NotificationAction::Overtime { session_id: 42, revision: 3 });
}
```

- [ ] **Step 2: Verificare il fallimento**

Run: `cargo test -p win-buddy focus_notifications::tests::parses_notification_action_with_revision`

Expected: FAIL.

- [ ] **Step 3: Aggiungere il backend WinRT esplicito**

```toml
[target.'cfg(windows)'.dependencies]
tauri-winrt-notification = "0.8"
```

Definire il payload chiuso usato dal parser e dal dispatch:

```rust
#[derive(Debug, PartialEq)]
enum NotificationAction {
    Overtime { session_id: i64, revision: i64 },
    StartBreak { session_id: i64, revision: i64 },
    Finish { session_id: i64, revision: i64 },
}
```

Costruire la notifica con `Toast::new(app_id)`, `add_button` e `on_activated`. Usare action string versionate con `session_id` e `revision`; il callback passa a `commands::dispatch_focus_action`. Su non-Windows mantenere il toast informativo esistente.

- [ ] **Step 4: Deduplicare e degradare correttamente**

Usare `focus-{session_id}-{transition_revision}` come tag/progress identifier. Se la notifica azionabile fallisce, mostrare il toast Tauri semplice una sola volta e lasciare le azioni in tray. Non duplicare la bolla se l'overlay è visibile e la policy la consente.

- [ ] **Step 5: Verificare su pacchetto installato**

Run: `cargo test -p win-buddy focus_notifications::tests`

Expected: PASS.

Run: `npm run tauri build`

Expected: bundle firmabile prodotto.

Installare il bundle di test: portare un focus a zero con overlay nascosto, scegliere Continua dalla notifica e verificare `phase = overtime`; ripetere il click e verificare che la revisione impedisca una seconda transizione.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/focus_notifications.rs src-tauri/src/lib.rs src-tauri/src/presenter.rs src-tauri/src/commands.rs src-tauri/Cargo.toml
git commit -m "feat(windows): add actionable focus notifications"
```

## Completion Gate

- Il documento spike contiene risultati reali per le build Windows supportate.
- Nessun percorso usa registro o policy non documentati.
- Una sessione Focus esterna non viene mai terminata da Win Buddy.
- Un lease posseduto viene ripristinato dopo fine, interruzione, uscita e crash.
- In assenza di token LAF l'interfaccia dichiara “Protezione manuale” e il timer resta pienamente usabile.
- Le notifiche azionabili funzionano in un bundle installato e i retry sono idempotenti.
