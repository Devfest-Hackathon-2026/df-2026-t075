import { people } from "@/client/preview/samples";
import { notFound } from "next/navigation";
import { ProblemScreen, SiteBar } from "@/client/components/blocks";
import { JoinRoom } from "@/client/preview/join";
export const metadata = { title: "入室前の確認" };
export default async function Join({
  params,
  searchParams,
}: PageProps<"/rooms/[id]/join">) {
  if ((await params).id !== "demo") notFound();
  const { issue } = await searchParams;
  if (issue === "age" || issue === "devices")
    return <ProblemScreen kind={issue} />;
  return (
    <>
      <SiteBar viewer={people[2]} />
      <JoinRoom />
    </>
  );
}
