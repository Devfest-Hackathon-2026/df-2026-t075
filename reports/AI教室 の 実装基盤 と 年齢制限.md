# AI教室を実現する技術と年齢条件

2026年11月6日確認。**想定しているAI教室は実現可能です。ただし、Google Meet APIを会議エンジンとして採用する前提は変更を勧めます。** 複数人の通話にはLiveKitなどの基盤を使い、部屋ごとに共有のAI先生を参加させる構成が現実的です。また、未成年への提供はGemini Live固有の問題ではなく、採用するAPI全体の利用条件を確認する必要があります。以下は公式資料と現在のリポジトリに基づく設計案で、実際の通話・権限制御は未検証です。

**Meetは、会議を作るAPIと会議中の音声を扱うAPIを分けて考える必要があります。** REST APIは会議作成、参加リンク、設定、参加記録などを扱います。Add-ons SDKは自作アプリをMeet内に表示する仕組みです。自作アプリへ、自由に音声を操作できるMeetを組み込む仕組みとは異なります。さらにMeet Media APIは2026年10月28日に終了が告知され、一般提供には進まず、2027年1月15日にエンドポイントが停止します。新規開発の中心に据えるべきではありません。([Meet REST API](https://developers.google.com/workspace/meet/api/guides/overview)、[Add-ons SDK](https://developers.google.com/workspace/meet/add-ons/guides/overview)、[終了告知](https://developers.google.com/workspace/meet/release-notes))

Meet画面には主催者のAudio Lockがありますが、AIの発話に合わせて参加者のマイクを自動制御する公開APIは確認できませんでした。公開RESTの参加者操作はget/listで、詳細な会議設定にも必要な操作は見当たりません。あらゆる方法で不可能という意味ではありませんが、ハッカソンで実装できると見込むには根拠が足りません。Meetが必須なら、教材表示・テキスト質問・会議リンク連携と、主催者による手動の発言管理へ範囲を縮める案になります。([Audio Lock](https://support.google.com/meet/answer/11274707?hl=en)、[参加者API](https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords.participants))

**Meetのような会議体験を作れればよい場合は、次の構成を提案します。** 現在のリポジトリはFirebase Hosting上の動作確認用HTMLが中心なので、既存の公開基盤を継続し、画面とバックエンドを追加する方針です。サーバー側描画が必要と決まっていないため、最初からNext.jsを必須にはしません。([現在のREADME](../README.md))

| 担当 | 技術案 | 実装する内容 |
|---|---|---|
| 画面 | React・TypeScript・Vite、Firebase Hosting | 教室一覧、単元、所要時間、参加者、教材、挙手 |
| ログイン | Firebase Authentication | ユーザーの識別 |
| 部屋と進行 | Firestore | メンバー、授業の段階、質問待ち、現在の発言者 |
| 教材 | Cloud Storage for Firebase | 部屋ごとのPDF保存・閲覧制限 |
| 操作用API | Cloud Run | 入室許可、招待検証、通話用トークン発行、発言権の変更 |
| 音声・映像の中継 | LiveKit Cloud | 複数人のWebRTC通話 |
| AI先生・メンター | LiveKit AgentsとGemini Liveなど | 部屋に参加して質問を聞き、音声を配信する共有AI |

AIエージェントの実行先はLiveKit CloudまたはCompute Engineを候補にします。Cloud Runには入室・教材処理などのAPIを置き、会議中継サーバー自体は置かない構成です。LiveKitにはGemini Liveとの公式連携がありますが、技術的に接続できることと、対象年齢に提供できることは別の確認事項です。([Gemini連携](https://docs.livekit.io/agents/models/realtime/gemini/)、[エージェント配備](https://docs.livekit.io/deploy/agents/managing-deployments/)、[中継に必要な通信ポート](https://docs.livekit.io/transport/self-hosting/ports-firewall/))

**設計上の中心は、AIへの指示文よりも、部屋と発言権の管理です。** 一つの部屋に一つの共有AIセッションを置き、同じAI音声を全員へ配信します。各生徒が別々にGeminiへ接続すると、先生の発言や授業進行が人数分に分かれてしまいます。授業は「待機→解説→質問→演習→まとめ→終了」という状態をサーバーが保持し、AIは現在の段階の説明や回答を担当します。所要時間を管理するため、最初の単元は説明・確認問題・進行順を事前に用意するのが堅実です。

解説中はサーバー側で生徒の音声を止め、音声の再配信も制限します。質問時は「挙手→一人を指名→質問→AI回答」に絞ります。ミュートボタンを無効にするだけでは、再接続やクライアント改変に対応できません。一方、配信権限をすべて取り消すとカメラも止まるため、カメラを維持する場合は音声トラックと音声源別の権限を制御します。発言権を戻した後、マイクをオンにするのは本人です。([参加者の権限管理](https://docs.livekit.io/intro/basics/rooms-participants-tracks/participants/)、[ミュートと配信元の制御](https://docs.livekit.io/reference/other/roomservice-api/))

LiveKitの標準AIセッションは、既定では最初に入室した一人を会話相手とします。複数人教室では指名した人へ聞き取り対象を切り替え、その人が退出しても授業全体が終了しないようにします。友達部屋では自由な会話を許し、「AIに質問」ボタンでAIに渡す質問を明示すると、雑談への誤反応と不要な処理を抑えられます。授業部屋と友達部屋は共通の部屋機能を使い、進行ルールを変える設計で十分です。([AIセッションの参加者選択](https://docs.livekit.io/agents/logic/sessions/))

教材は短いPDF一つから始めます。保存後に通常の文書理解APIで問題番号・ページ付きの内容を整理し、必要な部分をAI先生へ渡す方法なら、Live APIがPDFを直接扱えることを前提にせず進められます。最初から検索用のベクトルDBを導入する必要はありません。認証済みユーザー全員が読める設定にはせず、部屋のメンバーだけが取得できるようにします。招待リンクも管理権限を兼ねず、サーバーで参加資格を確認して通話用トークンを発行します。APIキーはブラウザへ渡しません。([文書理解](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/document-understanding)、[Storageアクセス制御](https://firebase.google.com/docs/storage/security/rules-conditions)、[ログイン情報のサーバー検証](https://firebase.google.com/docs/auth/admin/verify-id-tokens))

**18歳未満への対応は、実装前に対象年齢を決める必要があります。** Gemini Developer APIの追加規約は、開発者自身の年齢に加え、18歳未満を対象とする、または18歳未満が利用する可能性のあるクライアントへの提供を制限しています。通常のテキストAPIに替える、音声認識→Gemini→音声合成に分ける、有料プランにする、といった変更ではこの条項を解消できません。消費者向けGeminiアプリの利用資格と、独自アプリへのAPI組み込み条件は区別してください。([Gemini API追加規約](https://ai.google.dev/gemini-api/terms)、[消費者向けLiveの条件](https://support.google.com/gemini/answer/15274899?hl=en))

「Vertex AI経由なら未成年にも提供できる」とも判断できません。2026年10月30日更新のGoogle Cloudサービス固有規約20(d)にも年齢制限があり、サービス一覧には旧Vertex AI API・旧Vertex AI Live APIが生成AIサービスとして含まれます。保護者同意や学校利用で解除される一般的な例外は、確認した条項にありません。学校が公式Gemini Appsを使えることも、自作APIアプリへの許可にはそのまま移せません。([Cloud規約20(d)](https://cloud.google.com/terms/service-terms)、[対象サービス一覧](https://cloud.google.com/terms/services)、[学校向けGemini Apps](https://support.google.com/gemini/answer/14620100?co=DASHER._Family%3DEducation&hl=en))

対象が18歳以上でよければ、その範囲にデモと実利用を揃え、利用者確認を含めて設計する案が取りやすいです。「18歳以上」と表示するだけで十分という保証ではありません。高校生以下がプロダクトの中心なら、Googleへ対象年齢・提供形態・使用API・データの流れを示し、適用可能な契約条件を文書で確認する必要があります。許容される経路がなければ、未成年向け提供が認められる別APIなどを選び直します。AI呼び出しを部屋管理から分離しておけば変更しやすく、最初から大規模な共通AI基盤を作る必要はありません。

**ハッカソンでは、先に友達部屋で「複数人が同じ教材を見て、一つのAIへ質問する」流れを完成させ、同じ基盤に一単元の授業進行を追加する順番を勧めます。** 提出範囲は、実参加者2〜4人、短い単元一つ、教材一つ、挙手による一人ずつの質問に絞ります。これは提案する範囲で、サービスの仕様上限ではありません。カメラ・大量教材検索・自然な同時発言・凝ったAIアバターは、核となる体験が動いてから追加できます。

完成の判断は画面だけで行わず、複数端末で同じAI音声と授業状態を共有できること、解説中に音声を再送できないこと、指名交代後も正しく回答すること、最初の参加者の退出で授業が止まらないこと、他の部屋の教材を取得できないことを確認します。空室時にAIを終了し、部屋数・授業時間に上限を設ければ、稼働する部屋数に応じた費用も管理しやすくなります。最後に検証したい価値は「AIが話せる」だけでなく、他の人の質問から学べる、友達と続けられるなど、複数人で参加する理由です。

未確定なのは、ハッカソンの必須技術・外部サービス利用条件、対象年齢、チームの期限・予算、実際に選ぶモデルと接続上限です。現時点では、この条件付きの設計を提案しており、実装・契約適合性・学習効果を確認済みとは扱っていません。
