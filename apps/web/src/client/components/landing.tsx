import Link from "next/link";
import type { ReactNode } from "react";
import { AiTile, PersonTile, SiteBar, SymbolIcon } from "./blocks";
import { people } from "../preview/samples";

const features = [
  {
    icon: "chat",
    color: "yellow",
    title: "AIも会話に加わる",
    text: "ノトがみんなの話を聞いて、意見を出したり、「ほかの見方はある？」と問いを返したりします。",
  },
  {
    icon: "search",
    color: "blue",
    title: "気になったことを、その場で調べる",
    text: "「この条件でも使える？」といった疑問をAIに頼むと、答えと出典がその話題のカードに届きます。",
  },
  {
    icon: "discussion-map",
    color: "green",
    title: "みんなの考えが、マップでつながる",
    text: "出た案とその理由、決まったこと、まだ確かめたいことを、MeetMapで一緒に見ながら話せます。",
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
