/**
 * I gesti delle creature alate: la libreria sorella di `gestures.ts`.
 *
 * Serve perché sotto una certa anatomia la libreria umanoide smette di
 * funzionare, e non per un difetto di scrittura: un saluto è un braccio che si
 * alza, e su un corpo che di braccia non ne ha resta una riga che non fa
 * niente. Cotone ha muso, orecchie, due ali e una coda a tre segmenti — cinque
 * catene, nessuna delle quali sa fare quello che sa fare una mano.
 *
 * Quello che cambia davvero non è l'elenco dei gesti, è dove sta il peso
 * espressivo. In un umanoide lo portano le mani, e testa e busto accompagnano.
 * Qui lo portano le **orecchie**: sono la parte più leggera, quella con il
 * ritardo di fase più lungo, e l'occhio ci va sopra da solo. Quasi ogni gesto
 * qui dentro ha una riga per le orecchie, e quasi sempre è quella che lo fa
 * leggere da lontano.
 *
 * Le convenzioni sono le stesse dell'altra libreria, con un'anatomia diversa:
 * orecchie e busto si muovono con `bend` (riposano verticali, quindi `z` è
 * portarle avanti sugli occhi e `x` è piegarle di lato); ali e coda con `aim`,
 * perché lì il riposo è la direzione dell'osso e uno scostamento scritto a
 * mano non significherebbe niente. Il muso è l'eccezione: insegue la testa da
 * sé (v. FOLLOW in `skinned.ts`), quindi va scritto con `bend` e con numeri
 * piccoli — quello che gli si chiede si somma a dove la testa è già arrivata.
 *
 * Due regole in più rispetto agli umanoidi. La prima: il moto continuo si
 * somma sempre a quello che il gesto chiede, quindi un gesto che *è*
 * un'assenza di movimento — una planata, cioè le ali che smettono di battere —
 * deve chiederla con `calm()`, o resta un tuffo con le ali che sbattono lo
 * stesso. La seconda: lungo una catena (le tre ossa della coda, l'ala e la sua
 * punta) i numeri devono crescere, perché ogni osso riceve una direzione
 * assoluta e la piega visibile è la *differenza* fra un segmento e il
 * successivo.
 */

import { key, mix } from "./gestures";
import type { Gesture, PoseSink } from "./skinned";

/** Le ali distese ai lati, orizzontali: da lì partono e lì tornano. */
const SPREAD = 0.94;

/**
 * Il ritardo con cui le orecchie inseguono la testa, in tempo normalizzato.
 * Sei centesimi di gesto: appena percettibile, ed è tutto il punto.
 */
const EAR_LAG = 0.06;

/**
 * Entrambe le orecchie insieme, radice e punta, con la punta più ampia.
 *
 * Le due vanno *nella stessa direzione*, non specchiate: quando la testa gira
 * a sinistra le orecchie la seguono a sinistra tutte e due. Specchiarle le
 * farebbe divaricare, che è un gesto diverso — e quando serve quello (la
 * scrollata) si scrive a mano.
 */
function ears(p: PoseSink, x: number, z: number, tip = 1.5): void {
  p.bend("earR", x, 0, z);
  p.bend("earL", x, 0, z);
  p.bend("earTipR", x * tip, 0, z * tip);
  p.bend("earTipL", x * tip, 0, z * tip);
}

/**
 * Le tre ossa della coda in una volta.
 *
 * I valori crescono verso la punta perché ogni osso riceve una direzione
 * *assoluta*, non relativa al segmento che lo precede: la piega visibile fra
 * due segmenti è la differenza fra i due numeri, e senza la crescita la coda
 * resterebbe dritta come un manico di scopa inclinato.
 */
function tail(p: PoseSink, x: number, y: number, grow = 1.4): void {
  p.aim("tail", x, y, -0.94);
  p.aim("tailMid", x * grow, y * grow, -0.86);
  p.aim("tailTip", x * grow * grow, y * grow * grow, -0.72);
}

