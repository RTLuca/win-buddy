# Win Buddy Focus Timer — ricerca di mercato e report funzionale

**Data:** 2 settembre 2026

**Scopo:** definire le funzionalità necessarie per rendere Win Buddy il miglior gestore di sessioni di focus per Windows, mantenendo il suo carattere di compagno da scrivania locale, discreto e leggero.

## Sintesi esecutiva

Il mercato non ha bisogno dell'ennesimo countdown 25/5. I concorrenti migliori dominano singole aree:

- Pomofocus è rapido e collega timer, stime e report;
- TickTick e Focus To-Do integrano il timer in un task manager completo;
- Forest rende il focus tangibile con progressione visiva e blocco delle distrazioni;
- Session cura intenzione, rituale, riflessione, modalità overtime e automazioni;
- Freedom è specializzato nel blocco difficile da aggirare;
- Focusmate offre responsabilità sociale tramite body doubling;
- Windows Focus controlla nativamente notifiche e segnali della barra delle applicazioni.

Win Buddy possiede già due vantaggi insoliti: un'entità sempre visibile che può accompagnare il ciclo senza aprire un'app e un'integrazione intelligente tra focus e promemoria, che vengono rimandati alla pausa. A questi si aggiungono funzionamento offline, privacy locale e un motore resistente a sospensione e riavvio.

La direzione raccomandata è quindi:

> **Win Buddy non deve diventare un task manager. Deve diventare il miglior “rituale operativo di focus” su Windows: ti fa iniziare, protegge la sessione, non spezza il flow, rende utile la pausa e ti aiuta a capire il tuo ritmo.**

Le cinque capacità che definiscono il prodotto sono:

1. **Partenza senza attrito:** iniziare con un'intenzione chiara in meno di cinque secondi.
2. **Protezione reale:** DND, cattura delle interruzioni e blocco opzionale di app/siti.
3. **Flessibilità senza complessità:** classico 25/5, deep work, micro-focus e Flowtime.
4. **Pause che recuperano:** il buddy guida una pausa breve, non un'altra attività sullo schermo.
5. **Apprendimento personale:** statistiche e suggerimenti che ottimizzano energia e continuità, non il numero grezzo di ore lavorate.

## 1. Cosa esiste già in Win Buddy

L'analisi del repository mostra una base più robusta di un timer tipico.

| Area | Stato attuale |
|---|---|
| Motore | Focus, pausa breve e lunga; durate configurabili; pausa lunga ogni N focus |
| Affidabilità | Scadenze assolute; recupero dopo sospensione/riavvio; invalidazione delle sessioni stale; nessun contatore soggetto a deriva |
| Contesto | Etichetta facoltativa della sessione |
| Storico | Sessioni completate, interrotte o invalidate; conteggio giornaliero |
| Interazione | Avvio e interruzione dal pannello; proposta della pausa; overlay e tray |
| Buddy | Stati idle/focus/break/alert/celebrate/sleep; countdown nell'overlay; modalità sobria |
| Distrazioni | DND automatico per fullscreen/presentazioni; promemoria non urgenti accodati durante il focus |
| Privacy | SQLite locale, offline, nessun account o telemetria |

Le lacune più importanti sono: pausa/ripresa, estensione e overtime, preset per tipo di lavoro, auto-avanzamento configurabile, rituale di inizio/fine, cattura e misura delle interruzioni, protezione nativa del focus, analytics utili, esportazione e controlli di accessibilità verificati.

## 2. Cosa dice la ricerca

### 2.1 Il 25/5 è un buon default, non una verità universale

