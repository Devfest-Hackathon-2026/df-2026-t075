import { useEffect, useRef, type RefObject } from "react";
import type { MapEdge } from "./types";

type Port = { left: number; right: number; y: number };

export function MapLines({
  board,
  viewport,
  edges,
  selectedId,
  scale,
}: {
  board: RefObject<HTMLDivElement | null>;
  viewport: RefObject<HTMLDivElement | null>;
  edges: MapEdge[];
  selectedId: string;
  scale: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const view = viewport.current;
    const area = board.current;
    const layer = canvas.current;
    const ctx = layer?.getContext("2d");
    if (!view || !area || !layer || !ctx) return;
    const cards = Array.from(
      area.querySelectorAll<HTMLElement>("[data-map-node]"),
    );
    const ports = new Map<string, Port>();
    const connected = (edge: MapEdge) =>
      edge.from === selectedId || edge.to === selectedId;
    const ordered = [...edges].sort(
      (a, b) => Number(connected(a)) - Number(connected(b)),
    );
    let pending = 0;

    function draw() {
      pending = 0;
      if (!layer || !ctx || !area) return;
      const frame = layer.getBoundingClientRect();
      const origin = area.getBoundingClientRect();
      const pixelRatio = window.devicePixelRatio || 1;
      const width = Math.round(frame.width * pixelRatio);
      const height = Math.round(frame.height * pixelRatio);
      if (layer.width !== width || layer.height !== height) {
        layer.width = width;
        layer.height = height;
      }
      ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      ctx.clearRect(0, 0, frame.width, frame.height);
      const left = frame.left - origin.left;
      const top = frame.top - origin.top;
      ctx.translate(-left, -top);
      for (const edge of ordered) {
        const a = ports.get(edge.from);
        const b = ports.get(edge.to);
        if (!a || !b) continue;
        const [start, end] = a.left <= b.left ? [a, b] : [b, a];
        const sameColumn = start.left === end.left;
        // Keep same-column links in the margin so they don't cross the cards.
        const x1 = sameColumn ? start.left : start.right;
        const x2 = end.left;
        const bend = sameColumn ? x1 - 16 * scale : (x1 + x2) / 2;
        if (
          Math.max(x1, x2, bend) < left - 2 ||
          Math.min(x1, x2, bend) > left + frame.width + 2 ||
          Math.max(start.y, end.y) < top - 2 ||
          Math.min(start.y, end.y) > top + frame.height + 2
        )
          continue;
        ctx.strokeStyle = connected(edge) ? "#244dc2" : "#88877e";
        ctx.lineWidth = Math.max(1, (connected(edge) ? 3 : 1.5) * scale);
        ctx.beginPath();
        ctx.moveTo(x1, start.y);
        ctx.bezierCurveTo(bend, start.y, bend, end.y, x2, end.y);
        ctx.stroke();
      }
    }
    const schedule = () => {
      if (!pending) pending = requestAnimationFrame(draw);
    };
    const measure = () => {
      const origin = area.getBoundingClientRect();
      for (const card of cards) {
        const box = card.getBoundingClientRect();
        ports.set(card.dataset.mapNode!, {
          left: box.left - origin.left,
          right: box.right - origin.left,
          y: box.top + box.height / 2 - origin.top,
        });
      }
      schedule();
    };
    const observer = new ResizeObserver(measure);
    for (const element of [area, view, ...cards]) observer.observe(element);
    view.addEventListener("scroll", schedule, { passive: true });
    measure();
    return () => {
      observer.disconnect();
      view.removeEventListener("scroll", schedule);
      cancelAnimationFrame(pending);
    };
  }, [board, viewport, edges, selectedId, scale]);
  return <canvas className="map-lines" ref={canvas} aria-hidden="true" />;
}
