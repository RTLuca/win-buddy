/**
 * La scena three.js dell'overlay: una creatura, due luci, una pedana d'ombra.
 *
 * Budget (§ 3): niente requestAnimationFrame a 60 fps a vuoto. Il loop gira
 * con un tetto a 30 fps (10 in stato sleep), si ferma del tutto quando la
 * pagina è nascosta od occlusa, e la creatura si congela — non recupera.
 */

import {
  AmbientLight,
  Box3,
  CircleGeometry,
  Clock,
  DirectionalLight,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";
import type { Buddy, BuddyState } from "../shared/contracts";
import { createBuddy } from "./creatures/registry";
import type { ProceduralBuddy } from "./creatures/base";

export interface ScreenRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class OverlayScene {
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera: PerspectiveCamera;
  private buddy: Buddy | null = null;
  private state: BuddyState = "idle";
  private clock = new Clock();
  private elapsed = 0;
  private raf = 0;
  private lastFrame = 0;
  private running = false;
  private host: HTMLElement;
  private box = new Box3();
  private corner = new Vector3();

  /** Chiamato a ogni frame con l'ancora della nuvoletta in pixel. */
  onFrame: ((anchor: { x: number; y: number }, creature: ScreenRect | null) => void) | null = null;

  constructor(host: HTMLElement) {
    this.host = host;
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(this.renderer.domElement);

    this.camera = new PerspectiveCamera(36, 1, 0.1, 60);
    this.camera.position.set(0, 0.2, 6.6);

    const key = new DirectionalLight(0xffffff, 1.0);
    key.position.set(2, 3.5, 3);
    this.scene.add(key);
    const rim = new DirectionalLight(0x9bd4f5, 0.5);
    rim.position.set(-2.5, 1, -2);
    this.scene.add(rim);
    this.scene.add(new AmbientLight(0xffffff, 0.6));

    // pedana appena accennata
    const pad = new Mesh(
      new CircleGeometry(1.45, 48),
      new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.18 }),
    );
    pad.rotation.x = -Math.PI / 2;
    pad.position.y = -1.7;
    this.scene.add(pad);

    window.addEventListener("resize", () => this.resize());
    document.addEventListener("visibilitychange", () => {
      // pausa su occlusione (§ 3.3): rendering completamente fermo
      if (document.hidden) this.stop();
      else this.start();
    });
    this.resize();
  }

  mountBuddy(id: string): void {
    if (this.buddy) {
      this.buddy.dispose(); // § 9.4: senza dispose ogni cambio lascia buffer sulla GPU
      this.buddy = null;
    }
    this.buddy = createBuddy(id);
    this.buddy.mount(this.scene);
    this.buddy.setState(this.state);
    this.start();
  }

  setState(state: BuddyState): void {
    this.state = state;
    this.buddy?.setState(state);
    this.start();
  }

  setVisible(visible: boolean): void {
    this.host.style.display = visible ? "" : "none";
    if (visible) this.start();
    else this.stop();
  }

  start(): void {
    if (this.running || document.hidden) return;
    this.running = true;
    this.clock.getDelta(); // azzera il delta: al risveglio non si recupera
    this.tick();
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private tick = (): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.tick);

    // tetto ai fps: 30 di norma, 10 quando dorme
    const cap = this.state === "sleep" ? 10 : 30;
    const now = performance.now();
    if (now - this.lastFrame < 1000 / cap) return;
    this.lastFrame = now;

    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.elapsed += dt;
    if (this.buddy) {
      this.buddy.update(this.elapsed, dt);
      this.renderer.render(this.scene, this.camera);
      this.onFrame?.(this.projectAnchor(), this.creatureRect());
    }
  };

  /** L'ancora della nuvoletta, proiettata in pixel finestra. */
  private projectAnchor(): { x: number; y: number } {
    const rect = this.host.getBoundingClientRect();
    if (!this.buddy) return { x: rect.width / 2, y: 0 };
    const v = this.buddy.getAnchor().clone().project(this.camera);
    return {
      x: rect.left + (v.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-v.y * 0.5 + 0.5) * rect.height,
    };
  }

  /**
   * Il rettangolo occupato dalla sagoma in pixel finestra, per l'hit-test
   * del click-through (§ 10.2): più è stretto, meno l'overlay ruba clic.
   */
  private creatureRect(): ScreenRect | null {
    const buddy = this.buddy as
      | (ProceduralBuddy & { getBox?: (t: Box3) => Box3 | null })
      | null;
    const root = buddy?.getRoot?.();
    if (!root) return null;
    // Le creature skinnate sanno dare la sagoma vera: per loro la bounding
    // box della geometria e' ancora la T-pose e dichiarerebbe un ingombro
    // molto piu' largo del dovuto. Le procedurali non ne hanno bisogno.
    if (!buddy?.getBox?.(this.box)) this.box.setFromObject(root);
    if (this.box.isEmpty()) return null;

    const rect = this.host.getBoundingClientRect();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < 8; i++) {
      this.corner.set(
        i & 1 ? this.box.max.x : this.box.min.x,
        i & 2 ? this.box.max.y : this.box.min.y,
        i & 4 ? this.box.max.z : this.box.min.z,
      );
      this.corner.project(this.camera);
      const sx = rect.left + (this.corner.x * 0.5 + 0.5) * rect.width;
      const sy = rect.top + (-this.corner.y * 0.5 + 0.5) * rect.height;
      minX = Math.min(minX, sx);
      minY = Math.min(minY, sy);
      maxX = Math.max(maxX, sx);
      maxY = Math.max(maxY, sy);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  private resize(): void {
    const r = this.host.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.renderer.setSize(r.width, r.height, false);
    this.camera.aspect = r.width / r.height;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.stop();
    this.buddy?.dispose();
    this.renderer.dispose();
  }
}
