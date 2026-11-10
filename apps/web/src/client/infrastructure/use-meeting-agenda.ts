import { useEffect, useRef, useState } from "react";
import type { SignInConfig } from "./firebase-auth";
import {
  roomRequest,
  RoomRequestError,
  proposalStatusMessage,
  type RoomResearch,
} from "./rooms";

type MeetingPart = {
  partId: string;
  name: string;
  minutes: number;
  startsAt: number | null;
  endsAt: number | null;
  notes: string[];
};
type ClockSample = { serverNow: number; version: number; planVersion: number };
type SharedAgenda = ClockSample & {
  startsAt: number | null;
  endsAt: number | null;
  parts: MeetingPart[];
  research?: RoomResearch[];
  proposal?: { id: string; reason: string; changes: string[] };
  appliedProposal?: { reason: string; changes: string[] };
  proposalStatus?: string;
};
type AgendaEdit =
  | { action: "start" }
  | { action: "approve" | "dismiss"; id: string }
  | {
      action: "save" | "confirm";
      planVersion: number;
      parts: { partId: string | null; name: string; minutes: number }[];
    }
  | { action: "note"; id: string; partId: string; text: string };

export function useMeetingAgenda(config: SignInConfig, roomId: string) {
  const path = "/api/meetings/" + roomId + "/agenda/v2";
  const [sample, setSample] = useState<{
    agenda: SharedAgenda;
    serverNow: number;
    receivedAt: number;
  } | null>(null);
  const [tick, setTick] = useState(0);
  const [readError, setReadError] = useState("");
  const [writeError, setWriteError] = useState<{
    message: string;
    proposal?: { planVersion: number | undefined; until: number };
  }>();
  const [busy, setBusy] = useState(false);
  const writing = useRef(false);
  const refresh = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let current: SharedAgenda | null = null;
    let timer: ReturnType<typeof setTimeout>;
    let active: AbortController | undefined;
    async function sync() {
      clearTimeout(timer);
      active?.abort();
      if (document.hidden) return;
      const controller = new AbortController();
      active = controller;
      let nextPoll = 5000;
      try {
        const reply = await roomRequest<ClockSample | SharedAgenda>(
          config,
          current ? path + "?since=" + current.version : path,
          "GET",
          undefined,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if ("parts" in reply) current = reply;
        const pending = current?.research?.find((r) => r.status === "pending");
        if (pending)
          nextPoll = Math.min(
            nextPoll,
            Math.max(
              1,
              pending.deadline - reply.serverNow + Math.random() * 300,
            ),
          );
        if (current)
          setSample({
            agenda: current,
            serverNow: reply.serverNow,
            receivedAt: performance.now(),
          });
        setReadError("");
      } catch (error) {
        if (controller.signal.aborted) return;
        if (
          error instanceof RoomRequestError &&
          ["not-member", "closed", "signed-out"].includes(error.code)
        ) {
          current = null;
          setSample(null);
        }
        setReadError(
          error instanceof Error
            ? error.message
            : "進行メモを読み込めませんでした。",
        );
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(sync, nextPoll);
      }
    }
    refresh.current = sync;
    void sync();
    const clock = window.setInterval(() => setTick(performance.now()), 500);
    document.addEventListener("visibilitychange", sync);
    return () => {
      active?.abort();
      clearTimeout(timer);
      window.clearInterval(clock);
      document.removeEventListener("visibilitychange", sync);
      refresh.current = async () => {};
    };
  }, [config, path]);

  async function edit(command: AgendaEdit) {
    if (writing.current) return false;
    writing.current = true;
    setBusy(true);
    setWriteError(undefined);
    try {
      await roomRequest(config, path, "POST", command);
      await refresh.current();
      return true;
    } catch (error) {
      const reason =
        (command.action === "approve" || command.action === "dismiss") &&
        error instanceof RoomRequestError &&
        proposalStatusMessage(error.code);
      setWriteError(
        reason
          ? {
              message: reason,
              proposal: {
                planVersion: sample?.agenda.planVersion,
                until: performance.now() + 30_000,
              },
            }
          : {
              message:
                error instanceof Error
                  ? error.message
                  : "変更を保存できませんでした。",
            },
      );

      await refresh.current();
      return false;
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }
  const now = sample
    ? sample.serverNow + Math.max(0, tick - sample.receivedAt)
    : 0;
  return {
    agenda: sample?.agenda,
    now,
    readError,
    writeError:
      writeError?.proposal &&
      (tick >= writeError.proposal.until ||
        sample?.agenda.planVersion !== writeError.proposal.planVersion)
        ? ""
        : (writeError?.message ?? ""),
    clearWriteError: () => setWriteError(undefined),
    busy,
    edit,
    refresh: () => refresh.current(),
  };
}
