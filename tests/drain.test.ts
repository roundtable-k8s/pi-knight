import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { waitForInflight } from "../src/drain.ts";
import { startHealthServer, stopHealthServer, setDraining } from "../src/health.ts";
import { startPullLoop, type PulledMsg } from "../src/nats.ts";
import type { KnightConfig } from "../src/config.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("drain on SIGTERM", () => {
  it("a long task survives the drain: heartbeats continue, result published, acked, no new fetches", async () => {
    let active = 0;
    let draining = false;
    const events: string[] = [];
    let heartbeats = 0;
    let fetchesAfterDrain = 0;
    let served = false;
    const mkMsg = (id: string): PulledMsg => ({
      data: new TextEncoder().encode(JSON.stringify({ task: `do ${id}`, taskId: id })),
      subject: `fleet-a.tasks.x.${id}`,
      ack: () => events.push(`ack:${id}`), working: () => { heartbeats++; }, term() {},
    });

    const puller = startPullLoop({
      freeSlots: () => (draining ? 0 : 1 - active),
      fetch: async () => {
        if (draining) fetchesAfterDrain++;
        const batch = served ? [] : [mkMsg("long")];
        served = true;
        if (batch.length === 0) await sleep(20);
        return (async function* () { yield* batch; })();
      },
      onTask: (d) => {
        active++;
        const hb = setInterval(() => d.working(), 20);
        void (async () => {
          await sleep(400); // the "long" task, outlives the SIGTERM below
          events.push(`result:${d.task.taskId}`);
          clearInterval(hb);
          d.ack();
          active--;
        })();
      },
      fetchExpiresMs: 20,
    });

    while (active === 0) await sleep(10);
    // --- SIGTERM: same sequence as the shutdown handler ---
    draining = true;
    await puller.stop();
    const hbAtSigterm = heartbeats;
    const left = await waitForInflight({ getActive: () => active, maxWaitMs: 5000, pollMs: 10 });

    assert.equal(left, 0);
    assert.deepEqual(events, ["result:long", "ack:long"], "result published before ack");
    assert.ok(heartbeats > hbAtSigterm, "kept heartbeating while draining");
    assert.equal(fetchesAfterDrain, 0);
  });

  it("gives up at the deadline and reports the tasks still running", async () => {
    const left = await waitForInflight({ getActive: () => 2, maxWaitMs: 60, pollMs: 10 });
    assert.equal(left, 2);
  });

  it("/ready reports draining with 503", async () => {
    const port = 18000 + Math.floor(Math.random() * 1000);
    startHealthServer({ knightName: "T", metricsPort: port } as unknown as KnightConfig);
    await sleep(50);
    setDraining(true);
    const res = await fetch(`http://127.0.0.1:${port}/ready`);
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { status: string }).status, "draining");
    setDraining(false);
    await stopHealthServer();
  });
});
