"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { AiTile } from "../components/blocks";
import { characterErrors } from "./accuracy";
import { ProbeAudio } from "./audio";
import { connectProbe, ProbeFailure } from "./connection";
import type { Report } from "./connection";

const initialText = "来週の勉強会では、最初の15分で何を決めますか。";
type Result = { report: Report; browserMs: number | null };
export function VoiceProbe() {
  const active = useRef<AbortController | null>(null);
  const [phase, setPhase] = useState<
    "idle" | "joining" | "listening" | "thinking" | "answering"
  >("idle");
  const [key, setKey] = useState("");
  const [reference, setReference] = useState(initialText);
  const [recording, setRecording] = useState<File>();
  const [consent, setConsent] = useState(false);
  const [captions, setCaptions] = useState({ user: "", ai: "" });
  const [score, setScore] = useState<ReturnType<typeof characterErrors>>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const running = phase !== "idle";
  useEffect(
    () => () => {
      active.current?.abort();
    },
    [],
  );

  function cancel() {
    active.current?.abort();
    active.current = null;
    setPhase("idle");
  }
  async function start(event: FormEvent) {
    event.preventDefault();
    if (active.current || !consent || !key) return;
    const call = new AbortController();
    active.current = call;
    setPhase("joining");
    setError("");
    setResult(null);
    setScore(null);
    setCaptions({ user: "", ai: "" });
    const current = () => active.current === call && !call.signal.aborted;
    const deadline = window.setTimeout(() => {
      if (current()) {
        cancel();
        setError("制限時間に達しました。もう一度試してください。");
      }
    }, 100_000);
    let audio: ProbeAudio | undefined;
    const releaseAudio = () => {
      void audio?.close();
    };
    call.signal.addEventListener("abort", releaseAudio, { once: true });
    try {
      audio = new ProbeAudio();
      await audio.resume().catch(() => {
        throw new ProbeFailure("audio");
      });
      call.signal.throwIfAborted();
      const measured = await connectProbe(
        key,
        call.signal,
        audio,
        {
          ready() {
            if (current()) setPhase("listening");
          },
          caption(speaker, text) {
            if (!current()) return;
            setCaptions((old) => ({ ...old, [speaker]: text }));
            if (speaker === "user") setScore(characterErrors(reference, text));
            setPhase(speaker === "user" ? "thinking" : "answering");
          },
        },
        recording,
      );
      if (current()) setResult(measured);
    } catch (cause) {
      if (current())
        setError(
          cause instanceof ProbeFailure
            ? cause.message
            : "接続できませんでした。マイクと接続先を確認してください。",
        );
    } finally {
      window.clearTimeout(deadline);
      call.signal.removeEventListener("abort", releaseAudio);
      await audio?.close();
      if (current()) {
        active.current = null;
        setPhase("idle");
      }
    }
  }
  return (
    <main className="shell form-page voice-probe">
      <h1>声でノトに話しかける</h1>
      <p>運用者用の音声テストです。一文話すと、ノトが声と字幕で返します。</p>
      <form onSubmit={start} className="form-panel probe-form">
        <label className="field">
          検証キー
          <input
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            disabled={running}
            required
          />
        </label>
        <label className="field">
          読み上げる原稿
          <input
            maxLength={200}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            disabled={running}
            placeholder="自由に話す場合は空欄"
          />
        </label>
        <label className="field">
          比較用の録音（任意・20秒以内）
          <input
            type="file"
            accept="audio/*,.wav"
            disabled={running}
            onChange={(event) => setRecording(event.target.files?.[0])}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={consent}
            disabled={running}
            onChange={(e) => setConsent(e.target.checked)}
          />{" "}
          18歳以上です。音声をLiveKit・Google
          Cloudに送り、文字起こしとAIの応答に使うことに同意します。
        </label>
        {running ? (
          <button type="button" className="btn" onClick={cancel}>
            中止する
          </button>
        ) : (
          <button className="btn primary" disabled={!key || !consent}>
            音声テストを始める
          </button>
        )}
      </form>
      <div className="probe-conversation">
        <AiTile state={phase === "thinking" ? "thinking" : "listening"} />
        <div>
          <p role="status">
            {
              {
                idle: result ? "測定が終わりました" : "待機中",
                joining: "ノトの入室を待っています…",
                listening: recording
                  ? "録音を送信しています…"
                  : "どうぞ。20秒以内で一文話してください。",
                thinking: "返答を考えています…",
                answering: "返答を読み上げます",
              }[phase]
            }
          </p>
          {captions.user && (
            <p>
              <strong>あなた　</strong>
              {captions.user}
            </p>
          )}
          {captions.ai && (
            <p aria-live="polite">
              <strong>ノト　</strong>
              {captions.ai}
            </p>
          )}
          {error && <p role="alert">{error}</p>}
        </div>
      </div>
      {score && (
        <p>
          日本語の文字誤り率（CER）　
          {((score.edits / score.characters) * 100).toFixed(1)}%（{score.edits}
          文字の誤り／原稿{score.characters}文字）
        </p>
      )}
      {result && <Measurements {...result} score={score} />}
    </main>
  );
}

