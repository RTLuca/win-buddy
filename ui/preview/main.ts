/**
 * Banco di prova delle creature: una pagina di sviluppo, fuori dal bundle.
 *
 * Serve a rispondere a due domande — «come viene fuori questa creatura nei sei
 * stati?» e «come si muove?» — senza far girare il core, senza tray e senza
 * overlay. Luci, camera e pedana sono copiate da `scene.ts`: quello che si
 * vede qui è quello che l'overlay mostrerà, più gli attrezzi (orbita,
 * scheletro, sfondi, provini) che nell'app non ci sono.
 *
 * `npx vite` → http://localhost:5183/preview/
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
  SkeletonHelper,
  Vector3,
  WebGLRenderer,
  type Group,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CREATURE_META, type Buddy, type BuddyState } from "../shared/contracts";
import { createBuddy } from "../overlay/creatures/registry";

/**
 * Quello che una creatura con scheletro sa fare in più. Il banco lo usa se
 * c'è e lo ignora se non c'è: le sei procedurali non hanno né gesti né ossa.
 */
interface Skinned {
  getRoot?: () => Group;
  getBox?: (t: Box3) => Box3 | null;
  listGestures?: () => { id: string; label: string; dur: number; peak?: number }[];
  play?: (id: string) => boolean;
  currentGesture?: () => string | null;
}

type Extra = (Buddy & Skinned) | null;

const STATES: BuddyState[] = ["idle", "focus", "break", "alert", "celebrate", "sleep"];

const GROUNDS: Record<string, string> = {
  notte: "radial-gradient(120% 90% at 50% 0%, #2a1f4a 0%, #150f2b 60%, #0c0819 100%)",
  scrivania: "linear-gradient(160deg, #4a6fa5 0%, #2f4a72 45%, #1d2f4a 100%)",
  chiaro: "linear-gradient(160deg, #e4e0eb 0%, #cfc8dd 100%)",
  scacchiera: "repeating-conic-gradient(#3a3350 0% 25%, #2a2440 0% 50%) 50% / 28px 28px",
};

const VIEWS: Record<string, { pos: [number, number, number]; target: [number, number, number] }> = {
  overlay: { pos: [0, 0.2, 6.6], target: [0, 0, 0] },
  front: { pos: [0, 0, 5.2], target: [0, 0, 0] },
  side: { pos: [6.2, 0.5, 2.4], target: [0, 0, 0] },
};

const stage = document.getElementById("stage")!;
const stat = document.getElementById("stat")!;

// ------------------------------------------------------------------ scena

const renderer = new WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
stage.appendChild(renderer.domElement);

const scene = new Scene();
const camera = new PerspectiveCamera(36, 1, 0.1, 60);

// le stesse tre luci dell'overlay: chiave calda, controluce freddo, ambiente
const key = new DirectionalLight(0xffffff, 1.0);
key.position.set(2, 3.5, 3);
scene.add(key);
const rim = new DirectionalLight(0x9bd4f5, 0.5);
rim.position.set(-2.5, 1, -2);
scene.add(rim);
scene.add(new AmbientLight(0xffffff, 0.6));

const pad = new Mesh(
  new CircleGeometry(1.45, 48),
  new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.18 }),
);
pad.rotation.x = -Math.PI / 2;
pad.position.y = -1.7;
scene.add(pad);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

function applyView(name: string): void {
  const v = VIEWS[name] ?? VIEWS.overlay;
  camera.position.set(...v.pos);
  controls.target.set(...v.target);
  controls.update();
}
applyView("overlay");

// --------------------------------------------------------------- creatura

let buddy: Buddy | null = null;
let helper: SkeletonHelper | null = null;
let state: BuddyState = "idle";
let current = "";

function mount(id: string): void {
  buddy?.dispose();
  dropHelper();
  buddy = createBuddy(id);
  buddy.mount(scene);
  buddy.setState(state);
  current = id;
  // il GLB arriva dopo: scheletro e gesti si agganciano quando c'è
  window.setTimeout(refreshRig, 400);
  window.setTimeout(refreshRig, 2200);
}

function refreshRig(): void {
  refreshHelper();
  refreshGestures();
}

function dropHelper(): void {
  if (!helper) return;
  scene.remove(helper);
  helper.dispose();
  helper = null;
}

function refreshHelper(): void {
  const want = (document.getElementById("skel") as HTMLInputElement).checked;
  dropHelper();
  const root = (buddy as Extra)?.getRoot?.();
  if (!want || !root) return;
  helper = new SkeletonHelper(root);
  scene.add(helper);
}

/**
 * Un pulsante per gesto. Aspettare che vengano in mente alla creatura è
 * esattamente il punto, ma non aiuta a tararli.
 */
