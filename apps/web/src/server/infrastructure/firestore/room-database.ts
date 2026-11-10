import "server-only";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

export function roomDatabase(projectId: string) {
  return getFirestore(initializeApp({ projectId }, "user-auth"));
}
