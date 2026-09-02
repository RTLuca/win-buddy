/**
 * Overlay: la superficie effimera con la creatura (§ 5.1).
 *
 * Riceve stati già decisi dal core e li mostra. Se questa finestra viene
 * distrutta a metà di un pomodoro non succede nulla: non conteneva nulla
 * di importante.
 */

import {
  EVT_BUBBLE_DISMISS,
  EVT_BUBBLE_SHOW,
  EVT_BUDDY_CHANGED,
  EVT_MODE_CHANGED,
  EVT_POMODORO_PRESENTATION,
  EVT_STATE_CHANGED,
  STATE_COLOR,
  fmtCountdown,
  type BubbleDismiss,
  type BubbleShow,
  type BuddyChanged,
  type ModeChanged,
  type PomodoroPresentation,
  type StateChanged,
} from "../shared/contracts";
import * as ipc from "../shared/ipc";
import { BubbleLayer, stateLabel } from "./bubbles";
import {
  connectPomodoroPresentationSource,
  createPomodoroPresentationConsumer,
  pomodoroPresentationBubble,
} from "./pomodoro-presentations";
import { normalizeScale } from "./scale";
import { OverlayScene, type ScreenRect } from "./scene";

const stage = document.getElementById("stage")!;
const soberEl = document.getElementById("sober")!;
const soberLed = document.getElementById("soberLed")!;
const soberLbl = document.getElementById("soberLbl")!;
const soberTime = document.getElementById("soberTime")!;
const quickbar = document.getElementById("quickbar")!;
const qbPomo = document.getElementById("qbPomo") as HTMLButtonElement;
const qbMove = document.getElementById("qbMove") as HTMLButtonElement;
const qbScale = document.getElementById("qbScale") as HTMLButtonElement;
const scalePopover = document.getElementById("scalePopover")!;
const quickScale = document.getElementById("quickScale") as HTMLInputElement;
const quickScaleVal = document.getElementById("quickScaleVal") as HTMLOutputElement;

const scene = new OverlayScene(stage);
const bubbles = new BubbleLayer(document.body);
const consumePomodoroPresentation = createPomodoroPresentationConsumer({
  render: (event) => bubbles.show(pomodoroPresentationBubble(event)),
  acknowledge: (id) => ipc.pomodoroPresentationAck(id),
  reportError: (error) => console.error("presentazione Pomodoro non confermata", error),
});

let mode: "full" | "sober" = "full";
let creature = "";
let lastState: StateChanged = { state: "idle" };
let lastSent: ScreenRect = { x: -1, y: -1, w: -1, h: -1 };
let lastSentAt = 0;
let lastCreatureRect: ScreenRect | null = null;

// ------------------------------------------------------------- hit-test

/**
 * Comunica al core il rettangolo davvero occupato (creatura + nuvoletta),
 * non lo spazio vuoto attorno (§ 10.2). Throttle a 100 ms e solo su
 * variazioni percettibili.
 */
function reportHitbox(creature: ScreenRect | null, force = false): void {
  const now = performance.now();
  if (!force && now - lastSentAt < 100) return;

  let rect: ScreenRect | null = null;
  if (mode === "sober") {
    const r = soberEl.getBoundingClientRect();
    rect = { x: r.left, y: r.top, w: r.width, h: r.height };
  } else {
    rect = creature;
    rect = union(rect, bubbles.rect());
  }
  if (quickbar.classList.contains("on")) {
    const q = quickbar.getBoundingClientRect();
    rect = union(rect, { x: q.left, y: q.top, w: q.width, h: q.height });
  }
  if (!scalePopover.hidden && scalePopover.classList.contains("on")) {
    const s = scalePopover.getBoundingClientRect();
    rect = union(rect, { x: s.left, y: s.top, w: s.width, h: s.height });
  }
  if (!rect) return;

  const W = window.innerWidth || 1;
  const H = window.innerHeight || 1;
  const n = {
    x: Math.max(0, rect.x / W),
    y: Math.max(0, rect.y / H),
    w: Math.min(1, rect.w / W),
    h: Math.min(1, rect.h / H),
  };
  const moved =
    Math.abs(n.x - lastSent.x) > 0.005 ||
    Math.abs(n.y - lastSent.y) > 0.005 ||
    Math.abs(n.w - lastSent.w) > 0.005 ||
    Math.abs(n.h - lastSent.h) > 0.005;
  if (!force && !moved) return;

  lastSent = n;
  lastSentAt = now;
  void ipc.hittestUpdate(n.x, n.y, n.w, n.h);
}

