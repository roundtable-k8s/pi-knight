import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Scripts behind GITHUB_TOKEN_FILE support (roundtable-k8s/roundtable#194).
const scriptsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/github");
const helper = join(scriptsDir, "git-credential-roundtable");
const shim = join(scriptsDir, "gh");
const configure = join(scriptsDir, "configure-git.sh");

const TOKEN = "ghs_testtoken123";
const BASE_PATH = "/usr/local/bin:/usr/bin:/bin";

function tmp(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "gh-token-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runHelper(args: string[], input: string, env: Record<string, string>) {
  return spawnSync(helper, args, { input, encoding: "utf8", env: { PATH: BASE_PATH, ...env } });
}

const githubGet = "protocol=https\nhost=github.com\n\n";

test("credential helper answers get for github.com from the token file", (t) => {
  const dir = tmp(t);
  const file = join(dir, "token");
  writeFileSync(file, `${TOKEN}\n`);
  const r = runHelper(["get"], githubGet, { GITHUB_TOKEN_FILE: file });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, `username=x-access-token\npassword=${TOKEN}\n`);
  assert.equal(r.stderr, "");
});

test("credential helper re-reads the file on every call", (t) => {
  const dir = tmp(t);
  const file = join(dir, "token");
  writeFileSync(file, "ghs_old");
  assert.match(runHelper(["get"], githubGet, { GITHUB_TOKEN_FILE: file }).stdout, /password=ghs_old\n/);
  writeFileSync(file, "ghs_rotated");
  assert.match(runHelper(["get"], githubGet, { GITHUB_TOKEN_FILE: file }).stdout, /password=ghs_rotated\n/);
});

test("credential helper stays silent for other hosts, protocols, actions and missing files", (t) => {
  const dir = tmp(t);
  const file = join(dir, "token");
  writeFileSync(file, TOKEN);
  const cases: Array<[string[], string, Record<string, string>]> = [
    [["get"], "protocol=https\nhost=gitlab.com\n\n", { GITHUB_TOKEN_FILE: file }],
    [["get"], "protocol=http\nhost=github.com\n\n", { GITHUB_TOKEN_FILE: file }],
    [["store"], `${githubGet.trim()}\nusername=x\npassword=y\n\n`, { GITHUB_TOKEN_FILE: file }],
    [["erase"], githubGet, { GITHUB_TOKEN_FILE: file }],
    [["get"], githubGet, { GITHUB_TOKEN_FILE: join(dir, "missing") }],
    [["get"], githubGet, {}],
  ];
  for (const [args, input, env] of cases) {
    const r = runHelper(args, input, env);
    assert.equal(r.status, 0, `${args} ${input}`);
    assert.equal(r.stdout, "", `${args} ${input}`);
    assert.equal(r.stderr, "", `${args} ${input}`);
  }
  writeFileSync(file, "");
  assert.equal(runHelper(["get"], githubGet, { GITHUB_TOKEN_FILE: file }).stdout, "");
});

/** A fake gh that reports the GH_TOKEN it was given. */
function fakeGh(dir: string): string {
  const binDir = join(dir, "real-bin");
  mkdirSync(binDir, { recursive: true });
  const gh = join(binDir, "gh");
  writeFileSync(gh, '#!/bin/sh\necho "GH_TOKEN=${GH_TOKEN:-unset} args=$*"\n');
  chmodSync(gh, 0o755);
  return binDir;
}

/** The shim installed in its own dir, as the image does (/opt/roundtable/bin). */
function shimDir(dir: string): string {
  const d = join(dir, "shim-bin");
  mkdirSync(d, { recursive: true });
  symlinkSync(shim, join(d, "gh"));
  return d;
}

test("gh shim exports GH_TOKEN from the file per call and execs the real gh", (t) => {
  const dir = tmp(t);
  const file = join(dir, "token");
  writeFileSync(file, `${TOKEN}\n`);
  const PATH = [shimDir(dir), fakeGh(dir), BASE_PATH].join(":");
  const env = { PATH, GITHUB_TOKEN_FILE: file, GH_TOKEN: "ghp_stale_env" };

  const r = spawnSync("gh", ["pr", "create", "--fill"], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `GH_TOKEN=${TOKEN} args=pr create --fill\n`);
  assert.equal(r.stderr, "");

  writeFileSync(file, "ghs_rotated");
  assert.equal(execFileSync("gh", ["api", "user"], { encoding: "utf8", env }), "GH_TOKEN=ghs_rotated args=api user\n");
});