function Measurements({
  report: r,
  browserMs,
  score,
}: Result & { score: ReturnType<typeof characterErrors> }) {
  // Export only the allowed model settings and numeric fields. The download must never include captions or the test key.
  const metrics = {
    reply_model: r.reply_model ?? null,
    reply_thinking: r.reply_thinking ?? null,
    browser_voice_latency_ms: browserMs,
    worker_voice_latency_ms: r.voice_latency_ms,
    endpoint_ms: r.endpoint_ms,
    stt_ms: r.stt_ms,
    gemini_ms: r.gemini_ms,
    tts_first_ms: r.tts_first_ms,
    character_errors: score?.edits ?? null,
    reference_characters: score?.characters ?? null,
    window_s: r.window_s,
    stt_audio_s: r.stt_audio_s,
    gemini_input_tokens: r.llm_tokens?.prompt ?? null,
    gemini_cached_tokens: r.llm_tokens?.cached ?? null,
    gemini_output_tokens: r.llm_tokens?.output ?? null,
    gemini_thought_tokens: r.llm_tokens?.thoughts ?? null,
    tts_input_tokens: r.tts_tokens?.prompt ?? null,
    tts_output_tokens: r.tts_tokens?.output ?? null,
    google_usd_per_min: r.google_usd_per_min,
    google_usd_per_trial:
      r.google_usd_per_min === null
        ? null
        : (r.google_usd_per_min * r.window_s) / 60,
  };
  return (
    <section className="form-panel probe-form">
      <h2>今回の測定</h2>
      <dl>
        <dt>返答モデル</dt>
        <dd>{r.reply_model ?? "未記録"}</dd>
        <dt>思考レベル</dt>
        <dd>
          {r.reply_thinking === "default"
            ? "指定なし（モデルに任せる）"
            : (r.reply_thinking ?? "未記録")}
        </dd>
        <dt>発話終了からブラウザで返答音を検出するまで</dt>
        <dd>
          {browserMs === null
            ? "音量または計測条件を確認できず未計測"
            : `${browserMs} ms`}
        </dd>
        <dt>発話終了からワーカーが音声を送り始めるまで</dt>
        <dd>{r.voice_latency_ms} ms</dd>
        <dt>Googleの推定費用／会話1分</dt>
        <dd>
          {r.google_usd_per_min === null
            ? "トークン数が取得できず未算出"
            : `US$ ${r.google_usd_per_min.toFixed(5)}`}
        </dd>
      </dl>
      <details>
        <summary>処理時間と使用量</summary>
        <p>
          発話の区切り {r.endpoint_ms} ms ／ 文字起こし {r.stt_ms} ms ／ Gemini{" "}
          {r.gemini_ms} ms ／ TTSの最初の音声 {r.tts_first_ms} ms
        </p>
        <p>
          計測時間 {r.window_s.toFixed(2)} 秒 ／ 認識に送った音声{" "}
          {r.stt_audio_s.toFixed(2)} 秒
        </p>
        <p>
          Gemini入力・出力{" "}
          {r.llm_tokens
            ? `${r.llm_tokens.prompt}・${r.llm_tokens.output}` +
              (r.llm_tokens.thoughts === undefined
                ? ""
                : `（うち思考 ${r.llm_tokens.thoughts}）`)
            : "未取得"}{" "}
          トークン ／ TTS入力・出力{" "}
          {r.tts_tokens
            ? `${r.tts_tokens.prompt}・${r.tts_tokens.output}`
            : "未取得"}{" "}
          トークン
        </p>
        <p>
          2026年11月8日の単価による推定です。LiveKitの通信料とワーカーの稼働費は別途かかります。
        </p>
      </details>
      <a
        download="ainote-voice-measurement.json"
        href={`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(metrics, null, 2))}`}
      >
        測定値を保存（JSON）
      </a>
    </section>
  );
}
