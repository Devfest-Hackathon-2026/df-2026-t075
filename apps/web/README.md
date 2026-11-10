# Webアプリの基盤

Next.js App RouterでAInoteのGoogleログインと部屋の入退室を提供します。ログイン後の「部屋を開く」（`/rooms`）から部屋を作成できます。参加者は招待リンクを開くか6文字のコードを入力し、年齢と文字起こしへの同意を確認して入室します。退室した部屋には「最近の部屋」から戻れます。

トップの「デモを試す」から部屋の作成・入室・ノートを操作できます。招待コードは `AINOTE` で、別のタブからは既定のサンプルに入ります。

新しい保存先はFirestoreです。`POST /api/internal/function-check` は運用者用トークンを確認し、FirestoreとFunctionsを往復します。既存のSQL Connectの確認経路は下記の手順で個別に実行できます。

運用者用の `/voice-probe` では、1人分のマイクでノトの返答音・字幕と計測値を確認できます。[ワーカーの起動・認証・実測手順](../../docs/voice-probe.md)

## 起動と確認

リポジトリのルートで依存をインストールし、以下を実行します。

```sh
npm run dev --workspace @ai-classroom/web
npm run lint --workspace @ai-classroom/web
npm run typecheck --workspace @ai-classroom/web
npm run test --workspace @ai-classroom/web
npm run test:coverage --workspace @ai-classroom/web
npm run build --workspace @ai-classroom/web
npm run start --workspace @ai-classroom/web
```

環境変数のファイルは起動に必須ではありません。`APP_LOG_LEVEL` は `info`・`warn`・`error` のいずれかです。不正な設定では初期化を拒否し、設定名だけを報告します。値はログにもエラーにも出しません。standaloneは500を返す状態で残る場合があるため、プロセスの生存だけで起動成功を判断せずhealthを確認します。

## Googleログイン

