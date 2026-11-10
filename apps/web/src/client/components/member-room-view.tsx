import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { SignInConfig } from "../infrastructure/firebase-auth";
import { useMeetingAgenda } from "../infrastructure/use-meeting-agenda";
import type { RoomVisit } from "../infrastructure/rooms";
import { useRoomSession } from "../live-map/use-room-session";
import { Dialog, InviteLink } from "../preview/dialog";
import { AiTile, Face, PersonTile, SelfTile, SymbolIcon } from "./blocks";
import { CameraPreview } from "./member-camera";
import { JoinLayout, MeetingHeader } from "./room-layout";
import { MapResearchTools, ResearchList } from "./research-list";
import { MeetingAgenda, MeetingTime } from "./meeting-agenda";
import { ParticipantStage } from "./participant-stage";
import { useMapFullscreen } from "./use-map-fullscreen";

const MeetingAudio = dynamic(() =>
  import("./meeting-audio").then((module) => module.MeetingAudio),
);

const MemberMapPanel = dynamic(() =>
  import("../live-map/room").then((module) => module.MemberMapPanel),
);

function RoomInvitation({ code }: { code: string }) {
  return (
    <div className="room-invitation">
      <p className="room-code">
        <span>招待コード</span>
        <strong>{code}</strong>
      </p>
      <InviteLink
        url={window.location.origin + "/r/" + code}
        copyLabel="招待リンクをコピー"
      />
    </div>
  );
}

type MemberViewProps = {
  room: RoomVisit;
  displayName: string | null;
  children: ReactNode;
};

export function MemberPreflight({
  room,
  displayName,
  children,
}: MemberViewProps) {
  return (
    <JoinLayout
      homeHref="/"
      title={room.version ? "退室しました" : "入室前の確認"}
    >
      <section className="panel devices member-preview">
        <h2>あなたの表示</h2>
        {room.voiceAvailable ? (
          <CameraPreview displayName={displayName} />
        ) : (
          <div className="device-preview">
            <SelfTile displayName={displayName} />
            <span className="device-state">カメラはオフ</span>
          </div>
        )}
        <p className="meta">
          {room.voiceAvailable || room.mapAvailable
            ? "入室するとマイクはオフのまま通話につながります。マイクをオンにすると声が同室の参加者に届きます。"
            : "現在、この部屋では音声・映像は共有されません。"}
          {room.voiceAvailable &&
            "カメラはオンにすると映像を共有します。会議AIはマイクがオンの間の発言をGoogleで文字に起こし、進行案とパートメモに使います。"}
          {room.mapAvailable &&
            (room.voiceAvailable
              ? "議論マップも同じ音声を別にGoogleで文字に起こします。マップを閉じていても続きます。"
              : "議論マップはマイクの音声をGoogleで文字に起こします。マップを閉じていても続きます。")}
        </p>
      </section>
      <section className="join-summary" aria-label="入室の確認">
        <div className="panel room-info">
          <h2>{room.topic}</h2>
          <p className="meta">
            {room.owner ? "主催者" : "参加者"}として参加　·　予定 {room.minutes}
            分
          </p>
          <details className="join-invitation">
            <summary>招待コードとリンク</summary>
            <RoomInvitation code={room.code} />
          </details>
        </div>
        <div className="panel blue ai-info">
          <Face member={room.member} state="idle" />
          <div>
            <h3>
              {room.member} <span>AI</span>
            </h3>
            <p>この部屋のAIメンバー · 未接続</p>
          </div>
        </div>
        {children}
      </section>
    </JoinLayout>
  );
}

