# client: UIとブラウザ側の処理

画面の部品、スタイル、ブラウザ操作を置く。Next.jsのpage/layout/Route Handlerは `app` に置き、そこから必要な部品を呼ぶ。

- `server` や `app` をimportしない。型だけのimportも禁止する。
- ブラウザ向けFirebase SDKは `infrastructure/firebase-auth.ts` に置く。ログイン後はIDトークンをWebのHTTP APIに送る。
- `client` というディレクトリ名はNext.jsの実行環境を切り替えない。イベント、状態、ブラウザAPIを使う入口でのみ `"use client"` を付ける。
- トップ画面の見出しと案内はサーバーで描画し、ログイン操作と状態の復元を `components/google-sign-in.tsx` に置く。

`preview/` に見本の参加者・ノートと、画面を操作するためのタブ内の状態を置く。
