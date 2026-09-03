/**
 * Pannello (§ 5.1): note aperte, archivio ricercabile, Focus e
 * impostazioni. Vive a richiesta, muore alla chiusura.
 */

import {
  CREATURE_META,
  EVT_FOCUS_CHANGED,
  EVT_FOCUS_FINISH_INTENT,
  EVT_NOTES_CHANGED,
  KIND_LABEL,
  OUTCOME_LABEL,
  fmtCountdown,
  type FocusAction,
  type FocusFinishOutcome,
  type FocusShortcutSettingKey,
  type FocusShortcutSettings,
  type FocusStatus,
  type NoteView,
  type PomodoroPreset,
  type PomodoroSession,
} from "../shared/contracts";
import * as ipc from "../shared/ipc";
import { focusClock } from "../shared/focus-view-model";
import {
  buildFocusStart,
  clockBoundaryRefresh,
  configureFocusClockAccessibility,
  createFocusRequestSequencer,
  createFocusSurfaceBootstrap,
  focusChoicesAfterSnapshot,
  focusCommandFailure,
  focusFeedbackAfterSnapshot,
  focusMutationTarget,
  focusPhaseHeading,
  focusSnapshotIsNewer,
  historySummary,
  panelState,
  presetTimingLabel,
  type FocusPane,
  type FocusSnapshotSource,
} from "./focus-controller";
import {
  createShortcutSettingsController,
  startFinishIntentBridge,
} from "./shortcut-controller";

// ------------------------------------------------------------------ tabs

const tabs = document.getElementById("tabs")!;
function setMainTab(name: string, moveFocus = false): void {
  const btn = tabs.querySelector<HTMLButtonElement>(`button[data-tab="${name}"]`);
  if (!btn) return;
  for (const b of tabs.querySelectorAll("button")) b.classList.toggle("on", b === btn);
  for (const s of document.querySelectorAll<HTMLElement>(".tab")) {
    s.classList.toggle("on", s.id === `tab-${name}`);
  }
  if (moveFocus) btn.focus();
  if (name === "archive") void renderArchive();
  if (name === "focus") void refreshFocusSurface();
}

tabs.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-tab]");
  if (btn?.dataset.tab) setMainTab(btn.dataset.tab);
});

// ------------------------------------------------------------ note aperte

const openList = document.getElementById("openList")!;
const openFoot = document.getElementById("openFoot")!;
const newNote = document.getElementById("newNote") as HTMLFormElement;
const newNoteText = document.getElementById("newNoteText") as HTMLInputElement;

function noteRow(v: NoteView, archived: boolean): HTMLElement {
  const row = document.createElement("div");
  row.className = `note ${v.note.state}`;

  const box = document.createElement("button");
  box.className = "box";
  box.type = "button";
  box.title = archived ? "" : "Fatto";
  if (!archived) {
    box.addEventListener("click", async () => {
      await ipc.noteComplete(v.note.id);
      await renderOpen();
    });
  }
  row.append(box);

  const txt = document.createElement("span");
  txt.className = "txt";
  if (v.note.urgent && !archived) {
    const mark = document.createElement("span");
    mark.className = "urgent-mark";
    mark.textContent = "!";
    mark.title = "Urgente: può interrompere un focus";
    txt.append(mark);
  }
  txt.append(document.createTextNode(v.note.body));
  const when = document.createElement("span");
  when.className = `when${v.overdue ? " late" : ""}`;
  when.textContent = v.due_label ?? (archived ? stateWord(v) : "appunto");
  txt.append(when);
  row.append(txt);

  if (!archived) {
    const mini = document.createElement("div");
    mini.className = "mini";
    mini.append(
      miniBtn("+10′", () => ipc.noteSnooze(v.note.id, 10)),
      miniBtn("+1h", () => ipc.noteSnooze(v.note.id, 60)),
      miniBtn("domani", () => ipc.noteSnooze(v.note.id, tomorrowMinutes())),
      miniBtn("✕", () => ipc.noteDismiss(v.note.id)),
    );
    row.append(mini);
  }
  return row;
}

function miniBtn(label: string, action: () => Promise<unknown>): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.addEventListener("click", async () => {
    await action();
    await renderOpen();
  });
  return b;
}

/** Minuti da adesso alle 9:00 di domani: lo snooze ragiona in minuti. */
function tomorrowMinutes(): number {
  const t = new Date();
  const tomorrow = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1, 9, 0, 0);
  return Math.max(1, Math.round((tomorrow.getTime() - t.getTime()) / 60000));
}

function stateWord(v: NoteView): string {
  return v.note.state === "done" ? "completata" : "ignorata";
}

