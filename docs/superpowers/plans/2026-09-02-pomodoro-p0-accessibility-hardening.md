# Pomodoro P0 Accessibility and Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rendere il nuovo ciclo Focus accessibile, sensorialmente configurabile, robusto su Windows e pronto a una distribuzione firmata entro i budget di risorse esistenti.

**Architecture:** Preferenze e segnali sono politiche condivise prodotte dal core/presenter, mentre ogni superficie mantiene semantica nativa. Test deterministici coprono annunci e recupero; test Windows misurano DPI, high contrast, sospensione, consumo e firma del bundle.

**Tech Stack:** Rust 2021, TypeScript 5.9, HTML/CSS, Web Audio, Tauri 2, GitHub Actions, PowerShell 7

**Spec:** `docs/superpowers/specs/2026-09-02-pomodoro-p0-design.md`

## Global Constraints

- Eseguire dopo i piani Core Engine, Buddy/Surfaces, Intent/Interruptions e History/Analytics.
- Operabilità completa da tastiera; il percorso hover non è mai l'unico percorso.
- Il timer non viene annunciato ogni secondo.
- Testo normale con contrasto almeno 4,5:1; nessuna informazione affidata soltanto al colore.
- Supportare Windows High Contrast, DPI misti e `prefers-reduced-motion`.
- Core dormiente ≤ 20 MB e ~0% CPU; sobrio ≤ 60 MB e <0,5%; 3D idle ≤ 130 MB e <1,5%; picco avviso ≤ 160 MB e <4%.
- Nessun certificato, password o token viene scritto nel repository o nei log CI.

**Authoritative references:**
- `https://v2.tauri.app/distribute/sign/windows/`
- `https://v2.tauri.app/plugin/updater/`

---

### Task 1: Politica annunci e audit semantico

**Files:**
- Create: `ui/shared/focus-announcer.ts`
- Modify: `ui/shared/contracts.ts`
- Modify: `ui/overlay/index.html`
- Modify: `ui/overlay/main.ts`
- Modify: `ui/panel/index.html`
- Modify: `ui/panel/main.ts`
- Modify: `ui/capture/index.html`
- Test: `tests/focus-announcer.test.ts`

**Interfaces:**
- Consumes: snapshot `FocusStatus` precedente e corrente.
- Produces: `announcement(previous, current) -> string | null` e live region dedicate.

- [ ] **Step 1: Scrivere test che impediscono spam**

```ts
function focusState(phase: SessionPhase, remainingMs: number): FocusStatus {
  return {
    active: {
      id: 1, kind: "focus", preset_id: 1, phase, started_at: 0,
      deadline_at: remainingMs, paused_remaining_ms: phase === "paused" ? remainingMs : null,
      overtime_started_at: null, intention: "Spec", category: null,
      planned_duration_ms: 25 * 60_000, estimated_ms: null, next_step: null,
      outcome: null, interruption_reason: null, resolved_at: null, transition_revision: 0,
    },
    effective_focus_ms: 0, remaining_ms: remainingMs, overtime_ms: null,
    allowed_actions: [], pending_captures: 0, transition_revision: 0,
  };
}

const runningAt = (remainingMs: number) => focusState("running", remainingMs);
const pausedAt = (remainingMs: number) => focusState("paused", remainingMs);
const readyToClose = () => focusState("ready_to_close", 0);

test("does not announce ordinary second changes", () => {
  assert.equal(announcement(runningAt(10_000), runningAt(9_000)), null);
});

test("announces phase changes and selected minute thresholds", () => {
  assert.equal(announcement(runningAt(121_000), runningAt(120_000)), "Mancano 2 minuti al termine del focus.");
  assert.equal(announcement(runningAt(1_000), readyToClose()), "Tempo previsto concluso. Scegli se continuare o concludere.");
  assert.equal(announcement(runningAt(60_000), pausedAt(60_000)), "Focus in pausa, resta 1 minuto.");
});
```

- [ ] **Step 2: Verificare il fallimento**

Run: `node --test tests/focus-announcer.test.ts`

Expected: FAIL per modulo mancante.

- [ ] **Step 3: Implementare politica e live region**

Annunciare soltanto cambio fase, soglie configurate, errore e rientro. Aggiungere:

```html
<p id="focusAnnouncements" class="sr-only" aria-live="polite" aria-atomic="true"></p>
<p id="focusErrors" class="sr-only" role="alert"></p>
```

