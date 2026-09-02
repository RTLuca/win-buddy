/**
 * Creature con scheletro: un GLB skinnato animato per pose, non per clip.
 *
 * Il bestiario procedurale (`base.ts`) muove parti dichiarate dal costruttore.
 * Qui la grammatica è la stessa, ma le «parti» sono ossa di un rig importato e
 * il verbo non è «trasla» bensì «punta»: ogni stato dichiara *dove* deve
 * guardare l'asse di ciascun osso, e l'animatore ci arriva con uno smorzamento.
 *
 * Puntare invece di ruotare non è un vezzo: i rig automatici (UniRig, Mixamo,
 * Accurig) orientano gli assi locali in modo imprevedibile, quindi un angolo
 * di Eulero scritto a mano vale solo per quel rig. Una direzione nello spazio
 * della creatura («il braccio va in giù e un po' in avanti») vale per tutti, e
 * si legge senza aprire Blender.
 *
 * L'animazione sta su tre strati che si sommano:
 *
 *   posa di stato   dove stanno gli arti in `idle`, `focus`, `alert`…
 *   moto continuo   respiro, rollio, dondolio: sinusoidi con periodi primi
 *                   fra loro, così il ciclo non si richiude mai identico, e
 *                   con un ritardo di fase lungo la catena (il polso insegue
 *                   l'avambraccio che insegue la spalla). È quel ritardo a
 *                   distinguere una creatura viva da un manichino a molla.
 *   gesti           episodi rari e autonomi — un saluto, uno sbadiglio — che
 *                   entrano ed escono in dissolvenza sopra gli altri due.
 *
 * Il modello non ha `AnimationClip` (§ 9.2): se un giorno ne avrà, il mixer
 * qui sotto le suona e i tre strati restano come ripiego.
 */

