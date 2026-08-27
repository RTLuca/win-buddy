/**
 * Il bestiario (§ 9). Sei creature procedurali — tutte fluttuano, nessuna ha
 * le gambe: niente walk cycle, niente contatto col terreno — più gli ospiti
 * importati, che le gambe ce l'hanno e stanno in piedi sulla pedana.
 *
 * Questo registro è l'unico punto che cambia quando se ne aggiunge una:
 * nessuno switch sparso nel resto dell'applicazione. Le due famiglie stanno
 * dietro allo stesso contratto a quattro metodi, quindi `scene.ts` non sa
 * nemmeno quale delle due sta montando.
 */

import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  Mesh,
  OctahedronGeometry,
  PlaneGeometry,
  SphereGeometry,
  TetrahedronGeometry,
  TorusGeometry,
} from "three";
import { CREATURE_META, type Buddy, type BuddyMeta } from "../../shared/contracts";
import { ProceduralBuddy, type Builder, type Parts } from "./base";
import { INK, type Palette } from "./helpers";
import { ROBERTO } from "./roberto";
import { SkinnedBuddy, type SkinnedSpec } from "./skinned";

interface Entry {
  palette: Palette;
  build: Builder;
}

// ------------------------------------------------------------------ Lume

const buildLume: Builder = (c, kit) => {
  const g = new Group();
  const p: Parts = {};

  p.body = kit.part(new SphereGeometry(0.95, 32, 24), kit.toon(c.body), 0, -0.1, 0);
  p.body.scale.set(1, 1.18, 1);
  g.add(p.body);

  const hood = kit.part(new ConeGeometry(1.02, 1.25, 26), kit.toon(0x6455c0), 0, 0.72, 0);
  g.add(hood);

  p.head = new Group();
  p.head.position.set(0, 0.42, 0);
  g.add(p.head);

  p.eyeL = kit.eyeball(0.2);
  p.eyeL.position.set(-0.3, 0, 0.82);
  p.head.add(p.eyeL);
  p.eyeR = kit.eyeball(0.2);
  p.eyeR.position.set(0.3, 0, 0.82);
  p.head.add(p.eyeR);

  p.handL = kit.part(new SphereGeometry(0.24, 18, 14), kit.toon(0x6455c0), -1.18, -0.35, 0.3);
  p.handR = kit.part(new SphereGeometry(0.24, 18, 14), kit.toon(0x6455c0), 1.18, -0.35, 0.3);
  g.add(p.handL, p.handR);

  p.orbit = new Group();
  g.add(p.orbit);
  p.flame = new Mesh(kit.geo(new OctahedronGeometry(0.2, 0)), kit.flat(c.glow));
  p.flame.position.set(1.5, 0.5, 0);
  p.flame.scale.y = 1.6;
  p.orbit.add(p.flame);

  return { group: g, parts: p };
};

// ---------------------------------------------------------------- Cotone

const buildCotone: Builder = (c, kit) => {
  const g = new Group();
  const p: Parts = {};

  p.body = kit.part(new SphereGeometry(1.05, 32, 24), kit.toon(c.body), 0, -0.15, 0);
  p.body.scale.set(1.05, 0.95, 1);
  g.add(p.body);

  p.head = new Group();
  p.head.position.set(0, 0.62, 0.16);
  g.add(p.head);

  const snout = kit.part(new SphereGeometry(0.42, 20, 16), kit.toon(c.body), 0, -0.12, 0.72);
  snout.scale.set(1, 0.78, 1.05);
  p.head.add(snout);

  p.eyeL = kit.eyeball(0.19);
  p.eyeL.position.set(-0.32, 0.16, 0.6);
  p.head.add(p.eyeL);
  p.eyeR = kit.eyeball(0.19);
  p.eyeR.position.set(0.32, 0.16, 0.6);
  p.head.add(p.eyeR);

  const hornL = kit.part(new ConeGeometry(0.11, 0.4, 12), kit.toon(c.accent), -0.34, 0.62, -0.06);
  hornL.rotation.z = 0.32;
  const hornR = kit.part(new ConeGeometry(0.11, 0.4, 12), kit.toon(c.accent), 0.34, 0.62, -0.06);
  hornR.rotation.z = -0.32;
  p.head.add(hornL, hornR);

  p.wingL = kit.part(new ConeGeometry(0.5, 0.95, 4), kit.toon(c.accent), -1.0, 0.2, -0.25);
  p.wingL.rotation.set(0, 0, 1.5);
  p.wingL.scale.set(1, 1, 0.35);
  p.wingR = kit.part(new ConeGeometry(0.5, 0.95, 4), kit.toon(c.accent), 1.0, 0.2, -0.25);
  p.wingR.rotation.set(0, 0, -1.5);
  p.wingR.scale.set(1, 1, 0.35);
  g.add(p.wingL, p.wingR);

  p.tail = [];
  const sizes = [0.3, 0.24, 0.18, 0.12];
  sizes.forEach((s, i) => {
    const seg = kit.part(new SphereGeometry(s, 16, 12), kit.toon(c.body), 0, 0, -(0.85 + i * 0.34));
    g.add(seg);
    p.tail!.push(seg);
  });

  // organo di stato: un alone sotto la pancia, invisibile ma leggibile
  p.halo = new Mesh(kit.geo(new TorusGeometry(0.78, 0.045, 8, 30)), kit.flat(c.glow));
  p.halo.rotation.x = Math.PI / 2;
  p.halo.position.y = -1.28;
  g.add(p.halo);

  return { group: g, parts: p };
};

