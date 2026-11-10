import { people } from "@/client/preview/samples";
import { notFound } from "next/navigation";
import { SiteBar } from "@/client/components/blocks";
import { Meeting } from "@/client/preview/meeting";
export const metadata = { title: "話し合いの部屋" };
export default async function Room({
  params,
  searchParams,
}: PageProps<"/rooms/[id]">) {
  if ((await params).id !== "demo") notFound();
  const { mic, camera, status } = await searchParams;
  return (
    <>
      <SiteBar viewer={people[2]} />
      <Meeting
        muted={mic === "off"}
        cameraOn={camera === "on"}
        notice={typeof status === "string" ? status : ""}
      />
    </>
  );
}