function refreshGestures(): void {
  const list = (buddy as Extra)?.listGestures?.() ?? [];
  gestures.replaceChildren();
  for (const g of list) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = g.label;
    b.title = `${g.id} · ${g.dur}s`;
    b.addEventListener("click", () => void (buddy as Extra)?.play?.(g.id));
    gestures.appendChild(b);
  }
  if (list.length === 0) {
    const none = document.createElement("span");
    none.className = "hint";
    none.textContent = "questa creatura non ne ha";
    gestures.appendChild(none);
  }
}

// ---------------------------------------------------------------- comandi

function chips(
  host: HTMLElement,
  items: string[],
  label: (s: string) => string,
  pick: (s: string) => void,
): void {
  host.replaceChildren();
  for (const it of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.key = it;
    b.textContent = label(it);
    b.addEventListener("click", () => {
      for (const other of host.children) other.classList.remove("on");
      b.classList.add("on");
      pick(it);
    });
    host.appendChild(b);
  }
}

function select(host: HTMLElement, k: string): void {
  for (const b of host.children) b.classList.toggle("on", (b as HTMLElement).dataset.key === k);
}

const creatures = document.getElementById("creatures")!;
chips(
  creatures,
  CREATURE_META.map((m) => m.id),
  (id) => CREATURE_META.find((m) => m.id === id)!.name,
  (id) => mount(id),
);

const states = document.getElementById("states")!;
chips(states, STATES, (s) => s, (s) => {
  state = s as BuddyState;
  buddy?.setState(state);
});

const gestures = document.getElementById("gestures")!;

const grounds = document.getElementById("grounds")!;
chips(grounds, Object.keys(GROUNDS), (g) => g, (g) => {
  stage.style.background = GROUNDS[g];
});

for (const b of document.querySelectorAll<HTMLButtonElement>("[data-view]")) {
  b.addEventListener("click", () => applyView(b.dataset.view!));
}
document.getElementById("skel")!.addEventListener("change", refreshHelper);

// stato iniziale: Roberto, perché è quello che si sta collaudando
const boot = location.hash.replace("#", "") || "roberto";
stage.style.background = GROUNDS.notte;
select(grounds, "notte");
select(states, "idle");
select(creatures, boot);
mount(boot);

const spin = document.getElementById("spin") as HTMLInputElement;

// ------------------------------------------------------------------ loop

const clock = new Clock();
let elapsed = 0;
let frames = 0;
let fpsAt = performance.now();
let fps = 0;
const box = new Box3();
const size = new Vector3();

/** Il riquadro in basso a sinistra: cosa si sta guardando e quanto costa. */
function refreshStat(): void {
  // stessa logica dell'hit-test di `scene.ts`: la sagoma vera se c'è
  const b = buddy as Extra;
  const root = b?.getRoot?.();
  if (root) {
    if (!b?.getBox?.(box)) box.setFromObject(root);
    box.getSize(size);
  }
  const info = renderer.info;
  const ges = b?.currentGesture?.() ?? "";
  stat.textContent =
    `${current} · ${state}${ges ? " · " + ges : ""}\n` +
    `${fps} fps · ${info.render.triangles} tri\n` +
    `sagoma ${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)}\n` +
    `geom ${info.memory.geometries} · tex ${info.memory.textures}`;
}

function resize(): void {
  const r = stage.getBoundingClientRect();
  if (!r.width || !r.height) return;
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / r.height;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);

// il riquadro con le proporzioni della finestra vera: 330x360 logici
const winbox = document.getElementById("winbox") as HTMLInputElement;
winbox.addEventListener("change", () => {
  stage.classList.toggle("window", winbox.checked);
  resize();
});
resize();

/**
 * Attrezzi da console. Servono a guidare il banco da fuori — uno script, un
 * agente che fa screenshot — senza dipendere da `requestAnimationFrame`, che
 * il browser strozza quando la scheda non è in primo piano: `step()` avanza
 * l'animazione di quanto gli si dice e disegna un fotogramma, sempre.
 */
declare global {
  interface Window {
    preview: {
      mount(id: string): void;
      setState(s: BuddyState): void;
      step(seconds: number): void;
      settle(): void;
      info(): string;
      gesture(id: string): boolean;
      sheet(): string;
      moves(): string;
      strip(id: string, n?: number, secs?: number): string;
    };
  }
}

