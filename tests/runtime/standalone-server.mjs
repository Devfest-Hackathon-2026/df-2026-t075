import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const serverFile = fileURLToPath(
  new URL(
    "../../apps/web/.next/standalone/apps/web/server.js",
    import.meta.url,
  ),
);

export async function startServer(t, environment = {}) {
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const { port } = reservation.address();
  await new Promise((resolve) => reservation.close(resolve));

  let output = "";
  let closed = false;
  const child = spawn(process.execPath, [serverFile], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      APP_LOG_LEVEL: "info",
      NEXT_TELEMETRY_DISABLED: "1",
      ...environment,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (output += chunk));
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      closed = true;
      resolve(code);
    });
  });
  t.after(async () => {
    if (closed) return;
    child.kill("SIGTERM");
    const forceStop = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try {
      await exited;
    } finally {
      clearTimeout(forceStop);
    }
  });

  return {
    url: `http://127.0.0.1:${port}/api/health`,
    exited,
    output: () => output,
    events: () =>
      output.split(/\r?\n/).flatMap((line) => {
        try {
          const event = JSON.parse(line);
          return event.service === "ai-classroom-web" ? [event] : [];
        } catch {
          return [];
        }
      }),
    async waitFor(predicate) {
      const deadline = Date.now() + 20_000;
      while (!predicate()) {
        assert.ok(!closed, `Server exited unexpectedly:\n${output}`);
        assert.ok(
          Date.now() < deadline,
          `Server did not become ready:\n${output}`,
        );
        await delay(25);
      }
    },
  };
}