Il clock visuale usa `aria-hidden="true"`; la fase ha un'etichetta accessibile stabile. Ogni pulsante icon-only conserva `aria-label` aggiornato allo stato.

- [ ] **Step 4: Eseguire audit tastiera**

Attraversare overlay, pannello e cattura con Tab/Shift+Tab/Invio/Spazio/Escape. Non aggiungere `tabindex` positivi. Il focus deve essere visibile su ogni elemento, compresi high contrast e popup esito.

- [ ] **Step 5: Verificare test e build**

Run: `npm run test:ui`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/shared/focus-announcer.ts ui/shared/contracts.ts ui/overlay/index.html ui/overlay/main.ts ui/panel/index.html ui/panel/main.ts ui/capture/index.html tests/focus-announcer.test.ts
git commit -m "feat(a11y): add restrained focus announcements"
```

### Task 2: Presenza, movimento ridotto, high contrast e DPI

**Files:**
- Modify: `crates/core/sql/schema.sql`
- Modify: `docs/sql/schema.sql`
- Modify: `src-tauri/src/presenter.rs`
- Modify: `ui/shared/contracts.ts`
- Modify: `ui/overlay/main.ts`
- Modify: `ui/overlay/overlay.css`
- Modify: `ui/panel/index.html`
- Modify: `ui/panel/main.ts`
- Modify: `ui/panel/panel.css`
- Modify: `ui/shared/theme.css`
- Create: `ui/shared/buddy-copy.ts`
- Test: `tests/buddy-copy.test.ts`
- Test: `tests/focus-view-model.test.ts`

**Interfaces:**
- Consumes: impostazioni `buddy.mode`, `focus.countdown_visible`, `ui.reduced_motion`.
- Produces: modalità `full | sober | hidden` con canali equivalenti.

- [ ] **Step 1: Testare politica di presenza**

```ts
test("hidden buddy preserves system channels", () => {
  const policy = presencePolicy("hidden");
  assert.deepEqual(policy, { overlay: false, tray: true, notifications: true, shortcuts: true });
});

test("hidden countdown still exposes phase", () => {
  const vm = focusChip(fixture({ phase: "running" }), { countdownVisible: false });
  assert.equal(vm.visibleText, "Focus");
  assert.equal(vm.accessibleText, "Focus in corso");
});

test("interrupted copy is never punitive", () => {
  for (const tone of ["neutral", "encouraging", "playful"] as const) {
    const text = buddyCopy(tone, "interrupted").toLocaleLowerCase("it");
    for (const forbidden of ["fallito", "perso", "deluso", "streak"]) {
      assert.equal(text.includes(forbidden), false);
    }
  }
});
```

- [ ] **Step 2: Verificare il fallimento**

Run: `node --test tests/focus-view-model.test.ts`

Expected: FAIL per policy mancanti.

- [ ] **Step 3: Implementare tre modalità e countdown nascosto**

Estendere `ModeChanged` a `full | sober | hidden`. In hidden il presenter distrugge l'overlay ma continua tray, notifiche e scorciatoie. Il pannello offre radio button, non tre toggle indipendenti.

Aggiungere `buddy.tone = neutral | encouraging | playful`. `buddy-copy.ts` contiene una matrice chiusa per avvio, ritorno, pausa presa, completata, parziale e interrotta. Tutte le tonalità rinforzano l'avvio, il ritorno e la pausa; nessuna modifica postura o testo per punire un'interruzione.

- [ ] **Step 4: Implementare preferenze sensoriali CSS**

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}

@media (forced-colors: active) {
  button, input, select, dialog { forced-color-adjust: auto; }
  .state-indicator { border: 1px solid ButtonText; }
}
```

Non disabilitare l'outline nativo. Rendere testi e layout fluidi senza pixel font-size sotto 11 px.

- [ ] **Step 5: Verifica Windows visuale**

Controllare pannello e overlay a 100%, 150% e 200% DPI su due monitor; attivare High Contrast Black e White; verificare 320 × 420. Nessun testo o controllo deve essere troncato e il dock deve seguire la hitbox fisica corretta.

- [ ] **Step 6: Eseguire test e commit**

Run: `npm run test:ui`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

