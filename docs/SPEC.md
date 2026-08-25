# desk-buddy — specifica tecnica

**Versione** 0.1 · **Piattaforma** Windows 11 · **Stato** bozza di progetto

Compagno da scrivania in overlay: una creatura 3D che vive sopra le altre finestre,
gestisce sessioni pomodoro e ti ricorda note con scadenza. Sempre acceso, quindi
progettato attorno al costo di stare acceso.

---

## 1. Obiettivi e non obiettivi

### Obiettivi

1. **Pomodoro** — sessioni di focus con pause brevi e lunghe, avvisi a fine sessione, animazioni coerenti con lo stato.
2. **Note con promemoria** — cattura rapida di testo, scadenza a data/ora, notifica alla scadenza con rinvio o completamento.
3. **Recupero** — un promemoria scaduto mentre l'app era spenta viene notificato al riavvio, non perso.
4. **Archivio** — note aperte consultabili, note chiuse ricercabili.
5. **Presenza discreta** — overlay che si può nascondere del tutto (DND) e che non disturba durante presentazioni e videochiamate.
6. **Costo trascurabile** — l'app sta accesa dodici ore al giorno su una macchina già impegnata.

### Non obiettivi

- Non è un task manager. Nessuna priorità, nessun tag, nessuna sottotask, nessuna dipendenza. Il lavoro vero vive in ClickUp; qui si cattura e si ricorda.
- Nessuna sincronizzazione cloud nella v1. Tutto locale, tutto offline.
- Nessun account, nessuna telemetria.
- Nessuna integrazione con sessioni Claude Code (valutata e accantonata: vedi § 14).

---

## 2. Vincoli

| Vincolo | Valore |
|---|---|
| Sistema | Windows 11 (build 22000+), singolo utente |
| Modalità | avvio automatico al login, residente in tray |
| Rete | nessuna. L'app funziona con la scheda di rete spenta |
| Dati | interamente locali, nessun dato lascia la macchina |
| Multi-monitor | supporto DPI per-monitor v2, riposizionamento su cambio configurazione |

---

## 3. Budget delle risorse

Sono **target di progetto**, non misure. Vanno verificati con Process Explorer prima
di considerare chiusa la milestone 1, e ogni superamento è un bug, non un compromesso.

| Stato | RAM (working set) | CPU |
|---|---|---|
| Core dormiente (DND o idle prolungato, nessuna webview) | ≤ 20 MB | ~0 % |
| Overlay in modalità sobria (nessun 3D) | ≤ 60 MB | < 0,5 % |
| Overlay con creatura 3D, animazione a riposo | ≤ 130 MB | < 1,5 % |
| Picco durante un'animazione di avviso | ≤ 160 MB | < 4 % |

Le quattro leve che rendono raggiungibili questi numeri, in ordine di efficacia:

1. **Ciclo di vita della finestra.** La webview non è residente. Viene distrutta in DND,
   dopo N minuti senza pomodoro attivo né promemoria imminenti, e su richiesta esplicita.
   Il costo di riapertura (~300–500 ms) è invisibile perché non avviene mai durante
   un'interazione dell'utente.
2. **Rendering su richiesta.** Nessun `requestAnimationFrame` continuo. Il loop parte
   quando c'è un'animazione da mostrare e si ferma appena la creatura torna in una posa
   stabile. A riposo si anima a 30 fps, non a 60.
3. **Pausa su occlusione.** Rendering completamente fermo quando l'overlay non è visibile:
   fullscreen di un'altra app, sessione bloccata, monitor spento, minimizzazione.
4. **Geometria condivisa.** Le creature riusano geometrie e materiali dove possibile e
   rilasciano tutto al cambio buddy (§ 9). Senza `dispose()` esplicito ogni cambio di
   personaggio lascia buffer sulla GPU.

---

## 4. Scelta dello stack

**Decisione: Tauri v2** (core Rust + WebView2 di sistema) per la shell,
**three.js** per la creatura, **SQLite** per i dati.

Motivazione: il requisito dominante è il costo a riposo. Tauri usa il WebView2 già
presente nel sistema invece di spedire un Chromium, e soprattutto permette di tenere
acceso il core senza alcuna finestra — che è la condizione in cui l'app passa la maggior
parte del tempo. Un core Rust con SQLite e un timer resta nell'ordine dei 10 MB.

Costo della scelta: la shell va scritta in Rust, e le API Windows per l'overlay
(click-through, hit-test, rilevamento fullscreen) vanno chiamate direttamente via
`windows-rs` invece di avere un wrapper pronto. Sono circa 300 righe di codice
di piattaforma, scritte una volta.

