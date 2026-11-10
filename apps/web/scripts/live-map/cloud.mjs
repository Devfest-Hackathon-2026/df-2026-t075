import { readFile } from "node:fs/promises";
import { applicationDefault } from "firebase-admin/app";
import { classify, responseSchema } from "../map-classification/vertex.mjs";

// Use the same versioned definitions as the Firestore seed, without writing
// any real conversation into the persistent synthetic evaluation dataset.
export async function liveServices(project) {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project ?? ""))
    throw new Error("set-project");
  const credential = applicationDefault();
  const definition = JSON.parse(
    await readFile(
      new URL(
        "../../../../tests/fixtures/meetmap/classification.v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const schema = responseSchema(definition);
  return {
    async recognize(pcm, signal) {
      const token = await credential.getAccessToken();
      const res = await fetch(
        `https://us-speech.googleapis.com/v2/projects/${project}/locations/us/recognizers/_:recognize`,
        {
          method: "POST",
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
          headers: {
            authorization: "Bearer " + token.access_token,
            "x-goog-user-project": project,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            config: {
              explicitDecodingConfig: {
                encoding: "LINEAR16",
                sampleRateHertz: 16000,
                audioChannelCount: 1,
              },
              languageCodes: ["ja-JP"],
              model: "chirp_3",
            },
            content: pcm.toString("base64"),
          }),
        },
      );
      if (!res.ok) throw new Error("speech-http-" + res.status);
      const body = await res.json();
      return (body.results ?? [])
        .map((r) => r.alternatives?.[0]?.transcript ?? "")
        .join(" ")
        .trim();
    },
    async predict(heard, graph, signal) {
      return (
        await classify({
          credential,
          project,
          definition,
          schema,
          heard,
          graph,
          signal,
        })
      ).graph;
    },
  };
}