Firebaseコンソールのプロジェクト設定でWebアプリを登録し、Authenticationの「ログイン方法」でGoogleを有効にします。「設定 → 承認済みドメイン」にブラウザから開くホスト名を追加します。ローカルで使う場合は `localhost` が該当します。[FirebaseのGoogleログイン手順](https://firebase.google.com/docs/auth/web/google-signin?hl=ja)

WebアプリのSDK設定から次の4項目を `apps/web/.env.local` に設定し、`make dev` を実行します。Cloud Runで使う場合も同じ項目をサービスの実行時環境変数に指定します。ページがブラウザに渡す設定はこの4項目です。

| SDKの項目    | 実行時の環境変数       |
| ------------ | ---------------------- |
| `projectId`  | `GOOGLE_CLOUD_PROJECT` |
| `apiKey`     | `FIREBASE_WEB_API_KEY` |
| `authDomain` | `FIREBASE_AUTH_DOMAIN` |
| `appId`      | `FIREBASE_WEB_APP_ID`  |

[ローカル画面](http://localhost:3000)でGoogleログインボタンを押すとアカウントを選べます。ログイン時とログイン状態の復元時に、ブラウザは `PUT /api/auth/me` にIDトークンをBearerで送ります。サーバーはAdmin SDKでトークンを検証し、Firestoreの `users/{uid}` がなければ、トークンの表示名を `displayName`（未設定なら `null`）、登録日時を `createdAt` として作成します。登録を確認できると本人のUIDを返します。`GET /api/auth/me` は従来どおり本人のUIDを返します。[IDトークンの検証](https://firebase.google.com/docs/auth/admin/verify-id-tokens?hl=ja)

実Firestoreへの登録には、対象DBを読み書きできるアプリケーションのデフォルト認証情報（ADC）が必要です。ローカルでは `gcloud auth application-default login`、Cloud Runではサービスの実行用アカウントを使います。Firebaseコンソールの「Firestore → データ → users」で登録を確認できます。再ログインでは既存のプロフィールと登録日時を保持します。部屋は `rooms/{roomId}`、本人の入退室はその下の `members/{uid}` で確認できます。部屋を作った主催者にも、入室を確定した時点で参加記録ができます。

`make e2e` はJava 21以上とAuthentication・Firestoreの公式エミュレータを使い、テスト用アカウントでプロフィールの作成とログイン状態の復元を検証します。

公開URLは [hackathon-7314b.web.app](https://hackathon-7314b.web.app/) です。配布時はCloud RunのHTTP startup probeに加えて、トップ画面・CSS・APIのアクセス制御を確認します。[公開手順](../../docs/deployment.md#ainoteの公開とロールバック)

`GET /api/health` は `200 {"status":"ok","kind":"liveness"}` を返します。**Webプロセスが応答できることだけを表し、Firebase・Gemini・LiveKit等の接続可否は確認しません。** レスポンスをキャッシュせず、`X-Request-Id` を返します。未知のサーバーエラーでは詳細を返さず、このIDを問い合わせに使います。

## 実DBへの疎通確認

ルートで `npm ci` を済ませ、対象プロジェクトのSQL Connectコネクタを実行できるGoogleアカウントでアプリケーションのデフォルト認証情報（ADC）を用意します。ローカルではGoogle Cloud CLIの `gcloud auth application-default login` を使えます。すでにADCを設定している環境ではその認証を使います。

```sh
make check-db
```

このコマンドは本番ビルドのNext.jsをローカルの空きポートで起動し、`POST /api/internal/db-check` を呼びます。宛先はルートの `.firebaserc` の既定プロジェクトです。サーバーが実行ごとに別のIDと確認用の値を作り、`WriteConnectionCheck` で保存し、別リクエストの `ReadConnectionCheck` で同じ値を読み戻し、`RemoveConnectionCheck` で削除します。成功時の応答は `{"status":"ok","kind":"database-roundtrip"}` です。

テストが一時的な `DB_CHECK_TOKEN` と `GOOGLE_CLOUD_PROJECT` を子プロセスへ設定します。通常起動ではトークンを設定せず、確認用APIは404を返します。有効時も一致するBearerトークンが必要です。実DB検証では `DATA_CONNECT_EMULATOR_HOST` を解除してください。GQLの変更・配布方法は[SQL Connectのデプロイ手順](../../docs/deployment.md#sql-connectのデプロイ)を参照してください。

## 配置と依存の向き

`src/app`はNext.jsの入口、`src/client`はUIとブラウザ向け処理、`src/server`はサーバー側の業務・基盤です。

| ディレクトリ                | 置くもの                                       | 参照してよい自分のアプリのコード                         |
| --------------------------- | ---------------------------------------------- | -------------------------------------------------------- |
| `src/app`                   | ページ・レイアウト・Route Handler              | app・client・serverのcomposition/application/domain      |
| `src/client`                | UIコンポーネント、ブラウザ向け処理、表示用の型 | clientだけ                                               |
| `src/server/domain`         | 業務ルール・業務の型                           | server/domainだけ                                        |
| `src/server/application`    | ユースケースと外部処理のインターフェース       | server/domain・server/application                        |
| `src/server/infrastructure` | 設定・ログ・HTTP・将来の外部サービス実装       | server/domain・server/application・server/infrastructure |
| `src/server/composition`    | 具体的な実装の生成と結線                       | server内の各層                                           |

`client`から`server`は型だけのimportも禁止し、`server`から`client`・`app`にも依存させません。`app`から`server/infrastructure`を直接importせず、実装を選ぶ場所は`server/composition`にまとめます。現在は業務機能がないため、serverのdomain/applicationには説明だけを置いています。架空のEntity、Repository、UseCase、DIコンテナは作りません。

トップ画面の `src/client/components/landing.tsx` はサーバーで描画します。ログイン操作と状態の復元を担当する `src/client/components/google-sign-in.tsx` がClient Componentの入口です。

`src/instrumentation.ts`はNext.jsの起動フックです。Node.js側だけで`server/composition`を呼び、設定検証と起動ログを行います。サーバーの結線には`server-only`を付け、Client Componentから誤ってimportするとビルドを失敗させます。

起動ログはこのフックからのみ出します。Routeは`getServerLogger`でloggerを取得しますが、起動ログを出しません。loggerのキャッシュはNext.jsのバンドルごとであり、プロセス全体で1個ではありません。外部SDKの共有は、導入時に別途設計します。

## ログとテスト

アプリのログは1行のJSONです。イベント名、時刻、レベル、サービス名、HTTPメソッド、ステータス、処理時間、requestId、許可したエラーコードだけを記録し、URLのクエリ、ヘッダー、本文、環境変数、例外のメッセージやスタックは記録しません。秘密情報の収集を避けるため、任意のオブジェクトを渡すログAPIも設けていません。

共通HTTPログでは4xxを含む500未満が`info`、5xxが`error`です。`warn`は最低出力レベルとして利用できますが、現時点で`warn`イベントはありません。対象は共通wrapperを通る応答だけで、Next.jsが直接返す`POST /api/health`の405等には共通ログもrequestIdも付きません。Next.js自身のログもこのJSON形式の対象外です。[詳しい記録範囲と方針](../../docs/architecture.md#設定とログ)

Vitestは設定値の拒否、requestIdの検証、ログの項目制限、エラー応答からの情報漏えい防止を確認し、計測対象のstatement・branch・function・lineに全体90%の下限を置きます。composition・instrumentation・UIは単体カバレッジの対象外です。本番ビルドの起動ログはルートの`npm run test:runtime`、画面はE2Eテストが担当します。外部サービスの疎通試験はまだありません。

ビルドは`standalone`です。monorepoのルートをtraceするため、生成されるサーバーの場所は `.next/standalone/apps/web/server.js` です。build時に `.next/static` と `public` も同じ出力へコピーし、ローカルのstart・E2E・Dockerがこの出力を使います。ローカルstartはlocalhostだけをlistenし、ポートを変える場合は `PORT=3100 npm run start --workspace @ai-classroom/web` を使います。
