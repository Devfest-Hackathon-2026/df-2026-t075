# Python agent 基盤

Python 3.11以上、uv 0.13.0を使う。実行できるのは次の四つ。

- 既定の **config-check**：環境設定を検証して終了する。外部へ接続しない。終了コード0はローカル設定の形式が正しいことだけを表す。
- **voice-check**：録音したWAVを、声 → Speech-to-Text → Gemini → Gemini TTSの声と字幕まで一往復させ、AIが話し始めるまでの遅れ・聞き取りの誤り率・費用を測る（[声の計測](#声の計測voice-check)）。
- **live-check**：手元のブラウザからマイクで話しかけ、同じ経路でAIメンバーの声と字幕を返すテストページを出す（[ブラウザでの検証](#ブラウザでの検証live-check)）。
- **voice-worker**：名前付きのLiveKitジョブを待ち受け、検証室の一発話を処理する。[設定と測定手順](../../docs/voice-probe.md)
- `make meeting-voice-worker` は会員用の部屋を担当し、同意した全員の会話を文字起こしし、「AIに話す」で直近の会話と進行状況を使って回答する。[2人通話の起動手順](../../docs/voice-probe.md#会員の部屋で2人とaiが話す)

## セットアップと実行

```sh
cd apps/agent
uv sync --locked
uv run --no-sync python -m classroom_agent
```

環境変数を変更する場合は`.env.example`を`.env`へコピーし、`uv run --no-sync --env-file .env python -m classroom_agent`で明示的に読み込む。Python側で`.env`を自動読込しない。秘密値をGitやDockerイメージへ入れない。

ルートの `make meeting-voice-worker`、`make voice-worker`、`make voice-check`、`make live-check` は、`apps/agent/.env` があるときに読み込む。シェルで同じ変数を指定した場合はシェルの値を使う。

| 変数        | 既定値        | 許可する値                                      |
| ----------- | ------------- | ----------------------------------------------- |
| `APP_ENV`   | `development` | `development`, `test`, `production`             |
| `LOG_LEVEL` | `INFO`        | `DEBUG`, `INFO`, `WARNING`, `ERROR`, `CRITICAL` |

空文字・未知の値・余計な空白は設定エラー。設定エラー時は終了コード2と問題の変数名だけを返し、入力値はログへ出さない。`LOG_LEVEL=WARNING`以上では成功のINFOログは出ないが終了コードは0となる。

## 声の計測（voice-check）

[技術選定](../../docs/technical-selection.md)の実装順の最初にある「声 → 文字起こし → Gemini → TTSの声と字幕を一本つなぎ、遅れ・精度・費用を測る」ためのコマンド。LiveKitを使わず、録音ファイルを実時間の速さで送って会議中の声を再現する。

### 準備

1. [Google Cloud CLI](https://cloud.google.com/sdk/docs/install)を入れ、自分のアカウントでApplication Default Credentialsを作る。キーのファイルは作らない。

   ```sh
   gcloud auth application-default login
   gcloud auth application-default set-quota-project hackathon-7314b
   ```

2. プロジェクトで Vertex AI API（`aiplatform.googleapis.com`）と Speech-to-Text API（`speech.googleapis.com`）を有効にする。自分のアカウントに `roles/aiplatform.user` と `roles/speech.client` 相当の権限が要る。
3. 自分の声を録音する。QuickTime Playerなどで録った音声は、macOS標準の `afconvert` で16kHz・モノラルのWAVに変える。

   ```sh
   afconvert -f WAVE -d LEI16@16000 -c 1 録音.m4a input.wav
   ```

   60秒以内で、話し終えた後に1秒ほど無音を残す。受け付けるのは16ビットのPCM WAVだけで、ステレオはモノラルに混ぜる。

### 実行

リポジトリのルートから:

```sh
GOOGLE_CLOUD_PROJECT=hackathon-7314b make voice-check AUDIO=input.wav REFERENCE="ノト、次の勉強会で読む本、どうしたらいいと思う？" REPEAT=4
```

`REFERENCE` には実際に話した文を書く。省略すると誤り率は出ない。`REPEAT` は同じ録音を続けて流す回数（1〜10）。1回目は認証と接続の準備を含むので、常駐するワーカーに近い値は2回目以降と中央値で見る。直接実行する場合は `uv run --locked python -m classroom_agent voice-check --help` で引数を確かめる。`--phrase ノト` のように、聞き取りやすくしたい語（AIメンバーの名前など）を文字起こしへ渡せる。

| 変数                    | 既定値                 | 内容                                                                                                                                       |
| ----------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `GOOGLE_CLOUD_PROJECT`  | なし（必須）           | 課金と認証の対象プロジェクト                                                                                                               |
| `SPEECH_LOCATION`       | `us`                   | Speech-to-Textの場所。`chirp_3` は11月8日時点で `us`・`eu` だけ                                                                            |
| `SPEECH_MODEL`          | `chirp_3`              | Speech-to-Textのモデル                                                                                                                     |
| `SPEECH_ENDPOINTING`    | `standard`             | 話の切れ目を判断する速さ。`short`・`supershort` は速いが、短い間でも切れやすい                                                             |
| `GEMINI_LOCATION`       | `global`               | 返答を作るGeminiの場所。3.8 Flashは東京（`asia-northeast1`）にない                                                                         |
| `GEMINI_MODEL`          | `gemini-3.8-flash`     | 返答を作るモデル。比較候補は `gemini-3.5-flash-lite`                                                                                       |
| `GEMINI_THINKING_LEVEL` | `low`                  | `low`・`medium`・`high`、または指定しない `default`（Flash-Lite向け）。3.8 Flashは `minimal` を受け付けない。`voice-worker` も同じ値を使う |
| `GEMINI_TTS_LOCATION`   | `us`                   | TTSの場所。ストリーミングでは `global` より `us`・`eu` が速いとされる                                                                      |
| `GEMINI_TTS_MODEL`      | `gemini-3.8-flash-tts` | 声のモデル。遅れが大きければ `gemini-3.8-flash-lite-tts` と比べる                                                                          |
| `GEMINI_TTS_VOICE`      | `Kore`                 | 声の名前                                                                                                                                   |

### 結果の読み方

端末には数字だけを出す。

- **AIが話し始めるまで**：録音の声が終わった時刻から、TTSの最初の音が届くまで。内訳は「文字起こしの確定待ち」「Geminiの最初の文字と返答の完成」「TTSの最初の音」。
- **字幕を出せるまで**：返答の文が完成するまで。声より先に字幕を出せるかの目安になる。
- **誤り率（CER）**：参考文との1文字ごとの違い。Webの検証室と同じくNFKC正規化して小文字にし、Unicode分類 Z・P・C を除く。「＋」などの記号は採点する。「3」と「三」のような表記の違いも誤りに数えるので、参考文は話した通りの表記で書く。
- **費用**：この1回の推定費用と、1分あたりの見込み。見込みは「参加者全員の声を1分間ずっと文字起こしし、AIが1分に1回話す」と仮定する（`--participants`、`--ai-turns-per-minute` で変更）。メモや進め方の案に使うGeminiの費用は含まない。料金は11月8日に公式ページで確かめた表示価格で、Gemini 3.8 FlashとTTSは12月31日までの導入価格（1月1日から2倍）。単価が未登録の場合やGemini・TTSの使用量が欠けた場合、費用は未算出とする。

文字起こし・返答の文・AIの声は、`tmp/voice-check/日時/` の `report.json` と `reply.wav` にだけ保存する（Gitの対象外）。ログに出さないためであり、確認が済んだら消す。他人の声を録音して試す場合は本人の同意を取る。

返答の文は、です・ます調の1〜2文（50文字以内）の問いにするよう指示している（[アプリ要件](../../docs/app-requirements.md)の15番）。読み上げる前に、モデルが混ぜることのあるタグや記号を取り除く。

録音の後ろには3秒の無音を足して送り、文字起こしが自分で話の切れ目を判断できるようにする。話し終えた後の確定結果が届いた時点で残りの無音は送らず、すぐGeminiへ進む。実際の部屋で、確定した時点で返答を作り始めるのと同じ動きである。Geminiは30秒、文字起こしは120秒で打ち切り、その回を失敗として次の回へ進む。

11月8日の計測結果は[技術選定](../../docs/technical-selection.md)に記録した。

失敗したときは、どの段階（`speech`・`reply`・`voice`）で何の種類のエラーが起きたかと、HTTPの状態コードだけをログに出す。外部サービスのエラー文には設定値が含まれうるため出さない。代わりに、認証情報がない・権限がない・モデルと場所が合わない、などの対処を一行で表示する。

テストは偽のクライアントで、送る設定・受け取った結果の変換・時間の測り方を確かめる。実際のGoogleのサービスにつながるかは、このコマンドを手で実行するまで分からない。CIでは実行しない。

## ブラウザでの検証（live-check）

録音ファイルの代わりに、自分のマイクで話して確かめるためのページ。LiveKitは通さず、ブラウザとこのPythonの間をWebSocketでつなぐ。本番の部屋の経路ではないが、文字起こし・Gemini・TTSの部分は voice-check と同じアダプターを使う。

```sh
GOOGLE_CLOUD_PROJECT=hackathon-7314b make live-check
```

表示された <http://127.0.0.1:8765/> を Chrome で開き、「話す」を押してマイクを許可し、話しかける。準備（ログイン・APIの有効化）と環境変数は voice-check と同じ。`PORT=9000` でポートを、`SAMPLE=input.wav` で「サンプル音声で試す」に使う録音を指定できる。

- 話し終えたかどうかは、文字起こしの確定（話の切れ目）だけでは決めない。人は考えるために間を置くので、最初の確定で返答すると話の途中で割り込む（11月8日に実際のマイクで起きた）。確定した文をつなげて聞き続け、次の二つがそろったときに話し終えたと判断する。
  1. 最後に聞こえた声までが文字起こしで確定している。
  2. 最後に聞こえた声から、文の終わり方に応じた時間だけ無音が続いた。「？」「。」で終わる文は0.8秒、「、」や「〜けど」「〜は」「えーと」で終わる文は2.5秒、どちらとも言えないときは1.5秒（`turn_hold_seconds`）。
- 確定した後にまた声がしたら、その言葉の確定を待つ。咳のように言葉にならない音のときは、上の時間に2秒足して打ち切る。
- それでも途中で返答されるときは `PATIENCE=1.5` のように待つ時間を伸ばす（0.5〜3倍）。聞き取れた途中の文は「聞き取り中」として画面に出るので、どこで区切られたかを確かめられる。判断されないときは「話し終えた」を押す。
- 「声がした」は、ブラウザから届く0.1秒ごとの音量で判断する（16ビットで実効値500以上）。周りがうるさいと、話し終えた判断が遅れる。
- 「AIが話し終えたら続けて聞く」を付けたままにすると、続けて会話できる。直前の6発言（3往復）を Gemini に渡す。AIが話している間はマイクの音を送らない（割り込みへの対応はまだない）。
- 表の「確定まで・字幕まで・声まで」は、ブラウザで声が途切れたと判断した時刻から測る。「確定まで」は話し終えたと判断するまでの時間。内訳はサーバーで測った、そこからの時間。
- AIメンバーの名前は、文字起こしの聞き取りヒントに必ず入れる。入れないと「ノト」が「のと」になった。

安全のための制限:

- `127.0.0.1` だけで待ち受け、このページ以外からのWebSocket接続（Originが違うもの）は拒否する。ほかのサイトが開発者のGoogleのログインを使って料金を発生させないため。
- 1回の発言は60秒まで、1ページあたり30回まで。サンプル音声は自動では繰り返さない。
- 話した内容と返答はページに表示するだけで、ログにもファイルにも残さない。ログに出すのは失敗した段階と種類だけ。

テストは、偽のセッションを使って本物のWebSocketでページ・音声の中継・失敗の伝え方・Originの拒否を確かめる。マイクの取り込みと再生は、組み込みブラウザでサンプル音声を使って11月8日に確認した。実際のマイクでの確認は、利用者の手元で行う。

## 層と依存方向

```text
__main__ → bootstrap → infrastructure → application → domain
```

右側への依存を許可する。`bootstrap`がワーカーを組み立て、`application/voice_probe.py`が一発話の順序と計測を受け持つ。音声・字幕の入出力とプロバイダーのProtocolをこのユースケースで定め、LiveKit・Googleの呼出しは`infrastructure`に置く。

import-linterが全モジュールの配置と依存の逆転を検査する。内側の2層からGoogle、LiveKit、Firebase SDKへの依存も禁止する。新しいSDKを導入する際はこの禁止リストも更新する。

## 品質チェック

```sh
uv run --no-sync ruff check .
uv run --no-sync ruff format --check .
uv run --no-sync mypy
uv run --no-sync lint-imports
uv run --no-sync pytest --cov --cov-report=term-missing --cov-report=xml
```

テストは設定の境界値、秘密値を含む誤設定、JSONログ、重複ログ防止、CLIの終了コードと即時終了を確認する。計測対象は実装したPythonコードで、branch coverageを有効にし90%以上を要求する。薄い`__main__.py`はカバレッジ対象外にし、別プロセスでのCLIテストで確認する。

JSONログは標準出力へ1行ずつ出す。時刻、severity、logger、静的なevent名と許可したコンテキストだけを記録し、任意のextraや例外の生メッセージ・スタックを出さない。自由文に埋め込まれた秘密値を自動判定する機構ではないため、メッセージには固定のevent名を使う。

## Docker

リポジトリのルートから:

```sh
docker build -t classroom-agent:local apps/agent
docker run --rm -e APP_ENV=production classroom-agent:local
```

開発用依存を除いた非rootイメージを作る。既定のコマンドは設定確認を終えて終了する。音声ワーカーを動かすときは、コマンドを `/app/.venv/bin/python -m classroom_agent.bootstrap.voice_worker` に指定し、実行環境にLiveKitの接続情報とGoogleのADCを用意する。