```bash
git add crates/core/sql/schema.sql docs/sql/schema.sql src-tauri/src/presenter.rs ui/shared/contracts.ts ui/shared/buddy-copy.ts ui/overlay/main.ts ui/overlay/overlay.css ui/panel/index.html ui/panel/main.ts ui/panel/panel.css ui/shared/theme.css tests/focus-view-model.test.ts tests/buddy-copy.test.ts
git commit -m "feat(a11y): support presence motion contrast and DPI"
```

### Task 3: Preavviso e segnali sonori/visivi equivalenti

**Files:**
- Modify: `crates/core/src/pomodoro.rs`
- Modify: `crates/core/sql/schema.sql`
- Modify: `docs/sql/schema.sql`
- Modify: `src-tauri/src/presenter.rs`
- Create: `ui/overlay/signals.ts`
- Modify: `ui/overlay/main.ts`
- Modify: `ui/panel/index.html`
- Modify: `ui/panel/main.ts`
- Test: `crates/core/src/pomodoro.rs`
- Test: `tests/focus-signals.test.ts`

**Interfaces:**
- Consumes: `focus.prewarning_min`, `signal.focus_end`, `signal.break_end`, `signal.prewarning`, `signal.volume`.
- Produces: evento durevole `prewarning` e `signalPlan(event, settings)`.

- [ ] **Step 1: Testare emissione una sola volta**

```rust
#[test]
fn prewarning_is_emitted_once_before_deadline() {
    let s = running_focus_ending_at(10 * MIN);
    assert_eq!(tick(&s, 8 * MIN).unwrap().iter().filter(|e| e.kind == EventKind::Prewarning).count(), 1);
    assert_eq!(tick(&s, 8 * MIN + 5_000).unwrap().iter().filter(|e| e.kind == EventKind::Prewarning).count(), 0);
}
```

- [ ] **Step 2: Testare equivalenza sensoriale**

```ts
const signalSettings = (sound: boolean, visual: boolean): SignalSettings => ({
  sound,
  visual,
  volume: 70,
});

test("sound-only preference still has a visible state change", () => {
  assert.deepEqual(signalPlan("focus_end", signalSettings(true, false)), {
    play: "focus_end",
    showChipState: true,
    showBubble: false,
  });
});
```

- [ ] **Step 3: Verificare i fallimenti**

Run: `cargo test -p win-buddy-core prewarning_is_emitted_once_before_deadline`

Expected: FAIL.

Run: `node --test tests/focus-signals.test.ts`

Expected: FAIL.

- [ ] **Step 4: Implementare evento e sintesi audio locale**

Il core inserisce `prewarning` nell'outbox alla soglia configurata. `signals.ts` usa Web Audio per tre timbri brevi con volume 0–100: preavviso una nota morbida, focus concluso due note ascendenti, pausa conclusa due note discendenti. Creare l'`AudioContext` soltanto quando serve e chiuderlo dopo l'inviluppo; nessun loop.

- [ ] **Step 5: Implementare configurazione e prova**

Impostazioni contiene controlli separati per preavviso, fine focus e fine pausa, con Silenzioso/Suono/Entrambi e pulsante Prova. Anche in Silenzioso il chip cambia testo/stato; anche con visuale disabilitata le azioni restano in tray.

- [ ] **Step 6: Verificare e commit**

Run: `cargo test --workspace`

Expected: PASS.

Run: `npm run test:ui`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

```bash
git add crates/core/src/pomodoro.rs crates/core/sql/schema.sql docs/sql/schema.sql src-tauri/src/presenter.rs ui/overlay/signals.ts ui/overlay/main.ts ui/panel/index.html ui/panel/main.ts tests/focus-signals.test.ts
git commit -m "feat(focus): add accessible prewarning and signals"
```

### Task 4: Matrice di recupero temporale

**Files:**
- Create: `crates/core/tests/pomodoro_recovery.rs`
- Modify: `crates/core/src/pomodoro.rs`
- Modify: `src-tauri/src/runtime.rs`
- Create: `docs/qa/pomodoro-recovery-matrix.md`

**Interfaces:**
- Consumes: orologio iniettato, `last_alive`, stato persistente e lease Windows.
- Produces: comportamento provato per sospensione, riavvio, cambio orologio, DST e fuso.

- [ ] **Step 1: Scrivere la matrice automatica**

