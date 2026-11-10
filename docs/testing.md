# テストと変更の運用

## 一度セットアップした後の確認

```sh
make check
make e2e
make docker-check
```

普段は変更した側だけの `make check-web` または `make check-agent` でもよい。PRではCIが両方とコンテナを検証する。E2Eには最初に `npx playwright install chromium` が必要。

| 検証                              | 目的                                                 | 実行場所     |
| --------------------------------- | ---------------------------------------------------- | ------------ |
| Prettier／Ruff format             | 差分の書式を統一                                     | ローカル・CI |
| ESLint／Ruff・tsc／mypy           | 型と静的な問題を検出                                 | ローカル・CI |
| dependency-cruiser／import-linter | 層の依存方向を守る                                   | ローカル・CI |
| Vitest／pytest                    | 設定・エラー・ログ・CLIなどの境界条件                | ローカル・CI |
| standalone起動テスト              | 起動から初回HTTPアクセスまでのログ重複・設定エラー   | ローカル・CI |
| Docker検証スクリプトのテスト      | 成功・途中失敗・SIGINT／SIGTERM時の後片付け          | ローカル・CI |
| Playwright                        | production buildを起動し、HTTPとブラウザの入口を確認 | ローカル・CI |
| Docker smoke                      | 本番用イメージが資格情報なしでビルド・起動できるか   | ローカル・CI |

空の業務層（Webの`src/server/application`、Pythonのdomain/application）に架空のテストを作らない。Webの依存規則は、一時ディレクトリに違反するimportを書き、本当に検出できることを試験する。server内の層に加え、`client → server`（型だけのimportを含む）、`server → client/app`、`app → server/infrastructure`の参照を拒否する。

WebのVitestはstatement・branch・function・lineの全体カバレッジに90%の下限を置く。対象は`src/server/{domain,application,infrastructure}/**/*.ts`であり、composition・instrumentation・画面は含まれない。Pythonもbranchを含めて90%を下限とする。高い数値だけでアプリ全体を検証済みとは扱わない。

`make check-web`は単体検証とビルド後に`npm run test:runtime`も実行する。`tests/runtime/standalone.test.mjs`は本物のstandaloneを別プロセスで起動し、起動ログが出てから最初のGET・再GET・HEAD・未対応POSTを送り、起動イベントが増えないことを確認する。設定不正時はhealthが500になり、設定値が応答やログへ出ないことも確認する。

`npm run test:scripts`はDockerとcurlをテスト用コマンドへ差し替え、実際のシェルスクリプトの終了処理を検証する。`rmdir`を失敗させるケースでは、検証が成功していたら1、既に失敗・中断していたら元の終了コードを返すことも確認する。これは実コンテナの動作確認とは別で、`make docker-check`が実際のビルド・起動・HTTP・後片付けを担当する。CIも同じコマンドを使う。

2026年11月8日に東京の限定公開Cloud Runで、正常なWebがHTTP startup probeを通り、設定不正のWebは起動に失敗して通信を受けないことを確認した。クラウドでの検証は運用者が配布時に実行する。[運用ドキュメント](deployment.md)

