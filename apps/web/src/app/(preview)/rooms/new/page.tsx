import { people } from "@/client/preview/samples";
import { SiteBar } from "@/client/components/blocks";
import { CreateRoom } from "@/client/preview/create-room";
import { MemberRoomScreen } from "@/app/member-room-screen";
export const metadata = { title: "部屋を作る" };
export default async function NewRoom({
  searchParams,
}: PageProps<"/rooms/new">) {
  if ((await searchParams).mode === "live")
    return <MemberRoomScreen view="create" />;
  return (
    <>
      <SiteBar viewer={people[2]} />
      <CreateRoom />
    </>
  );
}