async function renderOpen(): Promise<void> {
  const items = await ipc.notesOpen();
  openList.replaceChildren();
  if (items.length === 0) {
    openList.append(empty("Nessuna nota aperta. Ctrl+Alt+Spazio per catturarne una."));
  } else {
    for (const v of items) openList.append(noteRow(v, false));
  }
  const archived = (await ipc.notesArchive(1000)).length;
  openFoot.textContent = `${items.length} aperte · ${archived} in archivio`;
}

newNote.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = newNoteText.value.trim();
  if (!text) return;
  await ipc.captureSubmit(text);
  newNoteText.value = "";
  await renderOpen();
});

// --------------------------------------------------------------- archivio

const searchBox = document.getElementById("searchBox") as HTMLInputElement;
const archiveList = document.getElementById("archiveList")!;
let searchTimer = 0;

async function renderArchive(): Promise<void> {
  const q = searchBox.value.trim();
  const items = q ? await ipc.notesSearch(q) : await ipc.notesArchive(200);
  archiveList.replaceChildren();
  if (items.length === 0) {
    archiveList.append(empty(q ? "Nessun risultato." : "L'archivio è vuoto."));
    return;
  }
  for (const v of items) archiveList.append(noteRow(v, true));
}

searchBox.addEventListener("input", () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => void renderArchive(), 150);
});

// ------------------------------------------------------------------ focus

const focusTabs = document.getElementById("focusTabs")!;
const focusTabPrepare = document.getElementById("focusTabPrepare") as HTMLButtonElement;
const focusPrepare = document.getElementById("focusPrepare")!;
const focusHistory = document.getElementById("focusHistory")!;
const focusStats = document.getElementById("focusStats")!;
const focusPrepareState = document.getElementById("focusPrepareState")!;
const focusPrepareForm = document.getElementById("focusPrepareForm") as HTMLFormElement;
const focusRunning = document.getElementById("focusRunning")!;
const focusError = document.getElementById("focusError")!;
const focusIntention = document.getElementById("focusIntention") as HTMLTextAreaElement;
const focusPreset = document.getElementById("focusPreset") as HTMLSelectElement;
const focusPresetHint = document.getElementById("focusPresetHint")!;
const focusDuration = document.getElementById("focusDuration") as HTMLInputElement;
const focusEstimate = document.getElementById("focusEstimate") as HTMLInputElement;
const focusCategory = document.getElementById("focusCategory") as HTMLInputElement;
const focusNextStep = document.getElementById("focusNextStep") as HTMLInputElement;
const focusStart = document.getElementById("focusStart") as HTMLButtonElement;
const focusHistoryContent = document.getElementById("focusHistoryContent")!;
const focusStatsContent = document.getElementById("focusStatsContent")!;
const focusHistoryRefresh = document.getElementById("focusHistoryRefresh") as HTMLButtonElement;

let currentFocusStatus: FocusStatus | null = null;
let focusPresets: PomodoroPreset[] = [];
let focusSessions: PomodoroSession[] | null = null;
let currentFocusPane: FocusPane = "prepare";
let focusPresetsLoading = true;
let focusHistoryLoading = true;
let focusStatusError: string | null = null;
let focusPresetsError: string | null = null;
let focusHistoryError: string | null = null;
let focusActionError: string | null = null;
let focusBusy = false;
let durationChoicesOpen = false;
let finishChoicesOpen = false;
let interruptionReasonOpen = false;
let zeroRefreshLatch: string | null = null;
const focusRequests = createFocusRequestSequencer();

function setFocusPane(pane: FocusPane, moveFocus = false): void {
  currentFocusPane = pane;
  const panes: Record<FocusPane, HTMLElement> = {
    prepare: focusPrepare,
    history: focusHistory,
    stats: focusStats,
  };
  for (const button of focusTabs.querySelectorAll<HTMLButtonElement>("button[data-focus-pane]")) {
    const selected = button.dataset.focusPane === pane;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
    if (selected && moveFocus) button.focus();
  }
  for (const [name, section] of Object.entries(panes)) section.hidden = name !== pane;
  renderFocusPrepare();
  if (pane === "history") renderFocusHistory();
  if (pane === "stats") renderFocusStats();
}

focusTabs.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
    "button[data-focus-pane]",
  );
  const pane = button?.dataset.focusPane as FocusPane | undefined;
  if (pane) setFocusPane(pane);
});

focusTabs.addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const panes: FocusPane[] = ["prepare", "history", "stats"];
  const current = panes.indexOf(currentFocusPane);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? panes.length - 1
        : (current + (event.key === "ArrowRight" ? 1 : -1) + panes.length) % panes.length;
  setFocusPane(panes[next], true);
});

