import { MemberRoomScreen } from "@/app/member-room-screen";

export const dynamic = "force-dynamic";
export const metadata = { title: "自分の部屋" };
export default function Rooms() {
  return <MemberRoomScreen view="list" />;
}
