# このリポジトリでの作業

- 利用者はジュニアエンジニア。設計判断は問題点・前提・保守性・トレードオフを具体的に説明する。
- Googleログインと部屋の入退室はWebに実装済み。音声検証は運用者用の `/voice-probe` とLiveKitワーカー、Agentの `voice-check` と `live-check` を使う。会員の部屋の通話は `MEETING_VOICE_ENABLED=1` のときだけ有効にし、本番での有効化は別途判断する。プロダクトの要件は `docs/app-requirements.md` を正とする。
- `docs/architecture.md` の依存方向を守る。Webの`src/app`はNext.jsの入口、`src/client`はUI・ブラウザ処理、`src/server`はdomain/application/infrastructure/composition。Pythonの構成は従来どおり。
- Webは`client → server`を型importも含めて禁止し、`server → client/app`、`app → server/infrastructure`も禁止する。SDKはinfrastructure、結線はcomposition／bootstrap。空の業務層を架空のクラスで埋めない。
- `client`という名前だけでClient Componentにはならない。静的UIはサーバー描画を維持し、イベント処理やブラウザAPIが必要な入口にだけ`"use client"`を付ける。
- 設定・秘密値・音声・文字起こし・メモをログやエラー応答に出さない。ビルド時やimport時に外部へ接続しない。
- JS依存はnpm、Python依存はuvで管理する。両lockfileを維持する。
- 変更に応じて `make check-web`／`make check-agent` を実行する。HTTP・画面は `make e2e`、コンテナ変更は `make docker-check` でも確認する。
- 必要な実サービス検証をモックやhealthの成功で代用しない。未検証を明記する。
- `public/` は旧Firebase Hosting確認用。新Webは `apps/web/`。両者を混同しない。
- 無関係な変更や既存の調査資料を上書きしない。
