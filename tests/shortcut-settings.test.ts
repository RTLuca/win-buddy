import assert from "node:assert/strict";
import test from "node:test";

import {
  createShortcutSettingsController,
  startFinishIntentBridge,
} from "../ui/panel/shortcut-controller.ts";

const configured = {
  "shortcut.focus.start_last": "Ctrl+Alt+F",
  "shortcut.focus.pause_resume": "Ctrl+Alt+P",
  "shortcut.focus.extend_5": "Ctrl+Alt+5",
  "shortcut.focus.capture": "Ctrl+Alt+Space",
  "shortcut.focus.finish": "Ctrl+Alt+Enter",
};

test("shortcut settings expose loading then current values", async () => {
  const events: string[] = [];
  let values: Record<string, string> = {};
  const controller = createShortcutSettingsController(
    {
      read: async () => configured,
      apply: async (draft) => draft,
    },
    {
      readDraft: () => values,
      writeValues: (next) => { values = { ...next }; },
      setBusy: (busy) => events.push(`busy:${busy}`),
      setStatus: (message, error) => events.push(`status:${error}:${message}`),
    },
  );

  await controller.load();

  assert.deepEqual(values, configured);
  assert.deepEqual(events, ["busy:true", "status:false:Caricamento…", "status:false:", "busy:false"]);
});

test("successful save returns canonical values and reports success", async () => {
  let values = { ...configured, "shortcut.focus.start_last": " alt + ctrl + f " };
  let status = "";
  const controller = createShortcutSettingsController(
    { read: async () => configured, apply: async () => configured },
    {
      readDraft: () => values,
      writeValues: (next) => { values = { ...next }; },
      setBusy: () => {},
      setStatus: (message) => { status = message; },
    },
  );

  await controller.save();

  assert.deepEqual(values, configured);
  assert.equal(status, "Scorciatoie aggiornate.");
});

test("failed save keeps edits visible and reports the conflict", async () => {
  const edited = { ...configured, "shortcut.focus.pause_resume": "Ctrl+Alt+F" };
  let values = edited;
  let busy = false;
  let status = { message: "", error: false };
  const controller = createShortcutSettingsController(
    {
      read: async () => configured,
      apply: async () => { throw new Error("Combinazione duplicata"); },
    },
    {
      readDraft: () => values,
      writeValues: (next) => { values = { ...next }; },
      setBusy: (next) => { busy = next; },
      setStatus: (message, error) => { status = { message, error }; },
    },
  );

  await controller.save();

  assert.deepEqual(values, edited);
  assert.equal(busy, false);
  assert.deepEqual(status, { message: "Combinazione duplicata", error: true });
});

test("programmatic double submit starts only one settings transaction", async () => {
  let release!: (value: typeof configured) => void;
  const pending = new Promise<typeof configured>((resolve) => { release = resolve; });
  let calls = 0;
  const controller = createShortcutSettingsController(
    {
      read: async () => configured,
      apply: async () => { calls += 1; return pending; },
    },
    {
      readDraft: () => configured,
      writeValues: () => {},
      setBusy: () => {},
      setStatus: () => {},
    },
  );

  const first = controller.save();
  const second = controller.save();
  assert.equal(calls, 1);
  release(configured);
  await Promise.all([first, second]);
});

test("finish intent listener is installed before bootstrap and initial consume", async () => {
  const calls: string[] = [];
  let listener: (() => void) | null = null;

  await startFinishIntentBridge(
    async (handler) => { calls.push("listen"); listener = handler; },
    async () => { calls.push("bootstrap"); listener?.(); },
    async () => { calls.push("consume"); },
  );

  assert.deepEqual(calls, ["listen", "bootstrap", "consume", "consume"]);
});