// ---------------------------------------------------------------- Bolete

const buildBolete: Builder = (c, kit) => {
  const g = new Group();
  const p: Parts = {};

  p.body = kit.part(new CylinderGeometry(0.52, 0.72, 1.3, 22), kit.toon(c.body), 0, -0.55, 0);
  g.add(p.body);

  p.cap = new Group();
  p.cap.position.set(0, 0.24, 0);
  g.add(p.cap);

  const dome = kit.part(
    new SphereGeometry(1.15, 30, 18, 0, Math.PI * 2, 0, Math.PI / 2),
    kit.toon(c.accent),
  );
  dome.scale.set(1, 0.66, 1);
  p.cap.add(dome);

  const dots: [number, number, number][] = [
    [0.5, 0.42, 0.5],
    [-0.62, 0.36, 0.36],
    [0.05, 0.62, -0.62],
    [-0.2, 0.5, 0.78],
  ];
  for (const [x, y, z] of dots) {
    const d = new Mesh(kit.geo(new SphereGeometry(0.15, 14, 10)), kit.flat(0xf6f2ff));
    d.position.set(x, y, z);
    d.scale.y = 0.5;
    p.cap.add(d);
  }

  p.head = new Group();
  p.head.position.set(0, -0.42, 0);
  g.add(p.head);
  p.eyeL = kit.eyeball(0.16);
  p.eyeL.position.set(-0.24, 0, 0.52);
  p.head.add(p.eyeL);
  p.eyeR = kit.eyeball(0.16);
  p.eyeR.position.set(0.24, 0, 0.52);
  p.head.add(p.eyeR);

  p.handL = kit.part(new SphereGeometry(0.19, 16, 12), kit.toon(c.body), -0.92, -0.6, 0.2);
  p.handR = kit.part(new SphereGeometry(0.19, 16, 12), kit.toon(c.body), 0.92, -0.6, 0.2);
  g.add(p.handL, p.handR);

  // anello di stato alla base del gambo: il suo organo semantico
  p.halo = new Mesh(kit.geo(new TorusGeometry(0.8, 0.04, 8, 30)), kit.flat(c.glow));
  p.halo.rotation.x = Math.PI / 2;
  p.halo.position.y = -1.45;
  g.add(p.halo);

  return { group: g, parts: p };
};

// ---------------------------------------------------------------- Quarzo

const buildQuarzo: Builder = (c, kit) => {
  const g = new Group();
  const p: Parts = {};

  p.body = kit.part(new OctahedronGeometry(1.05, 0), kit.toon(c.body), 0, -0.05, 0);
  p.body.scale.set(0.92, 1.25, 0.92);
  g.add(p.body);

  p.head = new Group();
  p.head.position.set(0, 0.18, 0);
  g.add(p.head);
  p.eyeL = kit.eyeball(0.28);
  p.eyeL.position.set(0, 0, 0.66);
  p.head.add(p.eyeL);
  p.eyeR = null;

  p.orbit = new Group();
  g.add(p.orbit);
  p.shards = [];
  for (let i = 0; i < 4; i++) {
    const s = kit.part(new TetrahedronGeometry(0.26, 0), kit.flat(c.accent));
    const a = (i / 4) * Math.PI * 2;
    s.position.set(Math.cos(a) * 1.5, Math.sin(a * 1.6) * 0.5, Math.sin(a) * 1.5);
    p.orbit.add(s);
    p.shards.push(s);
  }

  p.ring = new Mesh(kit.geo(new TorusGeometry(1.45, 0.035, 8, 40)), kit.flat(c.glow));
  p.ring.rotation.x = Math.PI / 2.2;
  g.add(p.ring);

  return { group: g, parts: p };
};