/** Le due ali in fase, radice e punta. Stessa regola della coda sulle punte. */
function wings(p: PoseSink, y: number, z: number, tipY = y * 1.4): void {
  p.aim("wingR", -SPREAD, y, z);
  p.aim("wingL", SPREAD, y, z);
  p.aim("wingTipR", -SPREAD * 0.82, tipY, z * 1.25);
  p.aim("wingTipL", SPREAD * 0.82, tipY, z * 1.25);
}

// -------------------------------------------------------------- svolazzo

/**
 * Batte le ali forte e guadagna quota, poi si lascia riscendere. È il gesto
 * più riconoscibile della libreria — l'equivalente del saluto — e l'unico che
 * dice a chi guarda perché questa creatura sta per aria.
 */
const svolazzo: Gesture = {
  id: "svolazzo",
  label: "svolazza",
  dur: 2.4,
  fade: [0.12, 0.22],
  peak: 0.42,
  at(u, p) {
    const up = key(u, [
      [0, 0],
      [0.32, 1],
      [0.6, 1],
      [1, 0],
    ]);
    const beat = Math.sin(u * Math.PI * 2 * 4.5);
    p.lift(up * 0.44);
    wings(p, 0.12 + beat * 0.34, 0.08, 0.22 + beat * 0.46);
    p.bend("chest", 0, 0, -0.1 * up);
    p.bend("head", 0, 0, -0.11 * up);
    // le orecchie restano indietro nella salita: è l'aria, non una decisione
    ears(p, 0, -0.26 * up);
    p.bend("snout", 0, 0.14 * up, 0);
    tail(p, 0, -0.18 * up);
  },
};

// -------------------------------------------------------------- occhiata

/**
 * Si guarda intorno: sinistra, pausa, destra, pausa, torna. Il più discreto
 * della libreria, l'unico che ci si può permettere durante un focus — e anche
 * qui vale la regola di `gestures.ts`: raro, molto raro.
 */
const LOOK: readonly (readonly [number, number])[] = [
  [0, 0],
  [0.16, -0.62],
  [0.42, -0.62],
  [0.58, 0.66],
  [0.82, 0.66],
  [1, 0],
];

const occhiata: Gesture = {
  id: "occhiata",
  label: "si guarda intorno",
  dur: 4.6,
  fade: [0.2, 0.24],
  peak: 0.3,
  at(u, p) {
    const x = key(u, LOOK);
    // le orecchie fanno la stessa curva, ma in ritardo: arrivano dopo la
    // testa e ripartono dopo, ed è quel disallineamento che si nota
    const lag = key(Math.max(0, u - EAR_LAG), LOOK);
    p.bend("head", x * 0.42, 0, 0.05 - Math.abs(x) * 0.06);
    p.bend("chest", x * 0.09, 0, 0);
    ears(p, lag * 0.34, 0.06 * Math.abs(lag));
    // il naso insegue la testa da sé (v. FOLLOW): qui resta appena indietro
    p.bend("snout", -x * 0.09, 0, 0);
    tail(p, -x * 0.2, -0.04);
    p.turn(x * 0.42);
  },
};

// -------------------------------------------------------------- annusata

/** Muso a terra, tre piccoli scatti, orecchie in avanti: sta ascoltando. */
const annusata: Gesture = {
  id: "annusata",
  label: "annusa",
  dur: 3.0,
  fade: [0.18, 0.24],
  peak: 0.5,
  at(u, p) {
    const down = key(u, [
      [0, 0],
      [0.26, 1],
      [0.74, 1],
      [1, 0],
    ]);
    const sniff = Math.max(0, Math.sin(u * Math.PI * 2 * 3.5)) * down;
    p.bend("chest", 0, 0, 0.14 * down);
    p.bend("head", 0, 0, 0.36 * down + sniff * 0.05);
    p.bend("snout", 0, -0.34 * down - sniff * 0.13, 0);
    ears(p, 0, 0.32 * down, 1.35);
    wings(p, -0.12 * down, 0.08);
    tail(p, 0, 0.16 * down);
    p.lift(-0.12 * down);
    p.lean(0.06 * down);
  },
};

