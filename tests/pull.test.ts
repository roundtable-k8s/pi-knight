import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { AckPolicy, connect, type NatsConnection } from "nats";
import { connectNats, drain, publishResult, startPullLoop, subscribe, type PulledMsg, type TaskDelivery } from "../src/nats.ts";
import type { KnightConfig } from "../src/config.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("waitFor timed out");
    await sleep(25);
  }
}

describe("pull loop (fake fetch)", () => {
  const msg = (id: string): PulledMsg => ({
    data: new TextEncoder().encode(JSON.stringify({ task: `do ${id}`, taskId: id })),
    subject: `fleet-a.tasks.x.${id}`,
    ack() {}, working() {}, term() {},
  });

  it("requests exactly the number of free slots and nothing when full", async () => {
    let free = 0;
    const requests: number[] = [];
    const got: string[] = [];
    const puller = startPullLoop({
      freeSlots: () => free,
      fetch: async (max) => {
        requests.push(max);
        return (async function* () { for (let i = 0; i < max; i++) yield msg(`t${requests.length}-${i}`); })();
      },
      onTask: (d) => { got.push(d.task.taskId); free--; },
    });
    await sleep(100);
    assert.deepEqual(requests, [], "no fetch while no slot is free");
    free = 2;
    puller.wake();
    await waitFor(() => got.length === 2);
    assert.deepEqual(requests, [2]);
    free = 1; // one slot freed
    puller.wake();
    await waitFor(() => got.length === 3);
    assert.equal(requests[1], 1);
    await puller.stop();
  });

  it("terms empty payloads and acks filtered ones without running them", async () => {
    const calls: string[] = [];
    const mk = (body: string): PulledMsg => ({
      data: new TextEncoder().encode(body), subject: "fleet-a.tasks.x.1",
      ack: () => calls.push("ack"), working() {}, term: () => calls.push("term"),
    });
    let served = false;
    const ran: string[] = [];
    const puller = startPullLoop({
      freeSlots: () => 5,
      fetch: async () => {
        const batch = served ? [] : [mk(JSON.stringify({ task: "  " })), mk(JSON.stringify({ task: "hi", from: "me" }))];
        served = true;
        if (batch.length === 0) await sleep(50);
        return (async function* () { yield* batch; })();
      },
      accept: (t) => t.from !== "me",
      onTask: (d) => ran.push(d.task.task),
    });
    await waitFor(() => calls.length === 2);
    assert.deepEqual(calls, ["term", "ack"]);
    assert.deepEqual(ran, []);
    await puller.stop();
  });
});

const NATS_BIN = process.env["NATS_SERVER_BIN"] ?? ["/usr/local/bin/nats-server", "/usr/bin/nats-server"].find(existsSync) ?? "nats-server";

describe("pull consumer against a real nats-server", { skip: !hasBin(NATS_BIN) && "nats-server not found (set NATS_SERVER_BIN)" }, () => {
  let proc: ChildProcess;
  let dir: string;
  let admin: NatsConnection;
  const port = 4300 + Math.floor(Math.random() * 500);
  const config = {
    knightName: "Tester",
    natsUrl: `nats://127.0.0.1:${port}`,
    natsTasksStream: "TASKS",
    natsResultsPrefix: "fleet-a.results",
    subscribeTopics: ["fleet-a.tasks.tester.>"],
  } as unknown as KnightConfig;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "nats-"));
    proc = spawn(NATS_BIN, ["-js", "-p", String(port), "-sd", dir], { stdio: "ignore" });
    for (let i = 0; i < 100; i++) {
      try { admin = await connect({ servers: config.natsUrl }); break; } catch { await sleep(100); }
    }
    const jsm = await admin.jetstreamManager();
    await jsm.streams.add({ name: "TASKS", subjects: ["fleet-a.tasks.>", "fleet-a.results.>"] });
    await connectNats(config);
  });

  after(async () => {
    await drain().catch(() => {});
    await admin?.close().catch(() => {});
    proc?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  const publishTask = (id: string) =>
    admin.jetstream().publish(`fleet-a.tasks.tester.${id}`, new TextEncoder().encode(JSON.stringify({ task: `do ${id}`, taskId: id })));

  it("holds backlog in the stream (lag), takes the next task when a slot frees, and recovers a crashed task", async () => {
    for (const id of ["a", "b", "c", "d"]) await publishTask(id);

    let active = 0;
    const deliveries: TaskDelivery[] = [];
    const lost: string[] = [];
    const puller = await subscribe(config, {
      ackWaitMs: 1000,
      freeSlots: () => 1 - active,
      onTask: (d) => { active++; deliveries.push(d); },
      onLost: async (t) => {
        lost.push(t.taskId);
        await publishResult(t.taskId, { task_id: t.taskId, success: false, error: "lost" });
      },
    });

    await waitFor(() => deliveries.length === 1);
    await sleep(300);
    assert.equal(deliveries.length, 1, "only one slot, so only one task taken");
    const jsm = await admin.jetstreamManager();
    let info = await jsm.consumers.info("TASKS", "Tester-consumer");
    assert.equal(info.num_pending, 3, "lag reflects the backlog still in the stream");
    assert.equal(info.num_ack_pending, 1);
    assert.equal(info.config.max_deliver, 1);

    // heartbeats keep the task alive well past ack_wait (1s)
    const hb = setInterval(() => deliveries[0]!.working(), 300);
    await sleep(2500);
    clearInterval(hb);
    assert.deepEqual(lost, [], "in-progress acks prevent the task being declared lost");

    // finish -> slot frees -> next task is fetched
    deliveries[0]!.ack();
    active--;
    puller.wake();
    await waitFor(() => deliveries.length === 2);
    assert.equal(deliveries[1]!.task.taskId, "b");

    // "crash": task b is never acked and never heartbeats -> reported, not silently lost or re-run
    await waitFor(() => lost.length === 1, 10_000);
    assert.deepEqual(lost, ["b"]);
    const results = await admin.jetstream().consumers.get("TASKS", await (async () => {
      const ci = await jsm.consumers.add("TASKS", { filter_subject: "fleet-a.results.b", ack_policy: AckPolicy.None });
      return ci.name;
    })());
    const m = await results.next({ expires: 2000 });
    assert.equal(JSON.parse(new TextDecoder().decode(m!.data)).error, "lost");
    assert.equal(deliveries.filter((d) => d.task.taskId === "b").length, 1, "never redelivered");
    await puller.stop();
  });
});

function hasBin(bin: string): boolean {
  if (bin.includes("/")) return existsSync(bin);
  return (process.env["PATH"] ?? "").split(":").some((d) => existsSync(join(d, bin)));
}
