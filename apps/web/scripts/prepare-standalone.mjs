import { cp } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(appRoot, ".next/standalone/apps/web");

// Next's standalone server does not copy public assets or compiled CSS/JS.
// Package them once so local start, E2E and Docker run the same output.
await cp(
  path.join(appRoot, ".next/static"),
  path.join(output, ".next/static"),
  {
    recursive: true,
  },
);
await cp(path.join(appRoot, "public"), path.join(output, "public"), {
  recursive: true,
});

// The same immutable image runs the Web and, with a separate command and
// service identity, the authenticated WebSocket service.
for (const file of [
  "run-member-map.mjs",
  "live-map/member-access.mjs",
  "live-map/member-gateway.mjs",
  "live-map/audio.mjs",
  "live-map/cloud.mjs",
  "live-map/discussion.mjs",
  "map-classification/vertex.mjs",
]) {
  await cp(
    path.join(appRoot, "scripts", file),
    path.join(output, "scripts", file),
  );
}
const require = createRequire(import.meta.url);
await cp(
  path.dirname(require.resolve("ws/package.json")),
  path.join(output, "node_modules/ws"),
  { recursive: true },
);
await cp(
  path.resolve(appRoot, "../../tests/fixtures/meetmap/classification.v1.json"),
  path.resolve(output, "../../tests/fixtures/meetmap/classification.v1.json"),
);