// ------------------------------------------------------------ scodinzolio

/** Due giri di coda, con il corpo che ci va dietro quel tanto che basta. */
const scodinzolio: Gesture = {
  id: "scodinzolio",
  label: "scodinzola",
  dur: 3.4,
  fade: [0.2, 0.26],
  peak: 0.35,
  at(u, p) {
    const s = key(u, [
      [0, 0],
      [0.2, 1],
      [0.76, 1],
      [1, 0],
    ]);
    const swish = (lag: number): number => Math.sin(u * Math.PI * 2 * 2.5 - lag) * s;
    // qui la coda non si scrive con `tail()`: il ritardo fra un segmento e
    // l'altro è il gesto, e va nella fase, non nell'ampiezza
    p.aim("tail", swish(0) * 0.5, 0.08, -0.9);
    p.aim("tailMid", swish(0.55) * 0.72, 0.06, -0.76);
    p.aim("tailTip", swish(1.1) * 0.9, 0.02, -0.56);
    p.rock(-swish(0) * 0.07);
    p.bend("head", swish(0.3) * 0.1, 0, -0.04 * s);
    ears(p, swish(0.7) * 0.16, -0.1 * s);
    wings(p, 0.09 * s, 0.06);
  },
};

// -------------------------------------------------------------- scrollata

/** Si scrolla di dosso come un cane bagnato. Il gesto più rapido di tutti. */
const scrollata: Gesture = {
  id: "scrollata",
  label: "si scrolla",
  dur: 1.9,
  fade: [0.1, 0.16],
  peak: 0.45,
  at(u, p) {
    const env = key(u, [
      [0, 0],
      [0.18, 1],
      [0.6, 1],
      [1, 0],
    ]);
    const shake = (lag: number): number => Math.sin(u * Math.PI * 2 * 7 - lag) * env;
    const s = shake(0);
    p.turn(s * 0.2);
    p.rock(s * 0.15);
    p.bend("chest", -s * 0.1, 0, 0);
    p.bend("head", -shake(0.5) * 0.26, 0, 0);
    // le orecchie sbattono con mezzo periodo di ritardo e ampiezza doppia:
    // sono loro a fare tutto il rumore visivo del gesto
    p.bend("earR", -shake(0.9) * 0.55, 0, 0);
    p.bend("earL", shake(0.9) * 0.55, 0, 0);
    p.bend("earTipR", -shake(1.4) * 0.95, 0, 0);
    p.bend("earTipL", shake(1.4) * 0.95, 0, 0);
    wings(p, 0.07 + s * 0.2, 0.05);
    p.aim("tail", -shake(0.8) * 0.42, 0.04, -0.9);
    p.aim("tailMid", -shake(1.3) * 0.6, 0.02, -0.78);
    p.aim("tailTip", -shake(1.8) * 0.78, 0, -0.6);
  },
};

// -------------------------------------------------------------- sbadiglio

/**
 * Lo sbadiglio senza mascella. Il rig non ne ha una, quindi il gesto si regge
 * sul corpo: si allunga tutto verso l'alto, muso al cielo e ali che si aprono
 * lente, e poi ricade addosso a sé stesso. Chi guarda ci legge uno sbadiglio
 * lo stesso, che è l'unica cosa che conta.
 */
