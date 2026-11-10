import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./docker-check.sh", import.meta.url));

// Exercise the actual shell traps without needing Docker in the Web CI job.
async function runCheck(t, environment = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "docker-check-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const callsFile = path.join(directory, "calls.jsonl");
  const fakeCommand = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const command = tool === 'docker' ? args[args.indexOf('--file') + 2] : 'curl';
fs.appendFileSync(process.env.CHECK_CALLS, JSON.stringify({
  tool, command, args, port: process.env.WEB_PORT,
}) + '\\n');
if (command === process.env.CHECK_FAIL) process.exit(17);
if (command === 'up' && process.env.CHECK_SIGNAL) {
  process.kill(process.ppid, process.env.CHECK_SIGNAL);
}
if (command === 'port') process.stdout.write('127.0.0.1:54321\\n');
`;
  for (const command of ["docker", "curl"]) {
    await writeFile(path.join(directory, command), fakeCommand, {
      mode: 0o755,
    });
  }
  if (environment.CHECK_RMDIR_FAIL === "1") {
    await writeFile(path.join(directory, "rmdir"), "#!/bin/sh\nexit 23\n", {
      mode: 0o755,
    });
  }
  const result = spawnSync("bash", [script], {
    // Starting elsewhere also verifies that the script resolves its own root.
    cwd: directory,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      PATH: `${directory}${path.delimiter}${process.env.PATH}`,
      TMPDIR: directory,
      CHECK_CALLS: callsFile,
      // Existing Compose settings must not select a user's running project.
      COMPOSE_PROJECT_NAME: "normal-development",
      WEB_PORT: "8080",
      ...environment,
    },
  });
  assert.ifError(result.error);
  const calls = (await readFile(callsFile, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const composeCalls = calls.filter((call) => call.tool === "docker");
  const projects = composeCalls.map(
    (call) => call.args[call.args.indexOf("--project-name") + 1],
  );
  assert.equal(new Set(projects).size, 1);
  assert.match(projects[0], /^ai-classroom-check-[a-z0-9]+$/);
  assert.ok(composeCalls.every((call) => call.port === "0"));
  const cleanup = calls.filter((call) => call.command === "down");
  assert.equal(cleanup.length, 1);
  assert.deepEqual(cleanup[0].args.slice(-4), [
    "down",
    "--remove-orphans",
    "--rmi",
    "local",
  ]);
  return { result, calls };
}

test("successful checks probe the assigned port and clean their isolated project", async (t) => {
  const { result, calls } = await runCheck(t);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    calls.map((call) => call.command),
    ["build", "run", "up", "port", "curl", "down"],
  );
  assert.ok(
    calls
      .find((call) => call.command === "curl")
      .args.includes("http://127.0.0.1:54321/api/health"),
  );
});

for (const command of ["build", "run", "up", "port", "curl"]) {
  test(`a ${command} failure collects logs, cleans up and preserves the exit code`, async (t) => {
    const { result, calls } = await runCheck(t, { CHECK_FAIL: command });
    assert.equal(result.status, 17, result.stderr);
    assert.deepEqual(
      calls.slice(-2).map((call) => call.command),
      ["logs", "down"],
    );
  });
}

test("a cleanup failure makes an otherwise successful check fail", async (t) => {
  const { result } = await runCheck(t, { CHECK_FAIL: "down" });
  assert.equal(result.status, 1, result.stderr);
});

for (const [scenario, environment, expectedStatus] of [
  ["a successful check", {}, 1],
  ["a failed HTTP check", { CHECK_FAIL: "curl" }, 17],
  ["SIGINT", { CHECK_SIGNAL: "SIGINT" }, 130],
  ["SIGTERM", { CHECK_SIGNAL: "SIGTERM" }, 143],
]) {
  test(`an rmdir failure preserves the intended status after ${scenario}`, async (t) => {
    const { result } = await runCheck(t, {
      ...environment,
      CHECK_RMDIR_FAIL: "1",
    });
    assert.equal(result.status, expectedStatus, result.stderr);
  });
}

for (const [signal, status] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  test(`${signal} cleans up and returns the interruption status`, async (t) => {
    const { result, calls } = await runCheck(t, { CHECK_SIGNAL: signal });
    assert.equal(result.status, status, result.stderr);
    assert.deepEqual(
      calls.slice(-2).map((call) => call.command),
      ["logs", "down"],
    );
  });
}
