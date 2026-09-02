# Pomodoro P0 — specifica di prodotto e architettura

**Data:** 2 settembre 2026

**Stato:** proposta consolidata dopo approvazione dei mockup

**Ambito:** evoluzione del timer Pomodoro di Win Buddy da timer essenziale a gestore di sessioni flessibile, locale e buddy-first

## 1. Decisioni approvate

1. Le interazioni frequenti sono **buddy-first**: avvio rapido, pausa/ripresa, estensione, cattura di un'interruzione e conclusione.
2. I controlli del buddy compaiono **solo al passaggio del puntatore**. Rimane sempre visibile soltanto un indicatore compatto con fase e tempo.
3. Il buddy apre automaticamente una nuvoletta solo nei punti decisivi: fine sessione, errore, promemoria urgente e ripristino ambiguo.
4. Le operazioni articolate vivono nel pannello da 380 × 640 px.
5. La scheda principale resta **Focus** e contiene tre viste locali: **Prepara**, **Registro**, **Statistiche**.
6. Preset, automazioni, protezione Windows, segnali, accessibilità e gestione dati restano in **Impostazioni**.
7. Il timer non deve punire una sessione interrotta: gli esiti descrivono ciò che è successo e alimentano analisi utili.

## 2. Obiettivi P0

- Rendere il ciclo avvio → lavoro → chiusura → pausa completo senza obbligare ad aprire il pannello.
- Supportare pausa, ripresa, estensione, riduzione, conclusione anticipata e overtime senza perdere il tempo realmente lavorato.
- Preparare una sessione con intenzione, preset e stima, mantenendo un avvio rapido in un gesto.
- Catturare un pensiero o un'interruzione senza cambiare contesto e ripresentarlo nel momento opportuno.
- Proteggere il focus su Windows e ripristinare esattamente lo stato precedente.
- Produrre uno storico correggibile, statistiche comprensibili ed export portabile.
- Mantenere funzionamento locale, robustezza dopo sospensione/riavvio e accessibilità equivalente su tutti i canali.

## 3. Non-obiettivi del primo rilascio

- Project management, calendari complessi o assegnazione di attività.
- Sincronizzazione cloud o account.
- Blocco rigido di siti e applicazioni.
- Gamification, classifiche, streak punitive o ricompense.
- Suggerimenti adattivi basati su modelli predittivi.
- Integrazioni con Slack, Teams o servizi esterni.

## 4. Architettura dell'esperienza

### 4.1 Buddy

Il buddy è la superficie primaria durante il lavoro. L'indicatore compatto è sempre presente e comunica fase, tempo e stato anche senza colore. Il dock di azioni compare al passaggio e si chiude quando il puntatore esce dall'area.

| Stato | Indicatore persistente | Azioni al passaggio | Intervento automatico |
|---|---|---|---|
| Inattivo | `Pronto` oppure ultimo preset | Avvia ultimo preset, apri Focus | Nessuno |
| Focus attivo | `Focus · 18:42` | Pausa, `+5`, cattura, concludi | Solo promemoria urgente o errore |
| Focus in pausa | `In pausa · 12:08` | Riprendi, cattura, concludi | Nessuno |
| Tempo previsto concluso | `00:00 · decidi` | Overtime, `+5`, completata, parziale, interrotta | Nuvoletta di fine sessione una sola volta |
| Overtime | `+07:14` | Concludi, cattura | Nessuno |
| Pausa attiva | `Pausa · 03:21` | Salta, `+5`, concludi | Preavviso/fine secondo preferenze |
| Pausa conclusa | `Pronto a tornare` | Riprendi il focus, apri Focus | Nuvoletta di rientro una sola volta |

Il dock al passaggio non è l'unico accesso alle azioni: pannello, tray, notifiche azionabili e scorciatoie globali garantiscono equivalenza per tastiera, tecnologie assistive e modalità buddy nascosto.

### 4.2 Pannello Focus

La scheda **Focus** usa un controllo segmentato locale:

- **Prepara:** intenzione, preset, durata una tantum, stima, categoria leggera, prossimo passo, protezione Windows e avvio.
- **Registro:** sessioni e pause, tempo effettivo, esito, interruzioni; modifica, inserimento manuale e cancellazione esplicita.
- **Statistiche:** giorno/settimana/mese/anno, focus reale, esiti, previsto/reale, interruzioni e categorie; export CSV/JSON.

Quando esiste una sessione aperta, **Prepara** diventa contestualmente **In corso** senza introdurre una quarta vista. Mostra intenzione, tempo, preset e azioni complete. L'apertura del pannello non è richiesta per le azioni comuni.

