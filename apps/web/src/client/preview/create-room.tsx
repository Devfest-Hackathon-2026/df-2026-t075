"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Face, HomeBack, SymbolIcon } from "../components/blocks";
import { presets, type Preset } from "./samples";
import { InviteDialog } from "./dialog";
import { makePreviewRoom, usePreview } from "./session";

export function CreateRoom() {
  const { setRoom } = usePreview();
  return (
    <CreateRoomView
      onCreate={(topic, minutes, member) =>
        setRoom(makePreviewRoom(topic, minutes, member))
      }
    />
  );
}
export function CreateRoomView({
  onCreate,
  homeHref,
}: {
  onCreate: (
    topic: string,
    minutes: number,
    member: Preset,
  ) => void | Promise<string>;
  homeHref?: string;
}) {
  const [topic, setTopic] = useState("");
  const [minutes, setMinutes] = useState(30);
  const [member, setMember] = useState<Preset>("ノト");
  const [invite, setInvite] = useState<{ code?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const refresh = () => setVoices(synth.getVoices());
    synth.addEventListener("voiceschanged", refresh);
    refresh();
    return () => {
      synth.removeEventListener("voiceschanged", refresh);
      synth.cancel();
    };
  }, []);
  async function create(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    if (!topic.trim()) {
      setMessage("話し合いのお題を入力してください。");
      return;
    }
    setSaving(true);
    setMessage("");
    try {
      const code = await onCreate(topic.trim(), minutes, member);
      setInvite(code ? { code } : {});
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "部屋を作成できませんでした。もう一度お試しください。",
      );
    } finally {
      setSaving(false);
    }
  }
  function sampleVoice(preset: Preset) {
    const synth = window.speechSynthesis;
    const voice = voices.find((v) => v.localService && v.lang.startsWith("ja"));
    if (!voice) {
      setMessage(
        synth && !voices.length
          ? "音声一覧を取得できませんでした。少し待ってもう一度お試しください。"
          : "この端末では日本語音声を試聴できません。",
      );
      return;
    }
    const speech = new SpeechSynthesisUtterance(
      "こんにちは、" + preset + "です。一緒に話し合いましょう。",
    );
    speech.voice = voice;
    speech.pitch = { ノト: 1, ピコ: 1.15, ロロ: 0.85 }[preset];
    synth.cancel();
    synth.speak(speech);
    setMessage(preset + "の声を端末の音声で試聴しています。");
  }
  return (
    <main className="shell form-page">
      <HomeBack href={homeHref ?? "/home"} />
      <h1>部屋を作る</h1>
      <form className="form-panel panel" noValidate onSubmit={create}>
        <label className="field">
          話し合いのお題
          <input
            placeholder="例：ゼミ合宿の企画を考える"
            maxLength={100}
            required
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
          />
        </label>
        <fieldset>
          <legend>合計時間</legend>
          <div className="duration-options">
            {[15, 30, 45, 60].map((m) => (
              <label key={m} className="select-box">
                <input
                  type="radio"
                  name="duration"
                  checked={minutes === m}
                  onChange={() => setMinutes(m)}
                />
                <span>{m}分</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>AIメンバー</legend>
          <div className="presets">
            {presets.map((p) => (
              <div
                key={p}
                className={"preset panel " + (p === member ? "selected" : "")}
              >
                <label>
                  <input
                    type="radio"
                    name="member"
                    checked={p === member}
                    onChange={() => setMember(p)}
                  />
                  <span className="preset-picture">
                    <Face member={p} />
                    {p === member && (
                      <span className="selected-check">
                        <SymbolIcon name="check" />
                      </span>
                    )}
                  </span>
                  <strong>{p}</strong>
                </label>
                <button
                  type="button"
                  className="voice"
                  onClick={() => sampleVoice(p)}
                  aria-label={p + "の声を聞く"}
                >
                  <SymbolIcon name="volume" />
                  声を聞く
                </button>
              </div>
            ))}
          </div>
        </fieldset>
        {!homeHref && (
          <div className="dashed">
            進め方は決めなくて大丈夫です。部屋の中で、AIメンバーと話し合って決めます。
          </div>
        )}
        {message && <p role="status">{message}</p>}
        <div className="actions end">
          <button type="submit" className="btn primary" disabled={saving}>
            部屋を作る
            <SymbolIcon name="forward" />
          </button>
        </div>
      </form>
      {invite && (
        <InviteDialog created {...invite} onClose={() => setInvite(null)} />
      )}
    </main>
  );
}