La tecnica originale è un sistema di pianificazione, stima, gestione delle interruzioni e revisione; il timer è soltanto un componente. Lo ribadisce lo stesso Francesco Cirillo nel [sito ufficiale della tecnica](https://www.pomodorotechnique.com/francesco-cirillo/).

Uno studio sullo studio autonomo ha rilevato che pause sistematiche, incluse sessioni 24/6 simili al Pomodoro, erano associate a minore fatica e distrazione percepite e maggiore concentrazione rispetto alle pause autoregolate; non ha però trovato un miglioramento significativo nel completamento delle attività e alcuni partecipanti hanno percepito le pause come un'interruzione del flow ([Biwer et al., 2023](https://bpspsychub.onlinelibrary.wiley.com/doi/10.1111/bjep.12593)).

Un confronto successivo tra Pomodoro, Flowtime e pause autoregolate non ha trovato una tecnica complessivamente superiore per motivazione, produttività percepita, fatica, completamento o flow; ha invece osservato una forte variabilità individuale ([Biwer et al., 2025](https://pmc.ncbi.nlm.nih.gov/articles/PMC12292963/)).

**Conseguenza di prodotto:** offrire struttura, ma preservare autonomia. Il preset 25/5 deve essere il punto di partenza, affiancato da durate personalizzate, Flowtime, overtime e una modalità in cui il countdown è nascosto.

### 2.2 Le pause aiutano soprattutto recupero e benessere

Una meta-analisi di 22 campioni e 2.335 partecipanti ha trovato piccoli effetti positivi delle micro-pause su vigore e riduzione della fatica, ma nessun effetto complessivo significativo sulla performance; per attività cognitivamente impegnative potrebbero servire pause superiori a dieci minuti ([Albulescu et al., 2022](https://pubmed.ncbi.nlm.nih.gov/36044424/)). Una revisione di 83 studi sottolinea inoltre che efficacia e significato della pausa dipendono da iniziatore, durata, frequenza, attività ed esperienza ([Lyubykh et al., 2022](https://pubmed.ncbi.nlm.nih.gov/35980721/)).

**Conseguenza di prodotto:** non promettere aumenti garantiti di produttività. Il buddy deve insegnare pause realmente rigenerative, adattarne durata e contenuto e misurare come l'utente si sente al ritorno.

### 2.3 Dichiarare l'intenzione vale più di fissare soltanto il tempo

Una meta-analisi su 94 test ha trovato un effetto medio-grande delle intenzioni di implementazione — piani concreti “quando accade X, farò Y” — sul raggiungimento degli obiettivi ([Gollwitzer e Sheeran, 2006](https://www.sciencedirect.com/science/article/abs/pii/S0065260106380021)). La ricerca sull'attention residue mostra inoltre che passare a un'altra attività lasciando incompleta la precedente può peggiorare la prestazione successiva ([Leroy, 2009](https://www.sciencedirect.com/science/article/pii/S0749597809000399)).

**Conseguenza di prodotto:** ogni sessione dovrebbe avere un esito concreto, una cattura rapida per non inseguire pensieri laterali e un “segnalibro di rientro” prima della pausa.

### 2.4 La gamification deve sostenere autonomia, non produrre colpa

Le sintesi della letteratura attribuiscono valore a obiettivi chiari, percorsi scelti dall'utente, feedback immediato, progressione visibile e supporto sociale. Una meta-analisi di 35 interventi ha trovato un effetto piccolo sulla motivazione intrinseca, con benefici maggiori su autonomia e relazione che sulla competenza ([Li et al., 2024](https://link.springer.com/article/10.1007/s11423-023-10337-7)).

**Conseguenza di prodotto:** il buddy può crescere, decorare il proprio spazio e celebrare la costanza, ma non deve morire, rimproverare o azzerare brutalmente una serie perché una sessione è stata interrotta.

## 3. Benchmark competitivo

Il confronto usa funzioni dichiarate nelle pagine ufficiali, consultate il 2 settembre 2026.

| Prodotto | Punti forti rilevanti | Spazio lasciato a Win Buddy |
|---|---|---|
| [Pomofocus](https://pomofocus.io/) | Avvio rapido, task, stime in sessioni, template, progetti, report, CSV, Todoist e webhook | È un timer/task list, non una presenza ambientale Windows |
| [Focus To-Do](https://www.focustodo.cn/?lang=en_US) | Task, sottoattività, ricorrenze, scadenze, note, promemoria, report e sincronizzazione multipiattaforma | Grande ampiezza, poca differenziazione sul rituale e sulla privacy locale |
| [TickTick](https://ticktick.com/windows) | Integrazione con task e calendario, mini-finestra Windows, Pomo e cronometro, stime, rumori, obiettivi e statistiche | Il focus è una funzione dentro una suite più affollata |
| [Forest](https://forestapp.cc/) | Blocco app/siti, allowlist, progressione visiva, sfide, suoni, focus di gruppo, analytics e uso offline del core | Gamification forte ma meno contestuale al desktop e al lavoro in corso |
| [Session](https://stayinsession.com/learn/getting-started-with-session-pomodoro-app) | Intenzione, respiro iniziale, blocker, preavviso, overtime, riflessione, note, calendario, automazioni e sync | Esperienza molto curata ma centrata sull'ecosistema Apple |
| [Freedom](https://freedom.to/features) | Blocklist, allowlist, pianificazione ricorrente, modalità bloccata e copertura multipiattaforma | Protegge dalle distrazioni ma non orchestra bene l'intero ciclo focus–pausa |
| [Focusmate](https://support.focusmate.com/en/articles/9110188-getting-started) | Sessioni 25/50/75 con intenzione, body doubling e resoconto finale | Richiede account, rete, appuntamento e presenza video |
| [Windows Focus](https://support.microsoft.com/en-us/windows/focus-stay-on-task-without-distractions-in-windows-cbcc9ddb-8164-43fa-8919-b9a2af072382) | DND, occultamento di badge e lampeggi della taskbar, timer di sistema | Niente coach, memoria delle interruzioni o analisi personale |
| **Win Buddy oggi** | Buddy sempre presente, offline/local-first, recupero robusto, note urgenti e accodamento dei promemoria | Controlli e modalità limitati; mancano protezione, rituali e analytics |

La combinazione non ancora presidiata bene è: **compagno ambientale + privacy locale + protezione Windows + flessibilità del flow + gestione delle interruzioni**.

## 4. Inventario completo delle funzionalità

Legenda: **P0** indispensabile per competere; **P1** differenziante; **P2** espansione o esperimento.

### 4.1 Motore del timer e modalità

- **P0 — Preset salvabili:** Classico 25/5, Deep Work 50/10, Sprint 15/3 e valori personalizzati.
- **P0 — Durata una tantum:** modificare la prossima sessione senza cambiare il preset.
- **P0 — Pausa/ripresa:** con tempo effettivo separato dal tempo in pausa e motivo facoltativo.
- **P0 — Estendi/riduci:** `+1`, `+5`, `+10` minuti e conclusione anticipata.
- **P0 — Auto-avvio indipendente:** auto-avvia pause e auto-avvia focus come opzioni separate, mai imposte.
- **P0 — Overtime gentile:** allo zero il focus può continuare a contare, senza perdere il lavoro svolto.
- **P0 — Esiti realistici:** completata, parziale, interrotta, invalidata e corretta manualmente.
- **P0 — Cronologia modificabile:** correggere etichetta, categoria, durata o una registrazione dimenticata.
- **P0 — Scorciatoie globali personalizzabili:** avvia, pausa/riprendi, termina, estendi e cattura distrazione.
- **P0 — Controlli da overlay e tray:** le azioni comuni non devono richiedere l'apertura del pannello.
- **P0 — Persistenza robusta:** sospensione, ibernazione, riavvio, cambio dell'orologio, ora legale e cambio fuso.
- **P1 — Flowtime:** cronometro in salita; l'utente ferma il focus e riceve una pausa proporzionale configurabile.
- **P1 — Micro-start:** impegno iniziale da 2–5 minuti per superare la resistenza all'avvio, poi proposta di continuare.
- **P1 — Sessione “fino a”:** termina prima del prossimo evento di calendario o a un'ora scelta.
- **P1 — Countdown nascosto:** mostra solo fase o avanzamento morbido per chi prova ansia da timer.
- **P1 — Catena di sessioni:** sequenza preparata di focus e pause, con possibilità di divergere senza perderla.
- **P2 — Timer collaborativo:** stanza privata con cicli sincronizzati, solo come modulo di rete esplicito.

### 4.2 Rituale prima del focus

- **P0 — Intenzione unica:** “Alla fine di questa sessione avrò…” invece di un generico titolo.
- **P0 — Avvio rapido:** un tasto globale riapre l'ultima intenzione/preset e parte immediatamente.
- **P0 — Recenti e preferiti:** riprendere attività frequenti senza creare una struttura di progetti interna.
- **P0 — Stima:** numero di sessioni o minuti previsti, con confronto successivo tra previsto e reale.
- **P1 — Prossima azione:** trasformare “lavorare al report” in un passo osservabile e piccolo.
- **P1 — Piano per le interruzioni:** opzione “Se mi viene in mente altro, lo catturo e torno qui”.
- **P1 — Reset di tre secondi:** respiro o countdown breve, disattivabile.
- **P1 — Check energia:** un solo tap basso/medio/alto per scegliere o suggerire il preset più adatto.
- **P1 — Coda Focus:** massimo 1–3 intenzioni prossime; non una nuova lista di attività completa.
- **P2 — Avvio contestuale:** deep link o estensione per iniziare dalla scheda ClickUp, Todoist, Linear o Jira aperta.

### 4.3 Protezione dalle distrazioni

- **P0 — Integrazione Windows Focus/DND:** attivare la protezione all'inizio e ripristinare esattamente lo stato precedente alla fine.
- **P0 — Priorità configurabili:** consentire allarmi, persone o app indispensabili.
- **P0 — Cattura interruzione a zero attrito:** scorciatoia che salva un pensiero senza cambiare finestra e lo ripresenta in pausa.
- **P0 — Separazione interno/esterno:** distinguere pensiero spontaneo, notifica, persona, telefonata o problema tecnico.
- **P0 — Accodamento dei promemoria:** mantenere e rendere più visibile il comportamento già previsto da Win Buddy.
- **P1 — Blocco siti:** blocklist e allowlist tramite estensione browser per Edge/Chrome/Firefox.
- **P1 — Blocco applicazioni:** elenco locale, avviso morbido oppure chiusura/blocco forte a scelta.
- **P1 — Modalità impegno:** durante la sessione non si può ridurre la protezione; deve esistere un'uscita d'emergenza esplicita e registrata.
- **P1 — Sessioni di protezione pianificate:** orari ricorrenti o avvio prima di un blocco di calendario.
- **P1 — Rilevamento inattività:** al ritorno chiede se contare, escludere o riprendere il tempo trascorso lontano.
- **P2 — Trigger contestuali locali:** suggerire l'avvio quando si apre un'app/progetto noto; titoli delle finestre solo con consenso e conservazione minima.
- **P2 — Stato di presenza:** aggiornare Teams/Slack durante il focus, come integrazione di rete facoltativa.

### 4.4 Esperienza durante il focus

- **P0 — Stato leggibile a colpo d'occhio:** fase, tempo e intenzione senza aprire il pannello.
- **P0 — Tre livelli di presenza:** buddy completo, modalità sobria e completamente nascosto con soli segnali di sistema.
- **P0 — Preavviso configurabile:** segnale gentile 1–2 minuti prima della fine per chiudere un'unità di lavoro.
- **P0 — Controlli coerenti:** stessa semantica in overlay, tray, pannello, notifica e scorciatoie.
- **P0 — Silenzioso, suono o entrambi:** allarmi separati per focus, pausa e preavviso, con volume di prova.
- **P1 — Segnale di presenza:** suono/gesto discreto ogni N minuti per ritornare all'intenzione, disattivabile.
- **P1 — Soundscape offline:** pioggia, caffè, rumore bianco/rosa/marrone e combinazioni salvate.
- **P1 — Focus visivo senza cifre:** anello, luce o postura del buddy per comunicare il progresso senza countdown.
- **P1 — Overflow:** al termine scegliere continua, estendi, pausa o chiudi; il sistema non interrompe il flow da solo.
- **P2 — Collegamento all'attività:** pulsante per tornare alla finestra, documento o URL da cui la sessione è iniziata.

### 4.5 Conclusione e rientro

- **P0 — Chiusura in un tap:** completato, parziale o interrotto; nessun modulo obbligatorio.
- **P0 — Segnalibro di rientro:** breve nota “il prossimo passo è…” mostrata quando ricomincia il focus.
- **P0 — Smaltimento delle catture:** vedere i pensieri e promemoria accodati senza invadere il momento di celebrazione.
- **P1 — Valutazione leggera:** focus percepito ed energia, massimo due domande a risposta singola.
- **P1 — Riflessione facoltativa:** cosa è stato concluso o imparato.
- **P1 — Annulla ultima azione:** recuperare una conclusione/interruzione toccata per errore.
- **P1 — Riprendi la stessa intenzione:** nuova sessione già predisposta con il segnalibro precedente.
- **P2 — Suggerimento personale:** propone durata o modalità sulla base dello storico, spiegando il motivo e lasciando sempre la scelta.

### 4.6 Pause realmente rigenerative

- **P0 — Pausa proposta, non imposta:** avvia, salta, estendi o rimanda di pochi minuti.
- **P0 — Guida fuori dallo schermo:** alzati, acqua, guarda lontano, respira, cammina o semplicemente non fare nulla.
- **P0 — Ritorno chiaro:** avviso distinto e azione “riprendi” con intenzione e prossimo passo già visibili.
- **P1 — Pausa contestuale:** suggerimenti diversi per durata, ora, energia e numero di sessioni consecutive.
- **P1 — Fullscreen di pausa facoltativo:** blocca il lavoro solo per chi lo desidera.
- **P1 — Anti-scroll in pausa:** mantiene bloccati i siti più dispersivi, evitando che cinque minuti diventino trenta.
- **P1 — Micro-movimento animato:** il buddy mostra un gesto semplice; nessuna pretesa medica o fitness.
- **P1 — Pausa lunga intelligente:** suggerita anche in base al tempo totale e alla fatica dichiarata, non soltanto ogni quattro sessioni.
- **P2 — Check di recupero:** “ti senti più pronto?” per imparare quali pause funzionano davvero per quella persona.

### 4.7 Statistiche e apprendimento personale

- **P0 — Tempo di focus reale:** minuti effettivi, non soltanto numero di timer completati.
- **P0 — Esiti:** completate, parziali, interrotte e invalidate, con cause quando disponibili.
- **P0 — Viste giorno/settimana/mese/anno:** totali, medie e distribuzione.
- **P0 — Categorie leggere:** etichette e filtri senza trasformare il prodotto in project management.
- **P0 — Previsto vs reale:** precisione delle stime per attività o categoria.
- **P0 — Export e portabilità:** CSV e JSON; backup, ripristino, cancellazione completa.
- **P1 — Heatmap personale:** ore e giorni in cui focus ed energia sono migliori.
- **P1 — Interruzioni:** frequenza, fonte e tempo di ritorno al compito.
- **P1 — Qualità delle pause:** rispetto della pausa, durata reale e ritorno alla sessione.
- **P1 — Confronto dei preset:** quale combinazione produce migliore focus percepito e minori interruzioni.
- **P1 — Bilancio sostenibile:** evidenziare anche pause prese e orario di chiusura, non premiare soltanto l'eccesso di lavoro.
- **P1 — Obiettivi settimanali:** minuti o sessioni, con giorni liberi e recupero; nessun obbligo di serie quotidiana.
- **P1 — Revisione settimanale locale:** tre insight concreti e una singola modifica suggerita.
- **P2 — Esperimenti personali:** prova due ritmi per alcune sessioni e confronta i risultati, dichiarando i limiti dei dati.

### 4.8 Il buddy come vantaggio competitivo

- **P0 — Linguaggio coerente degli stati:** postura, colore, animazione e testo comunicano la stessa fase.
- **P0 — Intensità regolabile:** neutro, incoraggiante o giocoso; la modalità scelta vale più della “personalità” imposta.
- **P0 — Rinforzo positivo:** celebra iniziare, ritornare e prendersi una pausa, non soltanto lavorare a lungo.
- **P0 — Nessuna punizione emotiva:** niente creatura triste o morta per una sessione interrotta.
- **P1 — Body doubling simbolico:** il buddy si mette al lavoro in silenzio insieme all'utente, senza sollecitazioni continue.
- **P1 — Memoria del rituale:** ricorda preset, soundscape e grado di presenza per ogni tipo di attività.
- **P1 — Progressione ambientale:** lo spazio del buddy cresce con costanza e comportamenti sostenibili.
- **P1 — Ricompense cosmetiche:** ottenute anche prendendo pause e chiudendo in orario; niente acquisti necessari al focus.
- **P1 — Coaching contestuale breve:** una frase utile nel momento giusto, con frequenza limitabile o azzerabile.
- **P1 — Animazioni di pausa:** respirazione, stretching illustrativo, acqua o passeggiata.
- **P2 — Focus con un amico:** il buddy rappresenta una presenza remota senza richiedere video; privacy e rete sono però un prodotto separato.

### 4.9 Integrazioni

- **P0 — Windows:** DND/Focus, notifiche azionabili, tray, avvio automatico e scorciatoie globali.
- **P0 — Notifiche azionabili:** inizia pausa, continua, estendi e termina senza aprire l'app. Windows supporta azioni, progress bar e aggiornamenti silenziosi delle notifiche ([Microsoft Learn](https://learn.microsoft.com/en-us/windows/apps/develop/notifications/app-notifications/)).
- **P1 — Calendario locale/read-only:** mostra il prossimo impegno e crea sessioni che vi si adattano.
- **P1 — Protocollo URL e CLI locale:** avvio, pausa, stato e cattura per PowerToys, AutoHotkey, Stream Deck e automazioni.
- **P1 — Estensione browser:** blocker e avvio dal contesto di strumenti esterni.
- **P1 — Connettori task opt-in:** ClickUp prima di tutto, poi Todoist/Linear/Jira; importare l'intenzione e riportare il tempo, non duplicare il task manager.
- **P1 — Export calendario:** registrare le sessioni concluse in un calendario scelto.
- **P2 — Teams/Slack:** stato e DND sincronizzati, disattivati per impostazione predefinita.
- **P2 — Multi-device:** controllo e notifiche da telefono; richiede una scelta esplicita tra LAN, cloud o provider esterno.

### 4.10 Accessibilità e inclusività

- **P0 — Operabilità completa da tastiera:** ordine logico, focus visibile e scorciatoie rimappabili.
- **P0 — Screen reader:** nomi, ruoli, stati e aggiornamenti del timer esposti senza annunciare ogni secondo.
- **P0 — Contrasto:** almeno 4,5:1 per testo normale e nessuna informazione affidata soltanto al colore.
- **P0 — Temi ad alto contrasto e scaling:** layout utilizzabile con temi Windows, DPI misti e testo ingrandito.
- **P0 — Movimento ridotto:** animazioni eliminate o sostituite rispettando la preferenza di sistema.
- **P0 — Equivalenza sensoriale:** ogni allarme sonoro ha un segnale visivo e viceversa.
- **P0 — Controllo dello stimolo:** modalità sobria, countdown nascosto, silenzio totale e buddy non animato.
- **P1 — Profili di partenza:** gentile/micro-focus, classico, deep work e flow, senza etichettare o diagnosticare l'utente.
- **P1 — Linguaggio non giudicante:** “sessione interrotta” invece di “fallimento”.
- **P1 — Localizzazione completa:** formati 12/24 ore, lingua, plurali e primo giorno della settimana.

Microsoft raccomanda accesso programmatico per le tecnologie assistive, navigazione completa da tastiera e contrasto adeguato ([guida Windows all'accessibilità](https://learn.microsoft.com/en-us/windows/apps/develop/accessibility)).

### 4.11 Privacy, sicurezza e qualità

- **P0 — Local-first reale:** timer, storico, suoni e insight funzionano senza rete e senza account.
- **P0 — Trasparenza dei dati:** schermata che mostra cosa viene memorizzato e perché.
- **P0 — Export, backup e cancellazione:** nessun lock-in.
- **P0 — Nessuna sorveglianza predefinita:** app e titoli delle finestre non vengono registrati senza opt-in separato.
- **P0 — Ripristino dello stato di sistema:** DND e altre impostazioni tornano sempre al valore precedente, anche dopo crash.
- **P0 — Notifica esattamente una volta:** niente finali persi o duplicati dopo resume e riavvio.
- **P0 — Installer firmato e aggiornamenti affidabili:** requisito di fiducia per una utility sempre attiva.
- **P0 — Budget di risorse verificato:** rispettare i limiti CPU/RAM della specifica esistente.
- **P1 — Backup cifrato facoltativo:** file portabile protetto da password.
- **P1 — Conservazione configurabile:** eliminazione automatica dei dettagli granulari mantenendo aggregati.
- **P2 — Sync cifrato opzionale:** non deve mai diventare necessario per le funzioni core.

## 5. Esperienza ideale end-to-end

1. L'utente preme una scorciatoia globale.
2. Il buddy propone ultimo preset e intenzioni recenti; basta Invio per partire.
3. Facoltativamente l'utente dichiara un esito concreto e una stima.
4. Win Buddy abilita la protezione scelta, memorizzando lo stato precedente di Windows.
5. Durante il focus il buddy lavora in silenzio; pensieri e richieste vengono catturati con una scorciatoia e rimandati.
6. Poco prima della fine arriva un segnale discreto per creare un punto di chiusura.
7. Allo zero l'utente può continuare in overtime, estendere, concludere o prendere la pausa.
8. Scrive opzionalmente il prossimo passo; Win Buddy presenta le catture e i promemoria maturati.
9. Il buddy guida una pausa appropriata, possibilmente lontano dallo schermo.
10. Al ritorno mostra intenzione e segnalibro, riducendo il costo di ripresa.
11. Lo storico alimenta insight locali e comprensibili, mai ordini opachi.

## 6. Priorità consigliata

### Fase A — Portare il core allo standard migliore

1. Pausa/ripresa, estensione, conclusione anticipata, overtime e tempo effettivo.
2. Preset, auto-avvio separato, Flowtime e micro-start.
3. Controlli rapidi coerenti in overlay, tray, notifiche e scorciatoie.
4. Intenzione, stima, segnalibro di rientro e chiusura leggera.
5. Nuovo modello dati per pause, interruzioni, valutazioni e sessioni parziali.
6. Export/backup e analytics fondamentali.
7. Accessibilità e casi limite di sospensione/orologio trattati come criteri di rilascio.

### Fase B — Costruire il vantaggio Win Buddy

1. Cattura delle interruzioni e restituzione in pausa.
2. Protezione Windows Focus/DND con ripristino sicuro.
3. Pausa guidata e ritorno con prossimo passo.
4. Buddy configurabile come body double, coach e rinforzo positivo.
5. Insight locali su ritmo, interruzioni, stime e recupero.
6. Blocco siti tramite estensione e blocco app opzionale.

### Fase C — Ampliare senza perdere il centro

1. Calendario e sessione “fino al prossimo evento”.
2. ClickUp e altri connettori tramite deep link/estensione/API locale.
3. Automazioni locali e Stream Deck.
4. Presenza Teams/Slack e sync multi-device solo come moduli opt-in.
5. Focus condiviso senza video come esperimento separato.

## 7. Cosa non costruire

- Un task manager completo con progetti, dipendenze, priorità e collaborazione: Win Buddy perderebbe semplicità e competerebbe frontalmente con prodotti molto più grandi.
- Un assistente AI conversazionale permanente: aggiunge costo, rete e distrazione prima di provare valore nel ciclo base.
- Streak punitive, classifiche globali o perdita di ricompense per malattia, ferie o interruzioni legittime.
- Blocco rigido attivo per impostazione predefinita o senza uscita d'emergenza.
- Tracciamento automatico di applicazioni, siti o titoli di finestra senza consenso granulare.
- Dashboard piene di grafici senza una decisione concreta suggerita.
- Notifiche motivazionali durante il focus: il compito del buddy è proteggere l'attenzione, non reclamarla.

## 8. Metriche per definire “migliore del mercato”

La metrica principale non dovrebbe essere il numero di sessioni o le ore accumulate, perché incentiva uso eccessivo e sessioni vuote.

### Valore per l'utente

- percentuale di sessioni iniziate entro 60 secondi dall'apertura del comando rapido;
- ritorno al focus dopo la pausa;
- riduzione delle interruzioni auto-riferite nel tempo;
- accuratezza crescente di previsto vs reale;
- focus ed energia percepiti al termine;
- quota di utenti che trova utile almeno un insight settimanale.

### Qualità del prodotto

- avvio di una sessione in massimo un'interazione dopo la scorciatoia;
- tutte le azioni comuni accessibili senza aprire il pannello;
- zero notifiche finali perse o duplicate nei test di sospensione, riavvio e cambio dell'ora;
- ripristino corretto di DND e protezioni anche dopo crash;
- rispetto dei budget CPU/RAM già definiti dal progetto;
- flusso principale completabile con tastiera e screen reader.

### Salute del comportamento

- rapporto sostenibile tra focus e pause;
- nessun aumento sistematico delle sessioni oltre l'orario scelto;
- uso della modalità gentile/flow senza peggiorare il ritorno dopo pausa;
- interruzioni e sessioni abortite trattate come segnali diagnostici, non errori morali.

## 9. Rischi e decisioni aperte

1. **Controllo di Windows Focus/DND:** l'esperienza desiderata è chiara, ma le API e le restrizioni delle diverse build di Windows vanno validate con uno spike tecnico dedicato.
2. **Blocco app e siti:** richiede privilegi e componenti più invasivi. Va separato dal core e reso completamente opzionale.
3. **Gamification:** può rafforzare il buddy oppure trasformarlo in una distrazione. Deve essere misurata su ritorno e costanza, non su tempo nell'app.
4. **Adattività:** i dati del singolo utente sono pochi e rumorosi. I suggerimenti devono restare semplici, spiegabili e reversibili; niente falsa precisione.
5. **Scope creep:** calendario e integrazioni devono alimentare una singola intenzione, non ricreare la gestione dei progetti.
6. **Marchio:** “Pomodoro®” e “Pomodoro Technique®” sono marchi dichiarati dal titolare. Le [linee guida ufficiali](https://www.pomodorotechnique.com/pomodoro-trademark-guidelines/) limitano l'uso in nomi e software. È prudente presentare il prodotto come **Win Buddy Focus Timer**, usare “Pomodoro” solo dopo verifica legale o licenza e non impiegare un pomodoro rosso come identità visiva. Questa nota non sostituisce un parere legale.

## Raccomandazione finale

La versione migliore di Win Buddy non vince perché offre più menu. Vince perché coordina, in modo quasi invisibile, ciò che oggi richiede quattro prodotti distinti:

> **intenzione → protezione → focus flessibile → chiusura → recupero → rientro → apprendimento**

Le prime funzioni da realizzare sono il nuovo ciclo di sessione flessibile, la cattura delle interruzioni, il segnalibro di rientro, l'integrazione con la protezione Windows e analytics orientati a decisioni. La progressione del buddy viene subito dopo: è il moltiplicatore emotivo e il principale elemento che nessun concorrente può copiare senza cambiare identità.