### 4.3 Impostazioni

Le nuove sezioni sono:

- **Preset e automazioni:** elenco ordinabile di preset, preset predefinito, auto-avvio focus e auto-avvio pausa come opzioni indipendenti, pausa lunga ogni N focus.
- **Protezione focus:** attivazione Focus/DND, priorità consentite, comportamento se l'integrazione non è disponibile.
- **Segnali e presenza:** preavviso, suoni separati, volume di prova, buddy completo/sobrio/nascosto, countdown visibile/nascosto.
- **Accessibilità:** movimento ridotto, equivalenza sonora/visiva, scorciatoie rimappabili e collegamento alle impostazioni di contrasto del sistema.
- **Dati:** export, backup, ripristino e cancellazione completa.

## 5. Flussi principali

### 5.1 Avvio rapido

1. L'utente passa sul buddy inattivo.
2. Seleziona **Avvia** oppure usa la scorciatoia globale.
3. Parte l'ultimo preset con l'ultima intenzione compatibile o senza intenzione, secondo la preferenza salvata.
4. La protezione Windows viene acquisita prima dell'avvio; un fallimento non impedisce la sessione ma viene segnalato senza ambiguità.

### 5.2 Avvio preparato

1. In Focus → Prepara l'utente scrive “Alla fine avrò…”.
2. Sceglie preset e, se serve, modifica solo la prossima durata.
3. Inserisce una stima in minuti o numero di focus; il dominio la normalizza in millisecondi.
4. Facoltativamente assegna una categoria e un prossimo passo.
5. Avvia. Il preset salvato non viene modificato da un override una tantum.

### 5.3 Pausa, ripresa ed estensione

- **Pausa** congela il residuo e apre un intervallo di pausa tecnica; il tempo di pausa non conta come focus reale.
- **Riprendi** chiude l'intervallo e sposta la scadenza in avanti della sua durata.
- **+1/+5/+10** modificano la scadenza corrente e registrano la variazione.
- La riduzione non può portare la scadenza prima dell'istante corrente: in quel caso porta allo stato “tempo concluso”, non chiude automaticamente la sessione.

### 5.4 Cattura di un'interruzione

1. L'utente sceglie **Cattura** dal buddy o usa la scorciatoia globale.
2. Si apre la finestra di cattura esistente, già associata alla sessione corrente.
3. Il valore predefinito è “pensiero”; sono disponibili via tastiera: pensiero, notifica, persona, telefonata, problema tecnico.
4. Il testo diventa una nota aperta, mentre l'evento di interruzione resta legato alla sessione.
5. Alla pausa o alla chiusura il buddy indica quante catture attendono, senza aprirle automaticamente durante la celebrazione.

### 5.5 Arrivo a zero e overtime

1. Il countdown arriva a zero e la sessione passa a `ready_to_close`.
2. Viene emesso un solo evento di fine prevista e il buddy propone: **Continua**, **+5**, **Concludi**.
3. **Continua** entra in overtime e conta in avanti.
4. **Concludi** offre in un tap: completata, parziale, interrotta. La nota “prossimo passo” resta facoltativa.
5. Se l'utente non interagisce, il lavoro non viene perso né marcato completato automaticamente.

### 5.6 Pausa e rientro

1. Dopo la chiusura il buddy propone la pausa corretta, mai imposta.
2. L'utente può avviarla, rimandarla, estenderla o saltarla.
3. Durante la pausa il pannello rende disponibili catture e suggerimenti fuori dallo schermo.
4. Alla fine compare un invito distinto a riprendere con intenzione e prossimo passo già visibili.

## 6. Modello di dominio

### 6.1 Stati persistenti

```text
idle
  └─ start ─► running
                 ├─ pause ─► paused ── resume ─► running
                 ├─ deadline ─► ready_to_close ── continue ─► overtime
                 └─ finish ─► closed
       overtime ── finish ─► closed
       ready_to_close ── extend ─► running

closed focus ── accept break ─► running break ── deadline/finish ─► idle
```

`ready_to_close` è uno stato persistente, non una semplice animazione. Impedisce che `tick` trasformi automaticamente la sessione in completata e rende il comportamento recuperabile dopo crash o riavvio.

### 6.2 Regole temporali

