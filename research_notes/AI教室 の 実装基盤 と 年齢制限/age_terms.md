# Gemini の年齢制限と AI 教室への適用

確認日：2026-11-06。公開された公式資料に基づく整理。個別契約や非公開の例外は未確認。

## Gemini Live だけが18歳未満に使えないのか

### Takeaway
独自 Web アプリへの組み込みでは、消費者向け Gemini アプリの利用資格ではなく、採用する API の規約が判断基準になる。Gemini Developer API は Live に限らず年齢制限がある。

### Cited Findings
- Gemini API Additional Terms（2026-03-23発効）の Age Requirements は、開発者の18歳以上要件に加え、18歳未満を対象とする、または18歳未満が利用する可能性のある API クライアントでの利用を制限している。対象サービスは Gemini API と Google AI Studio 等。原文の短い該当箇所は “directed towards or is likely to be accessed by individuals under the age of 18”。— [Gemini API 追加規約](https://ai.google.dev/gemini-api/terms)
- 消費者向け Android の Gemini Live ヘルプは現在「13歳超、または居住国で適用される年齢」を示す。一方 Chrome 内の Live は18歳未満に提供しない旨を示す。製品・利用画面により条件が違う。— [Android Live ヘルプ](https://support.google.com/gemini/answer/15274899?hl=en)、[Gemini in Chrome](https://support.google.com/gemini/answer/16283624?hl=en)

### Inferences
- Gemini Live をテキスト API に替えるだけ、または STT → Gemini → TTS に分割するだけでは、Gemini API 自体の年齢条項を解消しない。
- 有料化や保護者同意で年齢制限が解除される例外は、確認した API の年齢条項にはない。成人の API キーを使い未成年へ代理提供することも、エンドユーザーに関する条項の問題を残す。

### Gaps
- API 規約の通常 URL は取得ツールで本文取得に失敗したが、公式ドメインの検索結果から発効日・年齢条項・有料／無料条項の全文を確認した。法的結論や個別例外の有無までは保証しない。

## Vertex AI や学校契約なら使えるのか

### Takeaway
「Vertex AI に替えれば18歳未満に提供できる」は、現在の公開規約では支持できない。Cloud 側にも同じ趣旨の明示的な年齢制限がある。

### Cited Findings
- Google Cloud Service Specific Terms（最終更新2026-10-30）の20(d) Age Restrictions は Generative AI Service を18歳未満向け、または18歳未満が利用する可能性のあるオンラインサービスに用いることを制限する。20(b)–(h) には Agentic AI Services も含まれる。保護者同意・教育機関・有料利用による解除はこの条項に記載されていない。— [Cloud サービス固有規約 20(d)](https://cloud.google.com/terms/service-terms)
- Services Summary の Generative AI Services には、旧 Vertex AI API と旧 Vertex AI Live API が明示されている。現在の資料では Gemini Enterprise Agent Platform API / Gemini Live API on Gemini Enterprise Agent Platform という名称。一般の Speech-to-Text と Text-to-Speech は別のサービス項目である。— [Cloud Services Summary](https://cloud.google.com/terms/services)
- Workspace for Education の Gemini Apps には全年齢の対象エディションがあり、機能ごとの年齢制限と Google AI Pro for Education の18歳以上要件がある。学校アカウントの Gemini Apps は Workspace 規約に基づく。— [学校アカウントの Gemini Apps](https://support.google.com/gemini/answer/14620100?co=DASHER._Family%3DEducation&hl=en)

### Inferences
- 学校が公式 Gemini Apps を生徒に提供できることは、第三者が自作した API アプリへ同じ権利を移せる根拠にならない。
- Google Cloud 上で STT/TTS を使う構成と、Gemini に推論をさせる構成は分けて判断する。前後の音声処理を変えても、Gemini 利用が残ればその年齢条項が残る。
- OSS や他社モデルも、クラウド経由の提供条件やモデルライセンスを含めて個別確認が必要。「自前モデルなら必ず適法・規約上問題なし」とは結論しない。

### Gaps
- 当該チームに適用される個別契約の有無は不明。Google との契約変更・特約・教育向け API 提供経路が取得できるか、公開資料では確定しない。
- Cloud STT/TTS の全モデルについて未成年向け利用可否を網羅検証したわけではない。Services Summary では生成AI機能を広く含む定義もあり、採用する正確なモデルと契約条件の確認が必要。

## ハッカソンではどう対応するか

### Takeaway
今回の実装を進めるなら「18歳以上の学習者向け」としてデモと実利用を揃える案が最も明確。高校生以下を価値の中心にするなら、対象を曖昧にしたまま Gemini の実装を固定しない。

### Cited Findings
- 無料の Gemini API サービスでは入力・出力が製品改善や人手確認の対象となり、個人情報・機密情報を送らないよう明記される。有料サービスでは入力・出力を製品改善に用いないが、不正利用検知等のため一定期間のログ処理がある。有料化は年齢制限解除とは別問題。— [Gemini API 追加規約の Unpaid/Paid Services](https://ai.google.dev/gemini-api/terms)
- Gemini Live の公式ヘルプも、他者を Live 会話に含める前の許可取得を案内している。— [Gemini Live の事前注意](https://support.google.com/gemini/answer/15274899?hl=en)

### Inferences
- 提案A：18歳以上に対象を限定し、招待制デモ、年齢条件表示、利用者確認、成人向け教材で検証する。「大学生」は18歳未満を含み得るので年齢条件を明示する。単に18歳以上と画面に書けば十分と保証はしない。
- 提案B：未成年必須なら、Google に対象年齢、学校管理か一般公開か、音声・教材のデータ経路、使用 API・モデルを示し、適用条件と許容される契約を文書で確認する。確認がつくまでは成人での技術検証に留める。
- 提案C：Google の許容経路がなければ、未成年向け利用が契約上認められる別 API または適切な運用条件の自前モデルを検討する。授業進行・部屋管理と AI 呼び出しを分離し、AI 部分だけを差し替えられる小さな境界を設ける。初めから汎用マルチプロバイダ基盤を作る必要はない。
- 教材はサンプルを使い、実際の成績・氏名・未成年の音声をデモへ持ち込まない。実サービスでは音声処理の参加者への表示、部屋単位の教材閲覧権限、保存期間と削除方法を定義する。これらは設計提案であり、規約上の年齢制限を解除する手段ではない。

### Gaps
- このハッカソンが Gemini の使用を必須としているか、Google Cloud の任意サービスでよいかは未確認。別 API 案の採用可否は大会要件に左右される。
- 代替 API の具体名と未成年向け条件は今回調査していない。未成年対応が必須と決まった時点で、対象国・対象年齢・提供形態を揃えて比較する必要がある。
