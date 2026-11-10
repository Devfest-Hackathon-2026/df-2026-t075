import type { Metadata } from "next";
import { MapDemoScreen } from "../_map-demo";

export const metadata: Metadata = { title: "AIの判定で見る議論マップ" };
export const dynamic = "force-static";

export default function VertexMapDemoPage() {
  return <MapDemoScreen initialMode="vertex" />;
}
