/**
 * Cotone: il draghetto di nuvola, secondo ospite importato del bestiario.
 *
 * Nasce come creatura procedurale — una sfera schiacciata con due coni per
 * ali e quattro palline per coda — e diventa un GLB scolpito fuori dall'app.
 * Come Roberto arriva da UniRig, quindi senza `AnimationClip` e con nomi
 * d'osso senza significato; e come per Roberto questo file è il dizionario
 * che traduce quei nomi negli slot che `skinned.ts` sa muovere.
 *
 * La mappa, letta dalle posizioni di riposo nel GLB e non dai nomi:
 *
 *     Bone_000  radice, sotto la pancia
 *     Bone_001  corpo — il perno da cui pende tutto il resto
 *     Bone_007 → Bone_006   testa → punta del muso (in avanti, +Z)
 *     Bone_009 → Bone_008   orecchio destro (−X), fino alla cima del modello
 *     Bone_011 → Bone_010   orecchio sinistro (+X)
 *     Bone_003 → Bone_002   ala destra (−X)
 *     Bone_005 → Bone_004   ala sinistra (+X)
 *     Bone_014 → 013 → 012  coda, tre segmenti, all'indietro (−Z)
 *
 * Rispetto a Roberto cambia tutto quello che conta per l'animazione, e vale
 * la pena dire cosa:
 *
 *   · **niente arti.** Non ci sono braccia, non ci sono gambe, non c'è una
 *     colonna: dal corpo pendono cinque catene e nessuna di loro sa fare
 *     quello che sa fare una mano. Per questo la libreria di gesti è un'altra
 *     (`gestures-alato.ts`): quella umanoide, qui, sarebbe fatta quasi tutta
 *     di righe che non fanno niente.
 *   · **il peso espressivo sta nelle orecchie.** Sono la parte più leggera e
 *     con il ritardo di fase più lungo, ed è lì che l'occhio va per primo —
 *     il posto che nel primo Roberto occupava l'antenna.
 *   · **galleggia.** Non ha gambe e non ha senso che stia appoggiata: `hover`
 *     la tiene sospesa sopra la pedana, che resta a terra come pozza di luce.
 *     Nel sonno ci si riaccosta, con un `lift` negativo che la fa scendere
 *     quasi a toccarla.
 *   · **è più profonda che alta.** 1,70 di statura contro 2,15 di lunghezza
 *     muso-coda: `height` da sola è il pomello sbagliato per scalarla, e il
 *     numero qui sotto è tarato sull'ingombro complessivo — con la statura di
 *     Roberto occuperebbe quasi quattro unità di scena.
 *
 * Un'ultima cosa, la meno ovvia: ogni osso puntato riceve una direzione
 * *assoluta*, quindi non segue il suo genitore. Le orecchie non ereditano
 * l'inclinazione del busto e vanno scritte a mano in ogni posa — è la stessa
 * regola dell'antenna di Roberto, ed è voluta: un'orecchia che insegue e basta
 * è un'orecchia che non dice niente. Il muso fa eccezione ed è l'unico slot
 * che insegue davvero (v. FOLLOW in `skinned.ts`): un naso che resta puntato
 * in avanti mentre la testa gira non è espressivo, è staccato.
 *
 * Se il modello viene ri-rigged, questi sono i quindici nomi da rivedere; e
 * l'animatore segnala in console quelli che non trova.
 */

import cotoneUrl from "../../../docs/concept/cotone.glb?url";
import { MOVES } from "./gestures-alato";
import type { Pose, RigMap, SkinnedSpec } from "./skinned";

const RIG: RigMap = {
  root: "Bone_000",
  // il corpo sta nello slot del torace: è l'unico osso del tronco, e da lì
  // pendono testa, orecchie, ali e coda tutte insieme
  chest: "Bone_001",

  head: "Bone_007",
  snout: "Bone_006",

  earR: "Bone_009",
  earTipR: "Bone_008",
  earL: "Bone_011",
  earTipL: "Bone_010",

  // L'ala sinistra porta tre volte i vertici della destra (645 contro 191):
  // l'auto-rigger le ha appiccicato mezzo fianco. Le pose restano scritte
  // simmetriche — è così che vanno pensate — e la differenza la fa il freno
  // qui sotto, che è il posto giusto perché è un difetto del rig, non della
  // posa.
  wingR: "Bone_003",
  wingTipR: "Bone_002",
  wingL: "Bone_005",
  wingTipL: "Bone_004",

  tail: "Bone_014",
  tailMid: "Bone_013",
  tailTip: "Bone_012",
};

/**
 * Posa di riposo: nessuna.
 *
 * A differenza di Roberto, che nel GLB arriva in T-pose e va per forza
 * riposizionato, Cotone è già scolpito nella posa giusta. Riscriverla
 * significherebbe soltanto inventarne una peggiore. Il moto continuo la anima
 * da sé, e le sei pose qui sotto se ne discostano.
 */
