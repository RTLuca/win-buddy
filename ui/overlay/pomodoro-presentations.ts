import type { BubbleShow, PomodoroPresentation } from "../shared/contracts";

interface PresentationConsumer {
  render(event: PomodoroPresentation): void;
  acknowledge(id: number): Promise<unknown>;
  reportError?(error: unknown): void;
}

interface PresentationSource {
  subscribe(deliver: (event: PomodoroPresentation) => void): Promise<unknown>;
  replay(): Promise<readonly PomodoroPresentation[]>;
  consume(event: PomodoroPresentation): Promise<void>;
}

/** Registra la consegna live prima di chiedere il replay durevole di boot. */
export async function connectPomodoroPresentationSource({
  subscribe,
  replay,
  consume,
}: PresentationSource): Promise<void> {
  await subscribe((event) => {
    void consume(event);
  });
  const pending = await replay();
  for (const event of pending) void consume(event);
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
        text = "Tempo scaduto · chiudi il focus e scegli la pausa.";
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
      try {
        render(event);
      } catch (error) {
        report(error);
        return Promise.resolve();
      }

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
