# Task 4 fix round 2 — Azioni atomiche e bootstrap FIFO

Data: 2026-09-02

Base autorizzata: `84994a963e8859312ea5ff6d622062c372f9dbed`

## Esito

Corretti i quattro finding Important e i due Minor del fix2 brief. In modalità Discreet/sober una bubble nascosta non conferma più l'outbox; il toast nativo viene comunque schedulato anche quando l'overlay esiste, senza usare il successo del plugin come ack. Le azioni legacy portano l'ID SQLite fino al core, validano evento/sessione/kind/revisione e chiudono focus, confermano evento e aprono l'eventuale pausa in una sola transazione. Il bootstrap accoda prima il replay durevole e poi gli eventi live ricevuti nel frattempo. Rejection dei pulsanti e fallimenti di init/subscription/replay sono contenuti e loggati.

Non sono stati introdotti i DTO completi del Task 5 né `AppState.break_prompt`.

## TDD: RED → GREEN

| Comportamento | RED osservato | GREEN osservato |
|---|---|---|
| Bubble non visibile in sober | ack effettivo `[41]`, atteso `[]` | nessun ack finché `BubbleLayer.show` non conferma visibilità |
| FIFO boot/live | consumo `[42,41]`, atteso `[41,42]` | replay `41` seguito dal live bufferizzato `42` |
| Errori subscription/replay | `assert.doesNotReject` riceveva `subscribe failed` | errori riportati e bootstrap contenuto |
| Rejection pulsanti legacy | export `createBubbleCommandHandler` assente | errore riportato, bubble non dismissata; successo dismissato |
| Repository atomico | `finish_ready_focus_from_presentation` assente (`E0599`) | consumo correlato, skip e accept verdi |
| API dominio accept/skip | funzioni assenti (`E0425`) | entrambe verdi con outbox consumata |
| Passaggio ID nel bridge | firma a 4 argomenti, test ne richiedeva 5 (`E0061`) | comandi e IPC portano l'ID outbox |
| Toast Discreet/sober con overlay | decision helper assente (`E0425`) | Discreet/sober `true`, Normal visibile e Hidden `false` |
| Validazione kind evento | tolto il predicato per mutation check: `Ok(())` invece dell'errore | un evento non `ready_to_close` non muta il focus |
| Rollback dello start break | mutation check con commit separato: focus `Closed`, atteso `ReadyToClose` | trigger SQLite forza lo start fallito e focus+ack restano invariati |

## Soluzioni

### Presentazione visibile e DND

Il consumer richiede ora che `render` restituisca `true` prima di invocare l'ack. `BubbleLayer.show` restituisce `false` quando il layer è nascosto dalla modalità sober. Il presenter schedula il toast Pomodoro quando la policy lo consente e l'overlay è assente **oppure** la modalità è sober/Discreet. Hidden continua a non presentare e lascia pending. La cache nativa resta solo una barriera effimera anti-duplicato: né `emit()` né `NotificationBuilder::show()` confermano l'evento.

### Bridge transazionale e identità evento

`breakAccept(eventId)` e `breakSkip(eventId)` inoltrano l'ID SQLite ai comandi Tauri e alle nuove operazioni core. Il repository seleziona soltanto un evento con:

- ID richiesto;
- `kind = ready_to_close`;
- sessione `focus` corrente in `ReadyToClose` senza outcome;
- `transition_revision` dell'evento uguale a quella della sessione.

Nella stessa transazione SQLite vengono chiusi eventuali intervalli tecnici, chiuso il focus come `Completed`, applicato l'ack con `COALESCE` e inserita l'eventuale break. Un trigger di test che abortisce l'insert della break dimostra il rollback di focus e ack. Un evento già confermato resta utilizzabile per l'azione se l'associazione è ancora valida, senza riscrivere il primo ack.

### Bootstrap FIFO ed error handling

La subscription live viene installata prima del replay, ma durante il bootstrap i live sono bufferizzati. Il consumer riceve in sequenza il replay durevole, poi il buffer live, mantenendo deduplica per ID e serializzazione degli ack. Errori di subscribe, replay o consume vengono loggati e contenuti; il fallback temporizzato che monta il buddy resta indipendente. I pulsanti legacy attendono il comando, dismissano soltanto sul successo e catturano/loggano le rejection.

## Invarianti verificate

- Dedup outbox `(session_id,kind,transition_revision)` invariata.
- ID durevole UI/retry sempre quello SQLite `i64`.
- CAS e incremento revisione della chiusura restano nel repository.
- Stale break pre-deadline resta `ReadyToClose`/reviewable senza outcome automatico.
- `adjust_duration` esplicito di una break fino a `now` resta `ReadyToClose` senza outcome.
- Nessun ack deriva dalla sola schedulazione del plugin notification.

## File modificati

- `crates/core/src/pomodoro.rs`
- `crates/core/src/store.rs`
- `src-tauri/src/commands.rs`
- `src-tauri/src/presenter.rs`
- `ui/shared/ipc.ts`
- `ui/overlay/main.ts`
- `ui/overlay/bubbles.ts`
- `ui/overlay/pomodoro-presentations.ts`
- `tests/pomodoro-presentations.test.ts`
- `tests/bubbles.test.ts`
- `.superpowers/sdd/2026-09-02-pomodoro-p0-core-engine/task-4-fix2-report.md`

## Verifica finale

- `cargo test -p win-buddy-core` → PASS, 86 test, 0 failure; doc-test PASS.
- `cargo test --workspace` → PASS, 86 test core + 17 test shell, 0 failure; doc-test PASS.
- `cargo check -p win-buddy` → PASS.
- `cargo clippy -p win-buddy-core --all-targets -- -D warnings` → PASS.
- `cargo clippy -p win-buddy --all-targets -- -D warnings` → PASS.
- `npm run test:ui` → PASS, 13 test, 0 failure.
- `npm run check` → PASS.
- `npm run build` → PASS; resta il warning Vite preesistente per il chunk overlay oltre 500 kB.
- `git diff --check` → PASS; soltanto gli avvisi Git sulla futura conversione LF→CRLF.

I test Node/Vite hanno richiesto l'esecuzione fuori sandbox per `spawn EPERM` nella creazione dei processi figli.

## Self-review

- Verificato che la bubble sober non possa ackare un render invisibile e che Discreet riceva comunque il toast immediato.
- Verificato che Hidden non presenti né confermi eventi.
- Verificato che il plugin notification non abbia alcun percorso verso l'ack.
- Verificato che accept/skip usino l'ID della bubble e rifiutino eventi obsoleti o di kind errato.
- Verificato con mutation check che separare commit e start-break fa fallire il test di rollback.
- Verificato che replay e live producano deterministicamente `[41,42]` e che duplicati convergano sullo stesso ID.
- Verificato che gli errori UI non producano rejection non gestite e non dismissino una bubble su comando fallito.
- Verificato che nessun piano o file estraneo sia stato modificato.

## Limite residuo

Il backend notification di Windows non fornisce una ricevuta affidabile di effettiva visualizzazione. Per questo il toast nativo segnala subito in sober/Discreet ma lascia l'evento pending finché una superficie visibile non lo renderizza e conferma; la cache per-processo evita soltanto toast ripetuti nello stesso processo.
