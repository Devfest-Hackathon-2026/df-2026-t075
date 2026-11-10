import { notFound, redirect } from "next/navigation";

import { inviteCode, roomPath } from "@/client/preview/samples";
import { MemberRoomScreen } from "@/app/member-room-screen";
export const metadata = { title: "招待リンク" };
export default async function Invite({
  params,
  searchParams,
}: PageProps<"/r/[code]">) {
  const code = (await params).code.toUpperCase();
  if (code === inviteCode) redirect(roomPath + "/join");
  if (!/^[A-Z0-9]{6}$/.test(code) || (await searchParams).demo === "1")
    notFound();
  return <MemberRoomScreen view="visit" code={code} />;
}
