import Link from "next/link";
import type { ReactNode } from "react";
import { AiTile, PersonTile, SiteBar, SymbolIcon } from "./blocks";
import { people } from "../preview/samples";

const features = [
  {
    icon: "hand",
    color: "yellow",
    title: "割り込まずに手を挙げる",
    text: "AIもひとりの参加者。話したいときは手を挙げて、会話の切れ目を待ちます。",
  },
  {
    icon: "bot",
    color: "blue",
    title: "進め方を一緒に決める",
    text: "お題と時間を決めたら、集まったみんなで今日の進め方を組み立てます。",
  },
  {
    icon: "note",
    color: "green",
    title: "パートごとにメモが残る",
    text: "出てきた意見はパートごとに整理。話し終えたあともノートで読み返せます。",
  },
] as const;
export function Landing({ children }: { children: ReactNode }) {
  return (
    <>
      <SiteBar />
      <main className="landing shell">
        <section className="hero">
          <div className="hero-copy">
            <h1>
              AIも、
              <br />
              話し合いのメンバー。
            </h1>
            <p>
              少人数の話し合いに、AIメンバーがひとり。
              <br />
              進め方を一緒に考えて、時間とメモを受け持ちます。
            </p>
            <div className="entry-actions">{children}</div>
            <nav className="demo-links" aria-label="デモ">
              <Link href="/home" className="text-action">
                会議デモを試す
                <SymbolIcon name="forward" />
              </Link>
              <Link href="/demo/map" className="text-action">
                議論マップを試す
                <SymbolIcon name="forward" />
              </Link>
            </nav>
            <small>18歳以上の方が対象です。</small>
          </div>
          <div
            role="img"
            className="hero-art"
            aria-label="アオイ、ハル、ユイとの話し合いで、AIメンバーのノトが手を挙げています"
          >
            <div className="tile-collage" aria-hidden="true">
              {people.map((person) => (
                <PersonTile key={person.name} person={person} />
              ))}
              <AiTile state="raised" />
            </div>
          </div>
        </section>
        <section className="features" aria-label="AInoteの特徴">
          {features.map((f) => (
            <article key={f.title} className="feature">
              <span className={"feature-icon " + f.color}>
                <SymbolIcon name={f.icon} />
              </span>
              <h2>{f.title}</h2>
              <p>{f.text}</p>
            </article>
          ))}
        </section>
      </main>
    </>
  );
}
