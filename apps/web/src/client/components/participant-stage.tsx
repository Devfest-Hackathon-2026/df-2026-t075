import { useRef, useState, type PointerEvent, type ReactNode } from "react";
import { SymbolIcon } from "./blocks";

const corners = [
  "bottom-right",
  "bottom-left",
  "top-left",
  "top-right",
] as const;
type Corner = (typeof corners)[number];

export function ParticipantStage({
  expanded,
  children,
}: {
  expanded: boolean;
  children: ReactNode;
}) {
  const stage = useRef<HTMLElement>(null);
  const [corner, setCorner] = useState<Corner>("bottom-right");
  const [folded, setFolded] = useState(false);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const drag = useRef<{
    x: number;
    y: number;
    dx: number;
    dy: number;
    moved: boolean;
  } | null>(null);
  const ignoreClick = useRef(false);

  function start(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || !event.isPrimary || !stage.current) return;
    const rect = stage.current.getBoundingClientRect();
    ignoreClick.current = false;
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      dx: event.clientX - rect.left,
      dy: event.clientY - rect.top,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent<HTMLButtonElement>) {
    const grip = drag.current;
    if (!grip || !stage.current || !event.isPrimary) return;
    if (
      !grip.moved &&
      Math.hypot(event.clientX - grip.x, event.clientY - grip.y) < 5
    )
      return;
    grip.moved = true;
    setPosition({
      left: Math.max(
        0,
        Math.min(
          event.clientX - grip.dx,
          window.innerWidth - stage.current.offsetWidth,
        ),
      ),
      top: Math.max(
        0,
        Math.min(
          event.clientY - grip.dy,
          window.innerHeight - stage.current.offsetHeight,
        ),
      ),
    });
  }
  function end(event: PointerEvent<HTMLButtonElement>) {
    const grip = drag.current;
    if (!grip || !event.isPrimary) return;
    if (grip.moved && event.type === "pointerup" && stage.current) {
      const right =
        event.clientX - grip.dx + stage.current.offsetWidth / 2 >=
        window.innerWidth / 2;
      const bottom =
        event.clientY - grip.dy + stage.current.offsetHeight / 2 >=
        window.innerHeight / 2;
      setCorner(
        bottom
          ? right
            ? "bottom-right"
            : "bottom-left"
          : right
            ? "top-right"
            : "top-left",
      );
    }
    ignoreClick.current = grip.moved;
    drag.current = null;
    setPosition(null);
  }
  return (
    <section
      ref={stage}
      className="meeting-stage"
      aria-label={expanded ? "参加者の小窓" : "あなたとAIメンバー"}
      data-corner={expanded ? corner : undefined}
      data-folded={(expanded && folded) || undefined}
      style={
        expanded && position
          ? { ...position, right: "auto", bottom: "auto" }
          : undefined
      }
    >
      {expanded && (
        <div className="mini-heading">
          <strong>
            <SymbolIcon name="group" />
            参加者
          </strong>
          <button
            type="button"
            className="mini-move"
            aria-label="小窓の位置を変える"
            title="小窓をドラッグして移動・クリックで次の角へ"
            onPointerDown={start}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            onLostPointerCapture={end}
            onClick={(event) => {
              if (!ignoreClick.current || event.detail === 0)
                setCorner(
                  (c) => corners[(corners.indexOf(c) + 1) % corners.length]!,
                );
              ignoreClick.current = false;
            }}
          >
            <SymbolIcon name="move" />
          </button>
          <button
            type="button"
            aria-expanded={!folded}
            aria-label={folded ? "参加者の小窓を広げる" : "参加者の小窓を畳む"}
            title={folded ? "小窓を広げる" : "小窓を畳む"}
            onClick={() => setFolded(!folded)}
          >
            <SymbolIcon name="down" />
          </button>
        </div>
      )}
      {children}
    </section>
  );
}
