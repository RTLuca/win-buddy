/**
 * Classe base delle creature procedurali.
 *
 * L'animazione è un'unica grammatica: ogni costruttore dichiara quali parti
 * esistono (coda, ali, orbita, visore...) e l'animatore muove quelle che
 * trova. È ciò che rende i personaggi intercambiabili invece che sei
 * comportamenti da mantenere separatamente (§ 9.2).
 */

import {
  Group,
  Mesh,
  MeshBasicMaterial,
  Vector3,
  type Object3D,
  type Scene,
} from "three";
import { STATE_COLOR, type Buddy, type BuddyMeta, type BuddyState } from "../../shared/contracts";
import { Kit, type Palette } from "./helpers";

export interface Parts {
  body?: Mesh;
  head?: Group;
  eyeL?: Object3D | null;
  eyeR?: Object3D | null;
  handL?: Mesh;
  handR?: Mesh;
  wingL?: Mesh;
  wingR?: Mesh;
  tail?: Mesh[];
  tailTip?: Mesh;
  crest?: Mesh[];
  orbit?: Group;
  flame?: Mesh;
  shards?: Mesh[];
  ring?: Mesh;
  cap?: Group;
  fire?: Mesh;
  visor?: Mesh;
  antenna?: Mesh;
  halo?: Mesh;
}

export type Builder = (c: Palette, kit: Kit) => { group: Group; parts: Parts };

/** Parametri di animazione per stato (dal prototipo del bestiario). */
const TUNE: Record<BuddyState, {
  bob: number; speed: number; squash: number; tilt: number;
  spin: number; eye: number; drop: number;
}> = {
  idle:      { bob: 0.11, speed: 1.5, squash: 0.03, tilt: 0.05, spin: 0.5,  eye: 1.0,  drop: 0.0 },
  focus:     { bob: 0.04, speed: 0.9, squash: 0.02, tilt: 0.02, spin: 0.25, eye: 0.45, drop: -0.1 },
  break:     { bob: 0.2,  speed: 2.2, squash: 0.09, tilt: 0.16, spin: 0.9,  eye: 1.15, drop: 0.1 },
  alert:     { bob: 0.26, speed: 6.5, squash: 0.13, tilt: 0.3,  spin: 2.4,  eye: 1.3,  drop: 0.18 },
  celebrate: { bob: 0.34, speed: 4.0, squash: 0.16, tilt: 0.12, spin: 3.2,  eye: 1.2,  drop: 0.22 },
  sleep:     { bob: 0.05, speed: 0.5, squash: 0.05, tilt: 0.0,  spin: 0.05, eye: 0.06, drop: -0.55 },
};

const LED_PARTS = ["flame", "ring", "antenna", "visor", "fire", "halo"] as const;

export class ProceduralBuddy implements Buddy {
  readonly meta: BuddyMeta;
  private kit = new Kit();
  private group: Group;
  private parts: Parts;
  private baseScale: Vector3;
  private state: BuddyState = "idle";
  private scene: Scene | null = null;
  private blink = 2.5;
  private anchor = new Vector3();

  constructor(meta: BuddyMeta, palette: Palette, build: Builder) {
    this.meta = meta;
    const { group, parts } = build(palette, this.kit);
    this.group = group;
    this.parts = parts;
    this.baseScale = parts.body ? parts.body.scale.clone() : new Vector3(1, 1, 1);
  }

  mount(scene: Scene): Group {
    scene.add(this.group);
    this.scene = scene;
    this.applyLed();
    return this.group;
  }

  setState(state: BuddyState): void {
    if (state === this.state) return;
    this.state = state;
    this.applyLed();
  }

  /** Applica il colore semantico all'organo di stato, qualunque esso sia. */
  private applyLed(): void {
    const col = STATE_COLOR[this.state];
    const p = this.parts;
    for (const name of LED_PARTS) {
      const mesh = p[name];
      const mat = mesh?.material;
      if (mat instanceof MeshBasicMaterial || (mat && "color" in (mat as object))) {
        (mat as MeshBasicMaterial).color.setHex(col);
      }
    }
    if (p.shards) {
      for (const s of p.shards) {
        (s.material as MeshBasicMaterial).color.setHex(col);
      }
    }
  }

