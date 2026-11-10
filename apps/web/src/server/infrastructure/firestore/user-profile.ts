import "server-only";
import { initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

export async function ensureUserProfile(
  projectId: string,
  uid: string,
  displayName: string | null,
) {
  if (uid.includes("/")) throw new Error("Invalid user document ID.");
  const db = getFirestore(initializeApp({ projectId }, "user-auth"));
  const profile = db.collection("users").doc(uid);
  await db.runTransaction(async (transaction) => {
    const existing = await transaction.get(profile);
    if (!existing.exists) {
      transaction.create(profile, {
        displayName,
        createdAt: FieldValue.serverTimestamp(),
      });
    }
  });
}
