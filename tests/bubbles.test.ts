import assert from "node:assert/strict";
import test from "node:test";

import {
  createBubbleCommandHandler,
  focusCompletionPromptActions,
} from "../ui/overlay/pomodoro-presentations.ts";

test("a rejected break action is reported and leaves its bubble visible", async () => {
  const dismissed: number[] = [];
  const errors: unknown[] = [];
  const action = createBubbleCommandHandler(
    async () => {
      throw new Error("command failed");
    },
    () => dismissed.push(41),
    (error) => errors.push(error),
  );

  await action();

  assert.deepEqual(dismissed, []);
  assert.equal(errors.length, 1);
});

test("a successful break action dismisses its bubble", async () => {
  const dismissed: number[] = [];
  const action = createBubbleCommandHandler(
    async () => {},
    () => dismissed.push(41),
    () => assert.fail("successful action must not be reported"),
  );

  await action();

  assert.deepEqual(dismissed, [41]);
});

test("focus completion prompt labels and dispatch both declare the completed outcome", async () => {
  const calls: Array<[string, number]> = [];
  const actions = focusCompletionPromptActions(41, {
    completeWithBreak: async (eventId) => {
      calls.push(["with_break", eventId]);
    },
    completeWithoutBreak: async (eventId) => {
      calls.push(["without_break", eventId]);
    },
  });

  assert.deepEqual(
    actions.map(({ label, className }) => ({ label, className })),
    [
      { label: "Completata · Pausa", className: "primary" },
      { label: "Completata · Salta", className: "" },
    ],
  );
  await actions[0].command();
  await actions[1].command();
  assert.deepEqual(calls, [
    ["with_break", 41],
    ["without_break", 41],
  ]);
});