  update(t: number, dt: number): void {
    const k = TUNE[this.state];
    const p = this.parts;
    const g = this.group;
    const w = t * k.speed;
    const state = this.state;

    // respiro / galleggiamento
    g.position.y = Math.sin(w) * k.bob + k.drop;
    g.rotation.z = Math.sin(w * 0.7) * k.tilt * 0.35;
    g.rotation.y = Math.sin(t * 0.35) * k.spin * 0.12;

    // schiacciamento in controfase sulla scala originale della specie
    if (p.body) {
      const sq = 1 - Math.sin(w) * k.squash;
      p.body.scale.y = this.baseScale.y * sq;
      p.body.scale.x = this.baseScale.x * (2 - sq);
      p.body.scale.z = this.baseScale.z * (2 - sq);
    }

    // occhi: battito di palpebre + apertura per stato
    this.blink -= dt;
    if (this.blink < -0.12) {
      this.blink = 1.6 + Math.random() * 3.4;
    }
    const lid = this.blink < 0 && state !== "sleep" ? 0.08 : k.eye;
    if (p.eyeL) p.eyeL.scale.y = lid;
    if (p.eyeR) p.eyeR.scale.y = lid;

    if (p.head) {
      p.head.rotation.z = Math.sin(w * 1.1) * k.tilt * 0.5;
      p.head.rotation.x = state === "sleep" ? 0.45 : Math.sin(w * 0.6) * 0.05;
    }

    // mani che orbitano, in controfase tra loro
    if (p.handL && p.handR) {
      const swing = Math.sin(w * 1.3) * (0.14 + k.bob);
      const lift = state === "alert" || state === "celebrate" ? 0.5 : 0;
      p.handL.position.y = -0.35 + swing + lift;
      p.handR.position.y = -0.35 - swing + lift;
    }

    if (p.orbit) {
      p.orbit.rotation.y = t * (0.6 + k.spin * 0.5);
      p.orbit.rotation.z = Math.sin(t * 0.4) * 0.2;
    }
    if (p.flame) {
      p.flame.scale.y = 1.6 + Math.sin(t * 9) * 0.3;
    }
    if (p.shards) {
      const spread = state === "celebrate" ? 1.35 : state === "focus" ? 0.78 : 1;
      p.shards.forEach((s, i) => {
        s.rotation.x = t * (1 + i * 0.3);
        s.rotation.y = t * 0.8;
        s.scale.setScalar(spread);
      });
    }
    if (p.ring) {
      p.ring.rotation.z = t * k.spin * 0.4;
    }

    // ali: sbattono più forte quando serve attenzione
    if (p.wingL && p.wingR) {
      const flap = Math.sin(w * 2.4) * (0.3 + k.bob * 1.5);
      p.wingL.rotation.x = flap;
      p.wingR.rotation.x = -flap;
    }

    // coda a onda: ogni segmento in ritardo di fase sul precedente
    if (p.tail) {
      p.tail.forEach((seg, j) => {
        const ph = w * 1.4 - j * 0.55;
        seg.position.x = Math.sin(ph) * 0.16 * (j + 1) * 0.5;
        seg.position.y = Math.cos(ph) * 0.1 * (j + 1) * 0.35 - 0.12;
      });
    }
    if (p.tailTip) {
      p.tailTip.position.x = Math.sin(w * 1.4 - 1.65) * 0.34;
      p.tailTip.rotation.z = Math.sin(w * 1.4 - 1.65) * 0.4;
    }

    if (p.cap) {
      p.cap.scale.y = 1 + Math.sin(w * 1.2) * k.squash * 1.4;
      p.cap.rotation.z = Math.sin(w * 0.8) * k.tilt * 0.4;
    }

    // cresta dorsale a onda, stesso ritardo di fase della coda
    if (p.crest) {
      p.crest.forEach((spine, i) => {
        spine.rotation.x = -0.35 + Math.sin(w * 1.2 - i * 0.5) * 0.14;
      });
    }

    // la fiammella compare solo quando la creatura reclama attenzione
    if (p.fire) {
      const want = state === "alert" || state === "celebrate" ? 1 : 0.001;
      const cur = p.fire.scale.x;
      const next = cur + (want - cur) * Math.min(1, dt * 9);
      p.fire.scale.set(next, next * (1 + Math.sin(t * 14) * 0.18), next);
    }

    // visore e antenna dell'automa: pulsano al ritmo dello stato
    if (p.visor) {
      p.visor.scale.x = 1 + Math.sin(w * 1.4) * 0.02;
    }
    if (p.antenna) {
      const pulse = 1 + Math.sin(t * (state === "alert" ? 11 : 2.4)) * 0.22;
      p.antenna.scale.setScalar(pulse);
    }
  }

  getAnchor(): Vector3 {
    const src = this.parts.head ?? this.group;
    src.getWorldPosition(this.anchor);
    this.anchor.y += 1.1;
    return this.anchor;
  }

  /** Il gruppo radice, per bounding box e raycast del chiamante. */
  getRoot(): Group {
    return this.group;
  }

  dispose(): void {
    if (this.scene) {
      this.scene.remove(this.group);
      this.scene = null;
    }
    this.kit.dispose();
  }
}
