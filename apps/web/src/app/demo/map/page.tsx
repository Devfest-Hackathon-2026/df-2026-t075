import type { Metadata } from "next";
import { MapDemoScreen } from "./_map-demo";

export const metadata: Metadata = { title: "議論マップのデモ" };
export const dynamic = "force-static";

export default function MapDemoPage() {
  return <MapDemoScreen initialMode="example" />;
}
