import { onDocumentCreated } from "firebase-functions/v2/firestore";

export const confirmFirestoreCheck = onDocumentCreated(
  {
    document: "functionChecks/{checkId}",
    region: "asia-northeast1",
    serviceAccount: "meeting-events@",
    maxInstances: 2,
    retry: false,
  },
  async (event) => {
    const created = event.data;
    const challenge = created?.get("challenge");
    if (typeof challenge !== "string") return;

    try {
      // Only acknowledge the exact document version that generated this event.
      await created.ref.update(
        { acknowledgement: challenge },
        { lastUpdateTime: created.updateTime },
      );
    } catch (error) {
      // NOT_FOUND or FAILED_PRECONDITION: already cleaned up or acknowledged.
      if (error?.code === 5 || error?.code === 9) return;
      throw new Error("The Firestore check could not be acknowledged.");
    }
  },
);