- Tutti gli istanti restano epoch millisecondi UTC.
- Il residuo è sempre `deadline_at - now`; nessun contatore incrementale.
- In pausa il residuo deriva da `paused_remaining_ms` e non avanza.
- Il focus reale è la somma degli intervalli di lavoro, esclusi gli intervalli di pausa tecnica.
- L'overtime è `now - overtime_started_at` e si somma al focus reale.
- Ogni comando mutante viene eseguito in una transazione e restituisce lo stato aggiornato.
- Una `transition_revision` intera cresce nella stessa transazione di ogni cambiamento. I comandi ricevono la revisione osservata e un comando già applicato diventa un no-op sicuro.

## 7. Persistenza e migrazione SQLite

### 7.1 `pomodoro_presets`

```text
id, name, focus_ms, short_break_ms, long_break_ms, long_every,
auto_start_break, auto_start_focus, is_default, sort_order,
created_at, updated_at
```

La migrazione crea i preset Classico 25/5, Deep Work 50/10 e Sprint 15/3; il preset Classico eredita i valori attuali delle impostazioni per non cambiare il comportamento esistente.

### 7.2 Evoluzione di `pomodoro_sessions`

Campi aggiunti o normalizzati:

```text
preset_id, phase, intention, category, planned_duration_ms,
deadline_at, paused_remaining_ms, overtime_started_at,
estimated_ms, next_step, outcome, interruption_reason,
resolved_at, edited_at, transition_revision
```

Esiti ammessi: `completed`, `partial`, `interrupted`, `invalidated`. Il vecchio `aborted` viene migrato a `interrupted`; le righe storiche restano distinguibili tramite la versione di migrazione se necessario.

### 7.3 `pomodoro_pause_intervals`

```text
id, session_id, started_at, ended_at, reason
```

Una riga aperta identifica una pausa tecnica attiva. La tabella permette tempo reale corretto e audit delle modifiche senza affidarsi a un unico contatore mutabile.

### 7.4 `pomodoro_interruptions`

```text
id, session_id, note_id, kind, captured_at
```

`kind` ammette `thought`, `notification`, `person`, `call`, `technical`. Il testo vive nella nota referenziata, evitando duplicazione e mantenendo il normale flusso Aperte/Archivio.

### 7.5 Registro delle modifiche

Per correzioni e inserimenti manuali viene conservato un log minimo:

```text
pomodoro_session_edits(id, session_id, changed_at, field, old_value, new_value)
```

È locale, esportabile e consente di distinguere dati rilevati e dati corretti.

### 7.6 Eventi di presentazione durevoli

```text
pomodoro_presentation_events(
  id, session_id, kind, transition_revision, created_at, acknowledged_at
)
```

La chiave unica `(session_id, kind, transition_revision)` impedisce di produrre due volte lo stesso evento. Presenter e notifiche usano `id` come chiave di deduplicazione e confermano il consumo; al riavvio vengono recuperati soltanto gli eventi ancora rilevanti. Questa outbox rende verificabile il requisito “una sola volta” anche attraverso un crash.

## 8. Servizi del core

Il modulo `crates/core/src/pomodoro.rs` resta la fonte delle transizioni. Va separato in:

- `domain`: stati, comandi, invarianti e calcolo del tempo;
- `repository`: persistenza delle sessioni, pause, preset e interruzioni;
- `analytics`: query aggregate senza logica UI;
- `export`: serializzazione CSV/JSON versionata.

Comandi di dominio previsti:

```text
prepare/start, pause, resume, adjust_duration, mark_ready,
start_overtime, finish, start_break, skip_break,
capture_interruption, edit_session, create_manual_session
```

Il runtime continua a usare timer mirati, ma `tick` emette transizioni anziché chiudere automaticamente un focus arrivato a zero.

## 9. Contratti Tauri e superfici

### 9.1 DTO condivisi

`PomodoroStatus` deve includere:

- sessione attiva con `phase`, residuo o overtime, intenzione e prossimo passo;
- preset selezionato e lista recenti/preferiti;
- azioni consentite nello stato corrente;
- conteggio delle catture in attesa;
- stato della protezione Windows: inattiva, attiva, degradata o da ripristinare;
- `transition_revision` per aggiornamenti idempotenti.

### 9.2 Comandi IPC

```text
focus_prepare, focus_start, focus_pause, focus_resume,
focus_adjust, focus_overtime, focus_finish,
focus_interruption_capture, focus_history_query,
focus_session_update, focus_session_create,
focus_stats_query, focus_export, focus_backup, focus_restore
```

Ogni comando valida la transizione nel core. Overlay, pannello, tray e notifiche non replicano regole di stato.

### 9.3 Eventi UI