test("gh shim is a pass-through without GITHUB_TOKEN_FILE", (t) => {
  const dir = tmp(t);
  const PATH = [shimDir(dir), fakeGh(dir), BASE_PATH].join(":");
  const out = execFileSync("gh", ["status"], { encoding: "utf8", env: { PATH, GH_TOKEN: "ghp_env" } });
  assert.equal(out, "GH_TOKEN=ghp_env args=status\n");
});

test("gh shim falls back to env credentials when the file is unreadable, without printing tokens", (t) => {
  const dir = tmp(t);
  const PATH = [shimDir(dir), fakeGh(dir), BASE_PATH].join(":");
  const r = spawnSync("gh", ["status"], {
    encoding: "utf8",
    env: { PATH, GH_TOKEN: "ghp_env", GITHUB_TOKEN_FILE: join(dir, "missing") },
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "GH_TOKEN=ghp_env args=status\n");
  assert.match(r.stderr, /not readable/);
  assert.doesNotMatch(r.stderr, /ghp_env/);
});

test("gh shim reports 127 when no real gh exists", (t) => {
  const dir = tmp(t);
  // Only the shim on PATH: readlink/tr are not needed on this path.
  const shimBin = shimDir(dir);
  const r = spawnSync(join(shimBin, "gh"), ["status"], { encoding: "utf8", env: { PATH: shimBin } });
  assert.equal(r.status, 127);
  assert.match(r.stderr, /command not found/);
});

/** A PATH holding only the tools configure-git.sh needs (no gh). */
function toolsWithoutGh(dir: string): string {
  const d = join(dir, "tools");
  mkdirSync(d, { recursive: true });
  for (const tool of ["git", "rm", "chmod"]) {
    const found = execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();
    symlinkSync(found, join(d, tool));
  }
  return d;
}

function configureGit(dir: string, env: Record<string, string>): void {
  execFileSync("bash", ["-c", `set -eo pipefail; . "${configure}"`], {
    encoding: "utf8",
    env: { PATH: BASE_PATH, HOME: dir, ROUNDTABLE_CREDENTIAL_HELPER: helper, ...env },
  });
}

test("configure-git wires git to the token file so `git credential fill` gets the current token", (t) => {
  const dir = tmp(t);
  const file = join(dir, "token");
  writeFileSync(file, TOKEN);
  // A stale token-store file from an earlier boot is removed.
  writeFileSync(join(dir, ".git-credentials"), "https://x-access-token:ghp_old@github.com\n");
  configureGit(dir, { GITHUB_TOKEN_FILE: file });

  assert.equal(existsSync(join(dir, ".git-credentials")), false);
  const env = { PATH: BASE_PATH, HOME: dir, GITHUB_TOKEN_FILE: file, GIT_TERMINAL_PROMPT: "0" };
  const helpers = execFileSync("git", ["config", "--global", "--get-all", "credential.helper"], { encoding: "utf8", env });
  assert.equal(helpers.trim(), helper);

  const fill = () =>
    execFileSync("git", ["credential", "fill"], { input: githubGet, encoding: "utf8", env });
  assert.match(fill(), new RegExp(`username=x-access-token\npassword=${TOKEN}\n`));
  writeFileSync(file, "ghs_rotated");
  assert.match(fill(), /password=ghs_rotated\n/);

  // Idempotent across restarts: still exactly one helper.
  configureGit(dir, { GITHUB_TOKEN_FILE: file });
  const again = execFileSync("git", ["config", "--global", "--get-all", "credential.helper"], { encoding: "utf8", env });
  assert.equal(again.trim(), helper);
});

test("configure-git keeps the GH_TOKEN store fallback without GITHUB_TOKEN_FILE", (t) => {
  const dir = tmp(t);
  const PATH = toolsWithoutGh(dir);
  execFileSync("/bin/bash", ["-c", `set -eo pipefail; . "${configure}"`], {
    encoding: "utf8",
    env: { PATH, HOME: dir, GH_TOKEN: "ghp_env" },
  });
  const env = { PATH, HOME: dir };
  assert.equal(execFileSync("git", ["config", "--global", "credential.helper"], { encoding: "utf8", env }).trim(), "store");
  assert.equal(existsSync(join(dir, ".git-credentials")), true);
});
