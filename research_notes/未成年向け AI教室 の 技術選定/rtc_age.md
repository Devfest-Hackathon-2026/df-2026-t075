# LiveKit Cloud の年齢条件

確認日: 2026年11月6日。対象は現行公開の Build / Ship / Scale 規約、Privacy Policy、DPA、AUP。個別 Enterprise 契約や事業者からの回答は未取得。

## 18歳条件は開発者かアプリの生徒か

### Takeaway
現行 ToS の18歳条件は契約主体 Customer に課されている。Privacy Policy の18歳未満に関する記述を、そのまま顧客アプリの生徒全員への利用禁止と読み替えるのは不正確。

### Cited Findings
- 2026年11月2日更新の ToS 1章は、開発・テスト・運用を行うプロ向け開発ツールであり、Customer が18歳以上かつ契約能力を有することを要求する。法人を代理する場合はその法人が Customer。— [Terms of Service](https://livekit.com/legal/terms-of-service)
- Privacy Policy（2026年11月2日更新）の冒頭は対象を LiveKit のウェブサイト利用者と定義し、顧客に代わる processor / service provider としての処理にはこのポリシーは適用されず、顧客との契約と顧客のプライバシーポリシーが適用されると明記する。そのうえで Children's Privacy に18歳未満から意図的に個人データを収集等しないと記載する。— [Privacy Policy](https://livekit.com/legal/privacy-policy)
- DPA は顧客を controller、LiveKit を顧客コンテンツの processor と定め、顧客アプリの end users の音声・映像・テキスト等を扱うことを定義する。— [DPA](https://livekit.com/legal/data-processing-addendum)

### Inferences
- 開発者が18歳以上で契約する構成なら、「高校生以下の生徒がいるから LiveKit Cloud は即座に不可」と結論する根拠はない。
- 公開文書を確認した範囲で、Customer のアプリの18歳未満／13歳未満の end users を一律禁止する条項は見つからなかった。これは未成年教育用途への個別の承認を得たという意味ではない。

### Gaps
- 小学生・13歳未満を含む教育用途が標準契約のままで承認されるか、年齢に応じた追加契約が必要かを肯定する公式 FAQ・明示条項は確認できなかった。商用提供を決定する前に、対象国、最低年齢、保存データ、録音の有無を示して LiveKit に確認するのが確実。

## 子どものデータに関する残る条件

### Takeaway
LiveKit Cloud は技術候補として残せるが、「子ども向けに無条件で利用可能」とは表現しない。契約主体、顧客コンテンツ、テレメトリ、接続する AI の規約を区別する。

### Cited Findings
- DPA 3章などはデータ移転権限・適用法遵守を Customer の責任とする。DPA の U.S. Privacy Laws の定義は子ども等の特定属性だけに適用される法律を含めないため、この DPA をもって COPPA 等の子ども向け要件を全面的に満たすと主張できない。— [DPA](https://livekit.com/legal/data-processing-addendum)
- DPA 2.3 はアカウントデータと Telemetry Data について LiveKit が controller として処理する場合を認める。したがって顧客アプリ利用者のすべてのデータが例外なく processor 処理であるとも言えない。— [DPA](https://livekit.com/legal/data-processing-addendum)
- AUP は未成年に害となり得るコンテンツの送信を禁止し、アプリの end users の遵守を顧客の責任とする。一般的な未成年利用そのものの禁止は掲載されていない。— [Acceptable Use Policy](https://livekit.com/legal/acceptable-use-policy)
- ToS 4.1 は接続先 AI 等の第三者規約・使用制限の確認を顧客に要求し、LiveKit Inference 経由でも provider usage restrictions の遵守を顧客の責任とする。LiveKit を経由しても Gemini 等の年齢制限を回避できるわけではない。— [Terms of Service](https://livekit.com/legal/terms-of-service)

### Inferences
- 提案時の適切な表現は「LiveKit Cloud は候補。契約者18歳以上の条件と、アプリの子ども利用を分けて確認済み。ただし13歳未満を含む本番提供条件はベンダー確認を残す」。
- Cloud の契約条件を避ける技術上の選択肢として OSS 自前運用は考えられるが、運用責任と別途クラウド契約は残るため、年齢問題がすべて消えるとは言わない。

### Gaps
- テレメトリ中の子どものデータの扱いと Children's Privacy の関係、地域別・年齢別の同意要件、学校向け契約の有無は今回の公開文書だけでは確定できない。
