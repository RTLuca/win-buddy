import type { FocusShortcutSettings } from "../shared/contracts";

export interface ShortcutSettingsApi {
  read(): Promise<FocusShortcutSettings>;
  apply(settings: FocusShortcutSettings): Promise<FocusShortcutSettings>;
}

export interface ShortcutSettingsEffects {
  readDraft(): FocusShortcutSettings;
  writeValues(values: FocusShortcutSettings): void;
  setBusy(busy: boolean): void;
  setStatus(message: string, error: boolean): void;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return "Impossibile aggiornare le scorciatoie.";
}

export function createShortcutSettingsController(
  api: ShortcutSettingsApi,
  effects: ShortcutSettingsEffects,
) {
  let busy = false;

  async function load(): Promise<void> {
    if (busy) return;
    busy = true;
    effects.setBusy(true);
    effects.setStatus("Caricamento…", false);
    try {
      effects.writeValues(await api.read());
      effects.setStatus("", false);
    } catch (error) {
      effects.setStatus(errorMessage(error), true);
    } finally {
      busy = false;
      effects.setBusy(false);
    }
  }

  async function save(): Promise<void> {
    if (busy) return;
    busy = true;
    const draft = effects.readDraft();
    effects.setBusy(true);
    effects.setStatus("Applicazione…", false);
    try {
      effects.writeValues(await api.apply(draft));
      effects.setStatus("Scorciatoie aggiornate.", false);
    } catch (error) {
      // Gli input restano quelli letti prima della chiamata: il backend ha
      // già ripristinato binding e impostazioni attive.
      effects.setStatus(errorMessage(error), true);
    } finally {
      busy = false;
      effects.setBusy(false);
    }
  }

  return { load, save };
}

/** Installa prima il listener: un intent arrivato durante la creazione del
 * pannello viene consumato dall'evento; quello precedente dal consume finale. */
export async function startFinishIntentBridge(
  register: (handler: () => void) => Promise<unknown>,
  bootstrap: () => Promise<unknown>,
  consume: () => Promise<void>,
): Promise<void> {
  await register(() => {
    void consume();
  });
  await bootstrap();
  await consume();
}
