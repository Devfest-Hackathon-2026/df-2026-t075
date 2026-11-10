# Google Meet による AI教室の実現可能性

確認日: 2026年11月6日。公式ドキュメントの調査結果であり、実際の Google アカウントや API を用いた動作検証は未実施。

## Meet の各 API は何を実現できるか

### Takeaway
Meet REST API は会議作成・参加リンク・メンバーや記録の管理に適する。Add-ons SDK は自作アプリを Meet 内に表示するための仕組みであり、自作 Web アプリに自由に制御できる会議エンジンを組み込む SDK と同一ではない。

### Cited Findings
- REST API の公開機能には会議スペースの作成、設定、共同主催者の割り当て、会議終了、参加記録、録画や文字起こしの取得がある。会議スペースには参加用 meetingUri が返る。— [REST overview](https://developers.google.com/workspace/meet/api/guides/overview), [spaces reference](https://developers.google.com/workspace/meet/api/reference/rest/v2/spaces)
- Add-ons SDK は自作アプリを Meet のサイドパネルやメインステージに組み込む。公式 quickstart の実装も Meet 内の iframe とアクティビティを扱う。— [Add-ons overview](https://developers.google.com/workspace/meet/add-ons/guides/overview), [Quickstart](https://developers.google.com/workspace/meet/add-ons/guides/quickstart)
- 現行 SDK/API 概要で案内される選択肢は REST API と Add-ons SDK。spaces の EntryPointAccess には Meet Embed SDK Web の名称が残るが、その記載だけで現在誰でも導入できる会議埋め込み SDK と判断できない。— [SDK and API overview](https://developers.google.com/workspace/meet/overview), [EntryPointAccess](https://developers.google.com/workspace/meet/api/reference/rest/v2/spaces#entrypointaccess)

### Inferences
- 教室一覧・単元・所要時間・招待リンクは独自アプリの DB と UI で管理し、Meet 会議リンクに誘導する構成なら成立する。ただしこれだけでは AI 先生のリアルタイム発話・音声受信を実装できない。
- 「Meet を埋め込めば音声を自由に制御できる」という前提は採用しない。Meet 内に教材を表示する体験に寄せる場合は Add-ons が検討対象。

### Gaps
- Meet Embed SDK の一般提供状況・現在の導入手順は現行公式ガイドで確認できなかった。絶対に存在しないとは断定しない。

## AI がリアルタイムに会議の音声を受け取り、授業を話せるか

### Takeaway
新規開発の中核として Meet Media API を選ぶべきではない。2026年10月28日に終了が発表され、一般提供には進まず、2027年1月15日に既存参加者向けを含むエンドポイントが停止する。

### Cited Findings
- Google の現行 Meet トップページは、Media API Developer Preview を終了し、GA には進まないこと、新規申込終了、既存利用者の期限が2027年1月15日であることを明記している。— [Google Meet developer landing page](https://developers.google.com/workspace/meet)
- 2026年10月28日のリリースノートは上記終了日と、REST API / Add-ons SDK は影響を受けず正式提供が継続することを明記している。— [Meet release notes](https://developers.google.com/workspace/meet/release-notes)
- 検索に残る旧公式 Media API overview は動画・音声・参加者メタデータの consume を用途として説明している。旧 get-started は readonly の音声/映像 OAuth scope と制限付きスコープ審査を説明していた。今回これらの URL を直接開くと404だったため、現行機能の根拠に使わない。— 旧URL: https://developers.google.com/workspace/meet/media-api/guides/overview および https://developers.google.com/workspace/meet/media-api/guides/get-started

### Inferences
- 旧文書や過去の記事を根拠に「Media API で AI 先生を作れる」と提案すると、現在の提供状況と矛盾する。
- REST は会議管理の API であり、Media API の終了に対して双方向リアルタイム音声の代替になったとは公式に書かれていない。AI 先生が参加者として音声を配信する中核には、別の WebRTC 基盤を選ぶのが妥当。
- 仮想マイク付きブラウザ bot、SIP 接続、外部 bot サービス等による別経路の可能性まで否定するものではないが、導入条件・運用・規約・品質検証を追加で要する。ハッカソンの第一選択としては勧めない。

### Gaps
- 公開されている一般向け Meet REST / Add-ons SDK で、AI を双方向音声の bot 参加者として直接接続し、音声を publish する機能は確認できなかった。
- 旧 Media API の Preview 登録条件（プロジェクト・OAuth 主体・全参加者の登録）を記載した古い検索結果もあるが、現行は終了発表が優先される。

## 生徒の自動ミュートと API の利用条件

### Takeaway
Meet の画面には主催者による Audio Lock があるが、授業の発話タイミングごとにアプリから確実に操作できる公開 API は確認できない。UI の機能と API で使える機能は分けて判断する。

### Cited Findings
- Meet の主催者・共同主催者は Audio Lock で他の参加者の音声を止められる。解除後は参加者自身がマイクをオンにする。主催者・共同主催者はロック対象外。— [Lock audio & video](https://support.google.com/meet/answer/11274707?hl=en)
- 公開 REST の conferenceRecords.participants の操作は get / list。participant mute / unmute の操作は掲載されていない。— [participants reference](https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords.participants)
- 詳細な設定ガイドと ModerationRestrictions のフィールドは chatRestriction、reactionRestriction、presentRestriction、defaultJoinAsViewerType。ユーザー個別の音声ミュート操作を示していない。— [Configure meeting space settings](https://developers.google.com/workspace/meet/api/guides/meeting-spaces-configuration), [ModerationRestrictions](https://developers.google.com/workspace/meet/api/reference/rest/v2/spaces#moderationrestrictions)
- 一方、REST overview は事前の moderation controls の例に microphone / camera も列挙している。この概要と詳細スキーマの差異があるため、公開 API では絶対に不可能とまでは断言しない。— [REST overview](https://developers.google.com/workspace/meet/api/guides/overview)
- REST API は OAuth 2.0 のユーザー認証を使い、そのユーザーとして操作する。meetings.space.created はアプリが作成した会議の作成・変更・読み取り用 Sensitive scope。meetings.space.settings は Non-sensitive。録画等を Drive から読む追加スコープは Restricted の場合がある。— [Authentication and authorization](https://developers.google.com/workspace/meet/api/guides/authenticate-authorize)
- Workspace 管理者が許可した domain-wide delegation ならサービスアカウントによるユーザー代理も可能だが、これはユーザーとしての認証に分類される。— [Authentication and authorization](https://developers.google.com/workspace/meet/api/guides/authenticate-authorize)

### Inferences
- AI 発話→全員ミュート→質問者だけ発言可能、という中心体験は、発言権をサーバーで管理できる独自会議基盤で実装した方が見通しがよい。
- Meet を必須にするなら、教材表示・テキスト質問・会議リンク連携を MVP とし、主催者の音声ロックは手動運用に縮小する。AI 音声を Meet 内に注入する自動化は別途検証課題として扱う。
- 音声を止められても、許可を戻した瞬間に参加者のマイクを勝手に有効化する UX にはしない。質問ボタンと本人による発話開始を組み合わせる。

### Gaps
- OAuth テストユーザーや公開審査の実際の状態、ユーザーが持つ Workspace エディション・組織ポリシーは未確認。ハッカソンの応募条件が Meet 必須かどうかもこの調査の範囲では未確認。
