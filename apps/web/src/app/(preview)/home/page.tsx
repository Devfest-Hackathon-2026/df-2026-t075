import { people } from "@/client/preview/samples";
import { SiteBar } from "@/client/components/blocks";
import { HomeContent } from "@/client/preview/home";
export const metadata = { title: "ホーム" };
export default async function Home({ searchParams }: PageProps<"/home">) {
  return (
    <>
      <SiteBar viewer={people[2]} />
      <HomeContent firstVisit={(await searchParams).view === "first"} />
    </>
  );
}