Un singolo evento `focus:changed` trasporta lo snapshot aggiornato. Gli eventi di presentazione — fine prevista, rientro, errore — contengono un identificatore consumabile una volta. Il presenter decide nuvoletta e postura del buddy; il renderer non decide la semantica.

## 10. Protezione Windows

L'integrazione deve essere un adapter distinto dall'attuale politica interna `dnd`, che oggi controlla soprattutto la presenza dell'overlay.

Interfaccia proposta:

```text
SystemFocusGuard.acquire(policy) -> lease
SystemFocusGuard.restore(lease)
SystemFocusGuard.recover_pending()
SystemFocusGuard.capabilities()
```

Prima di modificare lo stato di sistema viene salvato uno snapshot persistente. Il lease viene ripristinato alla fine, all'uscita ordinata e all'avvio successivo dopo un crash. Se la build di Windows non permette il controllo richiesto, Win Buddy continua la sessione, espone lo stato “protezione non disponibile” e offre un collegamento alle impostazioni di sistema.

La fattibilità delle API per Focus Assist/DND e delle eccezioni per app o persone è uno **spike tecnico bloccante** prima di promettere il controllo completo. Il fallback non deve simulare una protezione che non è stata applicata.

La verifica documentale del 2 settembre 2026 restringe lo spike: `Windows.UI.Shell.FocusSessionManager` espone lettura e gestione di Focus, ma avvio e terminazione sono **Limited Access Features** e richiedono approvazione/token Microsoft. Win Buddy userà quindi tre capability esplicite — non disponibile, sola lettura, controllabile — senza ricorrere a registro o Group Policy non documentati. In sola lettura, l'azione esplicita dell'utente apre l'URI ufficiale `ms-settings:quiethours`. Riferimenti: [FocusSessionManager](https://learn.microsoft.com/en-us/uwp/api/windows.ui.shell.focussessionmanager), [LimitedAccessFeatures](https://learn.microsoft.com/en-us/uwp/api/windows.applicationmodel.limitedaccessfeatures), [URI delle impostazioni Windows](https://learn.microsoft.com/en-us/windows/apps/develop/launch/launch-settings).

## 11. Scorciatoie, tray e notifiche

Le azioni comuni condividono gli stessi identificatori semantici:

```text
focus.start_last, focus.pause_resume, focus.extend_5,
focus.capture, focus.finish, break.start, break.skip
```

- Le scorciatoie globali sono rimappabili e rilevano conflitti prima del salvataggio.
- Il tray mostra soltanto azioni valide nello stato corrente.
- Le notifiche di fine offrono Continua, Pausa e Concludi; gli aggiornamenti non duplicano la notifica.
- La chiusura da una superficie aggiorna tutte le altre tramite `focus:changed`.

## 12. Analytics ed export

Le query producono dati, non valutazioni morali:

- tempo di focus reale e tempo in pausa;
- esiti e motivi di interruzione;
- confronto previsto/reale;
- distribuzione per categoria e preset;
- viste giorno, settimana, mese e anno.

CSV contiene una riga per sessione, con durate normalizzate e conteggi. JSON include sessioni, intervalli, preset, interruzioni e versione schema. Backup e ripristino operano su un pacchetto locale verificato prima di sostituire i dati. La cancellazione completa richiede conferma esplicita e non è annullabile.

## 13. Accessibilità e comportamento sensoriale

- Tutte le azioni hanno un percorso senza puntatore tramite pannello, tray o scorciatoia.
- Il timer espone fase e minuti significativi allo screen reader, non annuncia ogni secondo.
- Stato, testo e icona accompagnano sempre il colore.
- Il layout resta utilizzabile da 320 px, con scaling Windows e testo ingrandito.
- `prefers-reduced-motion` disattiva animazioni non essenziali del buddy e delle transizioni.
- Ogni segnale sonoro ha un equivalente visivo e ogni evento visivo importante può avere un suono configurabile.
- Buddy nascosto e countdown nascosto non disattivano notifiche, tray o scorciatoie.

### 13.1 Privacy, affidabilità e distribuzione

- Timer, storico, suoni, statistiche ed export funzionano senza rete e senza account.
- La sezione Dati spiega quali informazioni vengono memorizzate e per quale funzione.
- Titoli delle finestre, applicazioni in uso e contenuti esterni non vengono raccolti dal P0.
- Installer e aggiornamenti devono essere firmati prima del rilascio pubblico.
- I test di durata verificano che overlay e timer rispettino il budget CPU/RAM già definito per l'app sempre attiva.
- I promemoria non urgenti già accodati durante il focus rimangono accodati; pausa e chiusura mostrano il conteggio senza recap invasivi.

