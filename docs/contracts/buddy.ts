/**
 * desk-buddy · contratto delle creature
 *
 * Quattro metodi. Aggiungere una creatura non deve toccare lo scheduler,
 * il pomodoro, il layer delle nuvolette né il loop di animazione.
 * Se la settima creatura costa più della prima, questo contratto è stato
 * violato da qualche parte.
 */

import type { Group, Scene, Vector3 } from "three";

/** Gli stati che il core può chiedere. Il renderer non ne inventa altri. */
export type BuddyState =
  | "idle"       // in attesa, nulla in corso
  | "focus"      // sessione di focus attiva
  | "break"      // pausa in corso
  | "alert"      // ti sta chiedendo qualcosa
  | "celebrate"  // sessione completata
  | "sleep";     // inattivo da tempo

/**
 * Il colore è la lingua franca degli stati: qualunque creatura scelga
 * l'utente, il suo organo di stato (fiammella, visore, anello) parla con
 * questi colori. Il significato non cambia col personaggio.
 */
export const STATE_COLOR: Record<BuddyState, number> = {
  idle:      0xbfb3e8,
  focus:     0x57a98b,
  break:     0x9bd4f5,
  alert:     0xf2b441,
  celebrate: 0x8ce0a8,
  sleep:     0x4a4270,
};

export interface BuddyMeta {
  id: string;          // "cotone", "brace", ...
  name: string;        // nome mostrato nelle impostazioni
  species: string;     // riga descrittiva
  trait: string;       // la caratteristica che la distingue
}

export interface Buddy {
  readonly meta: BuddyMeta;

  /** Costruisce la gerarchia e la aggiunge alla scena. Chiamato una volta. */
  mount(scene: Scene): Group;

  /**
   * Cambia comportamento e colore dell'organo di stato.
   * Deve essere idempotente: chiamarlo due volte con lo stesso stato
   * non produce scatti.
   */
  setState(state: BuddyState): void;

  /**
   * Avanza l'animazione. `t` è il tempo trascorso in secondi, `dt` il delta
   * dall'ultimo frame (già limitato dal chiamante).
   *
   * Non deve leggere l'orologio da sé: se il loop viene messo in pausa
   * perché l'overlay è occluso, la creatura deve congelarsi, non recuperare.
   */
  update(t: number, dt: number): void;

  /**
   * Il punto 3D a cui si aggancia la nuvoletta, tipicamente sopra la testa.
   * Il layer delle bolle lo proietta in coordinate schermo a ogni frame.
   */
  getAnchor(): Vector3;

  /**
   * Il rettangolo occupato dalla sagoma in coordinate schermo, normalizzato
   * 0..1 rispetto alla finestra. Il core lo usa per l'hit-test del
   * click-through: più è stretto, meno l'overlay ruba clic ad altre app.
   */
  getHitBox(): { x: number; y: number; w: number; h: number };

  /**
   * Rilascia geometrie, materiali e texture. Su un'app accesa dodici ore
   * saltare questo passaggio si nota: ogni cambio buddy lascia buffer
   * sulla GPU che nessuno libera.
   */
  dispose(): void;
}

/** Firma di un costruttore di creature, per il registro. */
export type BuddyFactory = () => Buddy;

/**
 * Registro dei buddy disponibili. È l'unico punto che cambia quando se ne
 * aggiunge uno: nessun `switch` sparso nel resto dell'applicazione.
 */
export interface BuddyRegistry {
  list(): BuddyMeta[];
  create(id: string): Buddy;
  has(id: string): boolean;
}
