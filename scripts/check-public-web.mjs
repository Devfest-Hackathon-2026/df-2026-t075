import assert from "node:assert/strict";

const origin = new URL(process.argv[2]).origin;

async function request(path, status, method = "GET") {
  const response = await fetch(new URL(path, origin), {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(
    response.status,
    status,
    `${method} ${path} returned ${response.status}`,
  );
  return response;
}

const html = await (await request("/", 200)).text();
assert.ok(
  html.includes("<title>AInote</title>"),
  "Missing AInote landing page",
);
assert.ok(html.includes("デモを試す"), "Missing demo link");
assert.ok(
  html.includes("ログイン状態を確認しています"),
  "Missing Firebase sign-in",
);
const stylesheet = html.match(
  /href="(\/_next\/static\/[^"]+\.css(?:\?[^"]*)?)"/,
)?.[1];
assert.ok(stylesheet, "Missing Next.js stylesheet");
const css = await request(stylesheet, 200);
assert.ok(css.headers.get("content-type")?.includes("text/css"), "Missing CSS");
await request("/api/rooms", 401);
await request("/api/internal/function-check", 404, "POST");
await request("/api/internal/db-check", 404, "POST");
console.log(`AInote landing page, assets and API access verified at ${origin}`);
