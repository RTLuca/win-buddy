# Task 4 fix round 3 — Confine giornata nelle pause proposte

Data: 2026-09-02

Base autorizzata: `007737b56d9a9fde26ba9c5d906a54d0b2552c06`

## Esito

`accept_proposed_break` include ora il focus corrente nel conteggio della giornata soltanto quando la sessione è iniziata a partire da `day_start`, con la stessa semantica di `completed_focus_since`. Con tre focus odierni già completati, un focus `ReadyToClose` iniziato prima del confine apre quindi una `ShortBreak`; il quarto focus iniziato oggi continua ad aprire una `LongBreak` con `long_every = 4`.

Il guard `completed_after_current > 0` mantiene inoltre corta la prima pausa del giorno quando il focus accettato è iniziato nella giornata precedente.

## TDD: RED → GREEN

| Comportamento | RED osservato | GREEN osservato |
|---|---|---|
| Tre focus odierni completati + focus corrente iniziato prima di `day_start` | `accepting_focus_started_before_day_boundary_does_not_trigger_long_break`: `LongBreak`, atteso `ShortBreak` | PASS dopo aver reso condizionale l'inclusione del focus corrente |
| Nessun focus odierno + focus corrente iniziato prima di `day_start` | durante self-review: `LongBreak`, atteso `ShortBreak`, perché `0 % long_every == 0` | PASS con guard esplicito sul conteggio positivo |
| Quarto focus iniziato oggi | caso positivo aggiunto | PASS e produce `LongBreak` |

La mutation check è diretta: ripristinare il `+ 1` incondizionato rompe il test richiesto al confine; non aggiungere mai il focus corrente rompe il caso positivo del quarto focus; rimuovere il guard sullo zero rompe il caso senza completamenti odierni.

## Correzione

- Il conteggio persistito resta derivato da SQLite, senza introdurre contatori incrementali.
- `accept_proposed_break` legge la sessione aperta e aggiunge `1` soltanto per `started_at >= day_start`.
- La selezione della pausa lunga richiede un conteggio positivo e divisibile per `long_every`, come `proposed_break`.
- `finish_ready_focus_from_presentation` non è stato modificato: ID evento, sessione focus, kind `ready_to_close`, revisione e fase corrente continuano a essere validati nella transazione che esegue finish + ack + insert opzionale della pausa.

## Verifica finale

- `cargo test -p win-buddy-core` → PASS, 89 test, 0 failure; doc-test PASS.
- `cargo test --workspace` → PASS, 89 test core + 17 test shell, 0 failure; doc-test PASS.
- `cargo clippy -p win-buddy-core --all-targets -- -D warnings` → PASS.
- `cargo clippy -p win-buddy --all-targets -- -D warnings` → PASS.
- `rustfmt --edition 2021 --check crates/core/src/pomodoro.rs` → PASS.
- `git diff --check` → PASS; resta soltanto l'avviso Git sulla futura conversione LF→CRLF.

Il controllo aggiuntivo globale `cargo fmt --all -- --check` continua a segnalare formattazione preesistente in file estranei; non ha modificato il worktree. Il file Rust toccato passa il controllo `rustfmt` mirato.

## Self-review

- Verificato l'uso esatto del confronto inclusivo `started_at >= day_start` già presente nella query giornaliera.
- Verificati sia il lato negativo al confine sia il lato positivo del quarto focus odierno.
- Verificato il caso zero emerso dalla nuova inclusione condizionale.
- La suite core ha rieseguito i test di evento obsoleto, kind errato e rollback dell'inserimento pausa, tutti verdi.
- Nessun metodo store, contratto shell, percorso DND/FIFO o file UI è stato modificato.

## File modificati

- `crates/core/src/pomodoro.rs`
- `.superpowers/sdd/2026-09-02-pomodoro-p0-core-engine/task-4-fix3-report.md`
