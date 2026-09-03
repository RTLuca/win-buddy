import assert from "node:assert/strict";
import test from "node:test";

import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import * as ipc from "../ui/shared/ipc.ts";

test("focus mutation wrappers send session identity with the expected revision", async () => {
  const browserGlobal = globalThis as typeof globalThis & { window?: typeof globalThis };
  browserGlobal.window = globalThis;
  const calls: Array<{ command: string; payload: Record<string, unknown> }> = [];
  mockIPC((command, payload) => {
    calls.push({ command, payload: (payload ?? {}) as Record<string, unknown> });
    return null;
  });

  try {
    await ipc.focusPause(8, 4, "telefono");
    await ipc.focusResume(8, 5);
    await ipc.focusAdjust(8, 5 * 60_000, 6);
    await ipc.focusOvertime(8, 7);
    await ipc.focusFinish(8, "interrupted", 8, "telefono");
  } finally {
    clearMocks();
    delete browserGlobal.window;
  }

  assert.deepEqual(calls, [
    {
      command: "focus_pause",
      payload: { sessionId: 8, expectedRevision: 4, reason: "telefono" },
    },
    {
      command: "focus_resume",
      payload: { sessionId: 8, expectedRevision: 5 },
    },
    {
      command: "focus_adjust",
      payload: { sessionId: 8, deltaMs: 5 * 60_000, expectedRevision: 6 },
    },
    {
      command: "focus_overtime",
      payload: { sessionId: 8, expectedRevision: 7 },
    },
    {
      command: "focus_finish",
      payload: {
        sessionId: 8,
        outcome: "interrupted",
        expectedRevision: 8,
        interruptionReason: "telefono",
      },
    },
  ]);
});

test("focus completion prompt wrappers send the durable event identity", async () => {
  const browserGlobal = globalThis as typeof globalThis & { window?: typeof globalThis };
  browserGlobal.window = globalThis;
  const calls: Array<{ command: string; payload: Record<string, unknown> }> = [];
  mockIPC((command, payload) => {
    calls.push({ command, payload: (payload ?? {}) as Record<string, unknown> });
    return null;
  });
  try {
    await ipc.focusCompleteWithBreak(41);
    await ipc.focusCompleteWithoutBreak(42);
  } finally {
    clearMocks();
    delete browserGlobal.window;
  }

  assert.deepEqual(calls, [
    { command: "focus_complete_with_break", payload: { eventId: 41 } },
    { command: "focus_complete_without_break", payload: { eventId: 42 } },
  ]);
});