export function MemberMeeting({
  room,
  displayName,
  children,
  config,
}: MemberViewProps & { config: SignInConfig }) {
  const meeting = useMeetingAgenda(config, room.roomId);
  const research = meeting.agenda?.research ?? [];
  const ended =
    meeting.agenda?.endsAt != null && meeting.now >= meeting.agenda.endsAt;
  const [microphone, setMicrophone] = useState<MediaStreamTrack | null>(null);
  const session = useRoomSession({
    config,
    roomId: room.roomId,
    enabled: Boolean(room.mapAvailable),
    voiceViaLiveKit: room.voiceAvailable,
    microphone,
  });
  const peers = session.state.members.filter(
    (p) => p.connected && p.name !== session.welcome?.name,
  );
  const [presentationTarget, setPresentationTarget] =
    useState<HTMLSpanElement | null>(null);
  const [mapOpen, setMapOpen] = useState(false);
  const [mapVisited, setMapVisited] = useState(false);
  const { meetingRef, buttonRef, expanded, toggle } = useMapFullscreen();
  const mapArea = useRef<HTMLElement>(null);
  useEffect(() => {
    if (mapOpen) mapArea.current?.focus();
  }, [mapOpen]);
  const [invite, setInvite] = useState(false);
  const [panel, setPanel] = useState(true);
  return (
    <main
      ref={meetingRef}
      className={
        "meeting shell member-meeting" + (expanded ? " map-expanded" : "")
      }
    >
      <MeetingHeader
        topic={room.topic}
        status={
          <>
            <SymbolIcon name="check" />
            {room.owner ? "主催者" : "参加者"} · 入室中
          </>
        }
        time={<MeetingTime meeting={meeting} minutes={room.minutes} />}
      />
      <div className={"meeting-body" + (panel ? " with-panel" : "")}>
        <ParticipantStage expanded={expanded}>
          {room.voiceAvailable ? (
            <MeetingAudio
              presentationTarget={expanded ? presentationTarget : null}
              refreshResearch={meeting.refresh}
              researching={
                !ended && research.some((r) => r.status === "pending")
              }
              raisedId={
                ended
                  ? undefined
                  : research.find(
                      (r) => r.status === "verified" && !r.presented,
                    )?.id
              }
              config={config}
              onMicrophone={setMicrophone}
              room={room}
              displayName={displayName}
            />
          ) : (
            <>
              <div className="video-grid">
                <SelfTile displayName={displayName} muted={!session.mic} />
                {peers.map((p) => (
                  <PersonTile
                    key={p.name}
                    muted={!p.mic}
                    person={{
                      name: p.name,
                      initial: Array.from(p.name)[0] || "人",
                      color: "mint",
                    }}
                  />
                ))}
                <AiTile
                  member={room.member}
                  state={
                    session.state.waiting
                      ? "thinking"
                      : session.welcome &&
                          session.state.mappingEnabled !== false
                        ? "listening"
                        : "idle"
                  }
                />
              </div>
              <p className="captions media-status" role="status">
                <SymbolIcon name={session.mic ? "mic" : "mic-off"} />
                {session.welcome
                  ? session.mic
                    ? "通話中・自分のマイクはオン"
                    : "通話中・自分のマイクはオフ"
                  : room.mapAvailable
                    ? session.connecting
                      ? "通話に接続しています…"
                      : "通話は未接続です。"
                    : "現在、この部屋では音声・映像は共有されません。"}
              </p>
            </>
          )}
          {room.mapAvailable && session.notice && (
            <p role="status">{session.notice}</p>
          )}
          {room.mapAvailable && session.error && (
            <p className="form-error" role="alert">
              {session.error}
            </p>
          )}
          <div className="meeting-controls">
            {room.mapAvailable && !room.voiceAvailable && (
              <button
                type="button"
                className="btn mini-call-control"
                aria-pressed={session.mic}
                disabled={!session.welcome || session.micBusy}
                onClick={session.toggleMic}
              >
                <SymbolIcon name={session.mic ? "mic" : "mic-off"} />
                {session.mic ? "マイクをオフ" : "マイクをオン"}
              </button>
            )}
            {room.mapAvailable &&
              !room.voiceAvailable &&
              session.welcome &&
              session.playbackBlocked && (
                <button
                  type="button"
                  className="btn mini-call-control"
                  onClick={session.playAudio}
                >
                  音声を再生
                </button>
              )}
            {room.mapAvailable && !session.welcome && !session.connecting && (
              <button
                type="button"
                className="btn mini-call-control"
                onClick={() => void session.connect()}
              >
                {room.voiceAvailable ? "議論マップに再接続" : "通話に再接続"}
              </button>
            )}
            <button
              type="button"
              className="btn primary"
              aria-expanded={mapOpen}
              aria-controls="member-map"
              onClick={() => {
                setMapVisited(true);
                setMapOpen(!mapOpen);
              }}
            >
              <SymbolIcon name="note" />
              {mapOpen ? "議論マップを閉じる" : "議論マップを開く"}
            </button>
            <button
              type="button"
              className="btn"
              aria-haspopup="dialog"
              onClick={() => setInvite(true)}
            >
              <SymbolIcon name="group" />
              招待
            </button>
            {!panel && (
              <button
                type="button"
                className="btn"
                onClick={() => setPanel(true)}
              >
                <SymbolIcon name="note" />
                進行メモを開く
              </button>
            )}
            <Link className="btn" href="/">
              <SymbolIcon name="back" />
              ホームへ
            </Link>
            {meeting.agenda?.endsAt != null &&
              meeting.now >= meeting.agenda.endsAt && (
                <Link className="btn" href={"/rooms/" + room.roomId + "/note"}>
                  話し合いのノート
                </Link>
              )}
            {children}
          </div>
          {!expanded && <ResearchList rows={research} />}
        </ParticipantStage>
        <MeetingAgenda
          open={panel}
          meeting={meeting}
          minutes={room.minutes}
          owner={room.owner}
          onClose={() => setPanel(false)}
        />
      </div>
      <section
        id="member-map"
        tabIndex={-1}
        ref={mapArea}
        aria-label="部屋の議論マップ"
        hidden={!mapOpen}
      >
        {mapVisited &&
          (room.mapAvailable ? (
            <MemberMapPanel
              session={session}
              expanded={expanded}
              researchTools={
                expanded &&
                (room.voiceAvailable || research.length > 0) && (
                  <MapResearchTools
                    rows={research}
                    presentationRef={setPresentationTarget}
                  />
                )
              }
              fullscreenButton={
                <button
                  ref={buttonRef}
                  type="button"
                  className="btn map-expand-button"
                  aria-pressed={expanded}
                  onClick={toggle}
                >
                  <SymbolIcon
                    name={expanded ? "fullscreen-exit" : "fullscreen"}
                  />
                  {expanded ? "全画面を終了" : "全画面表示"}
                </button>
              }
            />
          ) : (
            <div className="panel form-panel">
              <h2>議論マップ</h2>
              <p>現在、この部屋ではライブマップを利用できません。</p>
              <Link
                className="btn"
                href="/demo/map/ai"
                target="_blank"
                rel="noopener noreferrer"
              >
                サンプルの議論マップを見る <SymbolIcon name="forward" />
              </Link>
            </div>
          ))}
      </section>
      {invite && (
        <Dialog title="メンバーを招待" onClose={() => setInvite(false)}>
          <RoomInvitation code={room.code} />
        </Dialog>
      )}
    </main>
  );
}
