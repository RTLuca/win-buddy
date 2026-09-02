# Pomodoro P0 Implementation Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Coordinare i sei piani P0 in un ordine che mantenga Win Buddy eseguibile e verificabile dopo ogni slice.

**Architecture:** Il motore persistente è la base comune; superfici, interruzioni, Windows e analytics si appoggiano ai suoi contratti senza duplicare logica. Accessibilità e hardening chiudono la release dopo l'integrazione funzionale.

**Tech Stack:** Rust 2021, SQLite/rusqlite, Tauri 2, TypeScript 5.9, HTML/CSS, Windows Runtime, GitHub Actions

**Spec:** `docs/superpowers/specs/2026-09-02-pomodoro-p0-design.md`

## Global Constraints

- Preservare tutte le modifiche preesistenti nel worktree; non usare reset o checkout distruttivi.
- Iniziare l'esecuzione con `superpowers:using-git-worktrees` oppure concordare come incorporare le modifiche non committate da cui dipende il lavoro.
- Usare TDD per ogni comportamento e `superpowers:verification-before-completion` a ogni completion gate.
- Nessuna slice viene considerata completa con test ignorati o controlli manuali obbligatori non eseguiti.
- Ogni commit deve contenere un cambiamento autonomo e la relativa prova.

---

## Ordine di esecuzione

1. **Core Engine** — blocca tutti gli altri piani.
   `docs/superpowers/plans/2026-09-02-pomodoro-p0-core-engine.md`
2. **Buddy and Surfaces** — migra pannello, overlay, tray e scorciatoie ai nuovi contratti.
   `docs/superpowers/plans/2026-09-02-pomodoro-p0-buddy-surfaces.md`
3. **Intent and Interruptions** — completa preparazione, cattura e rientro.
   `docs/superpowers/plans/2026-09-02-pomodoro-p0-intent-interruptions.md`
4. **Windows Integration** — può partire dopo Core Engine e procedere in parallelo ai punti 2–3, ma si integra soltanto dopo la stabilizzazione dei comandi.
   `docs/superpowers/plans/2026-09-02-pomodoro-p0-windows-integration.md`
5. **History, Analytics and Data** — parte dopo Intent/Interruptions perché aggrega anche le catture.
   `docs/superpowers/plans/2026-09-02-pomodoro-p0-history-analytics-data.md`
6. **Accessibility and Hardening** — gate finale trasversale, dopo l'integrazione degli altri cinque piani.
   `docs/superpowers/plans/2026-09-02-pomodoro-p0-accessibility-hardening.md`

## Checkpoint di prodotto

- [ ] **Checkpoint A — Motore:** migrazione v1, stati flessibili, recupero e outbox verificati.
- [ ] **Checkpoint B — Buddy-first:** ciclo quotidiano completo senza aprire il pannello.
- [ ] **Checkpoint C — Intento:** preparazione e cattura delle interruzioni funzionano end-to-end.
- [ ] **Checkpoint D — Windows:** capability reale documentata, lease sicuro e notifiche azionabili installate.
- [ ] **Checkpoint E — Comprensione:** registro, statistiche, export e backup concordano sugli stessi dati.
- [ ] **Checkpoint F — Release candidate:** accessibilità, recupero, budget risorse e firma superano i gate.

## Comando di verifica globale

Eseguire al termine di ogni checkpoint applicabile:

```powershell
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npm run test:ui
npm run build
```

La release candidate aggiunge `npx tauri build`, risolve l'unico file `target/release/bundle/nsis/*.exe`, ne verifica la firma con `signtool verify /pa /all /v` e completa la matrice manuale descritta in `docs/qa/pomodoro-recovery-matrix.md`.

## Stato iniziale da preservare

Il repository contiene modifiche non committate anteriori a questi piani, incluse superfici, creature, schema e dipendenze. Prima dell'esecuzione va creata una base recuperabile che le includa, senza assumere che `HEAD` rappresenti lo stato corrente dell'app. I file di mockup sotto `.superpowers/` sono materiale di esplorazione e non sono una dipendenza runtime.