const BASE: Pose = {};

/**
 * Uno stato è una posa più i parametri di movimento della TUNE. Qui c'è solo
 * la posa: la differenza fra `focus` e `alert` non è la velocità delle
 * sinusoidi, è dove stanno le orecchie.
 *
 * Le orecchie, appunto, sono la chiave di lettura di tutte e sei. All'indietro
 * vuol dire chiuso — concentrato o contento; in avanti vuol dire aperto —
 * curioso o all'erta; afflosciate vuol dire spento. Chi guarda l'overlay con
 * la coda dell'occhio non legge la posa del corpo, legge quelle.
 */
const POSES: SkinnedSpec["poses"] = {
  // idle: il riposo del modellatore, nient'altro. Il moto continuo fa tutto.

  // focus: si abbassa sul lavoro, muso in giù, orecchie appiattite
  // all'indietro, ali chiuse contro il corpo, coda distesa e immobile
  focus: {
    bend: {
      chest: [0, 0, 0.09],
      head: [0, 0, 0.24],
      snout: [0, -0.1, 0],
      earR: [0, 0, -0.36],
      earTipR: [0, 0, -0.54],
      earL: [0, 0, -0.36],
      earTipL: [0, 0, -0.54],
    },
    aim: {
      wingR: [-0.99, -0.13, 0.06],
      wingTipR: [-0.96, -0.25, 0.08],
      wingL: [0.99, -0.13, 0.06],
      wingTipL: [0.96, -0.25, 0.08],
      tail: [0, -0.12, -0.99],
      tailMid: [0, -0.17, -0.98],
      tailTip: [0, -0.22, -0.97],
    },
    lean: 0.06,
    lift: -0.2,
  },

  // break: risale, mento in su, orecchie dritte, ali aperte, coda alta
  break: {
    bend: {
      chest: [0, 0, -0.08],
      head: [0, 0, -0.11],
      snout: [0, 0.14, 0],
      earR: [0, 0, -0.08],
      earTipR: [0, 0, -0.14],
      earL: [0, 0, -0.08],
      earTipL: [0, 0, -0.14],
    },
    aim: {
      wingR: [-0.93, 0.2, 0.13],
      wingTipR: [-0.86, 0.34, 0.17],
      wingL: [0.93, 0.2, 0.13],
      wingTipL: [0.86, 0.34, 0.17],
      tail: [0, 0.22, -0.95],
      tailMid: [0, 0.33, -0.91],
      tailTip: [0, 0.44, -0.85],
    },
    lean: -0.05,
    lift: 0.16,
  },

  // alert: viene avanti verso chi guarda, orecchie ritte e puntate in avanti,
  // ali spiegate a metà, coda rigida in alto. È la posa che deve leggersi da
  // lontano e con la coda dell'occhio, quindi non è delicata.
  alert: {
    bend: {
      chest: [0, 0, 0.06],
      head: [0, 0, -0.02],
      snout: [0, 0.06, 0],
      earR: [0, 0, 0.18],
      earTipR: [0, 0, 0.28],
      earL: [0, 0, 0.18],
      earTipL: [0, 0, 0.28],
    },
    aim: {
      wingR: [-0.89, 0.3, 0.15],
      wingTipR: [-0.8, 0.47, 0.19],
      wingL: [0.89, 0.3, 0.15],
      wingTipL: [0.8, 0.47, 0.19],
      tail: [0, 0.42, -0.9],
      tailMid: [0, 0.54, -0.84],
      tailTip: [0, 0.62, -0.78],
    },
    lean: 0.05,
    lift: 0.12,
  },

  // celebrate: sale, schiena inarcata all'indietro, ali spalancate, coda
  // arricciata verso l'alto, orecchie buttate indietro dal vento
  celebrate: {
    bend: {
      chest: [0, 0, -0.1],
      head: [0, 0, -0.14],
      snout: [0, 0.2, 0],
      earR: [0, 0, -0.32],
      earTipR: [0, 0, -0.48],
      earL: [0, 0, -0.32],
      earTipL: [0, 0, -0.48],
    },
    aim: {
      wingR: [-0.82, 0.46, 0.06],
      wingTipR: [-0.7, 0.63, 0.08],
      wingL: [0.82, 0.46, 0.06],
      wingTipL: [0.7, 0.63, 0.08],
      tail: [0, 0.5, -0.85],
      tailMid: [0, 0.7, -0.7],
      tailTip: [0, 0.86, -0.48],
    },
    lean: -0.06,
    lift: 0.36,
  },

  // sleep: scende quasi sulla pedana, testa china, muso in giù, orecchie
  // afflosciate in avanti e divaricate, ali chiuse, coda arrotolata di lato
  sleep: {
    bend: {
      chest: [0, 0, 0.14],
      head: [0, 0, 0.5],
      snout: [0, -0.16, 0],
      earR: [0.08, 0, 0.62],
      earTipR: [0.14, 0, 0.9],
      earL: [-0.08, 0, 0.62],
      earTipL: [-0.14, 0, 0.9],
    },
    aim: {
      wingR: [-0.99, -0.12, 0.04],
      wingTipR: [-0.97, -0.23, 0.05],
      wingL: [0.99, -0.12, 0.04],
      wingTipL: [0.97, -0.23, 0.05],
      tail: [0.3, -0.16, -0.94],
      tailMid: [0.54, -0.2, -0.81],
      tailTip: [0.74, -0.22, -0.63],
    },
    lean: 0.05,
    // scende quasi a toccare la pedana: dorme appoggiata, sveglia galleggia
    lift: -0.5,
  },
};