## 14. Gestione errori e recupero

- Un comando non valido restituisce errore tipizzato e lo snapshot corrente.
- Un doppio clic o una notifica ripetuta non applica due volte la stessa transizione.
- Dopo sospensione breve la sessione riprende dallo stato persistito.
- Dopo un'assenza lunga una sessione ambigua compare nel recupero come “da verificare”; non viene celebrata né scartata silenziosamente.
- Un lease Windows pendente viene ripristinato prima di consentire una nuova acquisizione.
- Un export fallito non modifica il database; un restore viene validato e applicato in transazione.

## 15. Strategia di rilascio

### Slice A — Motore flessibile

Migrazione schema, preset, macchina a stati, pausa/ripresa, modifica durata, `ready_to_close`, overtime, esiti e recupero.

### Slice B — Buddy-first

Indicatore persistente, dock al passaggio, azioni coerenti nel pannello e nel tray, scorciatoie e notifiche azionabili.

### Slice C — Intenzione e interruzioni

Prepara, stima, recenti/preferiti, prossimo passo, cattura legata alla sessione e restituzione in pausa.

### Slice D — Protezione Windows

Spike API, adapter con lease, ripristino dopo crash, stato degradato e configurazione delle priorità disponibili.

### Slice E — Registro, statistiche e portabilità

Correzione/manuale, aggregazioni, viste temporali, CSV/JSON, backup, restore e cancellazione.

### Slice F — Accessibilità e hardening

Tastiera, screen reader, contrasto, DPI, movimento ridotto, equivalenza sensoriale, test sospensione/riavvio/fuso orario e budget risorse.

Ogni slice deve essere integrabile e lasciare il prodotto utilizzabile; le feature incomplete restano dietro capability interne, non dietro controlli visibili che non funzionano.

## 16. Verifica e criteri di accettazione

### Core

- Test di ogni transizione valida e invalida.
- Test deterministici con orologio iniettato per pausa, estensione, overtime, sospensione, cambio ora/fuso e riavvio.
- Proprietà: al massimo una sessione aperta; al massimo una pausa aperta per sessione; esito chiuso immutabile salvo modifica esplicita.
- Migrazione verificata sia da database vuoto sia dallo schema v1 con storico esistente.

### Superfici

- Ogni azione produce lo stesso risultato da buddy, pannello, tray, notifica e scorciatoia.
- Il dock non compare senza hover, non copre il buddy e resta utilizzabile con target adeguati.
- Fine prevista e rientro vengono annunciati esattamente una volta.
- Il pannello funziona a 380 × 640 e al minimo 320 × 420 senza contenuti sovrapposti.

### Sistema e accessibilità

- Lo stato Windows precedente viene ripristinato dopo fine, abort, chiusura e crash simulato.
- L'app dichiara chiaramente quando la protezione non è disponibile.
- Percorso completo avvio → pausa → ripresa → chiusura → pausa eseguibile senza mouse.
- Screen reader, contrasto elevato, scaling misto e movimento ridotto verificati su Windows.

### Dati

- Il focus reale esclude le pause e include correttamente l'overtime.
- Una modifica storica aggiorna aggregazioni ed export.
- CSV e JSON sono reimportabili o documentati e non omettono informazioni necessarie.
- Nessun dato di app o titoli finestra viene raccolto senza opt-in separato.

## 17. Rischi e decisioni tecniche aperte

1. **API Windows Focus/DND:** da validare con spike su build Windows supportate; determina il livello reale di automazione e priorità configurabili.
2. **Overlay interattivo:** il dock al passaggio deve convivere con la modalità click-through senza rubare focus; va misurata l'area interattiva e verificato il comportamento multi-monitor/DPI.
3. **Recupero di sessioni ambigue:** va scelta una soglia iniziale e misurato quante volte richiede conferma; il dato non deve essere perso automaticamente.
4. **Scorciatoie globali:** collisioni con sistema e altre app richiedono validazione preventiva e fallback visibile.
5. **Crescita dati:** gli intervalli e il log delle modifiche sono piccoli, ma le query annuali devono usare indici e aggregazioni misurate su storici pluriennali.

## 18. Esito della progettazione

Il P0 non è un singolo “timer più ricco”: è una macchina a stati persistente condivisa da più superfici. Il buddy offre la velocità; il pannello offre comprensione e controllo; il core conserva una sola semantica. Questa separazione consente di aggiungere in seguito Flowtime, insight adattivi e blocchi opzionali senza rifare il ciclo fondamentale.