function setFocusState(text: string, kind: "loading" | "empty" | "error"): void {
  focusPrepareState.replaceChildren();
  focusPrepareState.className = `focus-state ${kind}`;
  focusPrepareState.textContent = text;
  focusPrepareState.hidden = false;
}

function selectedPreset(): PomodoroPreset | null {
  const id = Number(focusPreset.value);
  return focusPresets.find((preset) => preset.id === id) ?? null;
}

function renderPresetOptions(): void {
  const previous = focusPreset.value;
  focusPreset.replaceChildren();
  for (const preset of focusPresets) {
    const option = document.createElement("option");
    option.value = String(preset.id);
    option.textContent = preset.name;
    focusPreset.append(option);
  }
  const fallback = focusPresets.find((preset) => preset.is_default) ?? focusPresets[0];
  const selected = focusPresets.some((preset) => String(preset.id) === previous)
    ? previous
    : fallback
      ? String(fallback.id)
      : "";
  focusPreset.value = selected;
  renderPresetHint();
}

function renderPresetHint(): void {
  const preset = selectedPreset();
  focusPresetHint.textContent = preset
    ? presetTimingLabel(preset)
    : "Durata e pause arrivano dal preset salvato.";
}

focusPreset.addEventListener("change", renderPresetHint);

function renderFocusPrepare(): void {
  if (!currentFocusStatus) {
    focusPrepareForm.hidden = true;
    focusRunning.hidden = true;
    setFocusState(
      focusStatusError ?? "Caricamento focus…",
      focusStatusError ? "error" : "loading",
    );
    return;
  }

  const view = panelState(currentFocusStatus, currentFocusPane);
  focusTabPrepare.textContent = view.localTabLabel;
  focusPrepareState.hidden = true;
  focusPrepareForm.hidden = true;
  focusRunning.hidden = true;

  if (view.showPreparationForm) {
    if (focusPresetsLoading) {
      setFocusState("Caricamento preset…", "loading");
    } else if (focusPresetsError) {
      setFocusState(focusPresetsError, "error");
    } else if (focusPresets.length === 0) {
      setFocusState("Nessun preset disponibile.", "empty");
    } else {
      focusPrepareForm.hidden = false;
      renderPresetOptions();
      focusStart.disabled = focusBusy || !currentFocusStatus.allowed_actions.includes("focus.start_last");
    }
  }

  if (view.showRunningControls) {
    focusRunning.hidden = false;
    renderRunningFocus(currentFocusStatus);
  }

  const message = focusActionError ?? (focusStatusError && currentFocusStatus ? focusStatusError : null);
  focusError.hidden = !message;
  focusError.textContent = message ?? "";
}

function renderRunningFocus(status: FocusStatus): void {
  const active = status.active;
  if (!active) return;
  focusRunning.replaceChildren();

  const head = document.createElement("div");
  head.className = "focus-now";
  const phase = document.createElement("p");
  phase.className = "focus-eyebrow";
  phase.textContent = focusPhaseHeading(status);
  const clock = document.createElement("output");
  clock.id = "focusClock";
  clock.className = "focus-clock";
  configureFocusClockAccessibility(clock);
  clock.textContent = focusClock(status, Date.now());
  head.append(phase, clock);

  const details = document.createElement("dl");
  details.className = "focus-details";
  appendDetail(details, "Intenzione", active.intention || "Nessuna intenzione");
  const preset = focusPresets.find((item) => item.id === active.preset_id);
  appendDetail(details, "Preset", preset?.name ?? "Preset salvato");
  if (active.next_step) appendDetail(details, "Prossimo passo", active.next_step);
  if (status.pending_captures > 0) {
    appendDetail(details, "Catture in attesa", String(status.pending_captures));
  }

  const controls = document.createElement("div");
  controls.className = "focus-actions";
  for (const action of status.allowed_actions) {
    const button = focusActionButton(action, active.kind !== "focus");
    if (button) controls.append(button);
  }
  focusRunning.append(head, details, controls);

  if (durationChoicesOpen && status.allowed_actions.includes("focus.extend_5")) {
    const group = document.createElement("div");
    group.className = "focus-adjust";
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", "Modifica durata in minuti");
    for (const minutes of [-10, -5, -1, 1, 5, 10]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ghost compact";
      button.textContent = minutes > 0 ? `+${minutes}` : `−${Math.abs(minutes)}`;
      button.setAttribute(
        "aria-label",
        `${minutes > 0 ? "Aggiungi" : "Riduci di"} ${Math.abs(minutes)} minuti`,
      );
      button.disabled = focusBusy;
      button.addEventListener("click", () => {
        const target = currentMutationTarget();
        if (target) {
          void runFocusMutation(() =>
            ipc.focusAdjust(target.sessionId, minutes * 60_000, target.expectedRevision),
          );
        }
      });
      group.append(button);
    }
    focusRunning.append(group);
  }

  if (finishChoicesOpen && active.kind === "focus") renderFinishChoices();
}

