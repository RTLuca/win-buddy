import type { BubbleShow, PomodoroPresentation } from "../shared/contracts";

interface PresentationConsumer {
  render(event: PomodoroPresentation): boolean;
  acknowledge(id: number): Promise<unknown>;
  reportError?(error: unknown): void;
}

interface PresentationSource {
  subscribe(deliver: (event: PomodoroPresentation) => void): Promise<unknown>;
  replay(): Promise<readonly PomodoroPresentation[]>;
  consume(event: PomodoroPresentation): Promise<void>;
  reportError?(error: unknown): void;
}

interface FocusCompletionCommands {
  completeWithBreak(eventId: number): Promise<unknown>;
  completeWithoutBreak(eventId: number): Promise<unknown>;
}

export interface FocusCompletionPromptAction {
  label: string;
  className: string;
  command(): Promise<unknown>;
}

export function focusCompletionPromptActions(
  eventId: number,
  commands: FocusCompletionCommands,
): FocusCompletionPromptAction[] {
  return [
    {
      label: "Completata · Pausa",
      className: "primary",
      command: () => commands.completeWithBreak(eventId),
    },
    {
      label: "Completata · Salta",
      className: "",
      command: () => commands.completeWithoutBreak(eventId),
    },
  ];
}

export function createBubbleCommandHandler(
  command: () => Promise<unknown>,
  dismiss: () => void,
  reportError: (error: unknown) => void = console.error,
): () => Promise<void> {
  return async () => {
    try {
      await command();
      dismiss();
    } catch (error) {
      try {
        reportError(error);
      } catch {
        // Il logger non deve trasformare il click in una rejection non gestita.
      }
    }
  };
}

/** Registra il live, poi accoda replay durevole e buffer live in ordine stabile. */
export async function connectPomodoroPresentationSource({
  subscribe,
  replay,
  consume,
  reportError = console.error,
}: PresentationSource): Promise<void> {
  const buffered: PomodoroPresentation[] = [];
  let bootstrapping = true;
  const report = (error: unknown): void => {
    try {
      reportError(error);
    } catch {
      // Un logger difettoso non deve interrompere il bootstrap.
    }
  };
  const deliver = async (event: PomodoroPresentation): Promise<void> => {
    try {
      await consume(event);
    } catch (error) {
      report(error);
    }
  };

  try {
    await subscribe((event) => {
      if (bootstrapping) {
        buffered.push(event);
      } else {
        void deliver(event);
      }
    });
  } catch (error) {
    report(error);
    return;
  }

  let pending: readonly PomodoroPresentation[] = [];
  try {
    pending = await replay();
  } catch (error) {
    report(error);
  }
  for (const event of pending) await deliver(event);
  while (buffered.length > 0) {
    await deliver(buffered.shift()!);
  }
  bootstrapping = false;
}

export function pomodoroPresentationBubble(event: PomodoroPresentation): BubbleShow {
  let text: string;
  let kind: BubbleShow["kind"] = "info";
  switch (event.kind) {
    case "prewarning":
      text = "Quasi finito · prepara la chiusura del focus.";
      break;
    case "ready_to_close":
      if (event.session_kind === "focus") {
        text = "Tempo scaduto · entrambe le scelte completano il focus.";
        kind = "break_prompt";
      } else {
        text = "Pausa pronta da chiudere.";
      }
      break;
    case "return_prompt":
      text = "Pausa finita · si riparte quando vuoi.";
      break;
    case "recovery_needed":
      text = "Sessione da verificare · controlla come si è conclusa.";
      break;
  }
  return { id: event.id, text, kind, urgent: false };
}

/**
 * Deduplica consegna live e replay di boot usando l'id durevole dell'outbox.
 * L'ack parte soltanto dopo che il consumer ha eseguito il render; un errore
 * lascia l'id ritentabile alla consegna successiva.
 */
export function createPomodoroPresentationConsumer({
  render,
  acknowledge,
  reportError = console.error,
}: PresentationConsumer): (event: PomodoroPresentation) => Promise<void> {
  const acknowledged = new Set<number>();
  const inFlight = new Map<number, Promise<void>>();
  let tail: Promise<void> | undefined;

  const report = (error: unknown): void => {
    try {
      reportError(error);
    } catch {
      // Il logging non deve bloccare gli eventi accodati.
    }
  };

  return (event) => {
    if (acknowledged.has(event.id)) return Promise.resolve();
    const existing = inFlight.get(event.id);
    if (existing) return existing;

    const run = (): Promise<void> => {
      let visible: boolean;
      try {
        visible = render(event);
      } catch (error) {
        report(error);
        return Promise.resolve();
      }
      if (!visible) return Promise.resolve();

      try {
        return Promise.resolve(acknowledge(event.id))
          .then(() => {
            acknowledged.add(event.id);
          })
          .catch(report);
      } catch (error) {
        report(error);
        return Promise.resolve();
      }
    };

    const current = tail ? tail.then(run) : run();
    let queued: Promise<void>;
    queued = current.finally(() => {
      inFlight.delete(event.id);
      if (tail === queued) tail = undefined;
    });
    inFlight.set(event.id, queued);
    tail = queued;
    return queued;
  };
}
