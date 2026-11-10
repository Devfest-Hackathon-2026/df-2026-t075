# 未成年向けAI教室のGemma自己運用案

確認日: 2026-11-06。対象は当初から高校生以下、Meetそのものは必須でなく会議型体験が必要、という修正を反映。以下は技術と公開規約の調査で、Googleによる個別の提供承認を得たものではない。

## Gemmaは未成年向けの有力な候補になるか

### Takeaway
Google中心で作りたい場合、**Gemma 4の重みを取得して自分たちの推論サーバーで動かす**案は、有力な検討候補。公式の想定用途にK-12数学指導が明記され、Gemma 4はApache 2.0。ただしモデルのライセンスと、借りるクラウド/音声APIの契約は別に確認する。

### Cited Findings
- GemmaのIntended Use Statementには、開発者が作り得る用途として "Tutor K-12 students in mathematics." が明記されている。同時に、Gemmaは完成品でなく、安全・適法なアプリへの調整は開発者の責任とする。— [公式想定用途](https://ai.google.dev/gemma/intended_use_statement)
- Gemma 4モデルカードのライセンス表示はApache 2.0。リンク先の全文も取得して確認したところ、18歳未満への提供禁止条項はない。複製・配布等のライセンス条件は引き続き満たす必要がある。— [Gemma 4モデルカード](https://ai.google.dev/gemma/docs/core/model_card_4)、[公式掲載Apache 2.0全文](https://ai.google.dev/gemma/apache_2)
- 従来のGemma Terms of Useは、冒頭でGemma 4には別ライセンスが適用されると区別。旧版の対象にはGemma 3/3n等が含まれ、契約能力、用途制限の伝達、Prohibited Use Policy等の条件がある。**Gemmaすべてが同一ライセンスではない。** — [従来のGemma利用条件](https://ai.google.dev/gemma/terms)、[禁止用途](https://ai.google.dev/gemma/prohibited_use_policy)
- Gemini APIにもGemmaを呼び出す提供形態がある。これはモデルを自分で運用する形態と異なり、利用サービス側のGemini API条件を消すものではない。— [Gemma on Gemini API](https://ai.google.dev/gemma/docs/core/gemma_on_gemini_api)、[Gemini API利用条件](https://ai.google.dev/gemini-api/terms)
- Google CloudのService Specific Terms §20(d)はGenerative AI Servicesに年齢制限を置く。定義はServices Summaryを参照し、同Summaryは列挙サービスに加えてサービスの生成AI機能全般を含む。§19はSeparate Offeringsが別条件に従うことを記載するが、Gemma自己運用を一律に§20から除外する明示回答は今回見つからなかった。— [Cloudサービス固有条件](https://cloud.google.com/terms/service-terms)、[Services Summary](https://cloud.google.com/terms/services)

### Inferences
- 根拠がある表現は「Gemma 4自己運用は、GoogleがK-12用途を想定している有力な候補」。根拠を超える表現は「Google Cloudに載せれば必ず未成年へ提供できる」「モデル名をGemmaへ変えれば解決」。後者は避ける。
- 通常のCompute Engine/Cloud Runで自作アプリとしてモデルを動かす方式と、Gemini API/Vertex系の管理された生成AI APIを呼ぶ方式を区別して選定する。モデル名だけでなく、**どのサービスの契約で実行するか**が重要。
- 大会がGemini APIの使用を必須にしているなら、Gemma採用だけでは応募要件を満たさない可能性がある。大会URLを確認する必要がある。

### Gaps
- 一般コンピュート上での当該構成にCloud §20(d)が適用されるかについてGoogleからの個別の明示確認はない。本番の対象年齢、地域、正確なサービス構成を添えて確認する事項として残す。
- K-12という想定用途の例は、完成アプリの安全性・各国法令・全構成サービスの許諾を保証しない。

## どの構成で動かせて、どんな負担が増えるか

### Takeaway
既存のFirebase基盤とLiveKit会議は使い、Gemini Live部分を「部屋制御ワーカー → 自前Gemma推論API」に差し替える。自然な音声会話まで一度に作るより、共有の教材とテキスト質問・回答を先に完成させる方がリスクを分解できる。

### Cited Findings
- Google公式はGemma 4をCloud Run GPU + vLLMで配備するガイドを公開。推論APIはIAM認証を要求する構成で、同時実行数とvLLMの処理枠、GPUメモリの調整が必要と説明している。— [Cloud RunでGemmaを配備](https://docs.cloud.google.com/run/docs/run-gemma-on-cloud-run)
- Gemmaの公式GCPガイドはCloud Run、GKE、vLLM等を紹介し、Cloud RunでGPUによるscale-to-zero推論が可能とする。— [Google CloudでGemma](https://ai.google.dev/gemma/docs/integrations/google-cloud)
- Gemma 4はテキスト出力モデル。E2B/E4B/12Bでは音声入力もあるが、Gemini Liveのような音声出力まで一体のモデルではない。— [モデルカード](https://ai.google.dev/gemma/docs/core/model_card_4)
- 公式実行ガイドは、必要性を確認するまで小さなモデルで始める考え方と、モデルサイズ・量子化・計算資源のトレードオフを説明する。— [Gemma実行ガイド](https://ai.google.dev/gemma/docs/run)

### Inferences

推奨候補の構造:

`React画面 → Firebase認証/部屋管理 → Cloud Run制御API → Gemma推論サーバー`

`生徒たち ↔ LiveKit会議 ↔ 部屋ごとの先生ワーカー`

- モデルサーバーはGPUつきCloud Run、またはGPUのCompute EngineにvLLM等を置く。GKEまで導入するのは3人の初期プロトタイプには運用負担が大きい。Compute Engine構成は一般的なVM推論設計案であり、今回Gemma専用のVM公式手順までは確認していない。
- Cloud RunのGPU対応は推論APIの話。LiveKitの会議中継SFUを通常のCloud Runサービスに置くこととは別。
- コストは「GPU稼働時間 + CPU/メモリ + ストレージ/転送 + 会議基盤」。API利用料がなくなることと無料運用は同義ではない。常時温めれば待ち時間を抑えられるが課金が増え、停止させれば起動待ちがある。
- モデルサイズ、量子化、同時授業数で速度・日本語数学の正答率が変わる。Geminiと同品質とは扱わず、対象単元の問題セットで誤答・待ち時間・教材への忠実さを測定する。
- 自己運用はモデル配備、GPU枠、障害対応、負荷制御、出力の安全対策をチームで負担する。利用条件を満たす管理APIを選べる場合は開発・運用が軽くなるが、その提供条件は別担当の調査を参照する。
- 個人ごとに先生を生成せず、部屋の共有回答を一度生成して全員に配信する。講義の説明は確認済み台本を使い、Gemmaは教材に基づくヒントと質問回答に絞ると評価しやすい。

### Gaps
- 実プロジェクトのGPU枠、利用可能リージョン、料金、最適モデル、実機遅延は未検証。金額や処理秒数は断定しない。
- Gemmaの日本語の対象学年・教科に対する品質は評価前。モデルカードの一般性能だけで教育品質を保証しない。

## 音声をどう段階導入するか

### Takeaway
STT→Gemma→TTSは技術的に構成できるが、音声APIの利用条件まで自動的に解決するわけではない。初期版はテキスト質問を確実に動かし、音声は押して質問する方式から追加する。

### Cited Findings
- Services Summary上ではSpeech-to-Text/Text-to-SpeechはPre-Trained APIsに列挙されるが、同じ文書のGenerative AI Servicesには各サービスの生成AI機能も含まれる。— [Services Summary](https://cloud.google.com/terms/services)
- Chirp 3 HDの公式資料は生成モデルで動作すると説明する。Chirp 3 STTも公式にASR向け生成モデルと記される。このため「音声APIという名前だから生成AIの年齢条件と無関係」とは言えない。— [Chirp 3 HD](https://docs.cloud.google.com/text-to-speech/docs/chirp3-hd)、[STTモデル比較](https://docs.cloud.google.com/speech-to-text/docs/transcription-model)
- Cloud TTSにはStandard、WaveNet、Neural2等の複数の音声種別がある。Gemini-TTSもCloud TTS APIから利用できるため、APIのエンドポイント名だけでは採用モデルの規約適用を判断できない。— [音声種別](https://docs.cloud.google.com/text-to-speech/docs/list-voices-and-types)、[Gemini-TTS](https://docs.cloud.google.com/text-to-speech/docs/gemini-tts)

### Inferences
- 段階1: 生徒同士は会議で話せる。先生の説明/質問回答は共有テキストで表示し、あらかじめ用意した講義音声を再生する。先生との動的な音声会話は未実装と明示する。
- 段階2: 「押して質問 → 音声認識 → 認識結果の確認 → Gemma → 読み上げ」。話者と発話終端が明確なので、全員の常時会話をAIに聞かせる方式より実装しやすい。
- 段階3: 一度に一人の発言権を守った低遅延ストリーミングへ進む。同時発話、割り込み、エコー、誤認識、応答停止などを追加で扱う。
- 音声部分の候補は、対象年齢に対応すると確認できたサービス、またはライセンスを確認して自己運用するSTT/TTS。**通常のGoogle STT/TTSも今回未成年向け許諾を明示確認できたわけではない**ので確定採用とはしない。
- 音声入力対応のGemmaを使えば独立したSTTを省ける可能性はあるが、リアルタイム性能・日本語音声の教材質問精度は別途検証が必要。テキスト出力後の読み上げは引き続き別処理。

### Gaps
- 個々のGoogle音声SKUへの§20(d)適用、未成年の声を処理できる具体的条件は未解決。声をクローンする機能は不要で、採用案から除く。
- 音声を外した段階1だけでは、当初の「AI先生と音声で授業」の全要件を達成しない。これは開発順の提案で、要件がすべて実現済みという意味ではない。