function union(a: ScreenRect | null, b: ScreenRect | null): ScreenRect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

scene.onFrame = (anchor, creature) => {
  lastCreatureRect = creature;
  bubbles.place(anchor);
  reportHitbox(creature);
};

// ------------------------------------------------------------ barra rapida

// Compare quando il cursore è sulla creatura (cioè quando la finestra
// accetta i clic) e resta un attimo dopo che se n'è andato.
let qbTimer = 0;
function pokeQuickbar(): void {
  const wasVisible = quickbar.classList.contains("on");
  quickbar.classList.add("on");
  if (!wasVisible) reportHitbox(lastCreatureRect, true);
  window.clearTimeout(qbTimer);
  if (!scalePopover.classList.contains("on")) {
    qbTimer = window.setTimeout(() => {
      if (!quickbar.matches(":hover, :focus-within")) {
        quickbar.classList.remove("on");
        reportHitbox(lastCreatureRect, true);
      }
    }, 1600);
  }
}
document.body.addEventListener("mousemove", pokeQuickbar);
quickbar.addEventListener("focusout", pokeQuickbar);

function closeScalePopover(): void {
  scalePopover.classList.remove("on");
  scalePopover.hidden = true;
  scalePopover.inert = true;
  qbScale.setAttribute("aria-expanded", "false");
  reportHitbox(lastCreatureRect, true);
  pokeQuickbar();
}

qbScale.addEventListener("click", (e) => {
  e.stopPropagation();
  const opening = !scalePopover.classList.contains("on");
  if (!opening) {
    closeScalePopover();
    return;
  }

  window.clearTimeout(qbTimer);
  quickbar.classList.add("on");
  scalePopover.hidden = false;
  scalePopover.inert = false;
  scalePopover.classList.add("on");
  qbScale.setAttribute("aria-expanded", "true");
  reportHitbox(lastCreatureRect, true);
  quickScale.focus({ preventScroll: true });
  void ipc
    .settingsAll()
    .then((settings) => {
      const current = normalizeScale(Number(settings["overlay.scale"] ?? "100"));
      persistedQuickScale = current;
      quickScale.value = String(current);
      quickScaleVal.value = `${current}%`;
    })
    .catch(() => {
      /* resta il valore corrente: il controllo è comunque utilizzabile */
    });
});

let scaleWrite = Promise.resolve();
let persistedQuickScale = normalizeScale(Number(quickScale.value));
let scaleRequest = 0;
function saveQuickScale(value: string): void {
  const next = normalizeScale(Number(value));
  const request = ++scaleRequest;
  scaleWrite = scaleWrite
    .then(async () => {
      try {
        await ipc.settingSet("overlay.scale", String(next));
        persistedQuickScale = next;
        if (request === scaleRequest) quickScaleVal.classList.remove("error");
      } catch {
        let persisted = persistedQuickScale;
        try {
          const settings = await ipc.settingsAll();
          persisted = normalizeScale(Number(settings["overlay.scale"] ?? persisted));
        } catch {
          /* usa l'ultimo valore confermato se anche la rilettura fallisce */
        }
        if (request === scaleRequest) {
          persistedQuickScale = persisted;
          quickScale.value = String(persisted);
          quickScaleVal.value = "Errore";
          quickScaleVal.classList.add("error");
        }
      }
    });
}

function setQuickScale(value: number, commit: boolean): void {
  const next = normalizeScale(value);
  quickScale.value = String(next);
  quickScaleVal.value = `${next}%`;
  quickScaleVal.classList.remove("error");
  if (commit) saveQuickScale(String(next));
}

quickScale.addEventListener("input", () => setQuickScale(Number(quickScale.value), false));
quickScale.addEventListener("change", () => setQuickScale(Number(quickScale.value), true));
document.getElementById("scaleDown")!.addEventListener("click", (e) => {
  e.stopPropagation();
  setQuickScale(Number(quickScale.value) - 10, true);
});
document.getElementById("scaleUp")!.addEventListener("click", (e) => {
  e.stopPropagation();
  setQuickScale(Number(quickScale.value) + 10, true);
});

qbMove.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  closeScalePopover();
  window.clearTimeout(qbTimer);
  void ipc.overlayDragStart();
});

