/**
 * I gesti: episodi brevi che la creatura si concede da sé.
 *
 * Servono a una cosa sola, ed è quella che distingue un compagno da uno
 * screensaver: ogni tanto succede qualcosa che non stavi aspettando. Un ciclo
 * di respiro, per quanto ben fatto, dopo trenta secondi sparisce dalla vista
 * periferica; un saluto ogni due minuti no.
 *
 * Sono presentazione, non dominio: il core non sa che esistono e non deve
 * saperlo (§ 5), esattamente come non sa del battito di palpebre delle
 * creature procedurali. Se l'overlay viene distrutto a metà di uno sbadiglio
 * non è successo niente.
 *
 * Regola d'oro nello scriverli: le braccia si muovono con `aim`, il resto con
 * `bend`. `bend` è uno scostamento da come l'osso riposa *nel modello*, e per
 * le braccia il riposo è la T-pose — chiedere «un po' più avanti» a un
 * braccio disteso di lato lo lascia disteso di lato. Per collo, testa e busto
 * invece il riposo è la verticale, sempre, qualunque rig ci sia sotto (v.
 * UPRIGHT in `skinned.ts`): `z` è annuire, `x` è piegarsi di lato.
 *
 * Sono scritti per un umanoide qualunque, non per Roberto: il prossimo
 * modello importato eredita la stessa libreria e sceglie quali usare. Uno
 * slot che quel modello non ha — le gambe di Roberto 2.0, per dire — è una
 * riga che non fa niente, non un errore; ma un gesto che si regge *solo* su
 * quello slot non si vede più, e va scritto perché regga anche senza.
 */

import type { Gesture, PoseSink } from "./skinned";

/**
 * Interpolazione fra fotogrammi chiave, con raccordo dolce.
 *
 * `key(u, [[0, 0], [0.3, 1], [0.7, 1], [1, 0]])` sale, tiene, scende. È tutto
 * quello che serve per scrivere un gesto senza aprire un editor di curve.
 */
export function key(u: number, pts: readonly (readonly [number, number])[]): number {
  if (u <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [ub, vb] = pts[i];
    if (u <= ub) {
      const [ua, va] = pts[i - 1];
      const s = (u - ua) / (ub - ua || 1);
      return va + (vb - va) * (s * s * (3 - 2 * s));
    }
  }
  return pts[pts.length - 1][1];
}

const mix = (a: number, b: number, u: number): number => a + (b - a) * u;

/** Le braccia lungo i fianchi: il punto da cui partono e a cui tornano. */
const DOWN = { x: 0.42, y: -0.9, z: 0.06 };

// --------------------------------------------------------------- saluto

/** Alza il braccio destro e sventola la mano. Il più riconoscibile di tutti. */
const saluto: Gesture = {
  id: "saluto",
  label: "saluta",
  dur: 2.9,
  fade: [0.18, 0.22],
  at(u, p) {
    const wave = Math.sin(u * Math.PI * 6.5);
    p.aim("armL", 0.74, 0.56, 0.24);
    p.aim("foreL", 0.46 + wave * 0.26, 0.86, 0.14);
    p.aim("handL", 0.38 + wave * 0.4, 0.87, 0.1);
    // il braccio fermo accompagna appena: nessuno saluta con mezzo corpo
    p.aim("armR", -0.46, -0.86, 0.12);
    p.bend("neck", 0.06, 0, 0.04);
    p.bend("head", 0.12, 0, 0.06);
    p.rock(-0.06);
    p.turn(0.08);
  },
};

// -------------------------------------------------------------- occhiata

/**
 * Si guarda intorno: sinistra, pausa, destra, pausa, torna. È il gesto più
 * discreto della libreria, l'unico che ci si può permettere durante un focus.
 */
const occhiata: Gesture = {
  id: "occhiata",
  label: "si guarda intorno",
  dur: 4.6,
  fade: [0.2, 0.24],
  peak: 0.3,
  at(u, p) {
    const x = key(u, [
      [0, 0],
      [0.16, -0.62],
      [0.42, -0.62],
      [0.58, 0.66],
      [0.82, 0.66],
      [1, 0],
    ]);
    p.bend("head", x, 0, 0.05 - Math.abs(x) * 0.06);
    p.bend("neck", x * 0.33, 0, 0);
    p.bend("chest", x * 0.1, 0, 0);
    p.turn(x * 0.11);
  },
};

