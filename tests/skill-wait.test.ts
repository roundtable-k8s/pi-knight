import test from "node:test";
import assert from "node:assert/strict";
import { skillsExpected, waitForSkills } from "../src/skill-wait.ts";

const missing = () => { throw new Error("ENOENT"); };

test("skillsExpected: empty value means none expected", () => {
  assert.equal(skillsExpected({ KNIGHT_SKILLS: "" }, missing), false);
  assert.equal(skillsExpected({}, () => ""), false);
  assert.equal(skillsExpected({}, () => " , \n"), false);
});

test("skillsExpected: categories or missing signal means expected", () => {
  assert.equal(skillsExpected({ KNIGHT_SKILLS: "security,shared" }, missing), true);
  assert.equal(skillsExpected({}, () => "shared"), true);
  assert.equal(skillsExpected({}, missing), true);
});

function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return { sleeps, now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; } };
}

test("waitForSkills: skips the wait when no skills are expected", async () => {
  const c = fakeClock();
  const logs: string[] = [];
  const n = await waitForSkills({ maxAttempts: 20, intervalMs: 3000, expected: false, load: () => 0, ...c, info: (m) => logs.push(m) });
  assert.equal(n, 0);
  assert.deepEqual(c.sleeps, []);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /skipped/);
});

test("waitForSkills: keeps polling until skills appear when expected", async () => {
  const c = fakeClock();
  let calls = 0;
  const n = await waitForSkills({ maxAttempts: 20, intervalMs: 3000, expected: true, load: () => (++calls >= 3 ? 5 : 0), ...c });
  assert.equal(n, 5);
  assert.deepEqual(c.sleeps, [3000, 3000]);
});

test("waitForSkills: gives up after maxAttempts when skills never arrive", async () => {
  const c = fakeClock();
  const n = await waitForSkills({ maxAttempts: 20, intervalMs: 3000, expected: true, load: () => 0, ...c });
  assert.equal(n, 0);
  assert.equal(c.sleeps.length, 19);
});
