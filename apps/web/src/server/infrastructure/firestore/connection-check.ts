import "server-only";
import { randomUUID } from "node:crypto";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

export async function verifyFirestoreEvent(): Promise<void> {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT;
  if (!projectId) throw new Error("A Firestore project is required.");

  const app = initializeApp({ projectId }, "firestore-check");
  const db = getFirestore(app);
  const ref = db.collection("functionChecks").doc(randomUUID());
  const challenge = randomUUID();
  let stopListening: (() => void) | undefined;
  let timeout: NodeJS.Timeout | undefined;

  try {
    await ref.create({ challenge });
    await new Promise<void>((resolve, reject) => {
      timeout = setTimeout(
        () =>
          reject(new Error("Firestore Function acknowledgement timed out.")),
        45_000,
      );
      stopListening = ref.onSnapshot((snapshot) => {
        if (snapshot.get("acknowledgement") === challenge) resolve();
      }, reject);
    });
  } finally {
    clearTimeout(timeout);
    stopListening?.();
    await ref.delete();
  }
}
