# infrastructure: 技術との接続

環境設定、JSONログ、HTTPの共通処理を置きます。将来外部サービスを利用するときは、applicationで必要になったインターフェースをここで実装します。

server内のdomain/applicationを参照できますが、app/client/compositionへ逆向きに依存しません。SDKのクライアントや環境変数を業務層に渡さず、具体的な実装を選ぶ処理はcompositionへ置きます。

`firestore/` はログイン時の利用者プロフィールの作成と、Functionとの疎通確認を担当します。`sql-connect/` は既存のSQL Connect用の生成済みAdmin SDKと実DB検証です。生成元はルートの `dataconnect/` です。
