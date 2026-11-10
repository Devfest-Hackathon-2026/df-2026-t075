import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const binary = path.join(root, "node_modules/.bin/depcruise");

// Empty domain/application directories must not make the boundary check a no-op.
// Test the real checker against isolated source fixtures, without editing app code.
async function check(files, packages = []) {
  const dir = await mkdtemp(path.join(tmpdir(), "classroom-architecture-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(dir, "apps/web/src", name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    }
    await writeFile(
      path.join(dir, "apps/web/tsconfig.json"),
      JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
      }),
    );
    // Small local package fixtures verify SDK rules without installing an SDK.
    for (const name of packages) {
      const packageDirectory = path.join(dir, "node_modules", name);
      await mkdir(packageDirectory, { recursive: true });
      await writeFile(
        path.join(packageDirectory, "package.json"),
        JSON.stringify({ name, version: "0.0.0", types: "index.d.ts" }),
      );
      await writeFile(
        path.join(packageDirectory, "index.d.ts"),
        "export type Value = string;",
      );
    }
    return spawnSync(
      process.execPath,
      [
        binary,
        "apps/web/src",
        "--config",
        path.join(root, ".dependency-cruiser.cjs"),
      ],
      {
        cwd: dir,
        encoding: "utf8",
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("allows app to use client views and server composition, with inward server dependencies", async () => {
  const result = await check({
    "server/domain/value.ts": "export type Value = string;",
    "server/application/use-case.ts":
      "import type { Value } from '@/server/domain/value'; export type Input = Value;",
    "server/infrastructure/adapter.ts":
      "import type { Input } from '@/server/application/use-case'; export const adapt = (value: Input) => value;",
    "server/composition/root.ts":
      "export { adapt } from '@/server/infrastructure/adapter';",
    "client/types/view.ts": "export type View = string;",
    "client/components/view.ts":
      "import type { View } from '@/client/types/view'; export const view: View = 'ready';",
    "app/entry.ts": [
      "export { adapt } from '@/server/composition/root';",
      "export { view } from '@/client/components/view';",
      "export type { Value } from '@/server/domain/value';",
      "export type { Input } from '@/server/application/use-case';",
    ].join("\n"),
    "instrumentation.ts": "export { adapt } from '@/server/composition/root';",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

for (const [from, to, rule] of [
  ["server/domain", "server/application", "domain-is-independent"],
  ["server/domain", "server/infrastructure", "domain-is-independent"],
  [
    "server/application",
    "server/infrastructure",
    "application-only-depends-on-domain",
  ],
  [
    "app",
    "server/infrastructure",
    "presentation-uses-composition-not-adapters",
  ],
  [
    "server/infrastructure",
    "server/composition",
    "infrastructure-does-not-call-composition",
  ],
  ["server/composition", "app", "server-only-depends-on-defined-server-layers"],
  [
    "server/composition",
    "client",
    "server-only-depends-on-defined-server-layers",
  ],
  ["client", "server/domain", "client-only-depends-on-client-source"],
  ["client", "app", "client-only-depends-on-client-source"],
]) {
  test(`rejects ${from} -> ${to}, including type-only alias imports`, async () => {
    const result = await check({
      [`${to}/value.ts`]: "export type Value = string;",
      [`${from}/entry.ts`]: `import type { Value } from '@/${to}/value'; export type Leaked = Value;`,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, new RegExp(rule));
  });
}

test("rejects a client runtime import from server composition", async () => {
  const result = await check({
    "server/composition/root.ts": "export const value = 'server-only';",
    "client/view.ts": "export { value } from '@/server/composition/root';",
  });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stdout + result.stderr,
    /client-only-depends-on-client-source/,
  );
});

for (const [entry, intermediate, target, rule] of [
  [
    "app/entry.ts",
    "server/utils/adapter.ts",
    "server/infrastructure/adapter.ts",
    "presentation-uses-composition-not-adapters",
  ],
  [
    "server/infrastructure/entry.ts",
    "server/utils/helper.ts",
    "server/composition/root.ts",
    "server-only-depends-on-defined-server-layers",
  ],
  [
    "client/view.ts",
    "utils/shared.ts",
    "server/domain/value.ts",
    "client-only-depends-on-client-source",
  ],
]) {
  test(`rejects an indirect boundary bypass through ${intermediate}`, async () => {
    const modulePath = (file) => `@/${file.replace(/\.ts$/, "")}`;
    const result = await check({
      [target]: "export type Value = string;",
      [intermediate]: `export type { Value } from '${modulePath(target)}';`,
      [entry]: `import type { Value } from '${modulePath(intermediate)}'; export type Leaked = Value;`,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, new RegExp(rule));
  });
}

test("rejects instrumentation importing an adapter directly", async () => {
  const result = await check({
    "server/infrastructure/config.ts": "export const value = 'config';",
    "instrumentation.ts":
      "export { value } from '@/server/infrastructure/config';",
  });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stdout + result.stderr,
    /instrumentation-enters-through-composition/,
  );
});

test("allows the Firebase browser SDK in client", async () => {
  const result = await check(
    {
      "client/browser.ts":
        "import type { Value } from 'firebase'; export type BrowserValue = Value;",
    },
    ["firebase"],
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

for (const [layer, packageName, rule] of [
  ["server/domain", "firebase-admin", "domain-is-independent"],
  [
    "server/application",
    "firebase-admin",
    "application-only-depends-on-domain",
  ],
  ["app", "firebase", "external-services-live-in-infrastructure"],
  ["client", "firebase-admin", "client-does-not-import-server-sdks"],
]) {
  test(`rejects a ${packageName} type import from ${layer}`, async () => {
    const result = await check(
      {
        [`${layer}/entry.ts`]: `import type { Value } from '${packageName}'; export type Leaked = Value;`,
      },
      [packageName],
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, new RegExp(rule));
  });
}
