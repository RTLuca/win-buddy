import assert from "node:assert/strict";
import test from "node:test";

import { createBubbleCommandHandler } from "../ui/overlay/pomodoro-presentations.ts";

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
