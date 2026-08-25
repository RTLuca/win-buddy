/**
 * Attrezzi comuni ai costruttori: toon a tre fasce, contorno, occhi.
 *
 * Ogni risorsa creata passa dal Kit, che la registra: `dispose()` rilascia
 * tutto in un colpo. Su un'app accesa dodici ore, saltare questo passaggio
 * si nota (§ 9.4).
 */

import {
  BackSide,
  DataTexture,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshToonMaterial,
  NearestFilter,
  RGBAFormat,
  SphereGeometry,
  type BufferGeometry,
  type Material,
} from "three";

export const INK = 0x1a1330;

export interface Palette {
  body: number;
  accent: number;
  glow: number;
}

/** Registra geometrie, materiali e texture per il rilascio finale. */
export class Kit {
  private geometries = new Set<BufferGeometry>();
  private materials = new Set<Material>();
  private ramp: DataTexture;

  constructor() {
    const data = new Uint8Array([70, 70, 70, 255, 170, 170, 170, 255, 255, 255, 255, 255]);
    this.ramp = new DataTexture(data, 3, 1, RGBAFormat);
    this.ramp.minFilter = NearestFilter;
    this.ramp.magFilter = NearestFilter;
    this.ramp.generateMipmaps = false;
    this.ramp.needsUpdate = true;
  }

  geo<G extends BufferGeometry>(g: G): G {
    this.geometries.add(g);
    return g;
  }

  private mat<M extends Material>(m: M): M {
    this.materials.add(m);
    return m;
  }

  toon(color: number): MeshToonMaterial {
    return this.mat(new MeshToonMaterial({ color, gradientMap: this.ramp }));
  }

  /** Toon sfaccettato per Brace: le facce piatte prendono la luce a blocchi. */
  facet(color: number): MeshToonMaterial {
    const m = new MeshToonMaterial({ color, gradientMap: this.ramp });
    // i tipi non lo dichiarano per MeshToonMaterial, ma il renderer legge
    // material.flatShading in modo generico e attiva FLAT_SHADED nello shader
    (m as unknown as { flatShading: boolean }).flatShading = true;
    return this.mat(m);
  }

  flat(color: number): MeshBasicMaterial {
    return this.mat(new MeshBasicMaterial({ color }));
  }

  outline(mesh: Mesh, thickness = 1.06): Mesh {
    const o = new Mesh(mesh.geometry, this.mat(new MeshBasicMaterial({ color: INK, side: BackSide })));
    o.scale.multiplyScalar(thickness);
    mesh.add(o);
    return mesh;
  }

  part(geo: BufferGeometry, mat: Material, x = 0, y = 0, z = 0, withOutline = true): Mesh {
    const m = new Mesh(this.geo(geo), mat);
    m.position.set(x, y, z);
    if (withOutline) this.outline(m);
    return m;
  }

  eyeball(size: number): Group {
    const g = new Group();
    const white = new Mesh(this.geo(new SphereGeometry(size, 20, 16)), this.flat(0xf6f2ff));
    g.add(white);
    const pupil = new Mesh(this.geo(new SphereGeometry(size * 0.52, 16, 12)), this.flat(INK));
    pupil.position.z = size * 0.62;
    g.add(pupil);
    return g;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.geometries.clear();
    this.materials.clear();
    this.ramp.dispose();
  }
}
