import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

const project = process.env.GOOGLE_CLOUD_PROJECT;
if (!project) throw new Error("Set GOOGLE_CLOUD_PROJECT.");
const service = process.env.WEB_SERVICE ?? "meeting-web";
const verifier =
  process.env.WEB_CHECK_INVOKER ??
  `meeting-verifier@${project}.iam.gserviceaccount.com`;

function gcloud(...args) {
  return execFileSync("gcloud", [...args, `--project=${project}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

const { status, spec } = JSON.parse(
  gcloud(
    "run",
    "services",
    "describe",
    service,
    "--region=asia-northeast1",
    "--format=json(status.url,spec.template.spec.containers)",
  ),
);
const secret = spec.template.spec.containers[0].env?.find(
  ({ name }) => name === "DB_CHECK_TOKEN",
)?.valueFrom?.secretKeyRef;
if (!secret?.name || !secret.key)
  throw new Error("Cloud Run must reference a version of the operator secret.");

const credentialsUrl = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(verifier)}:generateIdToken`;
const identity = await fetch(credentialsUrl, {
  method: "POST",
  headers: {
    authorization: `Bearer ${gcloud("auth", "print-access-token")}`,
    "x-goog-user-project": project,
    "content-type": "application/json",
  },
  body: JSON.stringify({ audience: status.url, includeEmail: true }),
  redirect: "error",
  signal: AbortSignal.timeout(30_000),
});
if (!identity.ok)
  throw new Error(`Google IAM returned HTTP ${identity.status}.`);
const { token } = await identity.json();
const operator = gcloud(
  "secrets",
  "versions",
  "access",
  secret.key,
  `--secret=${secret.name}`,
);
const response = await fetch(
  new URL("/api/internal/function-check", status.url),
  {
    method: "POST",
    headers: {
      "x-serverless-authorization": `Bearer ${token}`,
      authorization: `Bearer ${operator}`,
    },
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
  },
);
if (!response.ok)
  throw new Error(`Cloud Run returned HTTP ${response.status}.`);
const result = await response.json();
assert.ok(
  result.status === "ok" && result.kind === "firestore-event-roundtrip",
  "Missing Function acknowledgement.",
);
console.log("Cloud Run → Firestore → Function → Cloud Run: OK");
