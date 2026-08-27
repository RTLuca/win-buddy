/**
 * Roberto: il primo ospite non procedurale del bestiario.
 *
 * È un GLB scolpito fuori dall'app e rigged automaticamente da UniRig, quindi
 * arriva senza `AnimationClip` e con nomi d'osso senza significato
 * (`Bone_000`…`Bone_047`). Questo file è il dizionario che traduce quei nomi
 * negli slot che l'animatore di `skinned.ts` sa muovere, più le pose dei sei
 * stati del § 12 e i gesti che si concede.
 *
 * Questa è la mappa del **modello 2.0**, che è un rig diverso dal primo, non
 * una sua revisione: i numeri delle ossa non hanno più niente a che vedere.
 * Va letta dalle posizioni di riposo lette nel GLB, non dai nomi:
 *
 *     Bone_000  radice, a terra e verticale
 *     Bone_003  bacino          Bone_002  lombi        Bone_001  torace
 *     Bone_005  collo           Bone_004  testa
 *     Bone_023 → 022 → 021      antenna, dallo stelo al pomello
 *     Bone_010 → 009 → 008 → 007 → 006   braccio destro (−X)
 *     Bone_015 → 014 → 013 → 012 → 011   braccio sinistro (+X)
 *
 * Tre cose sono cambiate rispetto al primo Roberto, e sono tutte quelle che
 * contano per l'animazione:
 *
 *   · **niente gambe.** Lo scheletro finisce al bacino: dal bacino in giù la
 *     mesh è attaccata rigida alla radice. Gli slot `legR`/`footR` e compagni
 *     qui non esistono, e i gesti che li piegano semplicemente non hanno
 *     effetto — il piegamento del saltello lo fa `lift` e la schiena.
 *   · **c'è un'antenna**, quattro ossa sopra la testa: il pezzo di Roberto
 *     che si muove di più e che l'animatore fa oscillare da sé.
 *   · **la radice è dritta.** Sparisce la trappola dei 9° di inclinazione che
 *     nel primo modello sbilanciava le gambe; resta la regola di non puntarla.
 *
 * L'osso della testa ha però l'asse che punta in avanti invece che in su: se
 * ne occupa UPRIGHT in `skinned.ts`, che per la colonna prende come
 * riferimento la verticale. Senza quello nessun `bend` della testa
 * significherebbe più quello che dice.
 *
 * Proporzioni: statura 1,70 (antenna compresa), bacino a 0,37, spalle a 0,75,
 * testa a 1,16, punta dell'antenna a 1,65.
 *
 * Se il modello viene ri-rigged, questi sono i quattordici nomi da rivedere; e
 * l'animatore segnala in console quelli che non trova.
 */

// L'asset viene preso dov'è stato messo, senza copie: un GLB da 7 MB
// duplicato nel repository si nota. Vite lo emette in `dist/assets` con
// l'hash, quindi l'URL è giusto sia in `vite dev` sia nel bundle Tauri.
//
// Le texture stanno dentro il GLB, e three.js le passa alla GPU costruendo un
// `blob:` — che nel bundle Tauri la CSP deve permettere esplicitamente, o il
// modello arriva grigio senza un errore che lo dica (v. `tauri.conf.json`).
import robertoUrl from "../../../docs/concept/roberto2.0.glb?url";
import { GESTURES } from "./gestures";
import type { Pose, RigMap, SkinnedSpec } from "./skinned";

const RIG: RigMap = {
  root: "Bone_000",
  hips: "Bone_003",
  spine: "Bone_002",
  chest: "Bone_001",
  neck: "Bone_005",
  head: "Bone_004",

  // stelo e pomello. Le ultime due ossa della catena (Bone_021 e Bone_020)
  // sono il pallino in cima e restano ferme: si muovono già abbastanza.
  antenna: "Bone_023",
  antennaTip: "Bone_022",

  // Ogni braccio ha cinque ossa: clavicola, omero, avambraccio, polso, mano.
  // Si puntano le tre di mezzo — la clavicola resta ferma (muoverla stacca la
  // spalla dal torace) e la mano tiene la posa che le ha dato il modellatore,
  // dita comprese.
  armR: "Bone_009",
  foreR: "Bone_008",
  handR: "Bone_007",
  armL: "Bone_014",
  foreL: "Bone_013",
  handL: "Bone_012",

  // niente gambe: questo scheletro non ne ha
};