const sbadiglio: Gesture = {
  id: "sbadiglio",
  label: "sbadiglia",
  dur: 3.4,
  fade: [0.14, 0.2],
  peak: 0.45,
  at(u, p) {
    const open = key(u, [
      [0, 0],
      [0.34, 1],
      [0.56, 1],
      [0.78, 0],
      [1, 0],
    ]);
    const slump = key(u, [
      [0, 0],
      [0.72, 0],
      [0.88, 1],
      [1, 0.3],
    ]);
    p.bend("chest", 0, 0, -0.13 * open + 0.16 * slump);
    p.bend("head", 0, 0, -0.3 * open + 0.3 * slump);
    p.bend("snout", 0, 0.44 * open - 0.3 * slump, 0);
    ears(p, 0, -0.42 * open + 0.46 * slump);
    wings(p, mix(0.05, 0.4, open) - 0.14 * slump, 0.05);
    tail(p, 0, mix(0, 0.32, open) - 0.28 * slump);
    p.lift(0.11 * open - 0.13 * slump);
    p.lean(-0.06 * open + 0.09 * slump);
  },
};

// --------------------------------------------------------------- planata

/**
 * Smette di battere, scende un poco, risale. Il gesto più silenzioso della
 * libreria: è l'unico fatto di *meno* movimento invece che di più, e senza
 * `calm()` non esisterebbe — il battito continuo lo ridurrebbe a un tuffo.
 */
const planata: Gesture = {
  id: "planata",
  label: "plana",
  dur: 5.0,
  fade: [0.3, 0.34],
  peak: 0.5,
  at(u, p) {
    const s = key(u, [
      [0, 0],
      [0.28, 1],
      [0.72, 1],
      [1, 0],
    ]);
    const dip = key(u, [
      [0, 0],
      [0.34, 1],
      [0.66, 0.5],
      [1, 0],
    ]);
    p.calm(0.86 * s);
    // ali spiegate e immobili, appena inclinate all'indietro come chi plana
    p.aim("wingR", -0.88, 0.18 * s, 0.24 * s);
    p.aim("wingL", 0.88, 0.18 * s, 0.24 * s);
    p.aim("wingTipR", -0.74, 0.32 * s, 0.3 * s);
    p.aim("wingTipL", 0.74, 0.32 * s, 0.3 * s);
    tail(p, 0, -0.12 - 0.1 * s, 1.2);
    p.bend("head", 0, 0, 0.14 * dip);
    ears(p, 0, -0.2 * s);
    p.lift(-0.18 * dip);
    p.lean(0.06 * dip);
  },
};

// -------------------------------------------------------------- sternuto

/** Si carica indietro e scatta in avanti. Raro, e quando capita si vede. */
const sternuto: Gesture = {
  id: "sternuto",
  label: "starnutisce",
  dur: 1.6,
  fade: [0.08, 0.14],
  peak: 0.6,
  at(u, p) {
    const load = key(u, [
      [0, 0],
      [0.4, 1],
      [0.48, 1],
      [0.56, 0],
      [1, 0],
    ]);
    const snap = key(u, [
      [0, 0],
      [0.5, 0],
      [0.58, 1],
      [0.74, 0.18],
      [1, 0],
    ]);
    p.bend("chest", 0, 0, -0.1 * load + 0.2 * snap);
    p.bend("head", 0, 0, -0.26 * load + 0.5 * snap);
    p.bend("snout", 0, 0.38 * load - 0.52 * snap, 0);
    ears(p, 0, -0.32 * load + 0.72 * snap);
    wings(p, 0.06 + 0.28 * snap - 0.1 * load, 0.05);
    tail(p, 0, 0.22 * load - 0.26 * snap);
    p.lift(0.08 * load - 0.15 * snap);
    p.lean(-0.08 * load + 0.13 * snap);
  },
};

// -------------------------------------------------------------- piroetta

/**
 * Un giro completo su sé stesso, ali aperte.
 *
 * Niente dissolvenza in uscita, ed è l'unico gesto della libreria che se la
 * può permettere: il giro finisce a 2π, cioè esattamente dove era partito.
 * Sfumarlo significherebbe moltiplicare l'angolo per una dissolvenza che
 * scende, e la creatura tornerebbe indietro srotolandosi. Tutti gli altri
 * canali rientrano da soli entro `u = 1`, così alla fine non resta nulla da
 * sfumare.
 */
