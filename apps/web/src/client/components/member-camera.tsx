import { useEffect, useRef, useState } from "react";
import type {
  CameraTrack,
  PreviewCamera,
} from "../infrastructure/meeting-voice";
import { SelfTile } from "./blocks";

export function CameraVideo({
  track,
  label,
}: {
  track: CameraTrack;
  label: string;
}) {
  const element = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = element.current;
    if (!video) return;
    track.attach(video);
    return () => {
      track.detach(video);
    };
  }, [track]);
  return <video ref={element} aria-label={label} autoPlay muted playsInline />;
}

export function CameraPreview({ displayName }: { displayName: string | null }) {
  const [open, setOpen] = useState(false);
  const [track, setTrack] = useState<CameraTrack | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    let closed = false;
    let camera: PreviewCamera | undefined;
    async function start() {
      const { openCameraPreview } =
        await import("../infrastructure/meeting-voice");
      if (closed) return;
      camera = await openCameraPreview();
      if (closed) camera.stop();
      else setTrack(camera);
    }
    void start().catch(() => {
      if (!closed) {
        setOpen(false);
        setError(
          "カメラを開けません。ブラウザのカメラ許可と端末を確認してください。",
        );
      }
    });
    return () => {
      closed = true;
      camera?.stop();
    };
  }, [open]);
  return (
    <>
      <div className="device-preview">
        <SelfTile displayName={displayName}>
          {track && <CameraVideo track={track} label="自分のカメラ映像" />}
        </SelfTile>
        <span className="device-state">
          {track
            ? "自分だけに表示中"
            : open
              ? "カメラを準備中"
              : "カメラはオフ"}
        </span>
      </div>
      <button
        className="btn"
        type="button"
        aria-pressed={open}
        onClick={() => {
          setTrack(null);
          setError("");
          setOpen(!open);
        }}
      >
        {open ? "カメラの確認を終了" : "カメラを確認"}
      </button>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