/**
 * Posa di riposo: solo le braccia.
 *
 * Tutto il resto — busto, collo, testa, antenna — non compare, e resta
 * esattamente come il modellatore l'ha lasciato. Vale la pena insistere: una
 * posa di riposo scritta è una posa di riposo *inventata*, e quella del
 * modellatore è già giusta. Il moto continuo la anima da sé.
 *
 * Le braccia invece vanno riposizionate per forza: nel GLB sono in T-pose.
 * Le direzioni sono nello spazio della creatura, +Y in su e +Z verso chi
 * guarda; già al primo frame scendono lungo i fianchi con lo smorzamento,
 * quindi la T-pose non si vede mai.
 */
const BASE: Pose = {
  aim: {
    // scostate dal corpo quanto basta a non compenetrarlo: è tozzo
    armR: [-0.42, -0.9, 0.06],
    foreR: [-0.24, -0.94, 0.24],
    handR: [-0.18, -0.93, 0.32],
    armL: [0.42, -0.9, 0.06],
    foreL: [0.24, -0.94, 0.24],
    handL: [0.18, -0.93, 0.32],
  },
};

/**
 * Uno stato è una posa più i parametri di movimento della TUNE. Qui c'è solo
 * la posa: la differenza fra `focus` e `alert` non è la velocità delle
 * sinusoidi, è dove stanno le mani.
 *
 * Le inclinazioni del busto si scrivono con `bend`, cioè come scostamento dal
 * riposo, così restano corrette anche se il modello viene ri-esportato con
 * una posa di partenza un po' diversa.
 */
const POSES: SkinnedSpec["poses"] = {
  // idle: la posa di riposo, nient'altro. Il moto continuo fa il resto.

  // focus: si china sul lavoro, mani avanti, spalle chiuse
  focus: {
    bend: {
      spine: [0, 0, 0.14],
      chest: [0, 0, 0.13],
      neck: [0, 0, 0.22],
      head: [0, 0, 0.15],
      // l'antenna segue la testa e la supera di poco: è appesa, non guidata
      antenna: [0, 0, 0.2],
      antennaTip: [0, 0, 0.3],
    },
    aim: {
      armR: [-0.36, -0.9, 0.24],
      foreR: [-0.24, -0.6, 0.76],
      handR: [-0.18, -0.46, 0.87],
      armL: [0.36, -0.9, 0.24],
      foreL: [0.24, -0.6, 0.76],
      handL: [0.18, -0.46, 0.87],
    },
    lean: 0.05,
  },

  // break: si stira, torace aperto e mento in su
  break: {
    bend: {
      chest: [0, 0, -0.15],
      neck: [0, 0, -0.07],
      head: [0, 0, -0.13],
      antenna: [0, 0, -0.12],
      antennaTip: [0, 0, -0.18],
    },
    aim: {
      armR: [-0.6, -0.75, 0.22],
      foreR: [-0.5, -0.48, 0.6],
      handR: [-0.44, -0.36, 0.74],
      armL: [0.6, -0.75, 0.22],
      foreL: [0.5, -0.48, 0.6],
      handL: [0.44, -0.36, 0.74],
    },
    lean: -0.03,
  },

  // alert: braccia a mezz'aria, come chi vuole essere visto
  alert: {
    bend: {
      chest: [0, 0, -0.07],
      neck: [0, 0, 0.1],
      head: [0, 0, 0.12],
      // qui l'antenna non asseconda: si irrigidisce all'indietro mentre la
      // testa va avanti. È l'unica posa in cui i due si contraddicono, ed è
      // il modo più economico di far leggere «attenzione» da lontano.
      antenna: [0, 0, -0.06],
      antennaTip: [0, 0, -0.12],
    },
    aim: {
      armR: [-0.66, -0.38, 0.55],
      foreR: [-0.56, 0.44, 0.66],
      handR: [-0.5, 0.62, 0.55],
      armL: [0.66, -0.38, 0.55],
      foreL: [0.56, 0.44, 0.66],
      handL: [0.5, 0.62, 0.55],
    },
  },

  // celebrate: braccia in alto e larghe, schiena inarcata all'indietro
  celebrate: {
    bend: {
      chest: [0, 0, -0.13],
      neck: [0, 0, -0.12],
      head: [0, 0, -0.14],
      antenna: [0, 0, -0.2],
      antennaTip: [0, 0, -0.3],
    },
    aim: {
      armR: [-0.78, 0.62, 0.14],
      foreR: [-0.6, 0.79, 0.12],
      handR: [-0.52, 0.85, 0.1],
      armL: [0.78, 0.62, 0.14],
      foreL: [0.6, 0.79, 0.12],
      handL: [0.52, 0.85, 0.1],
    },
    lean: -0.05,
  },

  // sleep: testa china sul petto, spalle giù, tutto molle
  sleep: {
    bend: {
      spine: [0, 0, 0.16],
      chest: [0, 0, 0.22],
      neck: [0, 0, 0.5],
      head: [0, 0, 0.68],
      // anche l'antenna dorme: cade in avanti più della testa
      antenna: [0, 0, 0.6],
      antennaTip: [0, 0, 0.85],
    },
    aim: {
      armR: [-0.3, -0.95, 0.02],
      foreR: [-0.18, -0.97, 0.14],
      handR: [-0.15, -0.97, 0.18],
      armL: [0.3, -0.95, 0.02],
      foreL: [0.18, -0.97, 0.14],
      handL: [0.15, -0.97, 0.18],
    },
    lean: 0.04,
  },
};