```rust
#[test]
fn paused_session_survives_clock_rollback() {
    let s = Store::open_in_memory().unwrap();
    let session = start(&s, StartSession::focus(1, "Spec", 25 * MIN), 100_000).unwrap().session;
    pause(&s, session.id, 0, 200_000, None).unwrap();
    resolve_open(&s, 150_000, 200_000, 120_000).unwrap();
    let recovered = s.get_session(session.id).unwrap().unwrap();
    assert_eq!(recovered.phase, SessionPhase::Paused);
    assert_eq!(recovered.paused_remaining_ms, Some(1_400_000));
}

#[test]
fn ready_to_close_survives_restart_without_duplicate_event() {
    let s = Store::open_in_memory().unwrap();
    start(&s, StartSession::focus(1, "Spec", MIN), 0).unwrap();
    tick(&s, MIN).unwrap();
    resolve_open(&s, MIN + 1_000, MIN, 120_000).unwrap();
    let ready = s.pending_presentation_events().unwrap()
        .into_iter().filter(|e| e.kind == EventKind::ReadyToClose).count();
    assert_eq!(ready, 1);
}

#[test]
fn running_session_after_long_gap_requires_review() {
    let s = Store::open_in_memory().unwrap();
    start(&s, StartSession::focus(1, "Spec", 25 * MIN), 0).unwrap();
    let recovered = resolve_open(&s, 20 * MIN, 5 * MIN, 120_000).unwrap();
    assert!(matches!(recovered, Recovery::NeedsReview(_)));
    assert_eq!(s.open_session().unwrap().unwrap().outcome, None);
}

#[test]
fn completed_sessions_keep_utc_instants_across_timezone_change() {
    let s = Store::open_in_memory().unwrap();
    let session = start(&s, StartSession::focus(1, "Spec", MIN), 1_000).unwrap().session;
    finish(&s, session.id, 0, SessionOutcome::Completed, None, 61_000).unwrap();
    let stored = s.get_session(session.id).unwrap().unwrap();
    assert_eq!((stored.started_at, stored.resolved_at), (1_000, Some(61_000)));
}
```

Ogni corpo crea uno store in memoria, applica istanti numerici espliciti e asserisce `phase`, `outcome`, `transition_revision` ed eventi pendenti.

- [ ] **Step 2: Eseguire e osservare i fallimenti reali**

Run: `cargo test -p win-buddy-core --test pomodoro_recovery`

Expected: almeno i casi non ancora coperti falliscono con differenze di stato, non con panic di setup.

- [ ] **Step 3: Correggere soltanto le invarianti fallite**

Centralizzare confronti temporali in `pomodoro.rs`; usare saturating arithmetic per rollback; non leggere `Local::now()` nel core. In `runtime.rs` calcolare i confini civili soltanto per aggregazioni e scelta pausa lunga.

- [ ] **Step 4: Documentare prova Windows**

`docs/qa/pomodoro-recovery-matrix.md` contiene righe: scenario, setup, stato atteso, notifica attesa, lease atteso, esito. Eseguire sospensione breve/lunga, ibernazione, kill processo, riavvio, cambio fuso e DST simulato.

- [ ] **Step 5: Verificare suite e commit**

Run: `cargo test --workspace`

Expected: PASS.

```bash
git add crates/core/tests/pomodoro_recovery.rs crates/core/src/pomodoro.rs src-tauri/src/runtime.rs docs/qa/pomodoro-recovery-matrix.md
git commit -m "test(pomodoro): harden recovery across clock changes"
```

### Task 5: Misurazione del budget risorse

**Files:**
- Create: `scripts/measure-resources.ps1`
- Create: `docs/qa/resource-budget.md`
- Modify: `README.md:70-85`

**Interfaces:**
- Consumes: processo installato `win-buddy` e scenario nominato.
- Produces: CSV di campioni e exit code non-zero se working set o CPU superano la soglia.

- [ ] **Step 1: Scrivere lo script con soglie esatte**

```powershell
param(
  [ValidateSet('idle','sober','3d-idle','alert')][string]$Scenario,
  [int]$Samples = 30,
  [string]$OutputDirectory = '.\target\resource-metrics'
)
$limits = @{
  'idle' = @{ RamMb = 20; Cpu = 0.2 }
  'sober' = @{ RamMb = 60; Cpu = 0.5 }
  '3d-idle' = @{ RamMb = 130; Cpu = 1.5 }
  'alert' = @{ RamMb = 160; Cpu = 4.0 }
}
```

