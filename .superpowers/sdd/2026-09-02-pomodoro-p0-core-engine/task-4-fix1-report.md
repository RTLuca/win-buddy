# Task 4 fix round 1 — Recovery e presentazione verificabile

Data: 2026-09-02

Base autorizzata: `7b4dfe2d9441af2a6289fc3b28019c785db088df`

## Esito

Corretti i quattro finding Important della review indipendente. Le break rese ambigue da un gap lungo diventano reviewable in modo persistente; l'outbox viene confermata soltanto dal consumer overlay dopo il render; il boot esegue replay senza race; i comandi legacy di pausa producono nuovamente transizioni reali derivate dal database; il fallback Windows non usa più `NotificationBuilder::id` e non conferma eventi sulla base della sola schedulazione del plugin.

Corretto anche il Minor: una break recente completata durante recovery restituisce `Recovery::Nothing`, non `ReadyToClose(Closed)`.

## TDD: RED → GREEN

I test sono stati scritti o modificati prima delle rispettive modifiche di produzione e osservati in RED:

| Comportamento | RED osservato | GREEN osservato |
|---|---|---|
| Break stale prima della deadline | `Running`, atteso `ReadyToClose` | test mirato PASS; il tick successivo non produce `ReturnPrompt` né outcome |
| Delivery runtime senza conferma UI | outbox pending `[]`, atteso l'evento originale | PASS: emissione/schedulazione lascia pending |
| Consumer UI e dedupe live/boot | modulo consumer assente (`ERR_MODULE_NOT_FOUND`) | PASS |
| Mapping focus/break | export `pomodoroPresentationBubble` assente | PASS; solo un focus ready espone le azioni legacy |
| Coda di eventi UI | render `[41, 42]`, atteso `[41]` finché il primo ack è pendente | PASS; presentazioni serializzate |
| Ordine subscription → replay | export del coordinatore assente | PASS; il replay parte soltanto dopo tutte le subscription |
| Replay boot Rust | `pomodoro_presentations` assente (`E0425`) | PASS con ID/sessione/revisione/tipo stabili |
| Bridge accept/skip | helper e `LegacyBreakAction` assenti (`E0425`/`E0433`) | entrambi PASS |
| Recovery di una break recente | variante restituita diversa da `Recovery::Nothing` | PASS mantenendo `Completed + ReturnPrompt` |

## Soluzioni

### Recovery delle break ambigue

Nel ramo stale di `resolve_open`, una break ancora `Running` passa a `ReadyToClose` tramite `set_phase_with_presentation_event(..., RecoveryNeeded)`. La transizione CAS e l'insert outbox restano nella stessa transazione; revisione, rollback e unicità `(session_id, kind, transition_revision)` non cambiano. Il ramo esplicito `adjust_duration` fino a `now` resta invariato: `ReadyToClose`, nessun outcome automatico.

### Consumer reale, boot senza race e acknowledgement

- Il runtime presenta gli eventi pending ma non chiama più l'ack dopo `emit()` o `show()`.
- L'overlay registra tutti i listener, incluso `pomodoro:presentation`, prima di invocare `surface_ready`.
- `OverlayBoot` include un DTO di presentazione ristretto (`id`, `session_id`, `kind`, `transition_revision`, `session_kind`), senza anticipare i DTO completi del Task 5.
- Il consumer deduplica consegna live e replay usando l'ID SQLite, serializza eventi distinti, esegue il render e soltanto dopo invoca `pomodoro_presentation_ack`.
- Un ack fallito rimuove l'evento soltanto dalla coda UI in-flight: l'outbox resta pending e una consegna successiva ritenta lo stesso ID.
- Il replay applica prima stato/bubble di boot e poi le presentazioni Pomodoro, evitando che una bubble iniziale sovrascriva il prompt recuperato.
- In DND Hidden non vengono emessi eventi né inclusi nel boot; l'outbox resta pending.

### Bridge legacy