// ----------------------------------------------------------------- Brace

const buildBrace: Builder = (c, kit) => {
  const g = new Group();
  const p: Parts = {};

  // corpo faccettato: icosaedro a bassa suddivisione, allungato
  p.body = kit.part(new IcosahedronGeometry(0.92, 1), kit.facet(c.body), 0, -0.15, 0);
  p.body.scale.set(0.92, 1.0, 1.15);
  g.add(p.body);

  p.head = new Group();
  p.head.position.set(0, 0.68, 0.32);
  g.add(p.head);

  const skull = kit.part(new IcosahedronGeometry(0.52, 1), kit.facet(c.body));
  skull.scale.set(1, 0.88, 1.05);
  p.head.add(skull);

  const muzzle = kit.part(new ConeGeometry(0.3, 0.66, 6), kit.facet(c.body), 0, -0.08, 0.52);
  muzzle.rotation.x = Math.PI / 2;
  p.head.add(muzzle);

  p.eyeL = kit.eyeball(0.15);
  p.eyeL.position.set(-0.28, 0.14, 0.34);
  p.head.add(p.eyeL);
  p.eyeR = kit.eyeball(0.15);
  p.eyeR.position.set(0.28, 0.14, 0.34);
  p.head.add(p.eyeR);

  const hornL = kit.part(new ConeGeometry(0.09, 0.46, 4), kit.facet(c.accent), -0.26, 0.5, -0.18);
  hornL.rotation.set(-0.5, 0, 0.3);
  const hornR = kit.part(new ConeGeometry(0.09, 0.46, 4), kit.facet(c.accent), 0.26, 0.5, -0.18);
  hornR.rotation.set(-0.5, 0, -0.3);
  p.head.add(hornL, hornR);

  // la fiammella esiste sempre, ma resta a scala zero finché non serve
  p.fire = new Mesh(kit.geo(new ConeGeometry(0.18, 0.5, 5)), kit.flat(c.glow));
  p.fire.position.set(0, -0.06, 1.05);
  p.fire.rotation.x = Math.PI / 2;
  p.fire.scale.setScalar(0.001);
  p.head.add(p.fire);

  // cresta dorsale: si anima a onda come la coda
  p.crest = [];
  const cs = [0.26, 0.22, 0.17, 0.12];
  cs.forEach((s, i) => {
    const spine = kit.part(
      new ConeGeometry(s, s * 2.2, 4),
      kit.facet(c.accent),
      0,
      0.72 - i * 0.16,
      -0.15 - i * 0.42,
    );
    spine.rotation.x = -0.35;
    g.add(spine);
    p.crest!.push(spine);
  });

  // ali membranose: triangoli piatti, nessuna geometria di spessore
  p.wingL = kit.part(new ConeGeometry(0.62, 1.15, 3), kit.facet(c.accent), -1.02, 0.34, -0.2);
  p.wingL.rotation.set(0.2, 0, 1.75);
  p.wingL.scale.set(1, 1, 0.08);
  p.wingR = kit.part(new ConeGeometry(0.62, 1.15, 3), kit.facet(c.accent), 1.02, 0.34, -0.2);
  p.wingR.rotation.set(0.2, 0, -1.75);
  p.wingR.scale.set(1, 1, 0.08);
  g.add(p.wingL, p.wingR);

  p.tail = [];
  const ts = [0.26, 0.2, 0.14];
  ts.forEach((s, j) => {
    const seg = kit.part(new IcosahedronGeometry(s, 0), kit.facet(c.body), 0, -0.4, -(1.0 + j * 0.34));
    g.add(seg);
    p.tail!.push(seg);
  });
  p.tailTip = kit.part(new ConeGeometry(0.22, 0.42, 4), kit.facet(c.accent), 0, -0.4, -2.05);
  p.tailTip.rotation.x = -Math.PI / 2;
  g.add(p.tailTip);

  return { group: g, parts: p };
};

// ---------------------------------------------------------------- Ottone