Campionare ogni secondo `WorkingSet64` e delta `TotalProcessorTime` normalizzato per core; scrivere CSV sotto una directory esplicitamente passata, mai nella home implicita. Ignorare i primi cinque campioni di warm-up e fallire se massimo RAM o mediana CPU supera il limite.

- [ ] **Step 2: Verificare validazione senza processo**

Run: `pwsh -File scripts/measure-resources.ps1 -Scenario invalid`

Expected: FAIL di validazione parametro prima di cercare il processo.

- [ ] **Step 3: Misurare i quattro scenari**

Avviare il bundle installato e preparare ogni stato. Run per ciascuno:

```powershell
pwsh -File scripts/measure-resources.ps1 -Scenario idle -Samples 30 -OutputDirectory .\target\resource-metrics
```

Expected: exit 0 e CSV con 30 campioni. Ripetere `sober`, `3d-idle`, `alert`.

- [ ] **Step 4: Documentare hardware e risultati**

In `docs/qa/resource-budget.md` registrare CPU, RAM, build Windows, DPI, GPU, versione WebView2, massimi e mediane. Ogni sforamento apre una issue prima del rilascio.

- [ ] **Step 5: Commit**

```bash
git add scripts/measure-resources.ps1 docs/qa/resource-budget.md README.md
git commit -m "test(perf): enforce desktop resource budgets"
```

### Task 6: Pipeline Windows firmata

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `src-tauri/tauri.conf.json`
- Create: `docs/release/windows-signing.md`

**Interfaces:**
- Consumes: GitHub secrets `WINDOWS_CERTIFICATE` e `WINDOWS_CERTIFICATE_PASSWORD`.
- Produces: installer NSIS firmato e verifica `signtool` prima dell'upload.

- [ ] **Step 1: Separare CI ordinaria e release firmata**

Mantenere test/build non firmati su push e PR. Aggiungere job `windows-release` solo per tag `v*`, con controllo iniziale che entrambi i secret siano valorizzati; in caso contrario fallire con “Windows signing secrets missing”.

- [ ] **Step 2: Importare il certificato senza stamparlo**

Nel job release usare PowerShell:

```powershell
$certDir = Join-Path $env:RUNNER_TEMP 'win-buddy-cert'
New-Item -ItemType Directory -Path $certDir | Out-Null
$encoded = Join-Path $certDir 'certificate.txt'
$pfx = Join-Path $certDir 'certificate.pfx'
[IO.File]::WriteAllText($encoded, $env:WINDOWS_CERTIFICATE)
certutil -decode $encoded $pfx | Out-Null
$secure = ConvertTo-SecureString $env:WINDOWS_CERTIFICATE_PASSWORD -AsPlainText -Force
$cert = Import-PfxCertificate -FilePath $pfx -CertStoreLocation Cert:\CurrentUser\My -Password $secure
"CERTIFICATE_THUMBPRINT=$($cert.Thumbprint)" | Out-File $env:GITHUB_ENV -Append
Remove-Item -LiteralPath $certDir -Recurse -Force
```

- [ ] **Step 3: Generare config effimera e firmare**

Creare sotto `$env:RUNNER_TEMP` un JSON con `certificateThumbprint`, `digestAlgorithm: sha256` e `timestampUrl: http://timestamp.digicert.com`. Eseguire `npx tauri build --config $configPath`; non scrivere thumbprint o certificato nel repository.

- [ ] **Step 4: Verificare firma prima dell'upload**

```powershell
$installers = @(Get-ChildItem -LiteralPath 'target\release\bundle\nsis' -Filter '*.exe')
if ($installers.Count -ne 1) { throw "Expected one NSIS installer, found $($installers.Count)" }
$installer = $installers[0]
signtool verify /pa /all /v $installer.FullName
if ($LASTEXITCODE -ne 0) { throw 'Installer signature verification failed' }
```

Expected: `Successfully verified` e job verde.

- [ ] **Step 5: Documentare provisioning**

`docs/release/windows-signing.md` spiega come codificare il PFX con `certutil`, creare i due secret GitHub, ruotare il certificato e verificare localmente con `Get-AuthenticodeSignature`. Non includere valori reali.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci.yml src-tauri/tauri.conf.json docs/release/windows-signing.md
git commit -m "ci(release): require signed Windows installer"
```

### Task 7: Aggiornamenti firmati e differiti durante il focus

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/capabilities/default.json`
- Modify: `package.json`
- Modify: `ui/shared/ipc.ts`
- Modify: `ui/panel/index.html`
- Modify: `ui/panel/main.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `docs/release/windows-signing.md`
- Test: `src-tauri/src/commands.rs` (`#[cfg(test)]`)

