import { currentIdToken, type SignInConfig } from "./firebase-auth";

export type RoomSummary = { code: string; topic: string };
export type RoomVisit = RoomSummary & {
  voiceAvailable: boolean;
  mapAvailable?: boolean;
  roomId: string;
  minutes: number;
  member: string;
  owner: boolean;
  open: boolean;
  notebookAvailable: boolean;
  joined: boolean;
  leaving: boolean;
  version: number;
};

const messages: Record<string, string> = {
  "voice-disconnect":
    "サーバーで通話の切断を確認できませんでした。復旧後に退室を再試行してください。",
  "map-offline":
    "この部屋の議論マップは現在オフラインです。主催者が接続を準備してからもう一度お試しください。",
  "signed-out": "もう一度ログインして部屋を開いてください。",
  "not-member": "進行メモを見るには部屋に入室してください。",
  "host-only": "話し合いの開始は主催者が操作できます。",
  "proposal-replaced":
    "この提案は更新されました。最新の進行メモを確認してください。",
  "meeting-ended": "予定したパートはすべて終了しました。",
  "no-change": "共有中の予定と同じ内容です。",
  "discussion-required": "討議パートを一つ以上残してください。",
  "not-planning": "準備が始まると進行案を変更できます。",
  "agenda-stale":
    "進行状況が変わりました。最新のフェーズとメモを確認してください。",
  "over-total":
    "予定が部屋の合計時間を超えています。パートの分数を減らしてください。",
  "reflection-fixed":
    "最後の「振り返り」は2分で固定です。元の位置と内容に戻してください。",
  "part-ended":
    "終了したパートの変更が含まれています。終了済みの行を共有中の予定に戻してください。",
  "current-part-moved":
    "今のパートはすでに始まっています。元の位置に戻してください。",
  "current-ends-too-soon":
    "入力した分数では今のパートがすでに終わってしまいます。分数を増やして、終了を現在時刻より後にしてください。",
  "duplicate-part":
    "同じパートが複数あります。重複した行を取り除いてください。",
  "unknown-part":
    "共有中の予定にないパートが含まれています。最新の予定を確認してください。",
  missing: "この招待コードの部屋が見つかりません。",
  "meeting-in-progress": "ノートは会議の終了後に読めます。",
  closed: "この部屋は終了しました。",
  stale: "別の画面で入退室の状態が変わりました。現在の状態を確認してください。",
  conflict: "部屋の作成内容が先ほどの操作と異なります。",
  limited: "招待コードを何度も試したため、1分待ってからお試しください。",
};

// Known responses when a proposal that was previously valid cannot be approved.
const proposalMessages: Record<string, string> = {
  "agenda-stale": "予定が変わったため、AIの変更案を取り下げました。",
  "part-ended": "対象のパートが終了したため、AIの変更案を取り下げました。",
  "current-part-moved":
    "対象のパートが始まり、順番を変えられないため、AIの変更案を取り下げました。",
  "current-ends-too-soon":
    "予定した終了時刻を過ぎたため、AIの変更案を取り下げました。",
  "meeting-ended": "会議の予定が終了したため、AIの変更案を取り下げました。",
  "proposal-replaced":
    "このAIの変更案は、すでに取り下げられたか別の案に更新されています。",
};

export function proposalStatusMessage(code: string): string | undefined {
  return proposalMessages[code];
}

export function roomErrorMessage(code: string) {
  return (
    messages[code] ??
    "部屋の情報を確認できませんでした。もう一度お試しください。"
  );
}

export class RoomRequestError extends Error {
  constructor(
    readonly code: string,
    reloadMessage?: string,
  ) {
    super(reloadMessage ?? roomErrorMessage(code));
  }
}

export async function roomRequest<T>(
  config: SignInConfig,
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  try {
    const token = await currentIdToken(config);
    const timeout = AbortSignal.timeout(25_000);
    const response = await fetch(path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      cache: "no-store",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const details = await response.json().catch(() => null);
      throw new RoomRequestError(
        details?.code ??
          (response.status === 401 ? "signed-out" : "unavailable"),
        details?.code === "reload-required" &&
          typeof details.message === "string"
          ? details.message
          : undefined,
      );
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof RoomRequestError) throw error;
    throw new RoomRequestError("unavailable");
  }
}

export type RoomResearch = {
  id: string;
  question: string;
  deadline: number;
  status: "pending" | "verified" | "unverified" | "failed" | "timeout";
  presented: boolean;
  finding?: {
    answer: string;
    conditions: string;
    title: string;
    license?: "CC-BY-4.0";
    publisher: string;
    url: string;
  };
};
