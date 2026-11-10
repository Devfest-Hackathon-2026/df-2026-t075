import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { HomeBack, SiteBar } from "@/client/components/blocks";
import type { DiscussionGraph, Utterance } from "@/client/discussion-map/types";
import { MapDemo } from "@/client/preview/map/demo";
import type { MapRecording } from "@/client/preview/map/vertex-replay";

export async function MapDemoScreen({
  initialMode,
}: {
  initialMode: "example" | "vertex";
}) {
  const samples = resolve(process.cwd(), "../../tests/fixtures/meetmap");
  const [script, snapshot, result] = await Promise.all([
    readFile(resolve(samples, "venue-selection.ja.jsonl"), "utf8"),
    readFile(resolve(samples, "venue-selection.u16.graph.json"), "utf8"),
    readFile(
      resolve(
        process.cwd(),
        "src/client/preview/map/venue-selection.vertex.json",
      ),
      "utf8",
    ),
  ]);
  const utterances: Utterance[] = script
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  const checkpoint: DiscussionGraph & { throughUtteranceId: string } =
    JSON.parse(snapshot);
  const recording: MapRecording = JSON.parse(result);
  if (
    recording.steps.length !== utterances.length ||
    !utterances.every(
      (turn, index) => turn.id === recording.steps[index]?.throughUtteranceId,
    )
  )
    throw new Error("台本とAIの判定結果の発言順が一致しません。");

  return (
    <>
      <SiteBar />
      <main className="map-page shell">
        <HomeBack href="/" />
        <h1>議論マップ</h1>
        <p className="map-subject">ゼミの勉強会の会場選び</p>
        <MapDemo
          utterances={utterances}
          checkpoint={checkpoint}
          recording={recording}
          initialMode={initialMode}
        />
      </main>
    </>
  );
}
