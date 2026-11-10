import { SiteBar } from "@/client/components/blocks";
import { MemberRooms, type RoomScreen } from "@/client/components/member-rooms";
import { getSignInConfig } from "@/server/composition/auth.server";

export function MemberRoomScreen(screen: RoomScreen) {
  const config = getSignInConfig();
  return (
    <>
      <SiteBar preview={false} />
      {config ? (
        <MemberRooms config={config} screen={screen} />
      ) : (
        <main className="shell form-page">
          <h1>部屋を開けません</h1>
          <p>現在、Googleログインを利用できません。</p>
        </main>
      )}
    </>
  );
}
