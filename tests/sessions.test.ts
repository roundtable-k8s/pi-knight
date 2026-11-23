import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, utimes, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideRunSession,
  pruneSessionFiles,
  selectSessionsToPrune,
  type SessionFile,
} from "../src/sessions.ts";

// --- decideRunSession (#31) ---

test("decideRunSession: no runId resets a used session (#53)", () => {
  for (const currentRunId of ["a", undefined]) {
    assert.equal(
      decideRunSession({ runId: undefined, currentRunId, hasSession: true, sessionPristine: false }),
      "reset",
    );
  }
  assert.equal(
    decideRunSession({ runId: "", currentRunId: "", hasSession: true, sessionPristine: false }),
    "reset",
  );
});

test("decideRunSession: no runId adopts a pristine pre-warmed session (#53)", () => {
  assert.equal(
    decideRunSession({ runId: undefined, currentRunId: undefined, hasSession: true, sessionPristine: true }),
    "adopt",
  );
});

test("decideRunSession: no runId with no session yet reuses (creates one)", () => {
  assert.equal(
    decideRunSession({ runId: undefined, currentRunId: undefined, hasSession: false, sessionPristine: false }),
    "reuse",
  );
});

test("decideRunSession: tasks in the same run share the session", () => {
  assert.equal(
    decideRunSession({ runId: "a", currentRunId: "a", hasSession: true, sessionPristine: false }),
    "reuse",
  );
});

test("decideRunSession: a new run resets a used session", () => {
  assert.equal(
    decideRunSession({ runId: "b", currentRunId: "a", hasSession: true, sessionPristine: false }),
    "reset",
  );
  // First run after a restart: the pre-warmed session already has history → still fresh.
  assert.equal(
    decideRunSession({ runId: "b", currentRunId: undefined, hasSession: true, sessionPristine: false }),
    "reset",
  );
});

test("decideRunSession: a new run adopts a pristine pre-warmed session", () => {
  assert.equal(
    decideRunSession({ runId: "b", currentRunId: undefined, hasSession: true, sessionPristine: true }),
    "adopt",
  );
});

test("decideRunSession: nothing to reset when no session exists yet", () => {
  assert.equal(
    decideRunSession({ runId: "b", currentRunId: "a", hasSession: false, sessionPristine: false }),
    "reuse",
  );
});

// --- selectSessionsToPrune ---

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;
const file = (name: string, ageDays: number): SessionFile => ({
  id: name,
  path: `/s/${name}.jsonl`,
  sizeBytes: 1,
  mtimeMs: NOW - ageDays * DAY,
});

test("selectSessionsToPrune caps the count, newest kept", () => {
  const files = [file("a", 0), file("b", 1), file("c", 2), file("d", 3)];
  const out = selectSessionsToPrune(files, { maxFiles: 2, maxAgeMs: 0 }, new Set(), NOW);
  assert.deepEqual(out.map((f) => f.id), ["c", "d"]);
});

test("selectSessionsToPrune drops files older than maxAge", () => {
  const files = [file("a", 0), file("b", 10), file("c", 40)];
  const out = selectSessionsToPrune(files, { maxFiles: 0, maxAgeMs: 30 * DAY }, new Set(), NOW);
  assert.deepEqual(out.map((f) => f.id), ["c"]);
});

test("selectSessionsToPrune never selects the live session, even if old", () => {
  const files = [file("a", 0), file("b", 1), file("live", 50)];
  const out = selectSessionsToPrune(
    files,
    { maxFiles: 1, maxAgeMs: 30 * DAY },
    new Set(["/s/live.jsonl"]),
    NOW,
  );
  assert.deepEqual(out.map((f) => f.id), ["a", "b"]);
});

test("selectSessionsToPrune with both caps disabled keeps everything", () => {
  const files = [file("a", 0), file("b", 400)];
  assert.deepEqual(selectSessionsToPrune(files, { maxFiles: 0, maxAgeMs: 0 }, new Set(), NOW), []);
});

// --- pruneSessionFiles (filesystem) ---

test("pruneSessionFiles deletes over-cap session files under the sessions root", async () => {
  const root = await mkdtemp(join(tmpdir(), "pk-sessions-"));
  try {
    const dir = join(root, "--data--");
    await mkdir(dir);
    const names = ["2026-01-01_aaa.jsonl", "2026-01-02_bbb.jsonl", "2026-01-03_ccc.jsonl"];
    for (const [i, n] of names.entries()) {
      const p = join(dir, n);
      await writeFile(p, "{}\n");
      const t = new Date(Date.UTC(2026, 0, 1 + i));
      await utimes(p, t, t);
    }
    await writeFile(join(dir, "notes.txt"), "not a session");

    const removed = await pruneSessionFiles({ maxFiles: 1, maxAgeMs: 0 }, new Set(), root);
    assert.equal(removed.length, 2);
    assert.deepEqual((await readdir(dir)).sort(), ["2026-01-03_ccc.jsonl", "notes.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pruneSessionFiles is a no-op when the sessions root does not exist", async () => {
  const removed = await pruneSessionFiles(
    { maxFiles: 1, maxAgeMs: DAY },
    new Set(),
    join(tmpdir(), "pk-sessions-does-not-exist"),
  );
  assert.deepEqual(removed, []);
});
