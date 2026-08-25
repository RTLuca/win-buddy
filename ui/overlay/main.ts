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
  EVT_STATE_CHANGED,
  STATE_COLOR,
  fmtCountdown,
  type BubbleDismiss,
  type BubbleShow,
  type BuddyChanged,
  type ModeChanged,
  type StateChanged,
} from "../shared/contracts";
import * as ipc from "../shared/ipc";
import { BubbleLayer, stateLabel } from "./bubbles";
import { OverlayScene, type ScreenRect } from "./scene";

const stage = document.getElementById("stage")!;
const soberEl = document.getElementById("sober")!;
const soberLed = document.getElementById("soberLed")!;
const soberLbl = document.getElementById("soberLbl")!;
const soberTime = document.getElementById("soberTime")!;

const scene = new OverlayScene(stage);
const bubbles = new BubbleLayer(document.body);

let mode: "full" | "sober" = "full";
let creature = "";
let lastState: StateChanged = { state: "idle" };
let lastSent: ScreenRect = { x: -1, y: -1, w: -1, h: -1 };
let lastSentAt = 0;

// ------------------------------------------------------------- hit-test

/**
 * Comunica al core il rettangolo davvero occupato (creatura + nuvoletta),
 * non lo spazio vuoto attorno (§ 10.2). Throttle a 100 ms e solo su
 * variazioni percettibili.
 */
function reportHitbox(creature: ScreenRect | null): void {
  const now = performance.now();
  if (now - lastSentAt < 100) return;

  let rect: ScreenRect | null = null;
  if (mode === "sober") {
    const r = soberEl.getBoundingClientRect();
    rect = { x: r.left, y: r.top, w: r.width, h: r.height };
  } else {
    rect = creature;
    const b = bubbles.rect();
    if (b) {
      if (rect) {
        const x = Math.min(rect.x, b.x);
        const y = Math.min(rect.y, b.y);
        rect = {
          x,
          y,
          w: Math.max(rect.x + rect.w, b.x + b.w) - x,
          h: Math.max(rect.y + rect.h, b.y + b.h) - y,
        };
      } else {
        rect = b;
      }
    }
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
  if (!moved) return;

  lastSent = n;
  lastSentAt = now;
  void ipc.hittestUpdate(n.x, n.y, n.w, n.h);
}

scene.onFrame = (anchor, creature) => {
  bubbles.place(anchor);
  reportHitbox(creature);
};

// ------------------------------------------------------- modalità sobria

function applyMode(next: "full" | "sober"): void {
  if (next === mode) return; // il core ritrasmette a ogni sync: è idempotente
  mode = next;
  const sober = mode === "sober";
  soberEl.classList.toggle("on", sober);
  scene.setVisible(!sober);
  if (sober) renderSober();
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

void ipc.on<StateChanged>(EVT_STATE_CHANGED, (s) => {
  lastState = s;
  scene.setState(s.state);
  bubbles.setState(s);
  if (mode === "sober") renderSober();
});

void ipc.on<BubbleShow>(EVT_BUBBLE_SHOW, (b) => bubbles.show(b));
void ipc.on<BubbleDismiss>(EVT_BUBBLE_DISMISS, (b) => bubbles.dismiss(b.id));
void ipc.on<BuddyChanged>(EVT_BUDDY_CHANGED, (b) => {
  // rimontare la creatura costa (dispose + ricostruzione): solo su cambio vero
  if (b.creature_id !== creature) {
    creature = b.creature_id;
    scene.mountBuddy(creature);
  }
});
void ipc.on<ModeChanged>(EVT_MODE_CHANGED, (m) => applyMode(m.mode));

// clic sulla creatura (o sulla pillola) → pannello (§ 5.1)
stage.addEventListener("click", () => void ipc.openPanel());
soberEl.addEventListener("click", () => void ipc.openPanel());

// pronta: il core risponde ri-emettendo stato corrente, buddy e modalità
void ipc.surfaceReady("overlay");
