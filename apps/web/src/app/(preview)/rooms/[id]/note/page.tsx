import { MemberRoomScreen } from "@/app/member-room-screen";
import { isUuidV4 } from "@/server/domain/uuid";
import { people } from "@/client/preview/samples";
import { SiteBar } from "@/client/components/blocks";
import { Note } from "@/client/preview/note";
export const metadata = { title: "話し合いのノート" };
export default async function NotePage({
  params,
}: PageProps<"/rooms/[id]/note">) {
  const { id } = await params;
  if (isUuidV4(id)) return MemberRoomScreen({ view: "note", roomId: id });
  return (
    <>
      <SiteBar viewer={people[2]} />
      <Note id={id} />
    </>
  );
}