let moveWrite = Promise.resolve();
qbMove.addEventListener("keydown", (e) => {
  const direction: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  const delta = direction[e.key];
  if (!delta) return;
  e.preventDefault();
  e.stopPropagation();
  moveWrite = moveWrite
    .then(() => ipc.overlayPositionNudge(delta[0], delta[1]))
    .catch(() => {
      /* una pressione successiva può riprovare */
    });
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && scalePopover.classList.contains("on")) {
    e.stopPropagation();
    closeScalePopover();
    qbScale.focus();
  }
});

function refreshQuickbarPomo(): void {
  const active = lastState.state === "focus" || lastState.state === "break";
  qbPomo.textContent = active ? "■" : "▶";
  qbPomo.classList.toggle("go", !active);
  qbPomo.classList.toggle("stop", active);
  qbPomo.title = active ? "Interrompi la sessione" : "Avvia un focus";
}

document.getElementById("qbNote")!.addEventListener("click", (e) => {
  e.stopPropagation();
  void ipc.openCapture();
});
qbPomo.addEventListener("click", (e) => {
  e.stopPropagation();
  const active = lastState.state === "focus" || lastState.state === "break";
  void (active ? ipc.pomodoroAbort() : ipc.pomodoroStart("focus"));
});
document.getElementById("qbPanel")!.addEventListener("click", (e) => {
  e.stopPropagation();
  void ipc.openPanel();
});

// ------------------------------------------------------- modalità sobria

function applyMode(next: "full" | "sober"): void {
  if (next === mode) return; // il core ritrasmette a ogni sync: è idempotente
  mode = next;
  const sober = mode === "sober";
  soberEl.classList.toggle("on", sober);
  scene.setVisible(!sober);
  bubbles.setVisible(!sober); // in sobria parlano pillola e toast, non i fumetti
  if (sober) {
    renderSober();
  }
}

function renderSober(): void {
  const { state, until } = lastState;
  soberLed.style.background = `#${STATE_COLOR[state].toString(16).padStart(6, "0")}`;
  soberLbl.textContent = stateLabel(state);
  soberTime.textContent = until ? fmtCountdown(until - Date.now()) : "";
}

setInterval(() => {
  if (mode === "sober") {
    renderSober();
    reportHitbox(null);
  }
}, 500);

// --------------------------------------------------------------- eventi

function applyState(s: StateChanged): void {
  lastState = s;
  scene.setState(s.state);
  bubbles.setState(s);
  refreshQuickbarPomo();
  if (mode === "sober") renderSober();
}

function applyBuddy(id: string): void {
  // rimontare la creatura costa (dispose + ricostruzione): solo su cambio vero
  if (id !== creature) {
    creature = id;
    scene.mountBuddy(creature);
  }
}

// clic sulla creatura (o sulla pillola) → pannello (§ 5.1)
stage.addEventListener("click", () => void ipc.openPanel());
soberEl.addEventListener("click", () => void ipc.openPanel());

async function init(): Promise<void> {
  // prima i listener, POI il ready: gli eventi emessi dal core in risposta
  // non devono cadere nel vuoto di una registrazione ancora in corso
  await connectPomodoroPresentationSource({
    subscribe: (deliver) =>
      Promise.all([
        ipc.on<StateChanged>(EVT_STATE_CHANGED, applyState),
        ipc.on<BubbleShow>(EVT_BUBBLE_SHOW, (b) => bubbles.show(b)),
        ipc.on<BubbleDismiss>(EVT_BUBBLE_DISMISS, (b) => bubbles.dismiss(b.id)),
        ipc.on<BuddyChanged>(EVT_BUDDY_CHANGED, (b) => applyBuddy(b.creature_id)),
        ipc.on<ModeChanged>(EVT_MODE_CHANGED, (m) => applyMode(m.mode)),
        ipc.on<PomodoroPresentation>(EVT_POMODORO_PRESENTATION, deliver),
      ]),
    replay: async () => {
      const boot = await ipc.surfaceReady("overlay");
      if (!boot) return [];
      applyBuddy(boot.creature_id);
      applyMode(boot.mode);
      if (boot.state) applyState(boot.state);
      if (boot.bubble) bubbles.show(boot.bubble);
      return boot.presentations;
    },
    consume: consumePomodoroPresentation,
    reportError: (error) => console.error("bootstrap presentazioni Pomodoro fallito", error),
  });
}

void init().catch((error) => {
  console.error("inizializzazione overlay fallita", error);
});

// rete di sicurezza: qualunque cosa sia andata storta nel boot, dopo un
// secondo e mezzo sullo schermo c'è una creatura, non il vuoto
window.setTimeout(() => {
  if (!creature) applyBuddy("cotone");
}, 1500);