function appendDetail(list: HTMLDListElement, term: string, value: string): void {
  const row = document.createElement("div");
  const dt = document.createElement("dt");
  const dd = document.createElement("dd");
  dt.textContent = term;
  dd.textContent = value;
  row.append(dt, dd);
  list.append(row);
}

function focusActionButton(action: FocusAction, isBreak: boolean): HTMLButtonElement | null {
  const labels: Partial<Record<FocusAction, string>> = {
    "focus.pause": "Pausa",
    "focus.resume": "Riprendi",
    "focus.extend_5": "Modifica durata",
    "focus.capture": "Cattura",
    "focus.finish": isBreak ? "Concludi pausa" : "Concludi",
    "focus.overtime": "Continua",
    "break.skip": "Salta pausa",
  };
  const label = labels[action];
  if (!label) return null;
  const button = document.createElement("button");
  button.type = "button";
  button.className = action === "focus.pause" || action === "focus.resume" ? "primary" : "ghost";
  button.textContent = label;
  button.disabled = focusBusy;
  button.addEventListener("click", () => handleFocusAction(action));
  return button;
}

function handleFocusAction(action: FocusAction): void {
  if (action === "focus.capture") {
    focusActionError = null;
    void ipc.openCapture().catch((error: unknown) => {
      focusActionError = focusCommandFailure(error).message;
      renderFocusPrepare();
    });
    return;
  }
  if (action === "focus.extend_5") {
    durationChoicesOpen = !durationChoicesOpen;
    finishChoicesOpen = false;
    interruptionReasonOpen = false;
    renderFocusPrepare();
    return;
  }
  const target = currentMutationTarget();
  if (!target) return;
  if (action === "focus.pause") {
    void runFocusMutation(() => ipc.focusPause(target.sessionId, target.expectedRevision));
  }
  if (action === "focus.resume") {
    void runFocusMutation(() => ipc.focusResume(target.sessionId, target.expectedRevision));
  }
  if (action === "focus.overtime") {
    void runFocusMutation(() => ipc.focusOvertime(target.sessionId, target.expectedRevision));
  }
  if (action === "break.skip") {
    void runFocusMutation(() =>
      ipc.focusFinish(target.sessionId, "partial", target.expectedRevision),
    );
  }
  if (action === "focus.finish") {
    if (currentFocusStatus?.active?.kind === "focus") {
      finishChoicesOpen = !finishChoicesOpen;
      durationChoicesOpen = false;
      interruptionReasonOpen = false;
      renderFocusPrepare();
    } else {
      void runFocusMutation(() =>
        ipc.focusFinish(target.sessionId, "partial", target.expectedRevision),
      );
    }
  }
}

function renderFinishChoices(): void {
  const group = document.createElement("div");
  group.className = "focus-finish";
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", "Esito della sessione");

  for (const [outcome, label] of [
    ["completed", "Completata"],
    ["partial", "Parziale"],
    ["interrupted", "Interrotta"],
  ] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost compact";
    button.textContent = label;
    button.disabled = focusBusy;
    button.addEventListener("click", () => {
      if (outcome === "interrupted") {
        interruptionReasonOpen = true;
        renderFocusPrepare();
      } else {
        void finishFocus(outcome);
      }
    });
    group.append(button);
  }
  focusRunning.append(group);

  if (interruptionReasonOpen) {
    const form = document.createElement("form");
    form.className = "focus-interruption";
    const label = document.createElement("label");
    label.className = "focus-field";
    const caption = document.createElement("span");
    caption.textContent = "Motivo dell’interruzione";
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 240;
    input.placeholder = "Facoltativo";
    label.append(caption, input);
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "primary";
    submit.textContent = "Conferma interruzione";
    form.append(label, submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void finishFocus("interrupted", input.value.trim() || null);
    });
    focusRunning.append(form);
    input.focus();
  }
}

async function consumeFinishShortcutIntent(): Promise<void> {
  if (!(await ipc.focusFinishIntentTake())) return;
  setMainTab("focus");
  setFocusPane("prepare");
  await loadFocusStatus();
  if (
    currentFocusStatus?.active?.kind !== "focus" ||
    !currentFocusStatus.allowed_actions.includes("focus.finish")
  ) {
    return;
  }
  finishChoicesOpen = true;
  durationChoicesOpen = false;
  interruptionReasonOpen = false;
  renderFocusPrepare();
  window.requestAnimationFrame(() => {
    document.querySelector<HTMLButtonElement>(".focus-finish button")?.focus();
  });
}

