"use client";

import { useEffect, useMemo, useState } from "react";
import { SymbolIcon } from "../../components/blocks";
import { DiscussionMap } from "../../discussion-map/discussion-map";
import { ResearchReferences } from "../../discussion-map/research-finding";
import {
  getSpeakerColors,
  SpeakerBadge,
} from "../../discussion-map/speaker-badge";
import type { DiscussionGraph, Utterance } from "../../discussion-map/types";
import { Dialog } from "../dialog";
import {
  type DemoRequest,
  questionForRequest,
  voiceExamples,
  withDemoResearch,
} from "./venue-research";
import { venueGraphAt } from "./venue-selection";
import { type MapRecording, vertexGraphAt } from "./vertex-replay";
import "./map-demo.css";

export function MapDemo({
  utterances,
  checkpoint,
  recording,
  initialMode,
}: {
  utterances: Utterance[];
  checkpoint: DiscussionGraph & { throughUtteranceId: string };
  recording: MapRecording;
  initialMode: "example" | "vertex";
}) {
  const [mode, setMode] = useState(initialMode);
  const [index, setIndex] = useState(() =>
    initialMode === "vertex"
      ? utterances.length - 1
      : Math.max(
          0,
          utterances.findIndex(
            (turn) => turn.id === checkpoint.throughUtteranceId,
          ),
        ),
  );
  const [choice, setChoice] = useState<string | null>(null);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [requests, setRequests] = useState<DemoRequest[]>([]);
  const speakerColors = useMemo(
    () => getSpeakerColors(utterances),
    [utterances],
  );
  const spoken = useMemo(
    () => utterances.slice(0, index + 1),
    [utterances, index],
  );
  const graph = useMemo(
    () =>
      mode === "vertex"
        ? vertexGraphAt(recording, index)
        : withDemoResearch(venueGraphAt(checkpoint, spoken), requests),
    [mode, recording, index, checkpoint, spoken, requests],
  );
  const pending = requests.find((request) => !request.done);
  useEffect(() => {
    if (!pending) return;
    // Keep playing the conversation while the example document is checked.
    const timer = window.setTimeout(() => {
      setRequests((items) =>
        items.map((item) =>
          item === pending ? { ...item, done: true } : item,
        ),
      );
    }, 1400);
    return () => window.clearTimeout(timer);
  }, [pending]);
  const examples = voiceExamples(graph);
  function requestResearch(id: string) {
    const question = questionForRequest(graph, id);
    if (!question) return;
    setRequests((items) =>
      items.some((item) => item.id === id)
        ? items
        : [...items, { id, turn: index, question, done: false }],
    );
    setChoice(id);
    setVoiceOpen(false);
  }
  const current = utterances[index]!;
  const latestSource = [...spoken]
    .reverse()
    .find((turn) =>
      graph.nodes.some((node) => node.sourceUtteranceIds.includes(turn.id)),
    );
  const suggested =
    graph.nodes.find(
      (node) =>
        (node.kind === "note" || node.kind === "action") &&
        node.sourceUtteranceIds[0] === current.id,
    ) ??
    graph.nodes.find(
      (node) =>
        latestSource && node.sourceUtteranceIds.includes(latestSource.id),
    );
  function go(next: number) {
    if (next < index)
      setRequests((items) => items.filter((item) => item.turn <= next));
    setIndex(next);
    setChoice(null);
  }
  function showMode(next: typeof mode) {
    if (next === mode) return;
    setMode(next);
    setChoice(null);
    setVoiceOpen(false);
    setRequests([]);
  }

  return (
    <>
      <div className="map-view-switch" role="group" aria-label="表示するマップ">
        <button
          type="button"
          aria-pressed={mode === "example"}
          onClick={() => showMode("example")}
        >
          正解例
        </button>
        <button
          type="button"
          aria-pressed={mode === "vertex"}
          onClick={() => showMode("vertex")}
        >
          AIの判定
        </button>
      </div>
      <section className="map-player panel" aria-label="会話台本の再生">
        <div className="map-turn">
          <div className="map-transcript" aria-live="polite" aria-atomic="true">
            <div className="map-byline">
              <span className="map-turn-index">
                発言 {index + 1} / {utterances.length}
              </span>
              <SpeakerBadge name={current.speaker} colors={speakerColors} />
            </div>
            <p>{current.text}</p>
          </div>
          <div className="map-step-actions">
            <button
              type="button"
              className="btn"
              disabled={index === 0}
              onClick={() => go(index - 1)}
            >
              <SymbolIcon name="back" /> 前の発言
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={index === utterances.length - 1}
              onClick={() => go(index + 1)}
            >
              次の発言 <SymbolIcon name="forward" />
            </button>
          </div>
        </div>
        <input
          aria-label="台本の発言位置"
          aria-valuetext={`全${utterances.length}発言中${index + 1}番目`}
          type="range"
          min={1}
          max={utterances.length}
          value={index + 1}
          onChange={(event) => go(Number(event.currentTarget.value) - 1)}
        />
        {mode === "example" && (
          <div className="map-demo-ask">
            <button
              type="button"
              className="btn"
              onClick={() => setVoiceOpen(true)}
            >
              <SymbolIcon name="mic" /> AIに話す
            </button>
            <p className="meta">
              発言例で頼むか、マップの未確認カードから調査を頼めます。資料はデモ用です。
            </p>
          </div>
        )}
      </section>
      <DiscussionMap
        graph={graph}
        utterances={spoken}
        speakerColors={speakerColors}
        selectedId={choice ?? suggested?.id ?? ""}
        onSelect={setChoice}
        {...(mode === "example" && {
          onRequestResearch: requestResearch,
          canResearch: (id: string) => !!questionForRequest(graph, id),
        })}
      />
      <ResearchReferences
        nodes={requests.flatMap(({ id }) =>
          graph.nodes.filter((node) => node.id === id),
        )}
      />
      {voiceOpen && (
        <Dialog title="AIに話す" onClose={() => setVoiceOpen(false)}>
          <p>デモではマイクの代わりに、この場面で話したいひと言を選びます。</p>
          <div className="map-voice-examples">
            {examples.map(({ id, speech }) => (
              <button
                type="button"
                key={id}
                className="btn"
                onClick={() => requestResearch(id)}
              >
                「{speech}」
              </button>
            ))}
            {!examples.length && (
              <p>
                この場面で頼める発言例はありません。台本を別の発言に進めると、ほかの質問を試せます。
              </p>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}