/**
 * Quando gli viene in mente di fare qualcosa.
 *
 * `alert` non compare apposta: quello stato è già una richiesta di attenzione,
 * e un saluto sopra un promemoria scaduto è rumore. In `focus` passa solo
 * l'occhiata, e di rado: la creatura deve dare segno di vita senza rubare
 * l'occhio a chi sta lavorando (§ 10). Gli intervalli sono volutamente lunghi
 * — un gesto ogni venti secondi diventa un tic, uno ogni due minuti resta una
 * sorpresa.
 */
const WHEN: SkinnedSpec["gestures"] = {
  idle: {
    every: [14, 40],
    pick: [
      GESTURES.occhiata,
      GESTURES.grattata,
      GESTURES.sbadiglio,
      GESTURES.saluto,
      GESTURES.stiracchiata,
      GESTURES.dondolio,
    ],
  },
  break: {
    every: [7, 18],
    pick: [GESTURES.stiracchiata, GESTURES.saluto, GESTURES.saltello, GESTURES.occhiata, GESTURES.dondolio],
  },
  focus: {
    every: [75, 160],
    pick: [GESTURES.occhiata],
  },
  celebrate: {
    every: [1.2, 3.5],
    pick: [GESTURES.saltello, GESTURES.inchino],
  },
  sleep: {
    every: [24, 60],
    pick: [GESTURES.sospiro],
  },
};

export const ROBERTO: SkinnedSpec = {
  url: robertoUrl,
  rig: RIG,
  base: BASE,
  poses: POSES,
  gestures: WHEN,
  // le creature procedurali stanno in circa 3 unità: qui la statura è tarata
  // su quelle, non sul modello (che nel GLB è alto 1,7 unità, antenna
  // compresa — il corpo da solo arriva a 1,49)
  height: 3.1,
  ground: -1.7, // la quota della pedana d'ombra di `scene.ts`
  haloRadius: 1.16,
  // sopra l'osso della testa, che in questo rig sta più in basso che nel primo
  // modello: così la nuvoletta resta dov'era, appena sopra la calotta
  anchorLift: 0.67,
  // Quanto la sagoma deborda dalle ossa. Mezza unità copre la testa, che è la
  // parte più larga; con l'antenna mappata il rettangolo del click-through
  // arriva finalmente fino in cima — prima si fermava a mezza testa, e un
  // clic sulla fronte non apriva la barra rapida.
  girth: 0.5,
};