**Interfaces:**
- Consumes: Tauri updater firmato e stato focus corrente.
- Produces: `update_check`, `update_install` e manifest GitHub Release `latest.json`.

- [ ] **Step 1: Testare che l'installazione non interrompa un focus**

```rust
#[test]
fn update_install_is_deferred_while_a_session_is_open() {
    assert_eq!(update_policy(true, true), UpdatePolicy::DeferUntilIdle);
    assert_eq!(update_policy(false, true), UpdatePolicy::InstallNow);
    assert_eq!(update_policy(false, false), UpdatePolicy::NothingToInstall);
}
```

- [ ] **Step 2: Verificare il fallimento**

Run: `cargo test -p win-buddy commands::tests::update_install_is_deferred_while_a_session_is_open`

Expected: FAIL per policy mancante.

- [ ] **Step 3: Generare una coppia updater fuori dal codice sorgente**

Su una workstation protetta creare la directory ignorata `target\release-secrets` e usare:

```powershell
New-Item -ItemType Directory -Force -Path 'target\release-secrets' | Out-Null
npx tauri signer generate -- -w 'target\release-secrets\win-buddy.key'
```

Salvare il contenuto della chiave privata nei secret GitHub `TAURI_SIGNING_PRIVATE_KEY` e `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; copiare soltanto la chiave pubblica stampata dal comando in `plugins.updater.pubkey`. Eliminare il file privato locale esatto dopo averne verificato il backup sicuro. Il valore pubblico generato è un dato di build ammesso nel repository; quello privato non lo è.

- [ ] **Step 4: Configurare plugin e artefatti**

Aggiungere `tauri-plugin-updater = "2"`, `@tauri-apps/plugin-updater` e i permessi minimi. In `tauri.conf.json` impostare `bundle.createUpdaterArtifacts` a `true`, `plugins.updater.pubkey` all'esatto valore pubblico stampato nello Step 3, `plugins.updater.endpoints` a `https://github.com/RTLuca/win-buddy/releases/latest/download/latest.json` e `plugins.updater.windows.installMode` a `passive`. Prima del commit verificare che la chiave configurata sia identica al file pubblico generato.

- [ ] **Step 5: Implementare check e install differito**

`update_check` restituisce versione e note senza installare. `update_install` applica `update_policy`: se un focus o una pausa sono aperti salva `update.pending = 1` e informa l'utente; appena il core torna idle, il pannello propone Installa e riavvia. Nessun download o riavvio avviene durante una sessione.

- [ ] **Step 6: Firmare updater artifacts in release CI**

Passare i due secret updater come variabili al job tag, usare `tauri-apps/tauri-action@v0` e pubblicare NSIS, `.sig` e `latest.json` nella stessa GitHub Release. Aggiungere un gate che richiede un file `.sig` non vuoto e `latest.json` con `windows-x86_64.signature` e URL HTTPS.

- [ ] **Step 7: Verificare end-to-end**

Pubblicare una prerelease firmata con versione superiore su un canale di prova; da un bundle installato verificare: check disponibile, firma accettata, installazione differita durante focus, installazione passiva da idle e riavvio sulla nuova versione.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/lib.rs src-tauri/src/commands.rs src-tauri/tauri.conf.json src-tauri/capabilities/default.json package.json package-lock.json ui/shared/ipc.ts ui/panel/index.html ui/panel/main.ts .github/workflows/ci.yml docs/release/windows-signing.md
git commit -m "feat(release): add signed deferred updates"
```

## Completion Gate

- Il ciclo Focus è completabile senza mouse e senza annunci al secondo.
- Full, sobrio e nascosto mantengono tray, notifiche e scorciatoie coerenti.
- High Contrast, reduced motion, 100/150/200% DPI e 320 × 420 sono verificati.
- I quattro scenari rispettano i budget RAM/CPU documentati.
- Tutti i casi di recupero automatici e manuali sono verdi.
- Un tag release non può pubblicare un installer con firma assente o non valida.
- Un aggiornamento senza firma valida viene rifiutato e nessun riavvio interrompe una sessione.
