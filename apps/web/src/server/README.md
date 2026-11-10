# server: サーバー側の業務と基盤

業務のルールは `domain`、操作の手順とI/O契約は `application`、外部処理の実装は `infrastructure`、実装の組み立ては `composition` に置く。

`client` と `app` には依存しない。`app` のHTTP入口やNext.jsの起動フックが `composition` を呼ぶ。具体的なサーバー実装を結線する入口には `server-only` を付け、ブラウザへの混入を防ぐ。純粋な業務層にはNext.jsの依存を追加しない。server内の `"use client"` はESLintで禁止する。

現在は設定・ログ・health、FirestoreとFunctionのイベント往復、既存SQL Connectへの疎通確認を実装している。domain/applicationは業務機能の追加時に実装する。
