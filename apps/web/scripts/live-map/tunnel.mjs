import { spawn } from "node:child_process";

// No shell, no cloud credentials, no request logging. The invitation secret is
// in the fragment of a later link; cloudflared never receives it in a URL.
export function shareGuestPort(port, { ready, stopped }) {
  const child = spawn(
    "cloudflared",
    [
      "tunnel",
      "--config",
      "/dev/null",
      "--no-autoupdate",
      "--protocol",
      "http2",
      "--url",
      `http://127.0.0.1:${port}`,
    ],
    {
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let closed = false,
    origin = "",
    registered = false,
    delivered = false,
    tail = "";
  const timeout = setTimeout(() => {
    if (!delivered) child.kill();
  }, 35_000);
  function read(chunk) {
    tail = (tail + chunk.toString()).slice(-6000);
    origin ||=
      tail.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com(?=[\s|])/)?.[0] ??
      "";
    registered ||= tail.includes("Registered tunnel connection");
    if (!closed && !delivered && registered && origin) {
      delivered = true;
      clearTimeout(timeout);
      ready(origin);
    }
  }
  child.stdout.on("data", read);
  child.stderr.on("data", read);
  function done() {
    clearTimeout(timeout);
    if (!closed) {
      closed = true;
      stopped();
    }
  }
  child.once("error", done);
  child.once("exit", done);
  return () => {
    closed = true;
    clearTimeout(timeout);
    child.kill();
  };
}