`make e2e` はproduction buildとAuthentication・Firestoreの公式エミュレータを使う。Googleログインで作成したプロフィールをFirestoreから読み戻し、再読み込みやログアウトをまたいで保持されること、既存の認証ユーザーが複数タブから開いても登録できることを確認する。実際のGoogleアカウントで試す手順は[Webのログイン設定](../apps/web/README.md#googleログイン)を参照する。

入退室のE2Eは2人が別々のブラウザセッションでログインし、作成・招待・同意・入室・退室・再入室を画面から操作する。Firestoreから各UIDの記録を読み戻して、主催者の退室後も参加者が残ること、再入室で初回日時が変わらないことを確認する。実Firestoreで同じ保存処理を確認するには、ADCと対象プロジェクトを設定し、`apps/web` で `ROOMS_LIVE_TEST=1 node --env-file=.env.local ../../node_modules/vitest/vitest.mjs run src/server/infrastructure/firestore/rooms.live.test.ts` を実行する。テストは一時的な部屋の記録を削除して消えたことを確認する。

デザインプレビューのE2Eでトップの表示、招待コード、入室前の同意、メモの追記、退室・再入室、振り返りとノートへの遷移を確認する。デザインプレビューには架空のデータを使う。

`/demo/map` は、未確認カードから直接頼む操作と「AIに話す」で発言例を選ぶ操作を試せる。調査には架空の会場資料を使い、回答から該当する資料を開ける。マイク入力、外部の検索、別端末との共有はこのデモの検証対象外。

音声テストのE2Eは同意と運用者キーの入口を確認する。応答時間・日本語認識・費用の基準値はGoogleの認証を設定し、実サービスとマイクで収集する。[音声テストの実測手順](voice-probe.md)

### 議論マップの発言判別用データ

Firestore の既定 DB にある `mapClassification/v1` に、分類・状態・関係と判定の基準を保存する。その下の `scripts/venue-selection` は、レビュー済みの会場選びデモから作った架空の台本で、次の2つのサブコレクションを持つ。

| パス                | 内容                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------ |
| `turns/{発言ID}`    | `u01` から `u30` までの発言順・発言者・本文                                                |
| `expected/{発言ID}` | その発言の**直後**の正解マップ。各項目の種類・状態・根拠発言ID、担当者、項目間の関係を含む |

評価するときは台本を順に送り、AI 自身の直前のマップと、その時点までの発言を入力にする。`expected` は採点に使う。例えば `u28` では会場は候補、`u29` では市民センターに決定し、陸の予約作業は未完了になる。実際に AI を試した結果は同じ台本の `runs/{実行ID}/predictions/{発言ID}` に分け、実行ごとにモデルとプロンプトの版を記録する。

初期データの作成と読み戻しには、Node.js 22 と対象プロジェクトへアクセスできる ADC を使う。リポジトリのルートから次を実行する。

```sh
node --env-file-if-exists=apps/web/.env.local apps/web/scripts/seed-map-classification.mjs --project hackathon-7314b
```

`--check` を付けると全件を読み取って照合する。再実行時は足りない文書だけを追加し、既存の値が異なる場合は書き込み全体を中止する。別の分類基準を試すときは新しい版を作る。

### Vertex AI の判定を試す

`/demo/map/ai` は、会場選びの30発言を Vertex AI の Gemini に判定させた結果を再生する。「AIの判定」と「正解例」を切り替えると、同じ発言位置でカードと根拠の違いを比較できる。画面は保存済みの結果を使う。

新しい試行には `--run` で識別子を指定する。下の1行目は Vertex AI の利用料金が発生する。架空の台本を1発言ずつ、直前の予測と一緒にモデルへ渡す。各発言の直後のマップを Firestore の `predictions/{発言ID}` に保存する。中断後は同じ入力と実行IDで続きから再開できる。完了した試行の再実行では、保存済みの件数を表示する。

```sh
node --env-file-if-exists=apps/web/.env.local apps/web/scripts/run-map-classification.mjs --project hackathon-7314b --run venue-trial-01
node --env-file-if-exists=apps/web/.env.local apps/web/scripts/report-map-classification.mjs --project hackathon-7314b --run venue-trial-01 --export-demo
```

2行目が正解と照合し、発言別の集計を `evaluations/{発言ID}` に保存する。`--export-demo` を付けると、ローカルの会場選びデモで再生する結果も更新する。採点では各項目を「最初の根拠発言IDと種類」で対応づける。種類、状態、担当者、明示的な賛否、関係ごとに一致数・正解件数・予測件数を数える。同じ発言で同じ種類の項目が複数できると内容の取り違えを区別できないため、文章の意味や根拠はデモで見比べる。

次のコマンドは Vertex AI に架空の発言を送り、席数の回答が参加人数・机の配置とともに1枚に収まり、別の設備情報も残ることを確かめる。動画公開の台本では、無料プランの1ファイルあたりの上限と動画のサイズが見送り材料のカードに残ることを確かめる。利用料金が発生する。

```sh
MAP_CLASSIFICATION_TEST_PROJECT=hackathon-7314b node --env-file-if-exists=apps/web/.env.local --test --test-name-pattern=Vertex apps/web/scripts/map-classification/classification.test.mjs
```

## CI

`.github/workflows/ci.yml` はPR、main更新、手動実行で動作する。`Web checks`、`Agent checks`、`Container smoke checks` を並行実行し、最後の `Required checks` が全成功を要求する。CIにはクラウドの認証情報や書き込み権限を与えない。

GitHubのブランチ保護で `Required checks` を必須にすると、失敗した変更のマージを防げる。**ワークフローファイルを置くだけではブランチ保護は有効にならない。リポジトリ設定はまだ変更していない。**

失敗時はActionsの該当ステップから調べる。WebのcoverageとPlaywrightのtrace、Pythonのcoverageをartifactとして7日保持する。E2E traceは入力・通信内容を含み得るため、テストは人工データだけで行う。

## 機能実装後のテストをどこに置くか

- 純粋な業務ルール：Webは`apps/web/src/server/`内の対象コードの近くに`*.test.ts`、Pythonは`apps/agent/tests/`。
- ブラウザ向けの純粋な処理：必要になったときに`apps/web/src/client/`内の対象コードの近くへテストを置く。サーバーの型や実装をimportしない。
- FirestoreとFunctionsは、`make check-functions` で重複・遅延イベントを試験し、`make check-firestore-emulator` でNext.jsから両方の公式エミュレータを往復する。実DBとFunctionを使うには、ローカルのWebからは `make check-firestore`、限定公開のCloud Runからは `make check-deployed-firestore` を実行する。
- 既存SQL Connectは `make check-db` が実DBに一時的な値を書き、別のQueryで照合して行を削除する。
- 主要な利用導線：`tests/e2e/` に追加する。細かい条件分岐は単体テストに任せ、同じ分岐を全画面で重複させない。
- 外部AIの実接続：課金・割当・実行時間を伴うため、通常のPRチェックと分け、明示的な実行とする。モック成功を実接続の成功として報告しない。

既存動作を変える場合は、受け入れ条件と不具合の再現を先に確認する。コードの行をなぞるだけのテストや、業務の意味を持たないsnapshotを増やさない。

## 依存更新

Web用の `package-lock.json`、Functions用の `apps/functions/package-lock.json`、Python用の `apps/agent/uv.lock` をコミットし、CIはlockfileを書き換えずインストールする。通常の更新は対象を絞って行い、上記の検証を通す。自動修正目的の `npm audit fix --force` は使わず、互換性と実際の影響を確認する。

Nodeは22系の最新パッチ、Pythonは3.11系をCI・コンテナで使う。依存はlockfileで固定し、ベースイメージは同じメジャー系列のセキュリティ更新を取り込む。リリース開始後はビルドしたイメージのdigestを記録し、同じdigestで戻せるようにする。

Dependabotは週次でnpm・uv・Docker・GitHub Actionsを確認する。マイナー・パッチ更新は各エコシステムのグループにまとめ、各更新設定の通常PR上限を1件にする。メジャー更新は `ignore` で自動提案から除外し、必要になった時点で互換性・移行内容を調べ、対象の依存を手動で更新して検証する。更新PRは自動マージしない。実際の更新ジョブはmainに反映後にGitHubで確認する。

### 初期構築時に残る依存の課題（2026-11-06確認）

`npm audit --omit=dev` は指摘0件。開発依存を含む監査はmoderateが8件で、同じminimatchの問題が依存経路上の複数パッケージへ計上されている。経路はNextのESLint設定 → typescript-eslint → minimatch。細工したglobパターンによるCPU・メモリ消費が対象。[上流のアドバイザリ](https://github.com/advisories/GHSA-g3hv-75wg-m249)

修正版minimatch 11.0.1は依存元の `^10.2.2` の範囲外なので、互換性を無視した強制overrideやNextのダウングレードは行っていない。現状はユーザー入力を静的解析へ渡さず、CIにはtimeoutと読み取り専用権限を設定している。これは修正の代わりではなく、上流更新を追う必要がある。

ESLint 9.39.5もサポート終了の警告があるが、Next公式設定が使うReact等のプラグインはESLint 10をまだpeer範囲に含めていない。TypeScriptもtypescript-eslintの対応範囲に合わせ5.9.3を選んでいる。これらの互換性が揃った更新を優先する。

## 2人の会話から作る議論マップ

[起動・参加手順](live-map-demo.md)。順番が逆になる文字起こし、判定の一時停止、部屋終了後の遅延結果の破棄は `npm run test:scripts`、招待・共有・再接続・終了後のアクセスは `make e2e` で検証する。実サービスの検証では空のデモを起動し、2人分の日本語WAV（1人目は「図書館」の提案、2人目は「予約」の引き受け、各ファイルの末尾に2秒以上の無音）を用意する。

```sh
node tests/runtime/live-map-audio.mjs /path/to/host.wav /path/to/guest.wav
```

2つのChromiumで別々のWAVをマイク入力に使う。相互の音声再生、実際の文字起こしとVertex判定、発言者つき字幕・カードの一致、終了時の両画面の消去を確認する。検証は課金対象。招待キーや発言内容は出力しない。
