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
  EVT_FOCUS_CHANGED,
  EVT_MODE_CHANGED,
  EVT_POMODORO_PRESENTATION,
  EVT_STATE_CHANGED,
  STATE_COLOR,
  type BubbleDismiss,
  type BubbleShow,
  type BuddyChanged,
  type FocusFinishOutcome,
  type FocusStatus,
  type ModeChanged,
  type PomodoroPresentation,
  type StateChanged,
} from "../shared/contracts";
import {
  buddyActions,
  focusIndicator,
} from "../shared/focus-view-model";
import * as ipc from "../shared/ipc";
import { BubbleLayer } from "./bubbles";
import {
  createFocusPresentationController,
  createFocusSnapshotGate,
  focusFinishCommand,
  focusHitbox,
  overlayActionCommand,
  overlayVisibility,
  presentOverlayCommandFailure,
  type FocusRect,
  type OverlayActionCommand,
} from "./focus-controller";
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
const focusChip = document.getElementById("focusChip") as HTMLOutputElement;
const actionDock = document.getElementById("actionDock")!;
const focusActions = document.getElementById("focusActions")!;
const finishChooser = document.getElementById("finishChooser")!;
const focusFeedback = document.getElementById("focusFeedback")!;
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
let currentFocusStatus: FocusStatus | null = null;
let focusStatusError: string | null = null;
let focusBusy = false;
let pointerInside = false;

// ------------------------------------------------------------- hit-test

/**
 * Comunica al core il rettangolo davvero occupato (creatura + nuvoletta),
 * non lo spazio vuoto attorno (§ 10.2). Throttle a 100 ms e solo su
 * variazioni percettibili.
 */
function reportHitbox(creature: ScreenRect | null, force = false): void {
  const now = performance.now();
  if (!force && now - lastSentAt < 100) return;

  const elementRect = (element: Element): FocusRect => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
  };
  const base = mode === "sober" ? null : union(creature, bubbles.rect());
  const rect = focusHitbox({
    base,
    chip: elementRect(soberEl),
    dock: actionDock.classList.contains("on") ? elementRect(actionDock) : null,
    chooser:
      !finishChooser.hidden && finishChooser.classList.contains("on")
        ? elementRect(finishChooser)
        : null,
    scale:
      !scalePopover.hidden && scalePopover.classList.contains("on")
        ? elementRect(scalePopover)
        : null,
  });
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

// ------------------------------------------------------------- dock focus

function closeFinishChooser(restoreFocus = false): void {
  focusPresentation.closeFinishChooser(restoreFocus);
}

function syncDockVisibility(): void {
  const { dockVisible } = overlayVisibility({
    pointerInside,
    focusWithin: actionDock.matches(":focus-within"),
  });
  actionDock.classList.toggle("on", dockVisible);
  actionDock.toggleAttribute("inert", !dockVisible);
  if (!dockVisible) {
    closeFinishChooser();
    closeScalePopover();
  }
  reportHitbox(lastCreatureRect, true);
}

document.body.addEventListener("pointerenter", () => {
  pointerInside = true;
  syncDockVisibility();
});
document.body.addEventListener("pointerleave", () => {
  pointerInside = false;
  syncDockVisibility();
});
actionDock.addEventListener("focusin", syncDockVisibility);
actionDock.addEventListener("focusout", () => queueMicrotask(syncDockVisibility));

function closeScalePopover(): void {
  if (scalePopover.hidden) return;
  scalePopover.classList.remove("on");
  scalePopover.hidden = true;
  scalePopover.inert = true;
  qbScale.setAttribute("aria-expanded", "false");
  reportHitbox(lastCreatureRect, true);
}

qbScale.addEventListener("click", (e) => {
  e.stopPropagation();
  const opening = !scalePopover.classList.contains("on");
  if (!opening) {
    closeScalePopover();
    return;
  }

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
  if (e.key !== "Escape") return;
  if (scalePopover.classList.contains("on")) {
    closeScalePopover();
    qbScale.focus();
  } else if (finishChooser.classList.contains("on")) {
    closeFinishChooser(true);
  } else {
    return;
  }
  e.stopPropagation();
});

function openFinishChooser(): void {
  closeScalePopover();
  focusPresentation.openFinishChooser();
  finishChooser.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
}

function showFocusFeedback(message: string | null): void {
  focusFeedback.textContent = message ?? "";
  focusFeedback.hidden = !message;
}

function renderFocusChip(): void {
  focusChip.value = currentFocusStatus
    ? focusIndicator(currentFocusStatus, Date.now())
    : focusStatusError
      ? "Focus non disponibile"
      : "Focus in caricamento";
  soberLed.style.background = `#${STATE_COLOR[lastState.state]
    .toString(16)
    .padStart(6, "0")}`;
}

