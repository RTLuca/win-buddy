/**
 * Il layer delle nuvolette: un solo fumetto per volta, ancorato alla testa.
 *
 * I promemoria arrivano in pila, uno alla volta (§ 7.3): le azioni stanno
 * dentro la nuvoletta — chiudere una nota non deve richiedere una finestra.
 * Quando non c'è una notifica, il fumetto mostra il countdown della sessione.
 */

import {
  fmtCountdown,
  type BubbleShow,
  type BuddyState,
  type StateChanged,
} from "../shared/contracts";
import * as ipc from "../shared/ipc";
import {
  createBubbleCommandHandler,
  focusCompletionPromptActions,
} from "./pomodoro-presentations";

type Anchor = { x: number; y: number };

export class BubbleLayer {
  private el: HTMLDivElement;
  private current: BubbleShow | null = null;
  private stateInfo: StateChanged = { state: "idle" };
  private timer = 0;
  private hiddenAll = false;
  // posizione smorzata del countdown: la creatura balla, la bolla no
  private sx: number | null = null;
  private sy: number | null = null;

  constructor(parent: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "bubble";
    parent.appendChild(this.el);
    // il countdown si ricalcola da `until − now`: nessun contatore
    this.timer = window.setInterval(() => this.renderState(), 500);
  }

  /** In modalità sobria le nuvolette non esistono: parla la pillola. */
  setVisible(visible: boolean): void {
    this.hiddenAll = !visible;
    this.el.style.display = visible ? "" : "none";
  }

  /** Notifica dal core: ha priorità sul countdown. */
  show(b: BubbleShow): boolean {
    this.current = b;
    this.render();
    return !this.hiddenAll && this.el.classList.contains("on");
  }

  dismiss(id: number): void {
    if (this.current && (this.current.id === id || id === 0)) {
      this.current = null;
      this.render();
    }
  }

  setState(s: StateChanged): void {
    this.stateInfo = s;
    this.render();
  }

  /** Il rettangolo del fumetto in pixel finestra, per l'hit-test. */
  rect(): { x: number; y: number; w: number; h: number } | null {
    if (!this.el.classList.contains("on")) return null;
    const r = this.el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }

  /**
   * Posiziona il fumetto. Le bolle con pulsanti NON seguono la testa che
   * balla: stanno ferme in alto al centro, altrimenti premere «Fatto»
   * durante un festeggiamento è tiro al bersaglio. Il countdown segue
   * l'ancora, ma smorzato e sempre dentro i bordi della finestra.
   */
  place(anchor: Anchor): void {
    if (this.hiddenAll || !this.el.classList.contains("on")) return;
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    const W = window.innerWidth;
    const H = window.innerHeight;

    let x: number;
    let y: number;
    if (this.current) {
      x = (W - w) / 2;
      y = 6;
      this.sx = null;
      this.sy = null;
    } else {
      const tx = anchor.x - w * 0.5;
      const ty = anchor.y - h - 12;
      this.sx = this.sx === null ? tx : this.sx + (tx - this.sx) * 0.15;
      this.sy = this.sy === null ? ty : this.sy + (ty - this.sy) * 0.15;
      x = this.sx;
      y = this.sy;
    }

    // mai tagliata: il fumetto resta dentro la finestra
    x = Math.min(Math.max(x, 4), Math.max(4, W - w - 4));
    y = Math.min(Math.max(y, 4), Math.max(4, H - h - 4));
    this.el.style.left = `${x}px`;
    this.el.style.top = `${y}px`;
  }

  private render(): void {
    if (this.current) {
      this.renderNotification(this.current);
    } else {
      this.renderState();
    }
  }

  private renderState(): void {
    if (this.current) return; // la notifica ha priorità
    const { state, until, label } = this.stateInfo;
    if ((state === "focus" || state === "break") && until) {
      const cap = state === "focus" ? (label ?? "Focus") : (label ?? "Pausa");
      this.el.innerHTML = "";
      this.el.append(el("span", "cap", cap), el("span", "mono", fmtCountdown(until - Date.now())));
      this.el.classList.remove("urgent");
      this.el.classList.add("on");
    } else {
      this.el.classList.remove("on", "urgent");
    }
  }

  private renderNotification(b: BubbleShow): void {
    this.el.innerHTML = "";
    if (b.position && b.position[1] > 1) {
      this.el.append(el("span", "cap", `promemoria ${b.position[0]} di ${b.position[1]}`));
    }
    this.el.append(el("div", "txt", b.text));

    const acts = document.createElement("div");
    acts.className = "acts";
    if (b.kind === "reminder") {
      acts.append(
        btn("Fatto", "primary", () => ipc.noteComplete(b.id)),
        btn("Rinvia 10′", "", () => ipc.noteSnooze(b.id, 10)),
        btn("+1h", "", () => ipc.noteSnooze(b.id, 60)),
      );
    } else if (b.kind === "summary") {
      acts.append(btn("Apri il pannello", "primary", () => ipc.openPanel()));
    } else if (b.kind === "break_prompt") {
      const actions = focusCompletionPromptActions(b.id, {
        completeWithBreak: ipc.focusCompleteWithBreak,
        completeWithoutBreak: ipc.focusCompleteWithoutBreak,
      });
      acts.append(
        ...actions.map((action) =>
          btn(
            action.label,
            action.className,
            createBubbleCommandHandler(
              action.command,
              () => this.dismiss(b.id),
              (error) => console.error("conclusione focus fallita", error),
            ),
          ),
        ),
      );
    } else {
      acts.append(btn("Ok", "primary", () => this.dismiss(b.id)));
      // un'informazione non deve restare a schermo per sempre
      window.setTimeout(() => this.dismiss(b.id), 20_000);
    }
    this.el.append(acts);

    this.el.classList.toggle("urgent", b.urgent);
    this.el.classList.add("on");
  }

  dispose(): void {
    clearInterval(this.timer);
  }
}

/** Etichetta di stato per la pillola sobria. */
export function stateLabel(state: BuddyState): string {
  switch (state) {
    case "focus":
      return "focus";
    case "break":
      return "pausa";
    case "alert":
      return "avviso";
    case "celebrate":
      return "fatto!";
    case "sleep":
      return "dorme";
    default:
      return "pronto";
  }
}

function el(tag: string, cls: string, text: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  e.textContent = text;
  return e;
}

function btn(label: string, cls: string, onClick: () => void | Promise<void>): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  if (cls) b.className = cls;
  b.textContent = label;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    void onClick();
  });
  return b;
}