// ------------------------------------------------------------- sbadiglio

/** Braccia in alto, testa all'indietro, e poi tutto che ricade giù. */
const sbadiglio: Gesture = {
  id: "sbadiglio",
  label: "sbadiglia",
  dur: 3.6,
  fade: [0.14, 0.18],
  at(u, p) {
    const open = key(u, [
      [0, 0],
      [0.32, 1],
      [0.55, 1],
      [0.78, 0],
      [1, 0],
    ]);
    const slump = key(u, [
      [0, 0],
      [0.72, 0],
      [0.88, 1],
      [1, 0.35],
    ]);

    p.aim("armR", -mix(DOWN.x, 0.6, open), mix(DOWN.y, 0.6, open), mix(DOWN.z, 0.3, open));
    p.aim("foreR", -mix(0.24, 0.42, open), mix(-0.94, 0.86, open), mix(0.24, 0.24, open));
    p.aim("armL", mix(DOWN.x, 0.6, open), mix(DOWN.y, 0.6, open), mix(DOWN.z, 0.3, open));
    p.aim("foreL", mix(0.24, 0.42, open), mix(-0.94, 0.86, open), mix(0.24, 0.24, open));

    p.bend("chest", 0, 0, -0.2 * open + 0.18 * slump);
    p.bend("neck", 0, 0, -0.38 * open + 0.3 * slump);
    p.bend("head", 0, 0, -0.58 * open + 0.36 * slump);
    p.lift(0.05 * open - 0.06 * slump);
    p.lean(-0.05 * open + 0.07 * slump);
  },
};

// -------------------------------------------------------------- grattata

/** Si gratta la testa, con la mano che gira in piccolo. */
const grattata: Gesture = {
  id: "grattata",
  label: "si gratta la testa",
  dur: 3.3,
  fade: [0.2, 0.24],
  at(u, p) {
    const a = u * Math.PI * 2 * 3.2;
    p.aim("armR", -0.44, 0.7, 0.22);
    p.aim("foreR", -0.16 + Math.cos(a) * 0.08, 0.97, 0.12 + Math.sin(a) * 0.08);
    p.aim("handR", -0.08 + Math.cos(a) * 0.12, 0.98, 0.1 + Math.sin(a) * 0.12);
    p.aim("armL", 0.4, -0.9, 0.14);
    // la testa si inclina dalla parte opposta alla mano: è così che si fa
    p.bend("head", -0.16, 0, 0.1);
    p.bend("neck", -0.07, 0, 0.05);
    p.rock(0.05);
  },
};

// ---------------------------------------------------------- stiracchiata

/** Si stira: braccia larghe verso l'alto, schiena inarcata, sulle punte. */
const stiracchiata: Gesture = {
  id: "stiracchiata",
  label: "si stiracchia",
  dur: 3.2,
  fade: [0.2, 0.26],
  at(u, p) {
    const s = key(u, [
      [0, 0],
      [0.38, 1],
      [0.64, 1],
      [1, 0],
    ]);
    p.aim("armR", -0.7, 0.68, -0.06);
    p.aim("foreR", -0.56, 0.82, -0.1);
    p.aim("handR", -0.5, 0.86, -0.12);
    p.aim("armL", 0.7, 0.68, -0.06);
    p.aim("foreL", 0.56, 0.82, -0.1);
    p.aim("handL", 0.5, 0.86, -0.12);
    p.bend("chest", 0, 0, -0.2);
    p.bend("neck", 0, 0, -0.14);
    p.bend("head", 0, 0, -0.2);
    p.lift(0.12 * s);
    p.lean(-0.07 * s);
  },
};

// --------------------------------------------------------------- saltello

