import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react";
import { MapLines } from "./map-lines";
import type { MapEdge } from "./types";

export function MapViewport({
  edges,
  selectedId,
  children,
}: {
  edges: MapEdge[];
  selectedId: string;
  children: ReactNode;
}) {
  const hint = useId();
  const viewport = useRef<HTMLDivElement>(null);
  const board = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0, fit: 1 });
  const [fullSize, setFullSize] = useState(false);
  const reading = fullSize && size.fit < 1;
  const scale = reading ? 1 : size.fit;
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    const view = viewport.current;
    const area = board.current;
    if (!view || !area) return;
    const measure = () => {
      // offsetWidth/Height describe the unscaled grid, even in the overview.
      const width = area.offsetWidth;
      const height = area.offsetHeight;
      const available = view.getBoundingClientRect().width;
      if (!width || !height || !available) return;
      const maxHeight = parseFloat(getComputedStyle(view).maxHeight);
      const fit = Math.min(1, available / width, maxHeight / height);
      setSize((prev) =>
        prev.width === width && prev.height === height && prev.fit === fit
          ? prev
          : { width, height, fit },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    observer.observe(view);
    // The CSS height limit also changes on rotation, even if the grid doesn't.
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  useLayoutEffect(() => {
    const view = viewport.current;
    if (!view) return;
    if (!reading) {
      view.scrollTo(0, 0);
      return;
    }
    const card = board.current?.querySelector<HTMLElement>(
      `[data-map-node="${CSS.escape(selectedId)}"]`,
    );
    if (!card) return;
    const frame = view.getBoundingClientRect();
    const rect = card.getBoundingClientRect();
    const dx =
      Math.min(0, rect.left - frame.left - 12) +
      Math.max(0, rect.right - frame.left - view.clientWidth + 12);
    const dy =
      Math.min(0, rect.top - frame.top - 12) +
      Math.max(0, rect.bottom - frame.top - view.clientHeight + 12);
    if (dx || dy) view.scrollBy(dx, dy);
  }, [reading, selectedId, size]);

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    const view = viewport.current;
    if (
      !reading ||
      !view ||
      event.pointerType === "touch" ||
      !event.isPrimary ||
      event.button !== 0 ||
      (event.target instanceof Element && event.target.closest("button"))
    )
      return;
    event.preventDefault();
    view.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.dataset.dragging = "true";
    drag.current = {
      id: event.pointerId,
      x: view.scrollLeft + event.clientX,
      y: view.scrollTop + event.clientY,
    };
  }
  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const anchor = drag.current;
    if (!anchor || anchor.id !== event.pointerId) return;
    viewport.current?.scrollTo(
      anchor.x - event.clientX,
      anchor.y - event.clientY,
    );
  }
  function stopDrag(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null;
    delete event.currentTarget.dataset.dragging;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }

  return (
    <>
      <div className="map-chart-title">
        <h2>議論のつながり</h2>
        {size.fit < 1 && (
          <button
            type="button"
            className="small-action map-reset"
            onClick={() => setFullSize(!fullSize)}
          >
            {reading ? "全体を表示" : "原寸で読む"}
          </button>
        )}
        <p id={hint}>
          {reading && "スクロールして移動できます。"}
          項目を選ぶと、発言者と元の発言を確認できます。
        </p>
      </div>
      <div className="map-frame">
        <MapLines
          viewport={viewport}
          board={board}
          edges={edges}
          selectedId={selectedId}
          scale={scale}
        />
        <div
          ref={viewport}
          className="map-scroll"
          role="region"
          aria-label="マップの表示範囲"
          aria-describedby={hint}
          tabIndex={reading ? 0 : undefined}
          data-reading={reading || undefined}
        >
          <div
            className="map-space"
            style={
              size.width
                ? { width: size.width * scale, height: size.height * scale }
                : undefined
            }
            onPointerDown={startDrag}
            onPointerMove={moveDrag}
            onPointerUp={stopDrag}
            onPointerCancel={stopDrag}
            onLostPointerCapture={stopDrag}
          >
            <div
              className="map-board"
              ref={board}
              style={{ transform: `scale(${scale})` }}
            >
              {children}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