function currentMutationTarget() {
  return currentFocusStatus ? focusMutationTarget(currentFocusStatus) : null;
}

function finishFocus(outcome: FocusFinishOutcome, reason?: string | null): Promise<void> {
  const target = currentMutationTarget();
  if (!target) return Promise.resolve();
  return runFocusMutation(() =>
    ipc.focusFinish(target.sessionId, outcome, target.expectedRevision, reason),
  );
}

async function runFocusMutation(operation: () => Promise<FocusStatus>): Promise<void> {
  if (focusBusy) return;
  const request = focusRequests.beginMutation(currentFocusStatus);
  focusBusy = true;
  focusActionError = null;
  renderFocusPrepare();
  try {
    const next = await operation();
    applyAuthoritativeFocusStatus(next);
  } catch (error) {
    const failure = focusCommandFailure(error);
    const errorIsCurrent = failure.current
      ? applyAuthoritativeFocusStatus(failure.current)
      : focusRequests.isCurrentMutation(request, currentFocusStatus);
    if (!failure.current && errorIsCurrent) {
      void loadFocusHistory();
    }
    if (errorIsCurrent) focusActionError = failure.message;
  } finally {
    focusBusy = false;
    renderFocusPrepare();
  }
}

function optionalNumber(input: HTMLInputElement): number | null {
  const value = input.value.trim();
  return value ? Number(value) : null;
}

focusPrepareForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const preset = selectedPreset();
  if (!preset || !currentFocusStatus?.allowed_actions.includes("focus.start_last")) return;
  try {
    const request = buildFocusStart(preset, {
      intention: focusIntention.value,
      durationMinutes: optionalNumber(focusDuration),
      estimateMinutes: optionalNumber(focusEstimate),
      category: focusCategory.value,
      nextStep: focusNextStep.value,
    });
    void runFocusMutation(() => ipc.focusStart(request));
  } catch (error) {
    focusActionError = focusCommandFailure(error).message;
    renderFocusPrepare();
  }
});

function applyFocusStatus(status: FocusStatus, source: FocusSnapshotSource): boolean {
  if (!focusSnapshotIsNewer(currentFocusStatus, status)) return false;
  const previousStatus = currentFocusStatus;
  const feedback = focusFeedbackAfterSnapshot(
    previousStatus,
    status,
    source,
    focusActionError,
  );
  const currentChoices = {
    durationChoicesOpen,
    finishChoicesOpen,
    interruptionReasonOpen,
  };
  const nextChoices = focusChoicesAfterSnapshot(previousStatus, status, currentChoices);
  durationChoicesOpen = nextChoices.durationChoicesOpen;
  finishChoicesOpen = nextChoices.finishChoicesOpen;
  interruptionReasonOpen = nextChoices.interruptionReasonOpen;
  if (nextChoices !== currentChoices) zeroRefreshLatch = null;
  currentFocusStatus = status;
  focusStatusError = null;
  focusActionError = feedback.actionError;
  if (source === "status" && feedback.domainChanged) {
    focusRequests.statusSnapshotAccepted(previousStatus, status);
  }
  renderFocusPrepare();
  tickFocusClock();
  return true;
}

function applyAuthoritativeFocusStatus(status: FocusStatus): boolean {
  if (!applyFocusStatus(status, "authoritative")) return false;
  focusRequests.authoritativeSnapshotArrived();
  void loadFocusHistory();
  return true;
}

function tickFocusClock(): void {
  if (!currentFocusStatus) return;
  const clock = document.getElementById("focusClock");
  if (clock) clock.textContent = focusClock(currentFocusStatus, Date.now());
  const decision = clockBoundaryRefresh(currentFocusStatus, Date.now(), zeroRefreshLatch);
  zeroRefreshLatch = decision.latch;
  if (decision.shouldRefresh) void loadFocusStatus();
}

window.setInterval(tickFocusClock, 500);

async function loadFocusStatus(): Promise<void> {
  const request = focusRequests.beginStatus();
  try {
    const status = await ipc.focusStatus();
    if (focusRequests.isCurrentStatus(request)) applyFocusStatus(status, "status");
  } catch (error) {
    if (!focusRequests.isCurrentStatus(request)) return;
    focusStatusError = focusCommandFailure(error).message;
    renderFocusPrepare();
  }
}

