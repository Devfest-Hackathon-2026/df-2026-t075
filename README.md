# AInote

18歳以上向けのWebアプリ。オンラインの話し合い・勉強会・グループワークに、AIのメンバーが参加して進行することを目指しています。Googleログインした人は部屋を作り、招待リンクやコードで入室・退室・再入室できます。

Webのトップで「デモを試す」を押すと、サンプルデータで部屋の作成から振り返り・ノートまでを操作できます。デモの入力はそのタブのメモリにだけ保持し、再読み込みで初期化します。実際の部屋はログイン後の「部屋を開く」から使えます。Firestoreには `users/{uid}` に初回の表示名と登録日時、`rooms/{roomId}/members/{uid}` に本人の参加状態と入退室日時を保存します。開発基盤には `GET /api/health` とPythonの設定確認CLIがあります。

録音した声をSpeech-to-Text・Gemini・Gemini TTSに通し、AIが話し始めるまでの遅れ・聞き取りの誤り率・費用を測る `make voice-check` と、手元のブラウザからマイクで話しかけて同じ経路を試す `make live-check` もあります（[手順](apps/agent/README.md#声の計測voice-check)）。

運用者用の `/voice-probe` では、マイクからの一文を文字にし、Geminiの返答を音声と字幕で受けて、応答時間・日本語認識・利用料を測れます。[音声テストの起動と実測手順](docs/voice-probe.md)

音声を有効にした会員の部屋では、参加者同士で通話できます。カメラをオンにすると同じ部屋に映像を共有できます。「AIに話す」を押した人の質問に、AIが通話中の全員へ声と字幕で答えます。[会員用ワーカーの起動と2台での確認](docs/voice-probe.md#会員の部屋で2人とaiが話す)

今後、議論マップを導入する段階では、AIメンバーが論点ごとに「何が決まり、何が未確認か」を追い、次に何を尋ねるか、いつ待つかを判断します。参加者は同じ内容を議論マップで確認・訂正できます。[論点の状態を使った進行](docs/app-requirements.md#論点の状態を使った進行)

[AInote を開く](https://hackathon-7314b.web.app/)。`main` にマージしてCIが通ると、東京のCloud RunにWebを配布し、このFirebase HostingのURLを更新します。運用者のFirestore・Functions疎通試験には別の限定公開サービスを使います。

ディレクトリ名やパッケージ名（`classroom_agent`、`@ai-classroom/web`など）には、11月6日版の「AI教室」の名残があります。プロダクト名は11月8日に AInote に決まりましたが、名前の変更はコード・設定・CIに広く及ぶため、別の変更として行います。

## 最初の起動

必要なものはNode.js 22（22.19以上）、npm 10以上、Python 3.11、uv 0.13.0、makeです。Dockerはコンテナ検証を行う場合だけ使います。

```sh
make setup
make dev
```

[ローカル画面](http://localhost:3000)／[liveness](http://localhost:3000/api/health)

実際のGoogleアカウントを使う場合は[Webのログイン設定](apps/web/README.md#googleログイン)を参照してください。`make e2e` ではJava 21以上を使ってAuthenticationとFirestoreの公式エミュレータを起動します。

FirestoreとFunctionsのローカル疎通は、Java 21以上を用意して `make check-firestore-emulator` で確認できます。実サービスの配布と検証は[運用手順](docs/deployment.md#firestoreとfunctionsの配布と確認)を参照してください。既存SQL Connectの実DB試験は `make check-db` です。

環境設定は既定値で動作します。変更する場合、Webは `apps/web/.env.example` を `.env.local` にコピーします。Agentの設定方法は [Agent README](apps/agent/README.md) を参照してください。

## 日常のコマンド

| コマンド                        | 用途                                                                  |
| ------------------------------- | --------------------------------------------------------------------- |
| `make setup`                    | lockfileに従いJS/Python依存をインストール                             |
| `make dev`                      | Webの開発サーバーを起動                                               |
| `make voice-worker`             | 音声テスト用のLiveKitワーカーを起動                                   |
| `make agent-check`              | Agentのローカル設定を検証して終了                                     |
| `make voice-check AUDIO=…`      | 録音1件で声→文字起こし→Gemini→声を計測（ADCが必要・課金あり）         |
| `make live-check`               | マイクでAIメンバーと話すローカルのテストページ（ADCが必要・課金あり） |
| `make check`                    | 整形・静的解析・依存方向・単体テスト・Webビルド                       |
| `make check-functions`          | Firestoreイベント関数の単体試験                                       |
| `make check-firestore-emulator` | ローカルでWeb・Firestore・Functionsのイベント連携を確認               |
| `make check-firestore`          | デプロイ済みFirestoreとFunctionの往復を確認（ADCが必要）              |
| `make check-deployed-firestore` | 配布済みWeb経由で同じ往復を確認（運用者用のGoogle Cloud認証が必要）   |
| `make check-db`                 | 既存SQL Connectの実DBで書き込み・読み戻し・削除（ADCが必要）          |
| `make e2e`                      | Webをビルドし、実HTTPとブラウザで確認                                 |
| `make format`                   | TypeScript/JSON/MarkdownとPythonを整形                                |
| `make docker-check`             | 両イメージ・Agent・WebのHTTPを検証し、後片付け                        |

E2Eの初回だけ `npx playwright install chromium` を実行してください。`make docker-check` は一時プロジェクトと空きポートを使い、成功・失敗・中断時に自分のコンテナを片付けます。起動したまま使う手順は[運用ドキュメント](docs/deployment.md)を参照してください。

## 構成

```text
apps/
  web/                 Next.js。画面とHTTPの入口
    src/
      app/             Next.jsのページ・レイアウト・Route Handler
      client/          UIコンポーネント・ブラウザ向け処理
      server/
        domain/        業務のルール（今は説明のみ）
        application/   ユースケースと外部I/Oの契約（今は説明のみ）
        infrastructure/ 設定・ログ・Firestore・SQL Connect・LiveKitのSDKアダプター
        composition/   具体実装の組み立て
  functions/           Firestore作成イベントを処理する第2世代Functions
  agent/               Python。設定確認CLIと音声テスト用LiveKitワーカー
    src/classroom_agent/
      domain/
      application/
      infrastructure/
      bootstrap/       実行入口と組み立て
dataconnect/           SQL Connectのスキーマと、サーバー用のGraphQL操作
tests/e2e/             実HTTP・ブラウザのスモークテスト
tests/runtime/         本番ビルドの起動ログ・設定エラーの回帰テスト
scripts/               依存ルールと検証スクリプト、そのテスト
.github/workflows/     CIとAInoteの公開
docs/                  設計・テスト・運用手順
```

`app`はNext.jsの入口、`client`はUI、`server`はサーバー側の業務・基盤を担当します。トップ画面はサーバーで描画し、ログイン操作の入口に `"use client"` を指定します。

- [アプリ要件と未決定事項](docs/app-requirements.md)
- [アーキテクチャと機能追加の手順](docs/architecture.md)
- [テスト方針とCI](docs/testing.md)
- [コンテナ・公開・障害調査](docs/deployment.md)
- [技術選定（通話・AIメンバー・実行基盤）](docs/technical-selection.md)
- [デザイン（色・線・文字・部品）](docs/design.md)

`apps/web/` が公開するアプリ本体です。ルートの `public/` は以前の確認用HTMLです。[公開・ロールバックの手順](docs/deployment.md#ainoteの公開とロールバック)

---

## DevFest Hackathon 2026 提出用リポジトリ

作品URL：[AInote を開く](https://hackathon-7314b.web.app/)

  DevFest Hackathon 2026 のチームの **最終提出用** リポジトリです。提出期限までに、作品のコードと資料をこのリポジトリに置いてください。

  このリポジトリは **公開（public）** です。開催中も、運営・審査員・ほかの参加者が見られます。

  ## はじめに

  1. GitHub から届いた招待を受け入れてください（招待の期限は 7 日です）
  2. このリポジトリを clone して、提出物を置いてください

  招待の期限が切れたときや、メンバーが変わったときは、運営に連絡してください。

  ## 開発用のリポジトリは別に作ることをおすすめします

  このリポジトリでは **GitHub Actions と GitHub Pages が使えません**。CI やデプロイ、Pages での公開をしたいときは、チームで開発用のリポジトリを別に作ってください。

  - 開発用のリポジトリは、チームのメンバーのアカウントや、チームで作った Organization に作ってください
  - 開発はそちらで進めて、提出期限までに最終版のコードと資料をこのリポジトリに push してください
  - 審査はこのリポジトリの内容で行います。開発用のリポジトリにしかないものは、審査の対象になりません
  - デプロイした作品の URL があれば、この README に書いてください

  ## 秘密情報をコミットしない

  API キー・パスワード・サービスアカウントの鍵などは、**絶対にコミットしないでください**。公開リポジトリなので、push
  した時点で誰でも見られます。開発用のリポジトリから持ってくるときも、履歴ごと push すると、過去のコミットに含まれる秘密情報も公開されます。

  - 秘密情報は `.env` や `.dev.vars` などに書き、コミットしない（`.gitignore` に入れてあります）
  - 誤って push したら、すぐにキー（鍵）を無効にして作り直し、運営に連絡してください。履歴から消すだけでは不十分です
  - GitHub の push protection が、よく知られた形式のキーの push を止めることがあります。止められたら、そのキーをコミットから外してください

  ## 提出

  提出の方法と締切は、運営からの案内に従ってください。提出期限を過ぎると、このリポジトリは読み取り専用になり、push できなくなります。

  ## ライセンス

  [MIT License](LICENSE) です。ほかのライセンスにしたいときは、LICENSE を書き換えてください。
