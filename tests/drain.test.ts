import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { describe, it } from "node:test";
import { createShutdown, installSignalHandlers, waitForInflight } from "../src/drain.ts";
import { startHealthServer, stopHealthServer, setDraining } from "../src/health.ts";
import { startPullLoop, type PulledMsg } from "../src/nats.ts";
import type { KnightConfig } from "../src/config.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

/** Wires the REAL createShutdown + installSignalHandlers + pull loop + health server to fakes for NATS/task. */
async function harness(opts: { taskMs: number; maxWaitMs: number; abortable?: boolean }) {
  const events: string[] = [];
  let active = 0;
  let shuttingDown = false;
  let fetches = 0;
  let fetchesAfterSigterm = 0;
  let served = false;
  let heartbeats = 0;
  let exitCode: number | null = null;
  const aborters: Array<() => void> = [];
  const port = await freePort();
  startHealthServer({ knightName: "T", metricsPort: port } as unknown as KnightConfig);

  const mkMsg = (id: string): PulledMsg => ({
    data: new TextEncoder().encode(JSON.stringify({ task: `do ${id}`, taskId: id })),
    subject: `fleet-a.tasks.x.${id}`,
    ack: () => events.push(`ack:${id}`), working: () => { heartbeats++; }, term() {},
  });
  const puller = startPullLoop({
    freeSlots: () => (shuttingDown ? 0 : 1 - active),
    fetch: async () => {
      fetches++;
      if (shuttingDown) fetchesAfterSigterm++;
      const batch = served ? [] : [mkMsg("long")];
      served = true;
      if (batch.length === 0) await sleep(20);
      return (async function* () { yield* batch; })();
    },
    onTask: (d) => {
      active++;
      const hb = setInterval(() => d.working(), 20);
      void (async () => {
        let aborted = false;
        await Promise.race([
          sleep(opts.taskMs), // the long fake task
          new Promise<void>((r) => aborters.push(() => { aborted = true; r(); })),
        ]);
        if (aborted) await sleep(50); // the failure result is published asynchronously
        events.push(`${aborted ? "failed" : "result"}:${d.task.taskId}`);
        clearInterval(hb);
        d.ack();
        active--;
      })();
    },
    fetchExpiresMs: 20,
  });

  const proc = new EventEmitter();
  const shutdown = createShutdown({
    setDraining: (d) => { shuttingDown = d; setDraining(d); },
    stopPulling: () => puller.stop(),
    getActive: () => active,
    maxWaitMs: opts.maxWaitMs,
    pollMs: 10,
    drainNats: async () => { events.push("nats-drain"); },
    cleanup: async () => { events.push("cleanup"); await stopHealthServer(); },
    exit: (code) => { events.push("exit"); exitCode = code; },
    ...(opts.abortable ? { abortInflight: () => { events.push("abort"); aborters.forEach((f) => f()); }, abortGraceMs: 2000 } : {}),
  });
  installSignalHandlers(shutdown, proc);

  return {
    events, port, proc,
    active: () => active,
    heartbeats: () => heartbeats,
    fetchesAfterSigterm: () => fetchesAfterSigterm,
    fetches: () => fetches,
    exitCode: () => exitCode,
  };
}

describe("drain on SIGTERM (real shutdown handler)", () => {
  it("SIGTERM mid-task: /ready 503, no new fetch, result published + acked, then NATS drain and exit", async () => {
    const h = await harness({ taskMs: 400, maxWaitMs: 5000 });
    while (h.active() === 0) await sleep(10);

    h.proc.emit("SIGTERM"); // exactly what the process signal path does
    await sleep(30);

    // Mid-drain: still running, not exited, /ready is 503 draining.
    assert.equal(h.exitCode(), null, "must not exit while a task is in flight");
    const res = await fetch(`http://127.0.0.1:${h.port}/ready`);
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { status: string }).status, "draining");
    const fetchesAtSigterm = h.fetches();
    const hbAtSigterm = h.heartbeats();

    while (h.exitCode() === null) await sleep(10);
    assert.deepEqual(h.events, ["result:long", "ack:long", "nats-drain", "cleanup", "exit"]);
    assert.equal(h.exitCode(), 0);
    assert.equal(h.fetchesAfterSigterm(), 0, "no fetch after SIGTERM");
    assert.ok(h.fetches() - fetchesAtSigterm <= 0, "no fetches during the drain");
    assert.ok(h.heartbeats() > hbAtSigterm, "kept heartbeating while draining");
    setDraining(false);
  });

  it("a second signal while draining does not re-run shutdown", async () => {
    const h = await harness({ taskMs: 150, maxWaitMs: 5000 });
    while (h.active() === 0) await sleep(10);
    h.proc.emit("SIGTERM");
    h.proc.emit("SIGINT");
    while (h.exitCode() === null) await sleep(10);
    assert.equal(h.events.filter((e) => e === "exit").length, 1);
    assert.equal(h.events.filter((e) => e === "nats-drain").length, 1);
    setDraining(false);
  });

  it("deadline: exits anyway after maxWaitMs, with the task still unfinished", async () => {
    const h = await harness({ taskMs: 2000, maxWaitMs: 80 });
    while (h.active() === 0) await sleep(10);
    h.proc.emit("SIGTERM");
    while (h.exitCode() === null) await sleep(10);
    assert.deepEqual(h.events, ["nats-drain", "cleanup", "exit"]);
    setDraining(false);
    await sleep(2100); // let the leaked fake task settle
  });

  it("forced path: aborted tasks publish their failure result before NATS drain and exit", async () => {
    const h = await harness({ taskMs: 5000, maxWaitMs: 60, abortable: true });
    while (h.active() === 0) await sleep(10);
    h.proc.emit("SIGTERM");
    while (h.exitCode() === null) await sleep(10);
    assert.deepEqual(h.events, ["abort", "failed:long", "ack:long", "nats-drain", "cleanup", "exit"]);
    setDraining(false);
  });

  it("waitForInflight reports tasks still running at the deadline", async () => {
    const left = await waitForInflight({ getActive: () => 2, maxWaitMs: 60, pollMs: 10 });
    assert.equal(left, 2);
  });
});