async function loadFocusPresets(): Promise<void> {
  focusPresetsLoading = true;
  focusPresetsError = null;
  renderFocusPrepare();
  try {
    focusPresets = await ipc.focusPresets();
  } catch (error) {
    focusPresets = [];
    focusPresetsError = focusCommandFailure(error).message;
  } finally {
    focusPresetsLoading = false;
    renderFocusPrepare();
  }
}

async function loadFocusHistory(): Promise<void> {
  const request = focusRequests.beginHistory();
  focusHistoryLoading = true;
  focusHistoryError = null;
  renderFocusHistory();
  renderFocusStats();
  try {
    const sessions = await ipc.pomodoroHistory(80);
    if (!focusRequests.isCurrentHistory(request)) return;
    focusSessions = sessions;
  } catch (error) {
    if (!focusRequests.isCurrentHistory(request)) return;
    focusSessions = null;
    focusHistoryError = focusCommandFailure(error).message;
  } finally {
    if (!focusRequests.isCurrentHistory(request)) return;
    focusHistoryLoading = false;
    renderFocusHistory();
    renderFocusStats();
  }
}

async function refreshFocusSurface(): Promise<void> {
  await Promise.all([loadFocusStatus(), loadFocusPresets(), loadFocusHistory()]);
}

focusHistoryRefresh.addEventListener("click", () => void loadFocusHistory());

function renderFocusHistory(): void {
  focusHistoryContent.replaceChildren();
  focusHistoryRefresh.disabled = focusHistoryLoading;
  if (focusHistoryLoading) {
    focusHistoryContent.append(empty("Caricamento registro…"));
    return;
  }
  if (focusHistoryError) {
    const state = empty(focusHistoryError);
    state.classList.add("error");
    focusHistoryContent.append(state);
    return;
  }
  if (!focusSessions || focusSessions.length === 0) {
    focusHistoryContent.append(empty("Ancora nessuna sessione registrata."));
    return;
  }
  for (const session of focusSessions) focusHistoryContent.append(historyRow(session));
}

function historyRow(session: PomodoroSession): HTMLElement {
  const row = document.createElement("article");
  row.className = "session";
  const body = document.createElement("div");
  body.className = "session-body";
  const title = document.createElement("strong");
  title.textContent = session.intention || KIND_LABEL[session.kind];
  const meta = document.createElement("span");
  const interval =
    session.resolved_at === null
      ? "in corso"
      : `intervallo ${formatDuration(session.resolved_at - session.started_at)}`;
  meta.textContent = `${formatDateTime(session.started_at)} · ${KIND_LABEL[session.kind]} · ${interval}`;
  body.append(title, meta);
  const outcome = document.createElement("span");
  outcome.className = `out ${session.outcome ?? "open"}`;
  outcome.textContent = session.outcome ? OUTCOME_LABEL[session.outcome] : "in corso";
  row.append(body, outcome);
  return row;
}

function renderFocusStats(): void {
  focusStatsContent.replaceChildren();
  if (focusHistoryLoading) {
    focusStatsContent.append(empty("Caricamento statistiche…"));
    return;
  }
  if (focusHistoryError) {
    const state = empty(focusHistoryError);
    state.classList.add("error");
    focusStatsContent.append(state);
    return;
  }
  if (!focusSessions || focusSessions.length === 0) {
    focusStatsContent.append(empty("Le statistiche appariranno dopo la prima sessione."));
    return;
  }

  const summary = historySummary(focusSessions);
  const scope = document.createElement("p");
  scope.className = "focus-scope";
  scope.textContent = summary.periodStart === null || summary.periodEnd === null
    ? `${summary.loadedSessions} sessioni caricate`
    : `${summary.loadedSessions} sessioni caricate · ${formatDate(summary.periodStart)}–${formatDate(summary.periodEnd)}`;

  const metrics = document.createElement("dl");
  metrics.className = "focus-metrics";
  appendMetric(metrics, "Focus conclusi", String(summary.closedFocusSessions));
  appendMetric(metrics, "Tempo pianificato", formatDuration(summary.plannedFocusMs));
  appendMetric(
    metrics,
    "Intervallo registrato",
    formatDuration(summary.recordedFocusSpanMs),
    "Include eventuali pause tecniche; il focus reale arriva dalle analytics dedicate.",
  );

  const outcomes = document.createElement("div");
  outcomes.className = "focus-outcomes";
  for (const name of ["completed", "partial", "interrupted", "invalidated"] as const) {
    const line = document.createElement("span");
    line.textContent = `${OUTCOME_LABEL[name]} ${summary.outcomes[name]}`;
    outcomes.append(line);
  }
  focusStatsContent.append(scope, metrics, outcomes);
}