`break_accept` e `break_skip` leggono la sessione aperta dal database sotto il lock dello store e accettano soltanto un focus `ReadyToClose`. Entrambi lo chiudono esplicitamente come `Completed` usando la revisione corrente; `break_accept` calcola poi `proposed_break` dai dati persistenti e avvia la break configurata, mentre `break_skip` non apre una nuova sessione. Non è stato reintrodotto `AppState.break_prompt`.

Il payload di un focus `ReadyToClose` produce la bubble legacy con “Inizia pausa” e “Salta”; un `ReadyToClose` di una break, compreso quello causato dall'adjust esplicito, resta informativo e non espone azioni di completamento focus.

### Fallback nativo e logging

Il presenter non imposta più `.id(...)` sul notification builder, perché il backend desktop lo ignora. Un set effimero per-processo evita di rischedulare continuamente lo stesso toast dopo una chiamata `show()` riuscita; in caso di errore la prenotazione viene rimossa. Questa cache non è verità di dominio e non ack-a nulla: l'identità durevole resta l'ID outbox inviato alla UI e riusato nei retry.

Gli errori di tick/recovery/outbox/presentazione che il loop runtime non può propagare vengono ora loggati. Il comando di ack propaga l'errore al consumer, che lascia l'evento ritentabile.

## File modificati

- `crates/core/src/pomodoro.rs`
- `src-tauri/src/commands.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/src/presenter.rs`
- `src-tauri/src/runtime.rs`
- `src-tauri/src/state.rs`
- `ui/shared/contracts.ts`
- `ui/shared/ipc.ts`
- `ui/overlay/main.ts`
- `ui/overlay/bubbles.ts`
- `ui/overlay/pomodoro-presentations.ts`
- `tests/pomodoro-presentations.test.ts`
- `package.json`

## Verifica finale

- `cargo test -p win-buddy-core` → PASS, 80 test, 0 failure; doc-test PASS.
- `cargo test --workspace` → PASS, 80 test core + 16 test shell, 0 failure; doc-test PASS.
- `cargo check -p win-buddy` → PASS.
- `cargo clippy -p win-buddy-core --all-targets -- -D warnings` → PASS.
- `cargo clippy -p win-buddy --all-targets -- -D warnings` → PASS (controllo aggiuntivo).
- `npm run test:ui` → PASS, 8 test, 0 failure.
- `npm run check` → PASS.
- `npm run build` → PASS; resta il warning Vite preesistente per il chunk overlay oltre 500 kB.
- `git diff --check` → PASS; soltanto gli avvisi Git sulla futura conversione LF→CRLF.

I test Node/Vite hanno richiesto l'esecuzione fuori sandbox perché la creazione dei processi figli fallisce in sandbox con `spawn EPERM`.

## Self-review

- Verificato che nessun path runtime ack-i un evento dopo la sola emissione Tauri o schedulazione nativa.
- Verificato che il solo ack di produzione sia il comando invocato dal consumer dopo il render.
- Verificato che live delivery e replay di boot convergano sullo stesso consumer e sullo stesso ID, senza doppio render/ack.
- Verificato che eventi distinti non si sovrascrivano prima dell'ack precedente.
- Verificato che DND Hidden non presenti e non confermi eventi.
- Verificato che la cache nativa sia esclusivamente effimera e che `AppState.break_prompt` non sia stato reintrodotto.
- Verificato che accept/skip usino stato e revisione correnti del database e che nessuna regola di transizione sia duplicata nel renderer.
- Verificato che il ramo stale della break usi ancora la transazione outbox esistente e che il tick successivo non inventi `Completed`.
- Verificato che l'adjust esplicito di una break fino a `now` resti senza outcome.
- Verificato che nessun documento di piano o file estraneo sia stato modificato.

## Limite residuo

Il plugin notification continua a offrire soltanto conferma della schedulazione API, non una ricevuta di visualizzazione di Windows. Per questo il toast nativo non produce ack: se l'overlay non riesce mai a renderizzare, l'evento resta correttamente pending e può essere ripresentato con lo stesso ID in un processo successivo.