const piroetta: Gesture = {
  id: "piroetta",
  label: "piroetta",
  dur: 3.6,
  fade: [0.14, 0],
  peak: 0.5,
  at(u, p) {
    const s = key(u, [
      [0, 0],
      [0.16, 1],
      [0.8, 1],
      [1, 0],
    ]);
    p.turn(
      key(u, [
        [0, 0],
        [0.1, 0],
        [0.9, Math.PI * 2],
        [1, Math.PI * 2],
      ]),
    );
    wings(p, 0.08 + 0.28 * s, 0.13 * s);
    p.rock(0.11 * s);
    p.lift(0.14 * s);
    p.bend("chest", 0, 0, -0.08 * s);
    p.bend("head", 0.14 * s, 0, -0.12 * s);
    ears(p, -0.2 * s, -0.16 * s);
    tail(p, 0.28 * s, 0.1 * s);
  },
};

// -------------------------------------------------------------- capriola

/**
 * Un giro della morte: sale, ruota di 2π attorno all'asse orizzontale e
 * riscende. Vale la stessa regola della piroetta sulla dissolvenza.
 *
 * Una creatura che galleggia ruota attorno al proprio centro (v. `pivot` in
 * `skinned.ts`), quindi il giro avviene sul posto e la quota che sale a
 * campana è solo carattere: la spinta che si dà per partire.
 */
const capriola: Gesture = {
  id: "capriola",
  label: "fa una capriola",
  dur: 1.9,
  fade: [0.1, 0],
  peak: 0.45,
  at(u, p) {
    const flip = key(u, [
      [0, 0],
      [0.14, 0],
      [0.82, Math.PI * 2],
      [1, Math.PI * 2],
    ]);
    const air = key(u, [
      [0, 0],
      [0.16, 0.2],
      [0.48, 1],
      [0.84, 0.2],
      [1, 0],
    ]);
    p.lean(flip);
    // le basta un saltello: il giro avviene attorno al centro del corpo, non
    // attorno alla pancia, quindi non c'è nessun pavimento da scavalcare
    p.lift(air * 0.34);
    // tutto raccolto: una capriola con la coda distesa non gira, sventola
    wings(p, 0.34 * air + 0.06, 0.05);
    tail(p, 0, 0.34 * air, 1.5);
    p.bend("chest", 0, 0, 0.1 * air);
    p.bend("head", 0, 0, 0.24 * air);
    ears(p, 0, 0.42 * air);
  },
};

// --------------------------------------------------------- arrotolamento

/** Nel sonno la coda si stringe attorno al corpo e tutto si fa più piccolo. */
const arrotolamento: Gesture = {
  id: "arrotolamento",
  label: "si arrotola nel sonno",
  dur: 6.0,
  fade: [0.34, 0.38],
  peak: 0.5,
  at(u, p) {
    const c = key(u, [
      [0, 0],
      [0.4, 1],
      [0.66, 1],
      [1, 0],
    ]);
    p.calm(0.55 * c);
    p.aim("tail", 0.34 * c, -0.12, -0.9);
    p.aim("tailMid", 0.6 * c, -0.14, -0.74);
    p.aim("tailTip", 0.84 * c, -0.16, -0.44);
    p.bend("chest", 0.06 * c, 0, 0.1 * c);
    p.bend("head", 0.12 * c, 0, 0.18 * c);
    ears(p, 0.08 * c, 0.22 * c);
    p.lift(-0.08 * c);
    p.rock(0.06 * c);
  },
};

export const MOVES = {
  svolazzo,
  occhiata,
  annusata,
  scodinzolio,
  scrollata,
  sbadiglio,
  planata,
  sternuto,
  piroetta,
  capriola,
  arrotolamento,
} satisfies Record<string, Gesture>;