**Ripiego: Electron.** Se la shell Rust diventa un ostacolo, Electron accorcia la
milestone 1 di giorni e ha wrapper pronti per quasi tutto (`setIgnoreMouseEvents`,
`powerMonitor`, `globalShortcut`). In cambio si rinuncia al budget del § 3: la soglia
a riposo diventa ~90 MB, con la webview attiva ~250 MB. Il resto della specifica —
modello dati, scheduler, contratto buddy, stati — resta valido senza modifiche.

**Da non fare:** WPF o WinUI con un renderer 3D nativo. Butterebbe via tutto il lavoro
sulle creature e sostituirebbe un problema noto con un problema nuovo.

---

## 5. Architettura

Un solo processo, quattro superfici con cicli di vita indipendenti.

```
┌─────────────────────────────────────────────────────┐
│ CORE (Rust, sempre acceso, nessuna UI)              │
│  · store SQLite                                     │
│  · scheduler promemoria (§ 7)                       │
│  · macchina a stati pomodoro (§ 8)                  │
│  · gestione DND (§ 10)                              │
│  · icona tray + scorciatoie globali                 │
│  · watcher: sospensione/ripresa, fullscreen, sblocco│
└───────────────┬─────────────────────────────────────┘
                │ eventi (§ 12)
   ┌────────────┼──────────────┬──────────────────┐
   ▼            ▼              ▼                  ▼
OVERLAY      PANNELLO      CATTURA RAPIDA      TOAST
(effimero)   (a richiesta) (a richiesta)      (nativo)
creatura 3D  note+archivio una riga di testo  fallback
nuvolette    impostazioni  chiude a Invio     quando
             pomodoro                          l'overlay
                                               è nascosto
```

Regola non negoziabile: **tutta la logica di dominio sta nel core**. Il renderer riceve
stati già decisi e li mostra. Non calcola scadenze, non decide quando è ora di una pausa,
non tiene contatori. Se la webview viene distrutta a metà di un pomodoro non succede nulla,
perché non conteneva nulla di importante.

### 5.1 Superfici

| Superficie | Vive | Muore |
|---|---|---|
| Overlay | quando c'è qualcosa da mostrare | DND, idle prolungato, occlusione persistente |
| Pannello | clic sulla creatura o voce di tray | alla chiusura |
| Cattura rapida | scorciatoia globale (`Ctrl+Alt+Spazio`) | a Invio o Esc |
| Toast nativo | promemoria con overlay non visibile | da solo |

---

## 6. Modello dati

SQLite locale in `%APPDATA%\desk-buddy\buddy.db`. Schema completo in `sql/schema.sql`.

### 6.1 Principi

- **Nessun contatore incrementale.** Ogni durata è una coppia di istanti assoluti in
  epoch millisecondi UTC. Lo stato si ricalcola sempre come `scadenza − adesso`.
  Un contatore che scala di un secondo alla volta è sbagliato per costruzione: salta
  con la sospensione, va in deriva con il throttling dei timer, e mente dopo un riavvio.
- **Lo snooze non crea record.** Aggiorna `due_at` e riporta lo stato a `pending`.
  Così il recupero all'avvio tratta i rinvii e i promemoria mai scattati con lo stesso codice.
- **Niente cancellazioni.** Le note completate cambiano stato, non spariscono: l'archivio
  è metà del valore della funzione.

### 6.2 Stati di una nota

```
pending ──(scadenza)──▶ fired ──(fatto)──▶ done
   ▲                      │
   └──────(rinvia)────────┘
                          └──(ignora)──▶ dismissed
```

Una nota senza `due_at` è un appunto: resta `pending` per sempre e compare nella lista
aperte, senza mai notificare.

### 6.3 Esito di una sessione pomodoro

| Esito | Quando |
|---|---|
| `completed` | arrivata a `ends_at` con l'app viva |
| `aborted` | interrotta dall'utente |
| `invalidated` | il sistema è stato sospeso o l'app chiusa per più della soglia (§ 8.3) |

Le sessioni invalidate restano a database ma non contano nelle statistiche. Cancellarle
nasconderebbe il fatto che il pomodoro è stato interrotto, che è un'informazione vera.

---

## 7. Scheduler dei promemoria

Il pezzo più delicato dell'app. Tre meccanismi che si coprono a vicenda.

### 7.1 Tick lento

Ogni **30 secondi**, una query:

