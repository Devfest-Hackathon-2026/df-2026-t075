# AI教室の実装基盤とハッカソン範囲

確認日: 2026-11-06。以下は実装済みの説明ではなく、公式仕様と現在のリポジトリを踏まえた設計案。年齢制限は別担当の調査結果を優先し、Gemini採用案は18歳以上に限定する前提。Vertex AIへの移行を年齢制限の回避策とは扱わない。

## 現在のリポジトリから何を再利用できるか

### Takeaway
Firebase Hostingによる公開は用意されているが、アプリ本体は動作確認用の静的HTML。認証、部屋管理、音声通信、AIワーカーは新規実装になる。

### Cited Findings
- READMEは「3人チームのハッカソン開発用」で、現在は動作確認用HTML、main更新でpublic/をHostingへ公開すると記載。ファイル一覧はREADME、docs/deployment、firebase.json、public/index.htmlが中心。— [README](../../README.md)
- デプロイ設定はHostingだけを対象にし、FirestoreやFunctionsは含まない。React導入時はビルド工程・公開ディレクトリ・ワークフローの検証を変更する必要があると明記。— [デプロイ文書](../../docs/deployment.md)
- リポジトリ内の探索ではAGENTS.mdは見つからず、ハッカソン応募規則やGoogle Meet必須条件も確認できなかった。— [README](../../README.md)

### Inferences
- React + TypeScript + Viteを加え、既存Firebase Hostingを継続する構成が自然。サーバー側描画が必要と分かっていない段階ではNext.jsを必須にしない。
- 「GoogleのハッカソンだからMeet必須」とは推論しない。GeminiとFirebase/GCPを主要構成にし、RTC部分に他社の基盤を使えるかは大会規則で確認する。

### Gaps
- 大会名、締切、審査基準、外部サービス利用規則、チームの得意言語・経験、予算は未確認。完成までの日数は断定しない。

## 複数人とAIが同席する部屋をどう実装するか

### Takeaway
提案は「自作の教室画面 + LiveKitの会議通信 + 部屋ごとのAIワーカー」。LiveKitは映像・音声の中継を担当し、授業進行、指名、教材へのアクセスはアプリのバックエンドで管理する。

