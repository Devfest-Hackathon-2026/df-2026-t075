# domain: 業務ルール

部屋の設定、入室時の年齢申告と同意、退室・再入室の状態遷移を扱います。同じ操作の再送は一度として扱い、別のタブから遅れて届いた古い操作で新しい状態が上書きされるのを防ぎます。

- Next.js、Firebase、LiveKit、環境変数、HTTP、DBへ依存しません。
- application、infrastructure、composition、appをimportしません。
- フレームワークなしで確認できる業務ルールができたとき、そのルールのテストを隣に置きます。
- フォルダを埋める目的でEntityやRepositoryを増やしません。