function appendMetric(
  list: HTMLDListElement,
  label: string,
  value: string,
  hint?: string,
): void {
  const row = document.createElement("div");
  const dt = document.createElement("dt");
  const dd = document.createElement("dd");
  dt.textContent = label;
  dd.textContent = value;
  row.append(dt, dd);
  if (hint) {
    const note = document.createElement("small");
    note.textContent = hint;
    row.append(note);
  }
  list.append(row);
}

function formatDuration(ms: number): string {
  const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  return fmtCountdown(safe);
}

const dateTimeFormatter = new Intl.DateTimeFormat("it-IT", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});
const dateFormatter = new Intl.DateTimeFormat("it-IT", { day: "2-digit", month: "short" });

function formatDateTime(epochMs: number): string {
  return dateTimeFormatter.format(new Date(epochMs));
}

function formatDate(epochMs: number): string {
  return dateFormatter.format(new Date(epochMs));
}

// ----------------------------------------------------------- impostazioni

const shortcutSettings = document.getElementById("shortcutSettings") as HTMLFormElement;
const shortcutSave = document.getElementById("shortcutSave") as HTMLButtonElement;
const shortcutStatus = document.getElementById("shortcutStatus")!;
const shortcutInputs: Record<FocusShortcutSettingKey, HTMLInputElement> = {
  "shortcut.focus.start_last": document.getElementById("shortcutStartLast") as HTMLInputElement,
  "shortcut.focus.pause_resume": document.getElementById("shortcutPauseResume") as HTMLInputElement,
  "shortcut.focus.extend_5": document.getElementById("shortcutExtend") as HTMLInputElement,
  "shortcut.focus.capture": document.getElementById("shortcutCapture") as HTMLInputElement,
  "shortcut.focus.finish": document.getElementById("shortcutFinish") as HTMLInputElement,
};
const shortcutKeys = Object.keys(shortcutInputs) as FocusShortcutSettingKey[];

function readShortcutDraft(): FocusShortcutSettings {
  return Object.fromEntries(
    shortcutKeys.map((key) => [key, shortcutInputs[key].value]),
  ) as FocusShortcutSettings;
}

function writeShortcutValues(values: FocusShortcutSettings): void {
  for (const key of shortcutKeys) shortcutInputs[key].value = values[key] ?? "";
}

const shortcutController = createShortcutSettingsController(
  {
    read: ipc.focusShortcutSettings,
    apply: ipc.focusShortcutSettingsApply,
  },
  {
    readDraft: readShortcutDraft,
    writeValues: writeShortcutValues,
    setBusy: (busy) => {
      shortcutSave.disabled = busy;
      for (const input of Object.values(shortcutInputs)) input.disabled = busy;
    },
    setStatus: (message, error) => {
      shortcutStatus.textContent = message;
      shortcutStatus.classList.toggle("error", error);
    },
  },
);

shortcutSettings.addEventListener("submit", (event) => {
  event.preventDefault();
  void shortcutController.save();
});

const creaturesBox = document.getElementById("creatures")!;
const setSober = document.getElementById("setSober") as HTMLInputElement;
const setScale = document.getElementById("setScale") as HTMLInputElement;
const scaleVal = document.getElementById("scaleVal") as HTMLSpanElement;
const setMonitor = document.getElementById("setMonitor") as HTMLSelectElement;
const setCorner = document.getElementById("setCorner") as HTMLSelectElement;
const resetPosition = document.getElementById("resetPosition") as HTMLButtonElement;
const positionResetStatus = document.getElementById("positionResetStatus")!;
const setAutoDnd = document.getElementById("setAutoDnd") as HTMLInputElement;
const setIdleSleep = document.getElementById("setIdleSleep") as HTMLInputElement;
const setFocus = document.getElementById("setFocus") as HTMLInputElement;
const setShort = document.getElementById("setShort") as HTMLInputElement;
const setLong = document.getElementById("setLong") as HTMLInputElement;
const setEvery = document.getElementById("setEvery") as HTMLInputElement;

function renderCreatures(selected: string): void {
  creaturesBox.replaceChildren();
  for (const m of CREATURE_META) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `creature${m.id === selected ? " on" : ""}`;
    const name = document.createElement("span");
    name.className = "cname";
    name.textContent = m.name;
    const species = document.createElement("span");
    species.className = "cspecies";
    species.textContent = m.species;
    const trait = document.createElement("span");
    trait.className = "ctrait";
    trait.textContent = m.trait;
    b.append(name, species, trait);
    b.addEventListener("click", async () => {
      await ipc.settingSet("buddy.creature", m.id);
      renderCreatures(m.id);
    });
    creaturesBox.append(b);
  }
}