### Cited Findings
- LiveKitは部屋単位の参加者identityと権限をアクセス用トークンに含め、参加者が音声・映像を配信/受信できる。— [接続](https://docs.livekit.io/intro/basics/connect/)、[トークンと権限](https://docs.livekit.io/frontends/reference/tokens-grants/)
- LiveKit AgentsのGoogle pluginはGemini Live APIとVertex AIへの接続をサポート。これは技術的対応であり対象年齢の許可を意味しない。— [Gemini Live連携](https://docs.livekit.io/agents/models/realtime/gemini/)
- 標準AgentSessionは「最初に入室した一人」を会話相手にする。RoomIO.set_participant()等で切替可能。既定では紐づいた相手が退出するとセッションが閉じるため、教室では退出動作も変更する必要がある。— [Agent session](https://docs.livekit.io/agents/logic/sessions/)
- バックエンドのUpdateParticipantで配信権限を更新可能。CanPublishを取り消すと現在の配信トラックも削除される。マイクだけでなくカメラも含む点に注意。— [参加者管理](https://docs.livekit.io/intro/basics/rooms-participants-tracks/participants/)
- MutePublishedTrackで既存トラックをミュート可能。遠隔アンミュートはプライバシー上の理由で既定では無効。音声源別のcan_publish_sources権限も存在する。— [Room service API](https://docs.livekit.io/reference/other/roomservice-api/)
- LiveKit CloudはAIエージェントのコンテナをビルド・配備する機能を持つ。— [エージェント配備](https://docs.livekit.io/deploy/agents/managing-deployments/)
- LiveKit SFUを自己運用する場合、公開UDPポートなどが必要。Cloud Runの通常のサービスはHTTPリクエスト中心で、WebSocketもタイムアウト・再接続・インスタンス間状態同期を考える必要がある。— [LiveKit通信ポート](https://docs.livekit.io/transport/self-hosting/ports-firewall/)、[Cloud Runコンテナ契約](https://docs.cloud.google.com/run/docs/container-contract)、[Cloud Run WebSocket](https://docs.cloud.google.com/run/docs/triggering/websockets)

### Inferences

提案する責務分担:

| 機能 | 技術案 | 担当すること |
|---|---|---|
| 教室一覧・授業画面 | React/TypeScript + Firebase Hosting | 単元、所要時間、参加者、教材、挙手ボタン |
| ログイン | Firebase Authentication | アカウントと本人識別 |
| 部屋・教材情報・進行状態 | Firestore | roomId、mode、phase、currentSpeaker、lessonId、members |
| 教材ファイル | Cloud Storage for Firebase | 部屋のメンバーだけが取得できるPDF等 |
| 入室・指名・権限のAPI | Node.js/TypeScriptまたはFastAPI + Cloud Run | 認証確認、招待の検証、短期の部屋トークン発行、授業操作 |
| 複数人の音声・映像 | LiveKit Cloud | WebRTC/SFUによる中継。WebRTCは会議通信、SFUは中継サーバー |
| AI先生・メンター | LiveKit Agents + Gemini Live | 1部屋に1つの共有AIセッション。実行先はLiveKit CloudまたはCompute Engine |

- AI音声を一度生成して会議部屋に配信し、全員が同じ先生を聞く。生徒のブラウザごとに個別Live接続を作ると、先生の回答と進行が人数分に分裂する。
- AIに授業の権限を全面委譲しない。小さな状態機械で `待機 → 解説 → 質問 → 演習 → まとめ → 終了` を管理する。単元のステップと時間はアプリが保持し、AIは現在のステップを説明する。
- 解説中は生徒の音声配信をサーバーで停止/禁止し、質問時はキューの先頭だけに発言権を付与。その人をAIのlinked participantに切り替える。解除時は本人がマイクをオンにする。UIのミュートボタンを無効にするだけでは改変や再接続に耐えない。
- 音声専用MVPならCanPublish全体の取消が簡単。カメラを維持する版では、音声トラックへのミュートとマイク/画面共有音声の配信制御を組み合わせる。権限更新だけで既存の特定ソースがどう扱われるかは実機で確認する。
- 同時発言を自然に理解する自由会話は追加開発。最初は「挙手 → 一人を指名 → 質問 → AIの返答」を固定する。友達部屋は通常の自由会話を許可するが、AIには「AIに質問」操作で対象の音声かテキストを明示的に渡す。
- 授業部屋と友達部屋を別アプリとして作らず、共通のRoomにmodeと進行規則を持たせる。AIワーカーは必要な部屋にだけ立ち上げ、空室なら終了する。
- 通常のCloud RunサービスにSFUそのものを置く案は避ける。Cloud Runは入室・教材処理等のAPI向け、会議中継はLiveKit Cloud。GCP内で自己運用する要件がある場合はCompute Engine等を別途検討する。
- コストは概ね「参加者の接続時間・通信量 + AIが稼働する部屋数×時間 + 教材解析」。部屋数・時間の上限を設定する。具体的料金と同時接続数は、採用プラン/モデルを決めた時点で確認する。
- Meetを外部リンクで開き、横に教材チャットを置く簡易案はあり得るが、それは『同じ会議でAI先生が発話し指名する』体験とは異なる。Meet自体の仕様・提供終了はmeet.mdの調査を参照。

### Gaps
- AgentSessionの参加者切替時の音声欠落・前の話者コンテキスト、退室時復旧、モデル側セッション制限は検証していない。公式に構成部品はあるが、この教室体験が完成品として提供されているわけではない。
- 具体的モデルID、リージョン、料金、上限はここでは選定していない。採用時の実際のプロジェクトで確認が必要。

## 教材対応と最初の提出範囲はどう絞るか

### Takeaway
まず「一つの単元を複数人で受講し、挙手してAIに質問できる」体験を完成させる。教材は短いPDFを1つに制限し、ベクトルDB・RAG基盤は最初から導入しない。

### Cited Findings
- Geminiの文書理解はPDFを入力として利用できる。ただし手書きの解釈、位置の理解などには誤りがあり得る。— [文書理解](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/document-understanding)
- Storage Security Rulesは認証、ファイルパス、サイズ、contentType、Firestoreの会員情報を使ってアクセスを制限できる。— [Storageの条件付きルール](https://firebase.google.com/docs/storage/security/rules-conditions)
- 独自バックエンドにはFirebase ID tokenをHTTPSで渡し、サーバー側で署名・有効期限等を検証してuidを取得する。— [ID token検証](https://firebase.google.com/docs/auth/admin/verify-id-tokens)

### Inferences
- 教材処理案は「PDF保存 → 通常のGeminiリクエストでページ/問題番号つきで内容整理 → 教室のAIへ必要な内容を渡す」。AIが答える際に問題番号や該当ページを表示し、読み取り間違いを検証できるようにする。Live APIの直接ファイル入力可否を前提にしないので、モデル差に依存しにくい。
- 問題が少ない段階なら全文/該当ページを渡す方式で十分。教材が多数・長大になってから検索用の索引やRAGを追加する。最初からベクトルDB、マルチエージェント、複雑なワークフロー基盤を積む必要はない。
- 教材中の文章は指示として実行せず参照データとして扱う。AIからのツール呼出しでもroomId/membershipをサーバーで検証し、別教室の教材へアクセスできないようにする。
- 招待URLは参加の入口であり、管理権限を与えない。短期トークン発行APIはFirebase認証、部屋の参加権限、定員を検証する。APIキーとroomAdmin権限はブラウザに置かない。
- 認証済みユーザー全員に教材を公開するルールは不適切。部屋のメンバー単位にする。ファイルの拡張子/contentTypeだけで中身が安全だとはみなさず、サイズと形式の実検証、期限つき削除を行う。
- ハッカソン提案: 18歳以上、大学生/成人の学習単元1つ、短い1授業、実参加者2〜4人、共有AI1人、解説と一問ずつの質問、教材1ファイル。人数/時間は製品上の提案で、サービスの仕様上限ではない。
- カメラ映像、常時の雑談理解、自由な途中参加、教材の大量検索、凝ったAIアバターは後回し。音声 + 参加者表示 + 同じ教材で核となる体験を確認できる。授業を開始する人と途中参加者の扱いは仕様として決める必要がある。
- 固定の授業は事前に作成/確認した説明と問題を使い、質問時に生成AIを使う設計も有効。完全即興授業より時間と品質を検証しやすい。ライブ音声より安定性優先ならSTT→通常LLM→TTSという代替もあるが、Geminiの年齢制限を解決する案ではない。
- 最初に検証する受入条件: 2台以上で同じAI音声/授業状態が見える、解説中に生徒が音声を再送できない、指名者が交代してもAIが正しく応答する、先頭参加者の退出で授業が終了しない、非メンバーが教材を読めない。

### Gaps
- 学習効果は実装できることとは別。『一人のAIチャットより複数人で学ぶ理由』を、他の人の質問から学べる・友達と継続できる等の仮説として少人数で検証する必要がある。
- 未成年の提供条件は別調査に依存。親の同意や有料API、Vertex移行だけで解決するとは主張しない。