```sql
SELECT * FROM notes
WHERE state = 'pending' AND due_at IS NOT NULL AND due_at <= :now
ORDER BY due_at ASC;
```

Costa niente e non richiede alcun timer di precisione. È la rete di sicurezza: qualunque
cosa vada storta altrove, entro 30 secondi il promemoria scatta.

### 7.2 Timer mirato

Se il prossimo `due_at` cade entro 60 secondi, viene armato un timer puntuale per avere
precisione al secondo. **Mai armare timer per scadenze lontane:** un timer a ore o giorni
di distanza non sopravvive alla sospensione, e Windows lo fa scattare in ritardo o mai.

### 7.3 Recupero

La stessa query del § 7.1, eseguita in tre momenti:

- all'avvio dell'applicazione;
- alla ripresa dalla sospensione (`WM_POWERBROADCAST` / `PBT_APMRESUMEAUTOMATIC`);
- allo sblocco della sessione.

Se torna più di un risultato, i promemoria si presentano **in pila, uno alla volta**,
ordinati per scadenza — non come sei nuvolette contemporanee. La creatura fa
l'animazione di avviso una volta sola e l'utente sfoglia con Fatto / Rinvia.

Se ne sono scaduti più di dieci, l'overlay mostra un riepilogo numerico e rimanda al
pannello: sfogliarne trenta uno per uno è peggio che non notificarli.

### 7.4 Precisione dichiarata

Il promemoria scatta entro **30 secondi** dalla scadenza a macchina attiva, e **entro
15 secondi dalla ripresa** se la macchina era sospesa. Non si promette di più: sarebbe
falso su un sistema che il sistema operativo può congelare in qualsiasi momento.

---

## 8. Pomodoro

### 8.1 Macchina a stati

```
        avvia
 idle ─────────▶ focus ──(ends_at)──▶ break_prompt
  ▲                │                        │
  │                │ interrompi             │ accetta
  │                ▼                        ▼
  └──────────── aborted                  break ──(ends_at)──▶ idle
```

Dopo N sessioni di focus (default 4) la pausa proposta è lunga. Il conteggio è per
giornata civile locale, azzerato a mezzanotte.

### 8.2 Durate

Configurabili. Default: focus 25 min, pausa breve 5, pausa lunga 20, cadenza pausa lunga 4.

### 8.3 Sospensione e riavvio

All'avvio o alla ripresa, per ogni sessione senza esito:

- se `now < ends_at` e il divario di inattività è sotto la soglia → la sessione **riprende**;
- se il divario supera la soglia (**default 120 secondi**) → la sessione è `invalidated`
  e la creatura non annuncia nulla;
- se `now ≥ ends_at` ma la fine è avvenuta meno di 5 minuti fa → si notifica normalmente;
- se è passato più tempo → `invalidated` in silenzio.

Senza queste regole il buddy annuncia una pausa alle quattro del mattino, e non lo apri più.

### 8.4 Interazione con i promemoria

**Durante una sessione di focus i promemoria non interrompono.** Vengono accodati e
presentati tutti insieme all'inizio della pausa. Un promemoria marcato urgente è l'unica
eccezione.

Questo è il vero motivo per cui le due funzioni stanno nella stessa app: separate,
la seconda demolirebbe la prima. A fine focus, insieme alla pausa, la creatura propone
le note maturate durante la sessione — è il momento in cui hai la testa libera per smaltirle.

---

## 9. Sistema dei buddy

Sei creature intercambiabili (`concept/bestiario-buddy.html` per il prototipo animato).
La scelta è una preferenza dell'utente, modificabile a caldo senza riavvio.

### 9.1 Contratto

Ogni creatura implementa quattro metodi e nient'altro (`contracts/buddy.ts`):

```
mount(scene)    costruisce la gerarchia e la aggiunge alla scena
setState(state) cambia comportamento e colore dell'organo di stato
getAnchor()     il punto 3D a cui si aggancia la nuvoletta
dispose()       rilascia geometrie, materiali e texture
```

Aggiungere una creatura non deve toccare lo scheduler, il pomodoro, il layer delle
nuvolette né il loop di animazione. Se la settima creatura costa più della prima,
il contratto è stato violato da qualche parte.

### 9.2 Colore semantico

Ogni creatura ha un **organo di stato** diverso — la fiammella di Lume, il visore e
l'antenna di Ottone, l'anello e i frammenti di Quarzo, la fiammella al muso di Brace —
ma tutti parlano con gli stessi colori:

| Stato | Colore | Significato |
|---|---|---|
| `idle` | lavanda `#BFB3E8` | in attesa, nulla in corso |
| `focus` | verde `#57A98B` | sessione di focus attiva |
| `break` | azzurro `#9BD4F5` | pausa in corso |
| `alert` | ambra `#F2B441` | ti sta chiedendo qualcosa |
| `celebrate` | verde chiaro `#8CE0A8` | sessione completata |
| `sleep` | blu spento `#4A4270` | inattivo da tempo |

La grammatica è unica, cambia l'attore. È ciò che rende i personaggi davvero
intercambiabili invece che sei comportamenti da mantenere separatamente.

### 9.3 Modalità sobria

Interruttore che sostituisce la creatura con un indicatore minimo — una pillola con
timer e pallino di stato, HTML puro, nessun canvas. Serve quando si condivide lo schermo
in videochiamata con un cliente. Effetto collaterale utile: il costo scende sotto i 60 MB,
quindi è anche la modalità di ripiego se l'overlay 3D risulta troppo pesante su una
macchina specifica.

### 9.4 Rilascio delle risorse

Al cambio buddy: `dispose()` su ogni geometria, materiale e texture, poi rimozione dalla
scena. Su un'app accesa dodici ore, saltare questo passaggio si nota.

---

## 10. Overlay e Do-Not-Disturb

### 10.1 Finestra

| Proprietà | Valore |
|---|---|
| Stile esteso | `WS_EX_LAYERED \| WS_EX_TOOLWINDOW \| WS_EX_NOACTIVATE \| WS_EX_TRANSPARENT` |
| Always on top | sì, senza rubare il focus |
| Barra applicazioni | assente (`WS_EX_TOOLWINDOW`) |
| Sfondo | trasparente |
| Decorazioni | nessuna |
| Posizione | ancorata a un angolo scelto dall'utente, trascinabile, memorizzata per monitor |

### 10.2 Click-through con hit-test

L'overlay è trasparente ai clic per impostazione predefinita (`WS_EX_TRANSPARENT`),
altrimenti diventa un rettangolo morto sopra le finestre di lavoro.

Il core interroga `GetCursorPos` ogni **100 ms** e confronta con il rettangolo occupato
dalla creatura: quando il cursore entra, toglie il flag; quando esce, lo rimette. Il costo
è irrilevante e non richiede hook di sistema, che farebbero scattare gli antivirus.

Il rettangolo di hit-test è comunicato dal renderer al core a ogni cambio di posa: è più
piccolo della finestra, e comprende creatura e nuvolette, non lo spazio vuoto attorno.

### 10.3 Livelli di DND

Sono due cose diverse e vanno tenute separate:

| Livello | Overlay | Toast | Scheduler | Promemoria scaduti |
|---|---|---|---|---|
| Normale | visibile | come ripiego | attivo | notificati subito |
| **Discreto** | modalità sobria | sì | attivo | notificati subito |
| **Nascosto (DND)** | distrutto | **no** | **attivo** | **accodati** |

In DND lo scheduler **non si ferma mai**: continua a marcare le note come `fired` e le
accumula. All'uscita dal DND si applica la logica di recupero del § 7.3 — la creatura
riappare e presenta la pila. Fermare lo scheduler significherebbe perdere promemoria,
che è l'unico errore imperdonabile per questa app.

### 10.4 Attivazione automatica

DND si attiva da solo interrogando `SHQueryUserNotificationState()`:

| Stato restituito | Azione |
|---|---|
| `QUNS_BUSY`, `QUNS_RUNNING_D3D_FULL_SCREEN` | DND (gioco o app a schermo intero) |
| `QUNS_PRESENTATION_MODE` | DND (presentazione in corso) |
| `QUNS_QUIET_TIME` | modalità discreta |
| `QUNS_ACCEPTS_NOTIFICATIONS` | normale |

Il rilevamento di una condivisione schermo in videochiamata non è affidabile via API:
si risolve con un interruttore manuale nel tray e una scorciatoia globale
(`Ctrl+Alt+H`), che è più veloce di qualunque euristica e non sbaglia mai.

### 10.5 Uscita dal dormiente

Il core ricrea la webview quando: un promemoria scatta, un pomodoro parte, l'utente
apre il pannello o esce dal DND. Il tempo di comparsa sta sotto il mezzo secondo e
non cade mai durante un'interazione, quindi non si percepisce.

---

## 11. Cattura rapida

Scorciatoia globale, una riga di testo, Invio. Se questo percorso non è istantaneo la
funzione note non viene usata e l'app muore in due settimane.

