/**
 * Pannello (§ 5.1): note aperte, archivio ricercabile, storico pomodoro,
 * impostazioni. Vive a richiesta, muore alla chiusura.
 */

import {
  CREATURE_META,
  EVT_NOTES_CHANGED,
  KIND_LABEL,
  OUTCOME_LABEL,
  fmtCountdown,
  type NoteView,
  type PomodoroSession,
  type PomodoroStatus,
} from "../shared/contracts";
import * as ipc from "../shared/ipc";

// ------------------------------------------------------------------ tabs

const tabs = document.getElementById("tabs")!;
tabs.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-tab]");
  if (!btn) return;
  for (const b of tabs.querySelectorAll("button")) b.classList.toggle("on", b === btn);
  for (const s of document.querySelectorAll<HTMLElement>(".tab")) {
    s.classList.toggle("on", s.id === `tab-${btn.dataset.tab}`);
  }
  if (btn.dataset.tab === "archive") void renderArchive();
  if (btn.dataset.tab === "pomodoro") void refreshPomodoro();
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

// --------------------------------------------------------------- pomodoro

const pomoActive = document.getElementById("pomoActive")!;
const pomoIdle = document.getElementById("pomoIdle")!;
const pomoKind = document.getElementById("pomoKind")!;
const pomoClock = document.getElementById("pomoClock")!;
const pomoLabel = document.getElementById("pomoLabel")!;
const pomoToday = document.getElementById("pomoToday")!;
const pomoTask = document.getElementById("pomoTask") as HTMLInputElement;
const historyList = document.getElementById("historyList")!;

let status: PomodoroStatus | null = null;

function applyStatus(s: PomodoroStatus): void {
  status = s;
  const active = s.active;
  pomoActive.hidden = !active;
  pomoIdle.hidden = !!active;
  if (active) {
    pomoKind.textContent = KIND_LABEL[active.kind];
    pomoLabel.textContent = active.label ?? "";
    tickClock();
  }
  pomoToday.textContent = `${s.focus_done_today} focus completati oggi · pausa lunga ogni ${s.config.long_every}`;
}

function tickClock(): void {
  if (status?.active) {
    pomoClock.textContent = fmtCountdown(status.active.ends_at - Date.now());
  }
}

setInterval(() => {
  tickClock();
  // la sessione può essere finita mentre il pannello è aperto
  if (status?.active && status.active.ends_at <= Date.now()) void refreshPomodoro();
}, 500);

async function refreshPomodoro(): Promise<void> {
  applyStatus(await ipc.pomodoroStatus());
  renderHistory(await ipc.pomodoroHistory(40));
}

function renderHistory(sessions: PomodoroSession[]): void {
  historyList.replaceChildren();
  if (sessions.length === 0) {
    historyList.append(empty("Ancora nessuna sessione."));
    return;
  }
  for (const s of sessions) {
    const row = document.createElement("div");
    row.className = "session";
    const left = document.createElement("span");
    const when = new Date(s.started_at);
    const hh = String(when.getHours()).padStart(2, "0");
    const mm = String(when.getMinutes()).padStart(2, "0");
    left.textContent = `${when.getDate()}/${when.getMonth() + 1} ${hh}:${mm} · ${KIND_LABEL[s.kind]}${s.label ? ` — ${s.label}` : ""}`;
    const out = document.createElement("span");
    out.className = `out ${s.outcome ?? ""}`;
    out.textContent = s.outcome ? OUTCOME_LABEL[s.outcome] : "in corso";
    row.append(left, out);
    historyList.append(row);
  }
}

document.getElementById("startFocus")!.addEventListener("click", async () => {
  applyStatus(await ipc.pomodoroStart("focus", pomoTask.value.trim() || undefined));
});
document.getElementById("startBreak")!.addEventListener("click", async () => {
  applyStatus(await ipc.pomodoroStart("short_break"));
});
document.getElementById("pomoAbort")!.addEventListener("click", async () => {
  applyStatus(await ipc.pomodoroAbort());
  renderHistory(await ipc.pomodoroHistory(40));
});

// ----------------------------------------------------------- impostazioni

const creaturesBox = document.getElementById("creatures")!;
const setSober = document.getElementById("setSober") as HTMLInputElement;
const setScale = document.getElementById("setScale") as HTMLInputElement;
const scaleVal = document.getElementById("scaleVal") as HTMLSpanElement;
const setMonitor = document.getElementById("setMonitor") as HTMLSelectElement;
const setCorner = document.getElementById("setCorner") as HTMLSelectElement;
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

  // schermi disponibili: «principale» più gli altri per indice
  try {
    const monitors = await ipc.monitorsList();
    setMonitor.replaceChildren();
    const def = document.createElement("option");
    def.value = "primary";
    def.textContent = "principale";
    setMonitor.append(def);
    for (const m of monitors) {
      const o = document.createElement("option");
      o.value = String(m.index);
      o.textContent = `${m.name} · ${m.width}×${m.height}${m.primary ? " (principale)" : ""}`;
      setMonitor.append(o);
    }
    setMonitor.value = s["overlay.monitor"] ?? "primary";
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
void refreshPomodoro();
void renderSettings();
void ipc.surfaceReady("panel");
