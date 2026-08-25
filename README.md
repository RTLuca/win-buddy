# win-buddy

Compagno da scrivania in overlay per **Windows 11**: una creatura 3D che vive
sopra le altre finestre, gestisce sessioni **pomodoro** e **note con
promemoria**, e si può nascondere del tutto quando dà fastidio. Sempre acceso,
quindi progettato attorno al costo di stare acceso.

La specifica completa è in [`docs/SPEC.md`](docs/SPEC.md); i prototipi di
concept (bestiario animato e mockup desktop) in [`docs/concept/`](docs/concept/).

## Architettura

**Tauri v2** (core Rust + WebView2 di sistema) · **three.js** per la creatura ·
**SQLite** per i dati. Un solo processo, quattro superfici con cicli di vita
indipendenti:

```
┌─────────────────────────────────────────────────────┐
│ CORE (Rust, sempre acceso, nessuna UI)              │
│  · store SQLite          · scheduler promemoria     │
│  · macchina pomodoro     · gestione DND             │
│  · tray + scorciatoie    · watcher sospensione      │
└───────────────┬─────────────────────────────────────┘
                │ eventi
   ┌────────────┼──────────────┬──────────────────┐
   ▼            ▼              ▼                  ▼
OVERLAY      PANNELLO      CATTURA RAPIDA      TOAST
(effimero)   (a richiesta) (Ctrl+Alt+Spazio)  (nativo)
```

Regola non negoziabile: **tutta la logica di dominio sta nel core**
(`crates/core`, testato e indipendente da Tauri). Il renderer riceve stati già
decisi e li mostra. Se la webview viene distrutta a metà di un pomodoro non
succede nulla, perché non conteneva nulla di importante.

## Struttura del repository

| Percorso | Cosa contiene |
|---|---|
| `crates/core` | Logica di dominio: store SQLite (FTS5), scheduler (§ 7), pomodoro (§ 8), parsing della cattura rapida (§ 11), livelli DND (§ 10.3), eventi (§ 12). Tutta testata. |
| `src-tauri` | La shell: superfici e cicli di vita, tray, scorciatoie globali, heartbeat con rilevamento sospensione, click-through con hit-test, DND automatico, API Windows dietro `cfg(windows)` (`src/platform.rs`). |
| `ui/` | Frontend Vite+TypeScript, tre pagine: `overlay` (le sei creature three.js + nuvolette + modalità sobria), `panel` (note, archivio, pomodoro, impostazioni), `capture` (cattura rapida). Nessuna risorsa di rete: funziona a scheda spenta. |
| `docs/` | Il materiale di progetto originale: specifica, prototipi, schema, contratto. |

## Sviluppo

Prerequisiti: Rust stabile, Node 22+. Su Windows serve WebView2 (già presente
su Windows 11); su Linux `libwebkit2gtk-4.1-dev` e `libayatana-appindicator3-dev`.

```sh
npm install
cargo test -p win-buddy-core   # la logica, ovunque
npm run build                  # typecheck + bundle delle tre pagine
npx tauri dev                  # l'app intera (su Windows per il collaudo vero)
npx tauri build                # installer NSIS in target/release/bundle/nsis/
```

La CI (`.github/workflows/ci.yml`) esegue i test del core su Linux e compila
l'app completa su `windows-latest`, caricando l'**installer NSIS** come
artifact di ogni push: è il modo più rapido di provarla senza toolchain locale.

## Stato rispetto alle milestone della specifica (§ 13)

- **M1 — Core senza faccia**: store, scheduler con tick/timer mirato/recupero,
  macchina pomodoro con le regole di sospensione (§ 8.3), tray, cattura rapida
  con parser italiano. Fatto, con test.
- **M2 — Overlay sobrio**: finestra trasparente always-on-top, click-through
  con hit-test sulla sagoma, pillola di stato, toast nativi, DND manuale
  (Ctrl+Alt+H) e automatico (`SHQueryUserNotificationState`), ciclo di vita
  della webview (distruzione in DND e inattività). Fatto.
- **M3 — La creatura**: le sei creature del bestiario in three.js dietro il
  contratto a quattro metodi, colori semantici, animazioni per stato,
  nuvolette ancorate, cambio a caldo con `dispose()`. Fatto.
- **M4 — Archivio**: pannello note con ricerca full-text, storico pomodoro,
  impostazioni. Fatto.

Restano da fare **sulla macchina vera** (non verificabili in CI): la misura dei
budget di risorse del § 3 con Process Explorer, il comportamento multi-monitor
con DPI misti, e la taratura fine del rettangolo di hit-test.

## Scorciatoie

| Tasti | Azione |
|---|---|
| `Ctrl+Alt+Spazio` | Cattura rapida |
| `Ctrl+Alt+H` | DND nascosto on/off |
| clic sulla creatura | apre il pannello |

Nella cattura rapida la scadenza si scrive nel testo: `+2h`, `+30m`, `+3g`,
`18:00`, `lun 9:30`, `dom 15`, `stasera`, `domani`, `dopodomani`, `giovedì`.
Un `!` in testa marca la nota urgente (può interrompere un focus). Tutto il
resto va ai pulsanti di ripiego o al selettore di data.