function renderFocusActions(): void {
  focusActions.replaceChildren();
  if (!currentFocusStatus) return;
  const fragment = document.createDocumentFragment();
  for (const action of buddyActions(currentFocusStatus)) {
    // `break.start` non viene prodotto dal core in questa slice.
    if (action.id === "break.start") continue;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = action.label;
    button.setAttribute("aria-label", action.ariaLabel);
    button.dataset.focusAction = action.id;
    button.disabled = focusBusy;
    fragment.append(button);
  }
  focusActions.append(fragment);
  focusActions.setAttribute(
    "aria-label",
    currentFocusStatus.active?.kind === "focus" ? "Azioni focus" : "Azioni pausa",
  );
}

const focusPresentation = createFocusPresentationController({
  render(state, { restoreFinishFocus }) {
    currentFocusStatus = state.status;
    focusStatusError = state.statusError;
    finishChooser.classList.toggle("on", state.finishChooserOpen);
    actionDock.classList.toggle("choosing", state.finishChooserOpen);
    finishChooser.hidden = !state.finishChooserOpen;
    finishChooser.inert = !state.finishChooserOpen;
    showFocusFeedback(state.feedback);
    renderFocusChip();
    renderFocusActions();
    if (restoreFinishFocus && !state.finishChooserOpen) {
      focusActions
        .querySelector<HTMLButtonElement>('[data-focus-action="focus.finish"]')
        ?.focus({ preventScroll: true });
    }
  },
  reportHitbox: () => reportHitbox(lastCreatureRect, true),
});

const focusSnapshots = createFocusSnapshotGate((status) =>
  focusPresentation.applySnapshot(status),
);

async function invokeFocusCommand(command: OverlayActionCommand): Promise<FocusStatus | null> {
  switch (command.type) {
    case "start-last":
      return ipc.focusStartLast();
    case "pause":
      return ipc.focusPause(command.sessionId, command.expectedRevision);
    case "resume":
      return ipc.focusResume(command.sessionId, command.expectedRevision);
    case "adjust":
      return ipc.focusAdjust(command.sessionId, command.deltaMs, command.expectedRevision);
    case "overtime":
      return ipc.focusOvertime(command.sessionId, command.expectedRevision);
    case "finish":
      return ipc.focusFinish(
        command.sessionId,
        command.outcome,
        command.expectedRevision,
      );
    case "capture":
      await ipc.openCapture();
      return null;
    case "choose-finish":
      openFinishChooser();
      return null;
  }
}

async function runFocusCommand(command: OverlayActionCommand): Promise<void> {
  if (focusBusy) return;
  if (command.type === "choose-finish") {
    openFinishChooser();
    return;
  }
  const request = focusSnapshots.beginRequest();
  focusBusy = true;
  focusPresentation.clearFeedback();
  renderFocusActions();
  try {
    const next = await invokeFocusCommand(command);
    if (next) focusSnapshots.applyResponse(request, next);
  } catch (error) {
    presentOverlayCommandFailure(
      focusSnapshots,
      focusPresentation,
      request,
      error,
    );
  } finally {
    focusBusy = false;
    renderFocusActions();
  }
}

focusActions.addEventListener("click", (event) => {
  event.stopPropagation();
  const button = (event.target as Element).closest<HTMLButtonElement>("[data-focus-action]");
  const status = currentFocusStatus;
  if (!button || !status) return;
  const command = overlayActionCommand(
    status,
    button.dataset.focusAction as Parameters<typeof overlayActionCommand>[1],
  );
  if (command) void runFocusCommand(command);
});

finishChooser.addEventListener("click", (event) => {
  event.stopPropagation();
  const button = (event.target as Element).closest<HTMLButtonElement>("[data-focus-outcome]");
  const status = currentFocusStatus;
  if (!button || !status) return;
  const command = focusFinishCommand(
    status,
    button.dataset.focusOutcome as FocusFinishOutcome,
  );
  if (command) void runFocusCommand(command);
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
  renderFocusChip();
  reportHitbox(lastCreatureRect, true);
}

setInterval(() => {
  renderFocusChip();
  reportHitbox(lastCreatureRect);
}, 500);

// --------------------------------------------------------------- eventi

function applyState(s: StateChanged): void {
  lastState = s;
  scene.setState(s.state);
  renderFocusChip();
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
        ipc.on<FocusStatus>(EVT_FOCUS_CHANGED, (status) => {
          focusSnapshots.applyEvent(status);
        }),
        ipc.on<PomodoroPresentation>(EVT_POMODORO_PRESENTATION, deliver),
      ]),
    replay: async () => {
      const statusRead = focusSnapshots.beginRequest();
      const [boot] = await Promise.all([
        ipc.surfaceReady("overlay"),
        ipc
          .focusStatus()
          .then((status) => focusSnapshots.applyResponse(statusRead, status))
          .catch((error) => {
            presentOverlayCommandFailure(
              focusSnapshots,
              focusPresentation,
              statusRead,
              error,
            );
          }),
      ]);
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