const buildOttone: Builder = (c, kit) => {
  const g = new Group();
  const p: Parts = {};

  p.body = kit.part(new CylinderGeometry(0.66, 0.78, 1.15, 16), kit.toon(c.body), 0, -0.55, 0);
  g.add(p.body);
  const belly = kit.part(
    new SphereGeometry(0.72, 20, 14, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
    kit.toon(c.body),
    0,
    -1.1,
    0,
  );
  g.add(belly);

  p.head = new Group();
  p.head.position.set(0, 0.36, 0);
  g.add(p.head);

  const skull = kit.part(new BoxGeometry(1.28, 1.02, 1.05), kit.toon(c.body));
  p.head.add(skull);

  // il visore è il suo organo di stato: cambia colore, non forma
  const panel = kit.part(new BoxGeometry(1.06, 0.6, 0.1), kit.toon(0x2a2340), 0, 0.02, 0.53);
  p.head.add(panel);

  p.visor = new Mesh(kit.geo(new PlaneGeometry(0.92, 0.46)), kit.flat(0xbfb3e8));
  p.visor.position.set(0, 0.02, 0.6);
  p.head.add(p.visor);

  // «occhi» disegnati sul visore: due tacche scure che possono chiudersi
  p.eyeL = new Mesh(kit.geo(new PlaneGeometry(0.2, 0.26)), kit.flat(INK));
  p.eyeL.position.set(-0.22, 0.02, 0.615);
  p.head.add(p.eyeL);
  p.eyeR = new Mesh(kit.geo(new PlaneGeometry(0.2, 0.26)), kit.flat(INK));
  p.eyeR.position.set(0.22, 0.02, 0.615);
  p.head.add(p.eyeR);

  const stalk = kit.part(new CylinderGeometry(0.045, 0.045, 0.42, 8), kit.toon(c.accent), 0, 0.72, 0);
  p.head.add(stalk);
  p.antenna = new Mesh(kit.geo(new SphereGeometry(0.13, 14, 10)), kit.flat(c.glow));
  p.antenna.position.set(0, 0.98, 0);
  p.head.add(p.antenna);

  p.handL = kit.part(new BoxGeometry(0.3, 0.3, 0.3), kit.toon(c.accent), -1.0, -0.5, 0.12);
  p.handR = kit.part(new BoxGeometry(0.3, 0.3, 0.3), kit.toon(c.accent), 1.0, -0.5, 0.12);
  g.add(p.handL, p.handR);

  // niente gambe: un anello di propulsione che gira sotto
  p.ring = new Mesh(kit.geo(new TorusGeometry(0.62, 0.05, 8, 32)), kit.flat(c.glow));
  p.ring.rotation.x = Math.PI / 2;
  p.ring.position.y = -1.5;
  g.add(p.ring);

  return { group: g, parts: p };
};

// --------------------------------------------------------------- registro

const BUILDERS: Record<string, Entry> = {
  lume: { palette: { body: 0x7b6bd6, accent: 0xffd98a, glow: 0xf2b441 }, build: buildLume },
  cotone: { palette: { body: 0xe8ecf5, accent: 0x7fb8e8, glow: 0x9bd4f5 }, build: buildCotone },
  bolete: { palette: { body: 0xe0d6c4, accent: 0xc4543f, glow: 0x57a98b }, build: buildBolete },
  quarzo: { palette: { body: 0x5fc8c0, accent: 0xb8f0eb, glow: 0x57a98b }, build: buildQuarzo },
  brace: { palette: { body: 0xd9603f, accent: 0xf2b441, glow: 0xf2b441 }, build: buildBrace },
  ottone: { palette: { body: 0xc9a227, accent: 0x8c6d1f, glow: 0x9bd4f5 }, build: buildOttone },
};

/** Gli ospiti importati: un GLB scolpito fuori e animato per pose (§ 9.2). */
const SKINNED: Record<string, SkinnedSpec> = {
  roberto: ROBERTO,
};

export function listBuddies(): BuddyMeta[] {
  return CREATURE_META;
}

export function hasBuddy(id: string): boolean {
  return id in BUILDERS || id in SKINNED;
}

export function createBuddy(id: string): Buddy {
  const safe = hasBuddy(id) ? id : "cotone";
  const meta = CREATURE_META.find((m) => m.id === safe)!;
  const skin = SKINNED[safe];
  if (skin) return new SkinnedBuddy(meta, skin);
  const entry = BUILDERS[safe];
  return new ProceduralBuddy(meta, entry.palette, entry.build);
}
