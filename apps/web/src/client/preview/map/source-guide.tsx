import { SiteBar } from "@/client/components/blocks";
import Link from "next/link";

export function DemoVenueSources() {
  return (
    <>
      <SiteBar />
      <main className="shell form-page">
        <Link className="back-link" href="/demo/map">
          議論マップへ
        </Link>
        <h1>会場の利用案内（デモ資料）</h1>
        <p>
          議論マップの架空の会場資料です。実在する施設の料金や予約状況を示すものではありません。
        </p>
        <div className="form-panel">
          <section
            className="panel feature"
            id="station"
            aria-labelledby="station-title"
          >
            <h2 id="station-title">駅前貸会議室｜2026年度 貸室案内</h2>
            <dl>
              <dt>土曜午後の使用料</dt>
              <dd>室料は1区分8,000円。プロジェクターは別途1区分3,000円。</dd>
              <dt>収容人数</dt>
              <dd>机を並べて16席。</dd>
            </dl>
          </section>
          <section
            className="panel feature"
            id="center"
            aria-labelledby="center-title"
          >
            <h2 id="center-title">市民センター｜2026年度 研修室利用案内</h2>
            <dl>
              <dt>土曜午後の使用料</dt>
              <dd>1区分6,000円。プロジェクターの利用料を含みます。</dd>
              <dt>午後の利用時間</dt>
              <dd>13時から17時まで。準備と片付けもこの時間に含みます。</dd>
              <dt>空き状況</dt>
              <dd>この利用案内には日別の予約状況を掲載していません。</dd>
            </dl>
          </section>
        </div>
      </main>
    </>
  );
}
