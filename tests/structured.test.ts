import test from "node:test";
import assert from "node:assert/strict";
import { extractStructured, parseVerdict } from "../src/structured.ts";

const call = (id: string, command: string) => ({
  role: "assistant",
  content: [{ type: "toolCall", id, name: "bash", arguments: { command } }],
});
const res = (id: string, text: string, isError = false) => ({
  role: "toolResult", toolCallId: id, content: [{ type: "text", text }], isError,
});
const URL1 = "https://github.com/roundtable-k8s/pi-knight/pull/71";

test("gh pr create yields an opened PR", () => {
  const s = extractStructured(
    [call("1", "git push -u origin rt/67 && gh pr create --title x --body y"), res("1", `Creating...\n${URL1}\n`)],
    "Done, see PR.",
  );
  assert.deepEqual(s.prs, [{ repo: "roundtable-k8s/pi-knight", number: 71, url: URL1, action: "opened" }]);
  assert.equal(s.verdict, undefined);
});

test("gh pr edit yields an updated PR; opened wins for the same PR", () => {
  const s = extractStructured(
    [call("1", "gh pr create -f"), res("1", URL1), call("2", "gh pr edit 71 --body z"), res("2", URL1)],
    "",
  );
  assert.equal(s.prs.length, 1);
  assert.equal(s.prs[0].action, "opened");
  const e = extractStructured([call("1", "gh pr edit 71 -R a/b --body z"), res("1", URL1)], "");
  assert.equal(e.prs[0].action, "updated");
});

test("failed gh commands are ignored", () => {
  const s = extractStructured([call("1", "gh pr create"), res("1", URL1, true)], "no PR");
  assert.deepEqual(s.prs, []);
});

test("falls back to PR URLs in the final message; push marks them updated", () => {
  const plain = extractStructured([], `Opened ${URL1}`);
  assert.deepEqual(plain.prs, [{ repo: "roundtable-k8s/pi-knight", number: 71, url: URL1 }]);
  const pushed = extractStructured(
    [call("1", "git push origin HEAD"), res("1", "remote: https://github.com/o/r/pull/new/branch")],
    `Pushed fixes to ${URL1}`,
  );
  assert.equal(pushed.prs[0].action, "updated");
  assert.equal(pushed.prs.length, 1);
});

test("verdict: last Verdict line wins, tolerant formatting", () => {
  assert.equal(parseVerdict("Verdict: needs changes\n...\nVerdict: SHIP IT"), "ship_it");
  assert.equal(parseVerdict("**Verdict:** Needs-Changes"), "needs_changes");
  assert.equal(parseVerdict("the verdict was ship it"), undefined);
  assert.equal(extractStructured([], "ok\nVerdict: ship it").verdict, "ship_it");
});