async function renderSettings(): Promise<void> {
  const s = await ipc.settingsAll();
  renderCreatures(s["buddy.creature"] ?? "cotone");
  setSober.checked = s["buddy.mode"] === "sober";
  setScale.value = s["overlay.scale"] ?? "100";
  scaleVal.textContent = `${setScale.value}%`;
  setCorner.value = s["buddy.corner"] ?? "bottom-right";
  setAutoDnd.checked = s["dnd.auto_fullscreen"] !== "0";
  setIdleSleep.value = s["overlay.idle_sleep_min"] ?? "20";
  setFocus.value = s["pomodoro.focus_min"] ?? "25";
  setShort.value = s["pomodoro.short_min"] ?? "5";
  setLong.value = s["pomodoro.long_min"] ?? "20";
  setEvery.value = s["pomodoro.long_every"] ?? "4";

  // Il nome dispositivo è stabile tra riavvii; gli indici restano solo per
  // migrare le impostazioni scritte dalle versioni precedenti.
  try {
    const monitors = await ipc.monitorsList();
    setMonitor.replaceChildren();
    const def = document.createElement("option");
    def.value = "primary";
    def.textContent = "principale";
    setMonitor.append(def);
    for (const m of monitors) {
      const o = document.createElement("option");
      o.value = `name:${m.id}`;
      o.textContent = `${m.name} · ${m.width}×${m.height}${m.primary ? " (principale)" : ""}`;
      setMonitor.append(o);
    }
    const savedMonitor = s["overlay.monitor"] ?? "primary";
    const legacyIndex = /^\d+$/.test(savedMonitor) ? Number(savedMonitor) : null;
    setMonitor.value =
      legacyIndex !== null && monitors[legacyIndex]
        ? `name:${monitors[legacyIndex].id}`
        : savedMonitor;
    if (setMonitor.selectedIndex < 0) setMonitor.value = "primary";
  } catch {
    setMonitor.replaceChildren();
  }
}

function bindSetting(el: HTMLInputElement | HTMLSelectElement, key: string): void {
  el.addEventListener("change", () => {
    const value =
      el instanceof HTMLInputElement && el.type === "checkbox"
        ? el.checked
          ? key === "buddy.mode"
            ? "sober"
            : "1"
          : key === "buddy.mode"
            ? "full"
            : "0"
        : el.value;
    void ipc.settingSet(key, value);
  });
}

bindSetting(setSober, "buddy.mode");
bindSetting(setCorner, "buddy.corner");
bindSetting(setMonitor, "overlay.monitor");
resetPosition.addEventListener("click", async () => {
  resetPosition.disabled = true;
  positionResetStatus.classList.remove("error");
  positionResetStatus.textContent = "Ripristino…";
  try {
    await ipc.overlayPositionReset();
    positionResetStatus.textContent = "Fatto";
  } catch {
    positionResetStatus.classList.add("error");
    positionResetStatus.textContent = "Errore";
  } finally {
    resetPosition.disabled = false;
  }
});
setScale.addEventListener("input", () => {
  scaleVal.textContent = `${setScale.value}%`;
});
setScale.addEventListener("change", () => {
  void ipc.settingSet("overlay.scale", setScale.value);
});
bindSetting(setAutoDnd, "dnd.auto_fullscreen");
bindSetting(setIdleSleep, "overlay.idle_sleep_min");
bindSetting(setFocus, "pomodoro.focus_min");
bindSetting(setShort, "pomodoro.short_min");
bindSetting(setLong, "pomodoro.long_min");
bindSetting(setEvery, "pomodoro.long_every");

// ------------------------------------------------------------------ init

function empty(text: string): HTMLElement {
  const e = document.createElement("div");
  e.className = "empty";
  e.textContent = text;
  return e;
}

void ipc.on(EVT_NOTES_CHANGED, () => {
  void renderOpen();
  if (document.getElementById("tab-archive")!.classList.contains("on")) {
    void renderArchive();
  }
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") void ipc.closePanel();
});

void renderOpen();
void renderSettings();
void shortcutController.load();
const focusSurfaceBootstrap = createFocusSurfaceBootstrap({
  registerListener: () =>
    ipc.on<FocusStatus>(EVT_FOCUS_CHANGED, (status) => {
      applyAuthoritativeFocusStatus(status);
    }),
  loadInitialState: refreshFocusSurface,
  markSurfaceReady: () => ipc.surfaceReady("panel"),
});
void startFinishIntentBridge(
  (handler) => ipc.on(EVT_FOCUS_FINISH_INTENT, handler),
  () => focusSurfaceBootstrap.start(),
  consumeFinishShortcutIntent,
);
