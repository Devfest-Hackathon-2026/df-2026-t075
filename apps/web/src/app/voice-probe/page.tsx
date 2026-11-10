import { VoiceProbe } from "@/client/voice-probe/probe";
import "@/client/voice-probe/probe.css";

export const metadata = { title: "音声テスト" };
export default function Page() {
  return <VoiceProbe />;
}
