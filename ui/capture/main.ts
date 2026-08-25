/**
 * Cattura rapida (§ 11): scorciatoia globale, una riga di testo, Invio.
 * Se questo percorso non è istantaneo la funzione note non viene usata.
 *
 * L'anteprima della scadenza la calcola il core («+2h → oggi 17:47»):
 * nessuna sorpresa al salvataggio.
 */

import * as ipc from "../shared/ipc";

const field = document.getElementById("field") as HTMLInputElement;
const chip = document.getElementById("chip") as HTMLSpanElement;
const picker = document.getElementById("picker") as HTMLInputElement;
const fallback = document.getElementById("fallback")!;

let previewTimer = 0;
let pickedMs: number | null = null;

function refreshPreview(): void {
  window.clearTimeout(previewTimer);
  previewTimer = window.setTimeout(async () => {
    const text = field.value.trim();
    if (!text || pickedMs !== null) return;
    try {
      const p = await ipc.capturePreview(text);
      if (p.matched && p.due_label) {
        chip.textContent = `${p.matched} → ${p.due_label}`;
        chip.hidden = false;
      } else {
        chip.textContent = "nessuna scadenza · resta un appunto";
        chip.hidden = text.length === 0;
      }
      chip.classList.toggle("urgent", p.urgent);
    } catch {
      chip.hidden = true;
    }
  }, 120);
}

function setPicked(ms: number | null, label?: string): void {
  pickedMs = ms;
  if (ms !== null && label) {
    chip.textContent = `⏰ ${label}`;
    chip.hidden = false;
  } else {
    refreshPreview();
  }
}

field.addEventListener("input", () => {
  pickedMs = null;
  picker.value = "";
  refreshPreview();
});

// ripiego (§ 11): tre pulsanti e un selettore — i pulsanti sono zucchero
// sui pattern del parser, quindi passano dallo stesso codice del testo
for (const b of fallback.querySelectorAll<HTMLButtonElement>("button[data-quick]")) {
  b.addEventListener("click", () => {
    const kw = b.dataset.quick!;
    field.value = `${field.value.replace(/\s+$/, "")} ${kw}`.trim();
    pickedMs = null;
    field.focus();
    refreshPreview();
  });
}

picker.addEventListener("change", () => {
  if (!picker.value) {
    setPicked(null);
    return;
  }
  const ms = new Date(picker.value).getTime();
  if (Number.isFinite(ms)) {
    setPicked(ms, picker.value.replace("T", " "));
  }
  field.focus();
});

async function submit(): Promise<void> {
  const text = field.value.trim();
  if (!text) {
    void ipc.captureCancel();
    return;
  }
  await ipc.captureSubmit(text, pickedMs);
  field.value = "";
  chip.hidden = true;
  // il core chiude la finestra dopo il salvataggio
}

field.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    void submit();
  } else if (e.key === "Escape") {
    e.preventDefault();
    void ipc.captureCancel();
  }
});

window.addEventListener("focus", () => field.focus());
void ipc.surfaceReady("capture");
field.focus();