/**
 * Quando gli viene in mente di fare qualcosa.
 *
 * Stessa disciplina di Roberto, per la stessa ragione (§ 10): `alert` non
 * compare perché quello stato è già una richiesta di attenzione, e una
 * capriola sopra un promemoria scaduto è rumore; in `focus` passa solo
 * l'occhiata, e di rado. Gli intervalli sono lunghi apposta — un gesto ogni
 * venti secondi diventa un tic, uno ogni due minuti resta una sorpresa.
 *
 * La capriola sta solo in `celebrate`: è l'unico gesto che ribalta la
 * creatura, e fuori da una festa sembrerebbe un difetto di rendering.
 */
const WHEN: SkinnedSpec["gestures"] = {
  idle: {
    every: [13, 38],
    pick: [
      MOVES.svolazzo,
      MOVES.occhiata,
      MOVES.annusata,
      MOVES.scodinzolio,
      MOVES.planata,
      MOVES.scrollata,
      MOVES.sbadiglio,
    ],
  },
  break: {
    every: [7, 18],
    pick: [
      MOVES.svolazzo,
      MOVES.piroetta,
      MOVES.scodinzolio,
      MOVES.sternuto,
      MOVES.occhiata,
      MOVES.scrollata,
    ],
  },
  focus: {
    every: [75, 160],
    pick: [MOVES.occhiata],
  },
  celebrate: {
    every: [1.2, 3.5],
    pick: [MOVES.capriola, MOVES.piroetta, MOVES.svolazzo],
  },
  sleep: {
    every: [24, 60],
    pick: [MOVES.arrotolamento],
  },
};

/**
 * I freni (v. `brake` in `skinned.ts`).
 *
 * `Bone_005` — l'ala sul lato +X — porta 645 vertici contro i 191 della
 * gemella: mezzo fianco è pesato su di lei. Ruotarla quanto l'altra non dà un
 * battito simmetrico, dà un fianco che si ripiega su sé stesso, e si nota
 * subito guardando la creatura di fronte. Il freno riporta il *movimento
 * visibile* alla simmetria, che è quello che conta; sul foglio le due pose
 * restano identiche.
 *
 * `Bone_014`, la radice della coda, ha lo stesso problema in scala minore: si
 * è presa buona parte della groppa, quindi la sua parte di onda va tenuta
 * bassa e il grosso lo fanno i due segmenti dopo, che pesano meno.
 */
const BRAKE: SkinnedSpec["brake"] = {
  wingL: 0.38,
  wingTipL: 0.55,
  tail: 0.65,
};

export const COTONE: SkinnedSpec = {
  url: cotoneUrl,
  rig: RIG,
  base: BASE,
  brake: BRAKE,
  poses: POSES,
  gestures: WHEN,
  // tarata sull'ingombro, non sulla statura: alta 1,70 nel GLB ma lunga 2,15,
  // quindi con questo fattore occupa circa 2,3 × 2,2 × 2,8 unità di scena —
  // in linea con le procedurali, che stanno in tre
  height: 2.2,
  ground: -1.7, // la quota della pedana d'ombra di `scene.ts`
  // sospesa: mezza unità sopra la pedana, che le resta sotto come pozza
  hover: 0.55,
  haloRadius: 1.15,
  // l'osso della testa sta in mezzo al muso, non in cima al cranio: il numero
  // porta la nuvoletta sopra le orecchie, che sono la parte più alta
  anchorLift: 0.95,
  // Quanto la sagoma deborda dalle ossa. Meno di Roberto perché qui le ossa
  // arrivano quasi ovunque — la coda fino alla punta, le orecchie fino alla
  // cima — e serve solo a coprire la pancia e i lati del corpo.
  girth: 0.3,
};
