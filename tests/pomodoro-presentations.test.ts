import assert from "node:assert/strict";
import test from "node:test";

import {
  connectPomodoroPresentationSource,
  createPomodoroPresentationConsumer,
  pomodoroPresentationBubble,
} from "../ui/overlay/pomodoro-presentations.ts";

const presentation = {
  id: 41,
  session_id: 7,
  kind: "ready_to_close" as const,
  transition_revision: 3,
  session_kind: "focus" as const,
};

test("boot replay starts only after the live subscription is ready", async () => {
  const steps: string[] = [];
  let finishSubscription: (() => void) | undefined;
  const subscription = new Promise<void>((resolve) => {
    finishSubscription = resolve;
  });

  const connected = connectPomodoroPresentationSource({
    subscribe: async () => {
      steps.push("subscribe");
      await subscription;
    },
    replay: async () => {
      steps.push("replay");
      return [presentation];
    },
    consume: async (event) => {
      steps.push(`consume:${event.id}`);
    },
  });

  await Promise.resolve();
  assert.deepEqual(steps, ["subscribe"]);
  finishSubscription?.();
  await connected;
  assert.deepEqual(steps, ["subscribe", "replay", "consume:41"]);
});

test("live delivery and boot replay render and acknowledge the stable event once", async () => {
  const rendered: number[] = [];
  const acknowledged: number[] = [];
  let confirmAck: (() => void) | undefined;
  const pendingAck = new Promise<void>((resolve) => {
    confirmAck = resolve;
  });
  const consume = createPomodoroPresentationConsumer({
    render: (event) => {
      rendered.push(event.id);
      return true;
    },
    acknowledge: async (id) => {
      acknowledged.push(id);
      await pendingAck;
    },
  });

  const live = consume(presentation);
  const bootReplay = consume({ ...presentation });

  assert.deepEqual(rendered, [41]);
  assert.deepEqual(acknowledged, [41]);
  confirmAck?.();
  await Promise.all([live, bootReplay]);
  await consume({ ...presentation });
  assert.deepEqual(rendered, [41]);
  assert.deepEqual(acknowledged, [41]);
});

test("a failed acknowledgement permits retry with the same stable id", async () => {
  const rendered: number[] = [];
  const errors: unknown[] = [];
  let attempts = 0;
  const consume = createPomodoroPresentationConsumer({
    render: (event) => {
      rendered.push(event.id);
      return true;
    },
    acknowledge: async (id) => {
      assert.equal(id, 41);
      attempts += 1;
      if (attempts === 1) throw new Error("ack failed");
    },
    reportError: (error) => errors.push(error),
  });

  await consume(presentation);
  await consume({ ...presentation });

  assert.equal(attempts, 2);
  assert.deepEqual(rendered, [41, 41]);
  assert.equal(errors.length, 1);
});

test("pending presentations render one at a time before each acknowledgement", async () => {
  const rendered: number[] = [];
  const acknowledged: number[] = [];
  let confirmFirst: (() => void) | undefined;
  const firstAck = new Promise<void>((resolve) => {
    confirmFirst = resolve;
  });
  const consume = createPomodoroPresentationConsumer({
    render: (event) => {
      rendered.push(event.id);
      return true;
    },
    acknowledge: async (id) => {
      acknowledged.push(id);
      if (id === 41) await firstAck;
    },
  });

  const first = consume(presentation);
  const second = consume({ ...presentation, id: 42 });

  assert.deepEqual(rendered, [41]);
  assert.deepEqual(acknowledged, [41]);
  confirmFirst?.();
  await Promise.all([first, second]);
  assert.deepEqual(rendered, [41, 42]);
  assert.deepEqual(acknowledged, [41, 42]);
});

test("an invisible sober presentation stays pending instead of being acknowledged", async () => {
  const acknowledged: number[] = [];
  const consume = createPomodoroPresentationConsumer({
    render: () => false,
    acknowledge: async (id) => {
      acknowledged.push(id);
    },
  });

  await consume(presentation);

  assert.deepEqual(acknowledged, []);
});

test("a live event received during boot is queued after the durable replay", async () => {
  const consumed: number[] = [];
  let deliverLive: ((event: typeof presentation) => void) | undefined;

  await connectPomodoroPresentationSource({
    subscribe: async (deliver) => {
      deliverLive = deliver;
    },
    replay: async () => {
      deliverLive?.({ ...presentation, id: 42 });
      return [presentation];
    },
    consume: async (event) => {
      consumed.push(event.id);
    },
  });

  assert.deepEqual(consumed, [41, 42]);
});

test("subscription and replay failures are reported without rejecting startup", async () => {
  for (const failingPhase of ["subscribe", "replay"] as const) {
    const errors: unknown[] = [];
    await assert.doesNotReject(
      connectPomodoroPresentationSource({
        subscribe: async () => {
          if (failingPhase === "subscribe") throw new Error("subscribe failed");
        },
        replay: async () => {
          if (failingPhase === "replay") throw new Error("replay failed");
          return [];
        },
        consume: async () => {},
        reportError: (error) => errors.push(error),
      }),
    );
    assert.equal(errors.length, 1);
  }
});

test("a ready focus renders the legacy break actions with the outbox id", () => {
  assert.deepEqual(pomodoroPresentationBubble(presentation), {
    id: 41,
    text: "Tempo scaduto · chiudi il focus e scegli la pausa.",
    kind: "break_prompt",
    urgent: false,
  });
});

test("an explicitly shortened break never renders focus completion actions", () => {
  assert.deepEqual(
    pomodoroPresentationBubble({
      ...presentation,
      session_kind: "short_break",
    }),
    {
      id: 41,
      text: "Pausa pronta da chiudere.",
      kind: "info",
      urgent: false,
    },
  );
});
