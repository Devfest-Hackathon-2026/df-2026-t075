# 実行・配布・運用

## 現在できること

参加者向けWebは `main` のCI成功後に、東京のCloud Runから[従来のFirebase Hosting URL](https://hackathon-7314b.web.app/)で配信する。[公開とロールバック](#ainoteの公開とロールバック)を参照。運用者のFirestore・Functions往復試験には別のIAM認証付きサービス `meeting-web` を使う。

```sh
make docker-check
```

この検証は一時的なComposeプロジェクト名とlocalhostの空きポートを使い、Agentの正常終了、Webのhealthcheck、ホストからのHTTPを確認する。成功・途中失敗・SIGINT／SIGTERMで終了処理を行い、自分のコンテナ・ネットワーク・自動命名されたサービスイメージを削除する。失敗時は削除前にログを出し、失敗した終了コードを保つ。後片付け自体が失敗した場合も成功扱いにしない。

コンテナの削除と一時ディレクトリの削除には同じ終了コードの方針を適用する。それ以前に失敗・中断していた場合は元のコードを保持し、それ以前が成功していた場合は後片付けの失敗として1を返す。

SIGKILLやDocker daemonの停止では片付けを完了できない場合がある。その場合は冒頭に表示された`ai-classroom-check-...`の名前を使い、`docker compose -p <表示された名前> down --remove-orphans --rmi local`で片付ける。ビルドキャッシュとベースイメージは保持する。

起動したまま手元で確認するときは、通常のComposeプロジェクトを使う。

```sh
docker compose up -d --build --wait web
curl --fail http://localhost:8080/api/health
docker compose logs web
docker compose down
```

Webは非rootで `0.0.0.0:$PORT` をlistenする。Composeの既定ホストポートは8080で、`WEB_PORT`で変更できる。ホストにはlocalhostだけを公開する。Next.jsのstandalone出力を使い、開発用ソースや依存全体を実行イメージへコピーしない。Agentも非rootで起動するが、現在は設定確認後に正常終了する。これは常駐ワーカーではなく、`restart: always` やGCEの常駐サービスとして登録してはいけない。

Dockerのビルドコンテキストから `.env`、秘密鍵、ローカルキャッシュを除外する。Webの `NEXT_PUBLIC_*` はビルド時にブラウザ用コードへ埋め込まれるため、秘密値を置かない。[Next.jsの実行時設定](https://nextjs.org/docs/app/guides/self-hosting#environment-variables)

## 本番配布へ進むときの構成

WebはArtifact Registryのイメージをdigestで指定してCloud Runに配布する。Firestoreの作成イベントはEventarcを通じて第2世代Functionに届く。将来のAgentはCompute Engineで動かす計画で、実行アカウントはWebと分ける。

| 認証する主体                     | 用途                                                        | 権限の考え方                                                                                                                                             |
| -------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub Actionsの配布用アカウント | イメージ登録・指定サービスへの配布                          | Artifact Registry書き込み、対象の配布権限、対象実行SAを利用する権限                                                                                      |
| Cloud Runの実行用アカウント      | WebからFirestoreの検証ドキュメントを作成・購読・削除する    | 対象DBの読み書き。運用者用トークンを使う場合だけ対象Secretのaccessorを付与                                                                               |
| Functionsの実行用アカウント      | 作成イベントを受けて同じドキュメントを更新する              | 対象DBの読み書き。配布権限は別のアカウントに設定                                                                                                         |
| GCEの実行用アカウント            | AIワーカーからVertex等へアクセス。Webへ段階の切り替えを提案 | Vertex・Speech-to-Textの必要な権限。部屋データはWebのAPIを通す。WebへはGoogle IDトークンを付けて呼び、Web側で署名・宛先・アカウントを検証する。Webと分離 |

GitHubからGoogle Cloudへの認証はWorkload Identity Federationを使う。長期秘密鍵を追加せず、信頼条件を対象リポジトリと配布ブランチ／Environmentに限定する。GitHubのOIDC subjectにはリポジトリ作成時期による形式差があるため、実際のclaimを確認して設定する。[GitHub公式のOIDC手順](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-google-cloud-platform)

既存のFirebase Hosting用アカウントにCloud RunやVertexの権限を追加しない。LiveKitの秘密情報はサーバー側のSecret Managerで扱い、ブラウザには短期の入室トークンだけを渡す設計にする。

参加者向けWebは最小0台・最大2台とし、GCEのAgentはこの配布に含めない。以下のFirestore疎通試験は限定公開Web・Functionで実行する。

### Cloud RunのHTTP startup probeを必須にする

初回デプロイから、Webの起動確認にはHTTP/1の`GET /api/health`を使う`startupProbe`を明示する。既定のTCP probeはポートへの接続だけを確認するため、設定不正でhealthが500になる現状のサーバーを起動成功と判定し得る。Composeのhealthcheck設定はCloud Runへ自動では引き継がれない。

以下はコンテナのポートが8080の場合に、Cloud Runサービスの`containers`要素へ追加する設定例。実際のポートと起動時間に合わせて調整し、デプロイ設定で管理する。

```yaml
startupProbe:
  httpGet:
    path: /api/health
    port: 8080
  initialDelaySeconds: 0
  timeoutSeconds: 3
  periodSeconds: 5
  failureThreshold: 12
```

Cloud RunはHTTP probeの2xx・3xxを成功と扱うため、healthをログイン画面等へリダイレクトさせない。正常時は200、設定不正時は2xx・3xx以外（現状は500）を返す。startup probeが失敗し続けるとコンテナは停止される。[Google公式のstartup probe仕様](https://docs.cloud.google.com/run/docs/configuring/healthchecks)

デプロイ実装時の受け入れ条件は、正常な設定で起動確認が通ることと、限定公開の検証環境で`APP_LOG_LEVEL`に不正値を与えたリビジョンが起動成功にならず、トラフィックを受けないこと。ローカルの500応答テストやComposeの成功だけで、このCloud Run側の確認を代用しない。

`make deploy-web` は上記のHTTP probeを設定する。東京の限定公開環境では、通常URLの通信を正常版に100%残して不正設定の候補を試した。通信0%の候補は起動せず休止することがあるため、検証用タグに一時的に最小1台を設定して実際に起動させた。`meeting-web-badcfg-1108` が `Ready=False`・`HealthCheckContainerError` となり、受けた通常トラフィックは0%。正常な候補の起動後、最小0台に戻し、タグを解除した。

## FirestoreとFunctionsの配布と確認

2026年11月8日、東京（`asia-northeast1`）のFirestore Native・Standardの `(default)` DBに対し、配布済みWebから検証用ドキュメントを作成した。第2世代Functionが同じドキュメントに応答を書き、Webが値の一致を確認して削除するまでのHTTP 200を2回確認した。直後の検証コレクションは0件。匿名のWeb・Function呼び出しとFirestoreの読み取りは各403、Cloud Runの認証だけで運用者トークンを付けない検証リクエストは404だった。

| 対象      | 確認した配布状態                                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloud Run | `meeting-web-verified-1108` に100%。イメージは `meeting-deploy/web@sha256:fb31e4bbf0cfa978f55978b4c5111ccfff0982def0399454b30aa316ee2c32bf` |
| Function  | `confirmFirestoreCheck`、Node.js 22、`confirmfirestorecheck-00002-ged`。Web、Functionとも最小0台・最大2台                                   |
| アクセス  | WebはIAM必須。Eventarcの `meeting-events` は宛先Functionを、検証用の `meeting-verifier` はWebを呼べる                                       |

運用者はNode.js 22と認証済みのGoogle Cloud CLIで、実際に配布されたWeb経由の往復を再検証できる。

```sh
GOOGLE_CLOUD_PROJECT=hackathon-7314b make check-deployed-firestore
```

このコマンドはサービス設定からURLとSecretのバージョンを読み取る。運用者にはこの設定と対象Secretの読み取り、対象プロジェクトのAPI利用、検証用アカウントのIDトークン発行権限が必要。検証用アカウントのWeb呼び出し権限は `meeting-web` サービスに付与した。通常のGoogle CloudアカウントがWeb呼び出し権限を持つ場合は、`gcloud run services proxy meeting-web --region=asia-northeast1 --project=hackathon-7314b` が表示するlocalhostのURLで準備中画面を開ける。[Cloud Run管理画面](https://console.cloud.google.com/run/detail/asia-northeast1/meeting-web/revisions?project=hackathon-7314b)

### 配布を更新する

リポジトリのルートでNode.js 22を使い、`npm ci` と `npm ci --prefix apps/functions` を実行する。

1. 対象プロジェクトを `GOOGLE_CLOUD_PROJECT` に設定する。Firestore APIを有効にし、既存のDBとその場所を確認する。新規のときだけ `gcloud firestore databases create --project="$GOOGLE_CLOUD_PROJECT" --database='(default)' --location=asia-northeast1 --type=firestore-native` で作成する。新規DBでは `npx --yes firebase-tools@15.35.0 deploy --project "$GOOGLE_CLOUD_PROJECT" --only firestore:rules` でサーバー専用Rulesを反映する。既存DBではこのコマンドがRules全体を置換するため、利用中のルールと統合してから配布する。
2. `meeting-web` と `meeting-events` に `roles/datastore.user` を付け、IAM条件の `resource.name` で対象を `projects/プロジェクトID/databases/(default)` に限定する。初回はGoogle Cloud CLIでFunctionの実行アカウントとEventarcのトリガーアカウントを両方 `meeting-events` に指定した。このアカウントにはプロジェクトの `roles/eventarc.eventReceiver` と、宛先サービス `confirmfirestorecheck` の `roles/run.invoker` を付与する。以降は `make deploy-function` が `meeting-events` コードベースの対象Functionだけを更新する。Function専用の `gcf-artifacts` は古いビルドイメージを7日で削除する。[FirestoreのDBごとのIAM設定](https://firebase.google.com/docs/firestore/manage-databases#configure_per-database_access_permissions)
3. ADCが利用できる環境で `make check-firestore` を実行する。ローカルの本番ビルドから実Firestoreに毎回異なる値を書き、デプロイ済みFunctionが返した値と照合して削除する。ローカルだけの試験にはJava 21以上と `make check-firestore-emulator` を使う。
4. Webイメージは既存のArtifact Registryへ登録する。リポジトリのルートで `docker buildx build --platform linux/amd64 -f apps/web/Dockerfile -t "$WEB_IMAGE_TAG" --push .` を実行する。`WEB_IMAGE_TAG` はコミットSHAのタグ付きの完全名。出力されたdigest付き完全名を `WEB_IMAGE`、Web用実行アカウントを `WEB_SERVICE_ACCOUNT` に設定し、`make deploy-web` で配布する。サービス名の既定は `meeting-web` で、`WEB_SERVICE` で変更できる。初回はIAM認証あり、最小0台・最大2台。疎通APIを有効にする場合は32文字以上の運用者用トークンをSecret Managerに用意し、`DB_CHECK_SECRET_VERSION` に `シークレット名:バージョン` を指定する。

Linuxのビルド環境には東京のCloud Buildも使える。初回配布では、Mac上のamd64エミュレーションでNext.jsのビルドが停止したため、Cloud Buildで同じDockerfileをビルドした。以下はWebのみに絞った送信対象とビルド設定を使うコマンド。ビルド用アカウント `meeting-build` にはソース用バケットの読み取り、Web用レジストリへの書き込み、ビルドログの書き込みを付与した。専用の東京バケットは1日経過したソースを削除対象にする。

```sh
export GOOGLE_CLOUD_PROJECT=hackathon-7314b
export WEB_IMAGE_TAG="asia-northeast1-docker.pkg.dev/${GOOGLE_CLOUD_PROJECT}/meeting-deploy/web:$(git rev-parse --short HEAD)"
gcloud builds submit . --project="$GOOGLE_CLOUD_PROJECT" --region=asia-northeast1 \
  --config=scripts/cloudbuild-web.yaml --ignore-file=scripts/web.gcloudignore \
  --substitutions="_WEB_IMAGE_TAG=$WEB_IMAGE_TAG" \
  --gcs-source-staging-dir="gs://${GOOGLE_CLOUD_PROJECT}-meeting-build/source" \
  --service-account="projects/${GOOGLE_CLOUD_PROJECT}/serviceAccounts/meeting-build@${GOOGLE_CLOUD_PROJECT}.iam.gserviceaccount.com"
```

運用者の疎通APIは `POST /api/internal/function-check`。Cloud Run用IDトークンを `X-Serverless-Authorization`、アプリの運用者トークンを `Authorization` に付ける。成功時の `kind` は `firestore-event-roundtrip`。Webは作成したドキュメントを購読し、応答を最大45秒待つ。Functionは作成時の版にだけ応答し、重複・削除後の再通知で再作成しない。疎通試験はリクエスト単位でやり直せるため、Functionのエラー時の自動再試行は無効。Webは終了時に検証ドキュメントを削除する。プロセスを強制終了した場合は `functionChecks` の合成データが残る可能性がある。公開WebとSQL Connectは各専用手順で配布する。

## 障害の調べ方と戻し方

1. CIやコンテナの終了コードを確認する。Agentの設定エラーは終了コード2。
2. Webの共通HTTP処理を通るエラーは応答のrequestIdからログを探す。Next.jsが直接返す404・405等には共通ログとrequestIdがない（[記録範囲](architecture.md#設定とログ)）。設定エラーでは変数名を確認し、秘密値を貼らない。不正な設定でもNext.jsのプロセス自体は残り得るため、生存確認だけでなくhealthのHTTPステータスを確認する。
3. `/api/health` の200はWebのlivenessを表す。実際のイベント連携は `make check-deployed-firestore`、既存SQL Connectの読み書きは `make check-db` で確かめる。
4. 機能追加時は外部通信にタイムアウトを設ける。認証・権限拒否を無条件に再試行しない。
5. 配布後の不具合は直前の検証済みイメージdigestへ戻す。Cloud Runは前のrevisionへのトラフィック切替、GCEは前のイメージへの入れ替えを基本にする。DB変更を導入したら、コードだけ戻せるかを別途設計する。

部屋データの運用では、削除・保持期間、バックアップ、同時に動かすAIメンバーの数、部屋の利用時間を決める。空室・会議終了時にワーカーが音声購読を閉じることを確認する。[会議エージェントの実装設計](meeting-agent-design.md)

## SQL Connectのデプロイ

`hackathon-7314b` の `asia-northeast1` にある `hackathon-7314b-service` を使う。Cloud SQLインスタンスは `hackathon-7314b-instance`、DBは `hackathon-7314b-database`、コネクタは `app`。接続先は `dataconnect/dataconnect.yaml`、テーブルは `dataconnect/schema/`、アプリが実行できる操作は `dataconnect/app/` で管理する。

スキーマや操作を変更したら、ルートでFirebase CLI（動作確認版15.35.0）を使う。コンパイルで生成したAdmin SDKもGitに含めることで、Webのビルドはクラウドの認証情報なしで行える。

```sh
npx --yes firebase-tools@15.35.0 dataconnect:compile
npx --yes firebase-tools@15.35.0 dataconnect:sql:diff --service hackathon-7314b-service
```

表示されたDDLを確認し、必要なテーブル変更だけを適用してからコネクタを配布する。この構成の `COMPATIBLE` モードではスキーマに含めていない既存テーブルを保持する。

```sh
npx --yes firebase-tools@15.35.0 dataconnect:sql:migrate --service hackathon-7314b-service
npx --yes firebase-tools@15.35.0 deploy --only dataconnect:hackathon-7314b-service
make check-db
```

配布にはFirebase CLIの認証、実DBテストにはWebプロセスから使えるADCが必要。既存のADCファイルを使う場合はシェルで `GOOGLE_APPLICATION_CREDENTIALS` にそのパスを設定する。Webが定義済みコネクタを呼ぶ権限は `firebasedataconnect.connectors.impersonateQuery` と `firebasedataconnect.connectors.impersonateMutation`。配布やDBの管理権限は実行アカウントに含めない。[FirebaseのIAM](https://firebase.google.com/docs/sql-connect/iam-configuration)

実DBテストは書いた行を毎回削除する。プロセスの強制終了などで残った行は、次に書き込みが成功した時点で作成から24時間を過ぎていれば回収する。Hostingと通常のCIはDBへの配布や実DBテストを実行しない。

## AInoteの公開とロールバック

`main` へのマージ後、[CI](https://github.com/DotHub-japan/googlehackathon/actions/workflows/ci.yml) の `Required checks` が通ると `Publish AInote` が動く。PRではテストまでを実行する。再配布は同じCIの「Run workflow」で `main` を指定する。

1. マージしたコミットの `apps/web/Dockerfile` をビルドし、東京の専用Artifact Registry `ainote-public/web` にコミットSHAのタグで登録する。
2. イメージのdigestを指定してCloud Runの `ainote-web` を更新する。通常の配布はイメージのみ更新し、Googleログインの実行時設定を保持する。公開用の実行アカウント `ainote-web` は既定のFirestore DBを読み書きする。運用者用の `DB_CHECK_TOKEN` は限定公開の `meeting-web` でのみ設定する。
3. Cloud RunのURLでAInoteのトップ・ログインの初期表示・CSS・未ログインの部屋API（401）・運用者用API（404）を確認する。成功した版をFirebase Hostingの `pinTag` で固定してから、同じ検証を [公開URL](https://hackathon-7314b.web.app/) でも行う。ルートの `public/index.html` は配信しない。[Firebase公式のCloud Run連携とロールバック](https://firebase.google.com/docs/hosting/cloud-run)
4. 公開後に問題があれば、Firebaseコンソールの Hosting → リリース履歴から直前の正常版をロールバックする。WebとHostingの転送先が一緒に戻る。Firestoreに保存済みのデータは維持される。

会議の予定と版番号は `agendaV3` に保存する。固定ID対応版の `agendaV2` は読み取り時に旧 `version` を `planVersion` の初期値にし、最初の変更と同じトランザクションで移行する。番号付きパートの旧 `agenda` は従来どおり初回利用時にIDと番号の対応を固定する。新規の部屋は準備開始時に保存する。移行時に両方の旧フィールドを再読み込み案内の確定済み最終行に置き換えるため、旧サーバーに残ったリクエストから新しい予定を上書きできない。旧タブで予定の保存を求められたら再読み込みする。旧サーバーへロールバックした場合、移行済みの部屋で編集を再開するには `agendaV3` 対応版を再配布する。

GitHubの配布用アカウント `ainote-publisher` は、Workload Identity Federationで `DotHub-japan/googlehackathon` の `main` のCI（pushと手動実行）からのみ使用する。プロバイダ `ainote-github/github-main` は所有者とリポジトリの数値ID、ブランチ、イベント、ワークフローパスを検証する。配布には公開用レジストリへの書き込み、対象サービスの取得・更新、公開用実行アカウントの使用、およびHostingのリリース権限を使う。

Googleログインには `apps/web/README.md` の4個の設定と、Firebase AuthenticationでのGoogleプロバイダの有効化、承認済みドメイン `hackathon-7314b.web.app` が必要。設定や権限を更新したときは公開URLでGoogleログインを開いて確認する。