Riconoscimento della scadenza scritta nel testo: **non** un parser di linguaggio naturale
generico. Una manciata di pattern espliciti, tutto il resto va al selettore di data:

| Pattern | Esempio |
|---|---|
| `+<n><unità>` | `+2h`, `+30m`, `+3g` |
| ora del giorno | `18:00` (oggi se futura, domani se passata) |
| giorno + ora | `lun 9:30`, `dom 15` |
| parole chiave | `stasera`, `domani`, `dopodomani`, `lunedì` |

Fallback: tre pulsanti (stasera, domani mattina, lunedì) e un selettore. Le librerie di
parsing in linguaggio naturale hanno un supporto italiano inaffidabile; dieci espressioni
regolari sui pattern che si usano davvero funzionano meglio e non si rompono.

---

## 12. Eventi tra core e renderer

Il core emette, il renderer ascolta. Nessun flusso inverso a parte le azioni dell'utente.

| Evento | Direzione | Carico |
|---|---|---|
| `state:changed` | core → overlay | `{ state, until?, label? }` |
| `bubble:show` | core → overlay | `{ id, text, kind, urgent }` |
| `bubble:dismiss` | core → overlay | `{ id }` |
| `buddy:changed` | core → overlay | `{ creatureId }` |
| `hittest:update` | overlay → core | `{ x, y, w, h }` |
| `note:complete` | overlay → core | `{ id }` |
| `note:snooze` | overlay → core | `{ id, minutes }` |
| `pomodoro:start` | pannello → core | `{ kind }` |

---

## 13. Fasi

**M1 — Core senza faccia.** Store SQLite, scheduler con tick, recupero e ripresa, macchina
a stati pomodoro, icona di tray, cattura rapida. Il renderer è un log testuale.
*Criterio di uscita:* un promemoria fissato, l'app chiusa, la macchina sospesa e riaccesa
un giorno dopo → la notifica arriva. E il core a riposo sta sotto i 20 MB.

**M2 — Overlay sobrio.** Finestra trasparente, always-on-top, click-through con hit-test,
pillola di stato senza 3D, toast nativi, DND manuale e automatico, ciclo di vita della
webview.
*Criterio di uscita:* otto ore di uso reale senza che l'overlay intercetti un clic
destinato ad altro, e senza crescita del working set.

**M3 — La creatura.** three.js, contratto buddy, le sei creature, selettore, colori
semantici, animazioni per stato, nuvolette ancorate.
*Criterio di uscita:* rispetto del budget del § 3 e cambio buddy a caldo senza perdite.

**M4 — Archivio.** Pannello note, ricerca full-text, storico pomodoro, impostazioni.

---

## 14. Decisioni prese e accantonate

**Integrazione con Claude Code.** Valutata: gli hook HTTP di Claude Code permetterebbero
di mostrare le sessioni attive nelle nuvolette. Accantonata per tenere il buddy autonomo
e senza dipendenze da uno strumento esterno. L'architettura non la preclude: gli eventi
del § 12 accettano bolle da qualunque sorgente, quindi un ponte si aggiunge dopo senza
riscritture.

**Note come task manager.** Scartato. Priorità, tag e stati creerebbero un secondo
backlog accanto a ClickUp, e due backlog significano fidarsi di nessuno dei due. Semmai
si aggiunge un'azione "promuovi a task ClickUp" che sposta la nota dove vive il lavoro vero.

**Sincronizzazione tra macchine.** Fuori dalla v1. Il giorno che servisse, il modello a
timestamp assoluti e stati espliciti la rende praticabile senza cambiare schema.

---

## 15. Rischi

| Rischio | Impatto | Mitigazione |
|---|---|---|
| Il budget RAM non regge con il 3D attivo | alto | la modalità sobria esiste già come ripiego a costo zero |
| L'overlay intercetta clic destinati ad altre app | alto | click-through predefinito, hit-test stretto sulla sagoma |
| Antivirus o EDR segnalano il polling del cursore | medio | `GetCursorPos` invece di hook di sistema; firma dell'eseguibile |
| Trasparenza e always-on-top instabili su multi-monitor con DPI misti | medio | riposizionamento su `WM_DISPLAYCHANGE`, posizione salvata per monitor |
| La shell Rust rallenta la M1 | medio | ripiego Electron documentato al § 4, resto della spec invariato |
| Il buddy diventa fastidioso dopo due settimane | alto | DND a un tasto, modalità sobria, nessun suono predefinito |

L'ultimo rischio è quello che uccide davvero questo genere di applicazioni, e non si
risolve con il codice: si risolve rendendo banale zittirlo.