/** Piega, salta, atterra con una schiacciatina. Il gesto più fisico. */
const saltello: Gesture = {
  id: "saltello",
  label: "fa un saltello",
  dur: 1.5,
  fade: [0.06, 0.1],
  peak: 0.42,
  at(u, p) {
    const crouch = key(u, [
      [0, 0],
      [0.16, 1],
      [0.3, 0],
      [0.7, 0],
      [0.82, 0.85],
      [1, 0],
    ]);
    const f = (u - 0.28) / 0.44;
    const air = f > 0 && f < 1 ? Math.sin(f * Math.PI) : 0;
    const swing = air - crouch * 0.6;

    p.lift(air * 0.42 - crouch * 0.13);
    p.aim("armR", -0.5, mix(-0.86, 0.6, Math.max(0, swing)), 0.22);
    p.aim("foreR", -0.36, mix(-0.9, 0.8, Math.max(0, swing)), 0.26);
    p.aim("armL", 0.5, mix(-0.86, 0.6, Math.max(0, swing)), 0.22);
    p.aim("foreL", 0.36, mix(-0.9, 0.8, Math.max(0, swing)), 0.26);
    p.bend("legR", 0, 0, crouch * 0.2);
    p.bend("legL", 0, 0, crouch * 0.2);
    // La molla del salto sta nelle gambe, ma chi non ne ha resterebbe un
    // pupazzo rigido tirato su e giù: il busto che si raccoglie e si apre fa
    // leggere lo stesso il caricamento, e a chi le gambe ce l'ha non dà
    // fastidio — nessuno salta con la schiena dritta.
    p.bend("spine", 0, 0, crouch * 0.16 - air * 0.06);
    p.bend("chest", 0, 0, crouch * 0.13 - air * 0.1);
    p.bend("head", 0, 0, -air * 0.1 + crouch * 0.12);
  },
};

// --------------------------------------------------------------- dondolio

/** Sposta il peso da un piede all'altro, una volta sola, e torna. */
const dondolio: Gesture = {
  id: "dondolio",
  label: "sposta il peso",
  dur: 4.2,
  fade: [0.25, 0.3],
  peak: 0.25,
  at(u, p) {
    const s = Math.sin(u * Math.PI * 2);
    p.rock(s * 0.13);
    p.turn(s * 0.1);
    p.aim("armR", -0.42 + s * 0.12, -0.9, 0.06 + s * 0.14);
    p.aim("armL", 0.42 + s * 0.12, -0.9, 0.06 - s * 0.14);
    p.bend("head", -s * 0.2, 0, 0);
    p.bend("chest", s * 0.08, 0, 0);
  },
};

// ---------------------------------------------------------------- inchino

/** Un inchino: sta bene solo quando c'è qualcosa da festeggiare. */
const inchino: Gesture = {
  id: "inchino",
  label: "si inchina",
  dur: 2.5,
  fade: [0.16, 0.22],
  at(u, p) {
    const d = key(u, [
      [0, 0],
      [0.34, 1],
      [0.6, 1],
      [1, 0],
    ]);
    p.bend("spine", 0, 0, 0.5 * d);
    p.bend("chest", 0, 0, 0.4 * d);
    p.bend("neck", 0, 0, 0.18 * d);
    p.bend("head", 0, 0, 0.1 * d);
    p.aim("armR", -0.52, -0.82, -0.18);
    p.aim("armL", 0.52, -0.82, -0.18);
    p.lean(0.13 * d);
  },
};

// ---------------------------------------------------------------- sospiro

/** Un respiro più profondo nel sonno. Non sveglia nessuno, ma si vede. */
const sospiro: Gesture = {
  id: "sospiro",
  label: "sospira nel sonno",
  dur: 5.5,
  fade: [0.32, 0.36],
  at(u, p) {
    const b = key(u, [
      [0, 0],
      [0.4, 1],
      [0.62, 1],
      [1, 0],
    ]);
    p.bend("chest", 0, 0, -0.13 * b);
    p.bend("neck", 0, 0, 0.06 * b);
    p.lift(0.035 * b);
  },
};

export const GESTURES = {
  saluto,
  occhiata,
  sbadiglio,
  grattata,
  stiracchiata,
  saltello,
  dondolio,
  inchino,
  sospiro,
} satisfies Record<string, Gesture>;

export type { Gesture, PoseSink };