window.preview = {
  mount(id) {
    select(creatures, id);
    mount(id);
  },
  setState(s) {
    select(states, s);
    state = s;
    buddy?.setState(s);
  },
  step(seconds) {
    const dt = 1 / 60;
    for (let i = 0; i < Math.round(seconds / dt); i++) {
      elapsed += dt;
      buddy?.update(elapsed, dt);
    }
    controls.update();
    renderer.render(scene, camera);
    refreshStat();
  },
  /** Porta la posa a regime: lo smorzamento ha una mezza vita di 0,18 s. */
  settle() {
    window.preview.step(1.6);
  },
  info: () => stat.textContent ?? "",
  gesture: (id) => (buddy as Extra)?.play?.(id) ?? false,
  sheet: () => contact(STATES.map((s) => ({ label: s, at: () => window.preview.setState(s) }))),
  /**
   * Il flipbook di un gesto: n fotogrammi consecutivi affiancati. Un provino
   * mostra le pose, questo mostra il movimento — che in un'immagine ferma
   * altrimenti non si vede.
   */
  strip: (id, n = 6, secs) => {
    const list = (buddy as Extra)?.listGestures?.() ?? [];
    const g = list.find((x) => x.id === id);
    // senza un gesto riconosciuto si ritrae il solo moto continuo, che e'
    // il caso piu' interessante: e' quello che si vede il 99% del tempo
    const span = secs ?? g?.dur ?? 6;
    if (id && !g && secs === undefined) return "gesto sconosciuto: " + id;
    const cells: Cell[] = [];
    for (let i = 0; i < n; i++) {
      cells.push({
        label: `${((i * span) / n).toFixed(1)}s`,
        at: i === 0 && g ? () => void (buddy as Extra)?.play?.(id) : () => {},
        hold: span / n,
      });
    }
    return contact(cells);
  },
  moves: () => {
    const list = (buddy as Extra)?.listGestures?.() ?? [];
    return contact(
      list.map((g) => ({
        label: g.label,
        at: () => (buddy as Extra)?.play?.(g.id),
        // ogni gesto viene colto nel suo fotogramma piu' rappresentativo
        hold: g.dur * (g.peak ?? 0.5),
      })),
    );
  },
};

interface Cell {
  label: string;
  at: () => void;
  hold?: number;
}

/**
 * Il provino: più fotogrammi affiancati in un'immagine sola, ciascuno nel
 * riquadro della finestra vera. È il modo più rapido di accorgersi che due
 * pose si somigliano troppo — cosa che a guardarle una per volta sfugge.
 */
function contact(cells: Cell[]): string {
  const wasWindow = stage.classList.contains("window");
  const wasState = state;
  stage.classList.add("window");
  resize();

  const cw = 330;
  const ch = 360;
  const cols = Math.min(3, cells.length);
  const pad = 22;
  const rows = Math.ceil(cells.length / cols);
  const sheetEl = document.createElement("canvas");
  sheetEl.width = cols * cw;
  sheetEl.height = rows * (ch + pad);
  const g = sheetEl.getContext("2d")!;
  g.fillStyle = "#150f2b";
  g.fillRect(0, 0, sheetEl.width, sheetEl.height);

  cells.forEach((cell, i) => {
    cell.at();
    window.preview.step(cell.hold ?? 1.8);
    const x = (i % cols) * cw;
    const y = Math.floor(i / cols) * (ch + pad);
    g.drawImage(renderer.domElement, x, y, cw, ch);
    g.fillStyle = "#7a7196";
    g.font = "12px ui-monospace, monospace";
    g.fillText(cell.label, x + 10, y + ch + 15);
    g.strokeStyle = "rgba(255,255,255,.08)";
    g.strokeRect(x + 0.5, y + 0.5, cw - 1, ch - 1);
  });

  window.preview.setState(wasState);
  if (!wasWindow) {
    stage.classList.remove("window");
    resize();
  }

  sheetEl.id = "sheet";
  sheetEl.style.cssText =
    "position:fixed;inset:0;margin:auto;max-width:calc(100vw - 280px);max-height:96vh;" +
    "z-index:9;box-shadow:0 20px 60px rgba(0,0,0,.6)";
  document.getElementById("sheet")?.remove();
  sheetEl.addEventListener("click", () => sheetEl.remove());
  document.body.appendChild(sheetEl);
  return "provino pronto (clic per chiuderlo)";
}

function tick(): void {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05);
  elapsed += dt;

  if (spin.checked) {
    const r = camera.position.length();
    const a = elapsed * 0.4;
    camera.position.set(Math.sin(a) * r, camera.position.y, Math.cos(a) * r);
  }
  controls.update();

  buddy?.update(elapsed, dt);
  renderer.render(scene, camera);

  frames++;
  const now = performance.now();
  if (now - fpsAt > 500) {
    fps = Math.round((frames * 1000) / (now - fpsAt));
    frames = 0;
    fpsAt = now;
    refreshStat();
  }
}
tick();
