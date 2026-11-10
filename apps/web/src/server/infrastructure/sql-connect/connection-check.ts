import "server-only";
import { randomUUID } from "node:crypto";
import { initializeApp } from "firebase-admin/app";
import { getDataConnect } from "firebase-admin/data-connect";
import {
  connectorConfig,
  readConnectionCheck,
  removeConnectionCheck,
  writeConnectionCheck,
} from "./generated";

export async function verifyDatabaseConnection(): Promise<void> {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT;
  if (!projectId || process.env.DATA_CONNECT_EMULATOR_HOST) {
    throw new Error("A live SQL Connect project is required.");
  }
  // The Admin SDK reuses this named app and its ADC across requests.
  const app = initializeApp({ projectId }, "sql-connect");
  const db = getDataConnect(connectorConfig, app);
  const id = randomUUID();
  const marker = randomUUID();

  try {
    await writeConnectionCheck(db, { id, marker });
    const { data } = await readConnectionCheck(db, { id });
    if (data.connectionCheck?.marker !== marker) {
      throw new Error("SQL Connect readback did not match.");
    }
  } finally {
    // A failed write response can still mean that PostgreSQL committed the row.
    await removeConnectionCheck(db, { id });
  }
}