import {
  AnimationMixer,
  Bone,
  Box3,
  Group,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  TorusGeometry,
  Vector3,
  type AnimationAction,
  type Material,
  type Object3D,
  type Scene,
  type SkinnedMesh,
  type Texture,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { STATE_COLOR, type Buddy, type BuddyMeta, type BuddyState } from "../../shared/contracts";

export type Vec3 = readonly [number, number, number];

/** Gli slot semantici che l'animatore sa muovere. Il rig ne mappa quelli che ha. */
export type Slot =
  | "root"
  | "hips"
  | "spine"
  | "chest"
  | "neck"
  | "head"
  // lo stelo sopra la testa e il pomello in cima: non tutti i modelli ce
  // l'hanno, chi non ce l'ha semplicemente non li mappa
  | "antenna"
  | "antennaTip"
  | "armL"
  | "foreL"
  | "handL"
  | "armR"
  | "foreR"
  | "handR"
  | "legL"
  | "footL"
  | "legR"
  | "footR"
  // Le creature alate senza arti. Un umanoide non li mappa e non se ne
  // accorge, esattamente come Roberto 2.0 non mappa le gambe: uno slot che
  // il rig non ha è una riga che non fa niente, non un errore.
  | "snout"
  | "earL"
  | "earTipL"
  | "earR"
  | "earTipR"
  | "wingL"
  | "wingTipL"
  | "wingR"
  | "wingTipR"
  | "tail"
  | "tailMid"
  | "tailTip";

/** Nome dell'osso nel GLB per ogni slot. */
export type RigMap = Partial<Record<Slot, string>>;

/**
 * Le ossa che l'animatore punta, in ordine di gerarchia: ci conta per
 * aggiornare la matrice di un osso solo dopo quella del suo genitore.
 *
 * Radice e bacino non sono nell'elenco, ed è la lezione più cara imparata su
 * questi rig. Puntare un osso significa dargli un orientamento *assoluto*, e
 * quello della radice a riposo non è detto sia verticale: UniRig la lascia
 * inclinata di una decina di gradi (così era nel primo Roberto). Raddrizzarla
 * ruota rigidamente il bacino, e siccome gli attacchi delle due gambe non sono
 * simmetrici rispetto al suo centro, una sale e l'altra scende — a riposo,
 * senza che nulla si muova. Le gambe si ritrovavano una alta e una bassa per
 * colpa di un'ambizione mal riposta a tre ossa di distanza. Radice e bacino
 * restano dove il modellatore li ha messi; il corpo si muove inclinando il
 * gruppo intero attorno ai piedi, che per un pupazzo che dondola è anche più
 * giusto.
 *
 * L'ordine è quello della gerarchia: l'antenna sta sotto la testa e va dopo,
 * il muso sotto la testa, le punte sotto le loro radici. Fra fratelli l'ordine
 * non conta — orecchie, ali e coda pendono tutte dal busto.
 */
const AIMED: Slot[] = [
  "spine",
  "chest",
  "neck",
  "head",
  "snout",
  "antenna",
  "antennaTip",
  "earL",
  "earTipL",
  "earR",
  "earTipR",
  "armL",
  "foreL",
  "handL",
  "armR",
  "foreR",
  "handR",
  "wingL",
  "wingTipL",
  "wingR",
  "wingTipR",
  "legL",
  "footL",
  "legR",
  "footR",
  "tail",
  "tailMid",
  "tailTip",
];

/** Tutti gli slot mappati, compresi quelli fermi: servono a `getBox()`. */
const ALL: Slot[] = ["root", "hips", ...AIMED];

/**
 * Gli slot il cui riferimento è la verticale della creatura, non l'asse
 * dell'osso.
 *
 * Serve perché un rig automatico decide da sé come orientare gli assi locali,
 * e su Roberto 2.0 l'osso della testa ha l'asse che punta *in avanti* invece
 * che in su. Con il riferimento preso dall'osso, un `bend` di «annuisci» —
 * scritto per una testa che a riposo guarda in alto — su quell'osso diventa
 * una torsione di tre gradi verso il lato sbagliato, e le pose del § 12
 * smettono di significare quello che dicono.
 *
 * Per la colonna e per l'antenna il riferimento giusto è sempre lo stesso, e
 * non dipende dal rigger: la verticale. `bindRig` cerca allora quale asse
 * locale dell'osso, a riposo, guarda in su, e punta quello. La posa di riposo
 * non si muove di un pixel — cambia solo *come si legge* uno scostamento.
 *
 * Le membra no: lì «il braccio va in giù» ha senso solo lungo l'osso. Muso,
 * ali e coda stanno con le membra per la stessa ragione; le orecchie invece
 * riposano verticali come l'antenna, e si scrivono con lo stesso vocabolario
 * — `z` è portarle avanti sugli occhi, `x` è piegarle di lato.
 */
const UPRIGHT = new Set<Slot>([
  "root",
  "hips",
  "spine",
  "chest",
  "neck",
  "head",
  "antenna",
  "antennaTip",
  "earL",
  "earTipL",
  "earR",
  "earTipR",
]);

/**
 * Gli slot che si portano dietro il genitore invece di ignorarlo.
 *
 * Puntare un osso gli dà un orientamento *assoluto* nello spazio della
 * creatura, e la conseguenza è meno ovvia di quanto sembri: un osso puntato
 * non segue più il suo genitore. Per l'antenna di Roberto è voluto — è appesa,
 * non guidata, e ogni posa scrive di suo quanto insegue la testa. Per un muso
 * no: un muso che resta puntato in avanti mentre la testa gira di trenta gradi
 * non è una scelta espressiva, è un naso staccato dalla faccia.
 *
 * Per questi slot lo scostamento si somma a dove il genitore è arrivato,
 * invece di sostituirlo. Costa una riga — si converte in spazio genitore
 * usando l'orientamento che il genitore aveva *a riposo* anziché quello
 * attuale — e va scritto con `bend`, che è uno scostamento: un `aim` assoluto
 * su uno slot che insegue significherebbe due cose insieme.
 */
const FOLLOW = new Set<Slot>(["snout"]);

/**
 * Una posa. `aim` dà la direzione assoluta dell'asse dell'osso nello spazio
 * della creatura (+Y in su, +Z verso chi guarda); `bend` la dà come
 * scostamento da come l'osso riposa nel modello — comodo per le inclinazioni
 * piccole, dove «un po' più avanti» si scrive meglio di un vettore. Uno slot
 * che non compare in nessuna delle due resta esattamente a riposo e segue il
 * genitore, che è il default giusto.
 *
 * Per la colonna, la testa e l'antenna il riposo è la verticale (v. UPRIGHT),
 * quindi `bend` si legge sempre allo stesso modo: `z` è annuire, `x` è
 * piegare la testa di lato. Per le membra è la direzione dell'osso.
 */
export interface Pose {
  aim?: Partial<Record<Slot, Vec3>>;
  bend?: Partial<Record<Slot, Vec3>>;
  /** Rollio del corpo attorno ai piedi, in radianti. */
  rock?: number;
  /** Inclinazione avanti (positiva) o indietro, in radianti. */
  lean?: number;
  /** Sollevamento del corpo, in unità di scena. */
  lift?: number;
}

/** Quello che un gesto può chiedere, un fotogramma alla volta. */
export interface PoseSink {
  aim(slot: Slot, x: number, y: number, z: number): void;
  bend(slot: Slot, x: number, y: number, z: number): void;
  rock(v: number): void;
  lean(v: number): void;
  lift(v: number): void;
  turn(v: number): void;
  /**
   * Quanto acquietare il moto continuo mentre il gesto è in corso, da 0
   * (niente) a 1 (fermo del tutto).
   *
   * Serve ai gesti che *sono* un'assenza di movimento: una planata è «le ali
   * smettono di battere», e se il battito continua sotto resta solo un tuffo.
   * Il moto continuo si somma sempre alla posa — è quello che tiene viva la
   * creatura — quindi l'unico modo di toglierlo è chiederlo.
   */
  calm(v: number): void;
}

/**
 * Un gesto: un episodio breve che la creatura si concede da sé. Non è uno
 * stato — il core non ne sa nulla e non deve saperne (§ 5), come non sa del
 * battito di palpebre delle creature procedurali. È presentazione.
 */
export interface Gesture {
  id: string;
  /** Etichetta leggibile, per il banco di prova. */
  label: string;
  /** Durata in secondi. */
  dur: number;
  /** Frazioni di entrata e uscita della dissolvenza. */
  fade?: [number, number];
  /**
   * Dove sta il fotogramma piu' rappresentativo, per il provino del banco di
   * prova. Non serve all'app: serve a non ritrarre un gesto proprio
   * nell'istante in cui passa per la posa di partenza.
   */
  peak?: number;
  /** La posa al tempo normalizzato `u` fra 0 e 1. */
  at(u: number, p: PoseSink): void;
}

/** Quando e quali gesti, per uno stato. */
export interface GesturePlan {
  /** Attesa fra un gesto e il successivo: minimo e massimo, in secondi. */
  every: [number, number];
  pick: Gesture[];
}

export interface SkinnedSpec {
  /** URL del GLB (passato da Vite, quindi già con l'hash del bundle). */
  url: string;
  rig: RigMap;
  /** Posa di riposo: gli stati la ereditano per gli slot che non ridichiarano. */
  base: Pose;
  /**
   * Il freno di un osso: quanto di ciò che gli si chiede arriva davvero, da 0
   * (immobile) a 1 (tutto). Chi non compare vale 1. Da non confondere con lo
   * smorzamento (`damp` in `update`), che è il tempo che una posa ci mette ad
   * arrivare: questo è quanta strada fa, non quanto ci mette.
   *
   * Serve perché un rig automatico non distribuisce i pesi come farebbe un
   * rigger: su Cotone l'ala di un lato porta tre volte i vertici dell'altra,
   * cioè si è presa mezzo fianco. Ruotarle della stessa quantità non dà un
   * movimento simmetrico, dà un'ala che sbatte e un fianco che si piega su sé
   * stesso. Il freno esiste per quello — non per correggere una posa scritta
   * male, ma per correggere un peso assegnato male da una macchina.
   *
   * Agisce sul risultato finale, posa e gesto e moto continuo insieme:
   * l'osso si muove *meno*, non si muove diversamente, e le pose restano
   * scritte simmetriche come vanno pensate.
   */
  brake?: Partial<Record<Slot, number>>;
  poses: Partial<Record<BuddyState, Pose>>;
  /** Gli stati senza piano non hanno gesti: in `alert` e in `focus` è voluto. */
  gestures: Partial<Record<BuddyState, GesturePlan>>;
  /** Altezza voluta in unità di scena; il modello viene scalato di conseguenza. */
  height: number;
  /** Quota dei piedi: la pedana d'ombra della scena sta a −1,7. */
  ground: number;
  /**
   * Quanto la creatura sta sospesa sopra la pedana. Chi cammina non lo scrive.
   *
   * Non è un `lift` di comodo nella posa di riposo: dice anche a `getBox()`
   * che sotto la creatura non c'è un corpo ma aria, e che il rettangolo del
   * click-through non deve arrivare fino a terra — per un ospite appoggiato è
   * giusto che ci arrivi, per uno sospeso sarebbe una striscia di schermo
   * rubata a niente.
   */
  hover?: number;
  /** Raggio dell'anello di stato attorno ai piedi. */
  haloRadius: number;
  /**
   * Quanto sopra l'osso della testa si aggancia la nuvoletta. Non è una
   * costante dell'animatore perché dipende da dove il rigger ha messo
   * quell'osso: in Roberto 2.0 sta più in basso che nel primo, e con il
   * vecchio numero la nuvoletta finirebbe in mezzo all'antenna.
   */
  anchorLift: number;
  /**
   * Quanto la carne deborda dalle ossa, in unità di scena: il margine con cui
   * `getBox()` gonfia lo scheletro per ottenere la sagoma.
   */
  girth: number;
}

/** Parametri di movimento per stato: l'equivalente della TUNE di `base.ts`. */
interface Tune {
  /** Moltiplicatore del tempo: quanto è concitato lo stato. */
  speed: number;
  /** Rimbalzo verticale del corpo. */
  bob: number;
  /** Rollio laterale attorno ai piedi, in radianti. */
  rock: number;
  /** Rotazione attorno al proprio asse, in radianti. */
  turn: number;
  /** Apertura del torace: il respiro. */
  breath: number;
  /** Dondolio delle braccia. */
  swing: number;
  /** Quanto la testa si guarda intorno. */
  look: number;
}

const TUNE: Record<BuddyState, Tune> = {
  idle:      { speed: 1.00, bob: 0.050, rock: 0.048, turn: 0.100, breath: 0.045, swing: 0.060, look: 0.100 },
  focus:     { speed: 0.68, bob: 0.014, rock: 0.013, turn: 0.026, breath: 0.024, swing: 0.016, look: 0.030 },
  break:     { speed: 1.60, bob: 0.080, rock: 0.086, turn: 0.160, breath: 0.062, swing: 0.110, look: 0.160 },
  alert:     { speed: 4.20, bob: 0.090, rock: 0.074, turn: 0.100, breath: 0.070, swing: 0.135, look: 0.130 },
  celebrate: { speed: 3.00, bob: 0.165, rock: 0.062, turn: 0.220, breath: 0.080, swing: 0.155, look: 0.120 },
  sleep:     { speed: 0.38, bob: 0.012, rock: 0.021, turn: 0.015, breath: 0.042, swing: 0.012, look: 0.015 },
};

/** Secondi perché una posa percorra metà della distanza dal bersaglio. */
const HALF_LIFE = 0.18;

/** Stato di uno slot: dove riposa, dove deve andare, dove si trova ora. */
interface SlotState {
  bone: Bone;
  restQ: Quaternion;
  /** L'asse dell'osso che si punta, in spazio osso: `+Y`, o la verticale. */
  axis: Vector3;
  /** Direzione dell'asse a riposo, in spazio creatura. */
  rest: Vector3;
  /** Orientamento del genitore a riposo, in spazio creatura: serve a FOLLOW. */
  parentRest: Quaternion;
  /** Il freno dello slot: 1 se la spec non ne dichiara uno. */
  brake: number;
  target: Vector3;
  cur: Vector3;
  /** Quello che il gesto chiede in questo fotogramma, se lo chiede. */
  want: Vector3;
  wanted: boolean;
}

export class SkinnedBuddy implements Buddy {
  readonly meta: BuddyMeta;
  private spec: SkinnedSpec;

  /** Radice montata in scena: esiste subito, si popola quando il GLB arriva. */
  private group = new Group();
  /** Il modello: rollio, rotazione e rimbalzo lavorano qui, con perno ai piedi. */
  private rig = new Group();
  private slots = new Map<Slot, SlotState>();

  private halo: Mesh | null = null;
  private mixer: AnimationMixer | null = null;
  private action: AnimationAction | null = null;

  private state: BuddyState = "idle";
  private scene: Scene | null = null;
  private loaded = false;
  private disposed = false;

  // strato dei gesti
  private gesture: Gesture | null = null;
  private gestureAt = 0;
  /** Attesa prima del prossimo gesto. Il primo non arriva mai subito. */
  private wait = 8;
  private gRock = 0;
  private gLean = 0;
  private gLift = 0;
  private gTurn = 0;
  private gCalm = 0;
  /** Copia riscalata della TUNE quando un gesto chiede quiete: mai allocata nel loop. */
  private calmed: Tune = { speed: 1, bob: 0, rock: 0, turn: 0, breath: 0, swing: 0, look: 0 };

  // valori del corpo, smorzati come le pose
  private rock = 0;
  private lean = 0;
  private lift = 0;

  // scratch: nessuna allocazione nel loop di animazione (§ 3)
  private tmpV = new Vector3();
  private tmpV2 = new Vector3();
  private tmpV3 = new Vector3();
  private tmpQ = new Quaternion();
  private tmpQ2 = new Quaternion();
  private anchor = new Vector3();

  /** Il raccoglitore che i gesti riempiono: uno solo, riusato a ogni frame. */
  private sink: PoseSink = {
    aim: (slot, x, y, z) => {
      const s = this.slots.get(slot);
      if (!s) return;
      s.want.set(x, y, z);
      s.wanted = true;
    },
    bend: (slot, x, y, z) => {
      const s = this.slots.get(slot);
      if (!s) return;
      s.want.copy(s.rest).add(this.tmpV3.set(x, y, z));
      s.wanted = true;
    },
    rock: (v) => {
      this.gRock = v;
    },
    lean: (v) => {
      this.gLean = v;
    },
    lift: (v) => {
      this.gLift = v;
    },
    turn: (v) => {
      this.gTurn = v;
    },
    calm: (v) => {
      this.gCalm = v;
    },
  };

  /** Quota di riposo del fondo della creatura: pedana più galleggiamento. */
  private readonly floor: number;
  /**
   * A che altezza sopra il proprio fondo la creatura ruota.
   *
   * Chi cammina ruota attorno ai piedi: un pupazzo che dondola pianta i piedi
   * e sposta la testa, e il perno a terra è la cosa giusta. Chi galleggia no —
   * sospeso in aria non c'è niente che lo tenga per il fondo, e col perno lì
   * ogni rollio lo fa oscillare come se fosse appeso a un chiodo. Peggio
   * ancora una capriola, che gli farebbe descrivere un arco largo quanto la
   * creatura e passare sotto la pedana. Chi galleggia ruota attorno al proprio
   * centro, che è dove ruotano le cose che volano.
   */
  private pivot = 0;

  constructor(meta: BuddyMeta, spec: SkinnedSpec) {
    this.meta = meta;
    this.spec = spec;
    this.floor = spec.ground + (spec.hover ?? 0);
    this.group.add(this.rig);
  }

  mount(scene: Scene): Group {
    scene.add(this.group);
    this.scene = scene;
    void this.load();
    return this.group;
  }

  private async load(): Promise<void> {
    let gltf;
    try {
      gltf = await new GLTFLoader().loadAsync(this.spec.url);
    } catch (err) {
      console.error("[buddy] GLB non caricato:", this.spec.url, err);
      return;
    }
    // il cambio creatura può essere arrivato prima del GLB: allora si butta
    if (this.disposed) {
      disposeTree(gltf.scene);
      return;
    }

    const model = gltf.scene;
    this.rig.add(model);

    // Scala e appoggio: il GLB arriva con i piedi a 0 e un'altezza qualunque.
    // Il perno del gruppo resta a terra, così il rollio ruota attorno ai piedi
    // e non attorno alla pancia.
    const box = new Box3().setFromObject(model);
    const h = box.max.y - box.min.y || 1;
    const k = this.spec.height / h;
    model.scale.setScalar(k);
    // il fondo del modello finisce sul perno del rig, o mezza statura sotto
    // se la creatura galleggia (v. `pivot`)
    this.pivot = (this.spec.hover ?? 0) > 0 ? this.spec.height / 2 : 0;
    model.position.y = -box.min.y * k - this.pivot;
    this.rig.position.y = this.floor + this.pivot;

    model.traverse((o) => {
      o.castShadow = false;
      o.receiveShadow = false;
      o.frustumCulled = false; // lo skinning sposta i vertici fuori dalla bbox di riposo
    });

    this.bindRig(model);
    this.buildHalo();

    // se un domani il GLB porterà clip vere, vincono loro
    if (gltf.animations.length > 0) {
      this.mixer = new AnimationMixer(model);
      this.action = this.mixer.clipAction(gltf.animations[0]);
      this.action.play();
    }

    this.armTimer();
    this.loaded = true;
    this.applyLed();
  }

  /** Trova le ossa e memorizza come riposano: è il riferimento di tutto. */
  private bindRig(model: Object3D): void {
    const byName = new Map<string, Bone>();
    model.traverse((o) => {
      if ((o as Bone).isBone) byName.set(o.name, o as Bone);
    });

    model.updateMatrixWorld(true);
    const rigQ = this.rig.getWorldQuaternion(new Quaternion());
    const toRig = rigQ.clone().invert();

    for (const slot of ALL) {
      const name = this.spec.rig[slot];
      if (!name) continue;
      const bone = byName.get(name);
      if (!bone) {
        console.warn(`[buddy] osso mancante per lo slot ${slot}: ${name}`);
        continue;
      }
      const boneQ = bone.getWorldQuaternion(new Quaternion());
      // Per le membra si punta l'asse dell'osso; per la colonna e l'antenna
      // l'asse locale che a riposo guarda in su, quale che sia (v. UPRIGHT).
      const axis = UPRIGHT.has(slot)
        ? new Vector3(0, 1, 0).applyQuaternion(rigQ).applyQuaternion(boneQ.clone().invert())
        : new Vector3(0, 1, 0);
      const rest = axis.clone().applyQuaternion(boneQ).applyQuaternion(toRig).normalize();
      // com'era orientato il genitore prima che l'animatore toccasse niente
      const parentRest = new Quaternion();
      if (bone.parent) bone.parent.getWorldQuaternion(parentRest).premultiply(toRig);
      this.slots.set(slot, {
        bone,
        restQ: bone.quaternion.clone(),
        axis,
        rest,
        parentRest,
        brake: this.spec.brake?.[slot] ?? 1,
        target: rest.clone(),
        // si parte da come riposa il modello: la T-pose non si vede mai, le
        // braccia scendono lungo i fianchi con lo stesso smorzamento di
        // tutti gli altri cambi di posa
        cur: rest.clone(),
        want: new Vector3(),
        wanted: false,
      });
    }
  }

  /**
   * L'organo di stato. Un modello importato non ne ha uno: glielo si dà, con
   * lo stesso anello che portano Cotone e Bolete, così il colore semantico
   * (§ 9.2) resta leggibile qualunque creatura scelga l'utente.
   */
  private buildHalo(): void {
    const geo = new TorusGeometry(this.spec.haloRadius, 0.04, 8, 34);
    const mat = new MeshBasicMaterial({
      color: STATE_COLOR[this.state],
      transparent: true,
      opacity: 0.85,
    });
    this.halo = new Mesh(geo, mat);
    this.halo.rotation.x = Math.PI / 2;
    this.halo.position.y = this.spec.ground + 0.03;
    this.group.add(this.halo);
  }

  setState(state: BuddyState): void {
    if (state === this.state) return;
    this.state = state;
    this.applyLed();
    // un saluto iniziato in `idle` non ha senso mentre parte un allarme: non
    // si taglia di netto, si manda in dissolvenza subito
    if (this.gesture) this.gestureAt = Math.max(this.gestureAt, this.gesture.dur * 0.82);
    this.armTimer();
  }

  private applyLed(): void {
    const mat = this.halo?.material as MeshBasicMaterial | undefined;
    mat?.color.setHex(STATE_COLOR[this.state]);
  }

  // ---------------------------------------------------------------- gesti

  /** Rimette il cronometro con un'attesa casuale dentro il piano dello stato. */
  private armTimer(): void {
    const plan = this.spec.gestures[this.state];
    if (!plan || plan.pick.length === 0) {
      this.wait = Infinity;
      return;
    }
    const [a, b] = plan.every;
    this.wait = a + Math.random() * Math.max(0, b - a);
  }

  /** Fa partire un gesto per nome. Serve al banco di prova, non all'app. */
  play(id: string): boolean {
    for (const g of this.listGestures()) {
      if (g.id !== id) continue;
      this.gesture = g;
      this.gestureAt = 0;
      return true;
    }
    return false;
  }

  /** Tutti i gesti che questa creatura conosce, senza ripetizioni. */
  listGestures(): Gesture[] {
    const seen = new Map<string, Gesture>();
    for (const plan of Object.values(this.spec.gestures)) {
      for (const g of plan?.pick ?? []) seen.set(g.id, g);
    }
    return [...seen.values()];
  }

  /** Il gesto in corso, per il banco di prova. */
  currentGesture(): string | null {
    return this.gesture?.id ?? null;
  }

  private tickGesture(dt: number): void {
    if (this.gesture) {
      this.gestureAt += dt;
      if (this.gestureAt >= this.gesture.dur) {
        this.gesture = null;
        this.armTimer();
      }
      return;
    }
    if (this.wait === Infinity) return;
    this.wait -= dt;
    if (this.wait > 0) return;
    const plan = this.spec.gestures[this.state];
    if (!plan || plan.pick.length === 0) {
      this.wait = Infinity;
      return;
    }
    this.gesture = plan.pick[Math.floor(Math.random() * plan.pick.length)];
    this.gestureAt = 0;
  }

  /** La dissolvenza: entra, tiene, esce. Nessun gesto comincia di scatto. */
  private envelope(u: number, fade: [number, number]): number {
    const rise = fade[0] > 0 ? Math.min(1, u / fade[0]) : 1;
    const fall = fade[1] > 0 ? Math.min(1, (1 - u) / fade[1]) : 1;
    const w = Math.max(0, Math.min(rise, fall));
    return w * w * (3 - 2 * w);
  }

  // ----------------------------------------------------------- animazione

  update(t: number, dt: number): void {
    if (!this.loaded) return;
    const tune = TUNE[this.state];
    // il tempo non si acquieta mai: rallentarlo farebbe scattare le sinusoidi
    // nell'istante in cui il gesto entra o esce
    const w = t * tune.speed;
    const damp = 1 - Math.pow(0.5, dt / HALF_LIFE);

    this.mixer?.update(dt);

    // 1 · bersagli di stato, smorzati
    const pose = this.spec.poses[this.state];
    for (const slot of AIMED) {
      const s = this.slots.get(slot);
      if (!s) continue;
      this.resolve(slot, s, pose, s.target);
      s.cur.lerp(s.target, damp).normalize();
      s.wanted = false;
    }
    this.rock += ((pose?.rock ?? this.spec.base.rock ?? 0) - this.rock) * damp;
    this.lean += ((pose?.lean ?? this.spec.base.lean ?? 0) - this.lean) * damp;
    this.lift += ((pose?.lift ?? this.spec.base.lift ?? 0) - this.lift) * damp;

    // 2 · il gesto, se ce n'è uno in corso
    this.gRock = 0;
    this.gLean = 0;
    this.gLift = 0;
    this.gTurn = 0;
    this.gCalm = 0;
    this.tickGesture(dt);
    let g = 0;
    if (this.gesture) {
      const u = Math.min(1, this.gestureAt / this.gesture.dur);
      g = this.envelope(u, this.gesture.fade ?? [0.16, 0.2]);
      this.gesture.at(u, this.sink);
    }

    // La quiete che il gesto ha chiesto, se l'ha chiesta: entra e esce con la
    // stessa dissolvenza di tutto il resto, altrimenti il moto continuo si
    // spegnerebbe di colpo — che è esattamente ciò che si vuole evitare.
    let k = tune;
    if (this.gCalm > 0 && g > 0) {
      const m = 1 - this.gCalm * g;
      const q = this.calmed;
      q.speed = tune.speed;
      q.bob = tune.bob * m;
      q.rock = tune.rock * m;
      q.turn = tune.turn * m;
      q.breath = tune.breath * m;
      q.swing = tune.swing * m;
      q.look = tune.look * m;
      k = q;
    }

    // 3 · il corpo intero: perno ai piedi, tre periodi primi fra loro
    const a = Math.sin(w);
    const b = Math.sin(w * 0.41 + 1.3);
    const c = Math.sin(w * 0.67 + 2.7);

    this.rig.position.y =
      this.floor + this.pivot + this.lift + (a * 0.5 + 0.5) * k.bob + this.gLift * g;
    this.rig.rotation.set(
      this.lean + a * k.breath * 0.12 + this.gLean * g,
      c * k.turn + this.gTurn * g,
      this.rock + b * k.rock + c * k.rock * 0.35 + this.gRock * g,
    );

    // 4 · le ossa
    this.aimAll(w, k, g, a, b, c);
    this.pulseHalo(t);
  }

  /** Dove deve puntare uno slot in questo stato: `aim`, `bend`, o riposo. */
  private resolve(slot: Slot, s: SlotState, pose: Pose | undefined, out: Vector3): void {
    const a = pose?.aim?.[slot] ?? this.spec.base.aim?.[slot];
    if (a) {
      out.set(a[0], a[1], a[2]).normalize();
      return;
    }
    const bend = pose?.bend?.[slot] ?? this.spec.base.bend?.[slot];
    if (bend) {
      out.copy(s.rest).add(this.tmpV3.set(bend[0], bend[1], bend[2])).normalize();
      return;
    }
    out.copy(s.rest);
  }

  private aimAll(w: number, k: Tune, g: number, a: number, b: number, c: number): void {
    // le matrici del ramo devono essere fresche prima di leggere i genitori
    this.group.updateMatrixWorld(true);
    const rigQ = this.rig.getWorldQuaternion(this.tmpQ2);

    for (const slot of AIMED) {
      const s = this.slots.get(slot);
      if (!s) continue;

      this.tmpV.copy(s.cur);
      if (s.wanted && g > 0) this.tmpV.lerp(this.tmpV3.copy(s.want).normalize(), g);
      this.motion(slot, w, k, a, b, c, this.tmpV);
      // il freno, se l'osso ne ha uno: si riavvicina al riposo di quanto gli
      // manca per arrivare a 1, e vale per tutti e tre gli strati insieme
      if (s.brake < 1) this.tmpV.lerp(s.rest, 1 - s.brake);
      this.tmpV.normalize();

      // dalla direzione in spazio creatura alla rotazione in spazio genitore
      this.tmpV.applyQuaternion(rigQ); // → mondo
      const parent = s.bone.parent;
      if (parent) {
        // Chi insegue si converte con l'orientamento che il genitore aveva a
        // riposo: quello che il genitore ha fatto nel frattempo non viene
        // annullato, e lo scostamento gli si somma sopra (v. FOLLOW).
        if (FOLLOW.has(slot)) this.tmpQ.copy(rigQ).multiply(s.parentRest).invert();
        else this.tmpQ.copy(parent.getWorldQuaternion(this.tmpQ)).invert();
        this.tmpV.applyQuaternion(this.tmpQ);
      }
      this.tmpV2.copy(s.axis).applyQuaternion(s.restQ);
      s.bone.quaternion.setFromUnitVectors(this.tmpV2, this.tmpV).multiply(s.restQ);

      // solo questo osso: i genitori sono già passati, e i figli passeranno
      s.bone.updateWorldMatrix(false, false);
    }
  }

  /**
   * Il moto continuo, sovrapposto alla posa.
   *
   * Il ritardo di fase lungo le catene è la cosa importante: il torace respira
   * su `sin(w)`, il collo su `sin(w − 0,35)`, la testa su `sin(w − 0,6)`. Non
   * arrivano mai insieme, e il movimento smette di sembrare un blocco unico
   * montato su una molla.
   */
  private motion(
    slot: Slot,
    w: number,
    k: Tune,
    a: number,
    b: number,
    c: number,
    dir: Vector3,
  ): void {
    switch (slot) {
      case "spine":
        dir.z += a * k.breath * 0.25;
        dir.x += b * k.rock * 0.4;
        break;
      case "chest":
        dir.z += a * k.breath;
        dir.x += b * k.rock * 0.6;
        break;
      case "neck":
        dir.z += Math.sin(w - 0.35) * k.breath * 0.5;
        dir.x += b * k.look * 0.4 - c * k.rock * 0.5;
        break;
      case "head":
        // la testa ha un periodo suo, scollegato dal respiro: si guarda
        // intorno anche quando il resto del corpo è quasi fermo
        dir.x += b * k.look + c * k.look * 0.55;
        dir.z += Math.sin(w - 0.6) * k.breath * 0.7 + c * k.look * 0.25;
        break;

      // L'antenna è l'unica parte senza muscoli: non decide niente, insegue.
      // Ha il ritardo di fase più lungo di tutta la creatura e un periodo suo,
      // più rapido del corpo — è la prima cosa che parte e l'ultima a
      // fermarsi, ed è quella che si nota per prima quando Roberto si muove.
      case "antenna":
        dir.x += Math.sin(w * 1.3 - 0.7) * (k.look * 0.8 + k.bob * 0.5);
        dir.z += Math.sin(w * 0.83 - 1.0) * (k.look * 0.6 + k.breath * 0.4);
        break;
      case "antennaTip":
        // il pomello in cima frusta: doppia ampiezza e ancora mezzo periodo
        // di ritardo sullo stelo che lo porta
        dir.x += Math.sin(w * 1.3 - 1.25) * (k.look * 1.5 + k.bob * 0.9);
        dir.z += Math.sin(w * 0.83 - 1.6) * (k.look * 1.1 + k.breath * 0.7);
        break;

      case "armL":
        dir.z += Math.sin(w * 1.1) * k.swing;
        dir.x -= b * k.swing * 0.5;
        break;
      case "foreL":
        dir.z += Math.sin(w * 1.1 - 0.45) * k.swing * 1.35;
        dir.x -= Math.sin(w * 0.41 + 0.9) * k.swing * 0.6;
        break;
      case "handL":
        dir.z += Math.sin(w * 1.1 - 0.85) * k.swing * 1.7;
        dir.x -= Math.sin(w * 0.41 + 0.6) * k.swing * 0.8;
        break;

      case "armR":
        dir.z -= Math.sin(w * 1.1) * k.swing;
        dir.x += b * k.swing * 0.5;
        break;
      case "foreR":
        dir.z -= Math.sin(w * 1.1 - 0.45) * k.swing * 1.35;
        dir.x += Math.sin(w * 0.41 + 0.9) * k.swing * 0.6;
        break;
      case "handR":
        dir.z -= Math.sin(w * 1.1 - 0.85) * k.swing * 1.7;
        dir.x += Math.sin(w * 0.41 + 0.6) * k.swing * 0.8;
        break;

      // le gambe assecondano appena il rimbalzo: se si muovessero davvero
      // servirebbe un vincolo sui piedi, e i piedi qui stanno a terra
      case "legL":
      case "legR":
        dir.z += a * k.bob * 0.15;
        break;

      // Il muso non decide niente: insegue la testa con un ritardo brevissimo
      // e ci mette sopra un fremito suo, più rapido di tutto il resto. È
      // quello che fa leggere «sta annusando» anche quando non sta annusando.
      case "snout":
        dir.y += Math.sin(w * 2.1 - 0.4) * (k.breath * 0.6 + k.look * 0.2);
        dir.x += Math.sin(w * 0.9 - 0.5) * k.look * 0.45;
        break;

      // Le orecchie sono per questa creatura quello che l'antenna è per
      // Roberto: la parte senza muscoli, quella che parte per prima e si
      // ferma per ultima. Le due non arrivano mai insieme — mezzo periodo di
      // sfasamento fra destra e sinistra — e le punte frustano al doppio.
      case "earR":
        dir.x += Math.sin(w * 1.25 - 0.6) * (k.look * 0.7 + k.bob * 0.4);
        dir.z += Math.sin(w * 0.79 - 0.9) * (k.look * 0.5 + k.breath * 0.35);
        break;
      case "earTipR":
        dir.x += Math.sin(w * 1.25 - 1.15) * (k.look * 1.3 + k.bob * 0.75);
        dir.z += Math.sin(w * 0.79 - 1.45) * (k.look * 0.9 + k.breath * 0.6);
        break;
      case "earL":
        dir.x += Math.sin(w * 1.25 + 1.1) * (k.look * 0.7 + k.bob * 0.4);
        dir.z += Math.sin(w * 0.79 + 0.8) * (k.look * 0.5 + k.breath * 0.35);
        break;
      case "earTipL":
        dir.x += Math.sin(w * 1.25 + 0.55) * (k.look * 1.3 + k.bob * 0.75);
        dir.z += Math.sin(w * 0.79 + 0.25) * (k.look * 0.9 + k.breath * 0.6);
        break;

      // Le ali battono in fase fra loro — nessuno vola con le ali alternate —
      // e sono l'unica cosa che spiega perché una creatura senza gambe stia
      // per aria: se restano ferme, il galleggiamento sembra un errore di
      // posizionamento invece che una scelta.
      case "wingR":
      case "wingL":
        dir.y += Math.sin(w * 1.6) * (k.swing * 1.0 + k.bob * 0.5);
        dir.z += Math.sin(w * 1.6 - 0.3) * k.swing * 0.35;
        break;
      case "wingTipR":
      case "wingTipL":
        dir.y += Math.sin(w * 1.6 - 0.55) * (k.swing * 1.5 + k.bob * 0.8);
        dir.z += Math.sin(w * 1.6 - 0.85) * k.swing * 0.55;
        break;

      // L'onda viaggiante: ogni segmento in ritardo sul precedente, come per
      // la coda delle procedurali. È quel ritardo a far leggere una coda
      // invece che tre palline attaccate a uno stecco.
      case "tail":
        dir.x += Math.sin(w * 1.15) * (k.look * 0.8 + k.swing * 0.6);
        dir.y += Math.sin(w * 0.73 + 0.4) * (k.bob * 0.9 + k.breath * 0.5);
        break;
      case "tailMid":
        dir.x += Math.sin(w * 1.15 - 0.6) * (k.look * 1.3 + k.swing * 1.0);
        dir.y += Math.sin(w * 0.73 - 0.2) * (k.bob * 1.3 + k.breath * 0.8);
        break;
      case "tailTip":
        dir.x += Math.sin(w * 1.15 - 1.2) * (k.look * 1.9 + k.swing * 1.5);
        dir.y += Math.sin(w * 0.73 - 0.8) * (k.bob * 1.8 + k.breath * 1.1);
        break;

      default:
        break;
    }
  }

  private pulseHalo(t: number): void {
    if (!this.halo) return;
    const fast = this.state === "alert";
    const p = 1 + Math.sin(t * (fast ? 9 : 2.2)) * (fast ? 0.09 : 0.035);
    this.halo.scale.set(p, p, 1);
    (this.halo.material as MeshBasicMaterial).opacity = this.state === "sleep" ? 0.35 : 0.85;
  }

  getAnchor(): Vector3 {
    const head = this.slots.get("head");
    if (head) head.bone.getWorldPosition(this.anchor);
    else this.anchor.set(0, this.floor + this.spec.height * 0.85, 0).add(this.group.position);
    this.anchor.y += this.spec.anchorLift;
    return this.anchor;
  }

  getRoot(): Group {
    return this.group;
  }

  /**
   * L'ingombro vero della sagoma, per l'hit-test del click-through (§ 10.2).
   *
   * Non basta un `Box3.setFromObject()` sulla radice: three.js legge la
   * bounding box *della geometria a riposo*, che per un modello skinnato è
   * ancora la T-pose. Con le braccia lungo i fianchi la creatura è larga poco
   * più della testa, ma quella scatola la dichiara larga quanto l'apertura
   * delle braccia — e l'overlay si mangerebbe una striscia di schermo che non
   * copre nulla. Qui la scatola si costruisce dalle ossa.
   */
  getBox(target: Box3): Box3 | null {
    if (!this.loaded || this.slots.size === 0) return null;
    target.makeEmpty();
    for (const s of this.slots.values()) {
      target.expandByPoint(s.bone.getWorldPosition(this.tmpV));
    }
    // le ossa sono linee, la creatura ha uno spessore: un margine grossolano
    // sbaglia per difetto, che è il verso giusto per un rettangolo di clic
    target.expandByScalar(this.spec.girth);
    // Sotto l'osso più basso c'è ancora corpo — la pancia, i piedi — e il
    // fondo del modello sta per costruzione all'origine del rig. Per chi
    // cammina quella quota è la pedana; per chi galleggia è dove finisce la
    // creatura e comincia l'aria, e il rettangolo si ferma lì.
    target.expandByPoint(this.tmpV.set(0, this.rig.position.y - this.pivot, 0));
    return target;
  }

  dispose(): void {
    this.disposed = true;
    this.action?.stop();
    this.mixer?.stopAllAction();
    this.mixer = null;
    this.gesture = null;
    if (this.halo) {
      this.halo.geometry.dispose();
      (this.halo.material as Material).dispose();
    }
    disposeTree(this.group);
    this.scene?.remove(this.group);
    this.scene = null;
    this.slots.clear();
    this.loaded = false;
  }
}

/** Rilascia geometrie, materiali e texture di un sottoalbero (§ 9.4). */
function disposeTree(root: Object3D): void {
  root.traverse((o) => {
    // Lo scheletro ha una texture sua, dove three.js carica le matrici delle
    // ossa: non appartiene a nessun materiale, quindi il giro sui materiali
    // qui sotto non la vede. Senza questa riga ogni cambio di creatura ne
    // lascia una sulla GPU — un'app accesa dodici ore le colleziona.
    (o as SkinnedMesh).skeleton?.dispose?.();

    const mesh = o as Mesh;
    mesh.geometry?.dispose?.();
    const mat = mesh.material;
    if (!mat) return;
    for (const m of Array.isArray(mat) ? mat : [mat]) {
      for (const v of Object.values(m as unknown as Record<string, unknown>)) {
        if (v && typeof v === "object" && (v as Texture).isTexture) (v as Texture).dispose();
      }
      m.dispose();
    }
  });
}
