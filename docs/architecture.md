# フォーム営業自動化アーキテクチャ

- ステータス: PoC 実装中（production実送信有効 / 管理下サイト13シナリオ検証済み）
- 最終更新: 2026-09-03
- 対象: `siu-issiki/form-agent`

## 目的

企業の問い合わせフォームへの営業送信を、手元 PC の CPU・RAM に依存せず、安全かつ段階的に並列化できるクラウド実行基盤を構築する。

対象企業ごとに異なるフォームの構造や項目の意味を LLM / Agent が理解し、営業禁止判定、フォーム発見、入力、送信、結果記録までを一貫して処理する。一方で、フォーム送信は外部サイトへの不可逆な副作用であるため、二重送信や意図しない操作を防ぐ状態遷移と実行境界をエージェントの外側で強制する。

## 現在地

| 領域 | 状態 | 現在の到達点 |
| --- | --- | --- |
| ジョブ状態管理 | 実装済み | D1 の条件付き更新と `runToken` で実行権・送信権を制御 |
| Queue / DLQ | 実装済み | production Queue、retry、DLQ、実POSTを伴う重複配信テスト |
| Agent 実行 | 実装済み | Worker から OpenAI Responses API の function calling を直接実行 |
| 推論 Provider | 部分実装 | OpenAI Responses API のみ。モデル、回数、本文、出力 token を Worker 側で制限 |
| BrowserUse | 実装済み | REST API v4 で standalone browser session を作成・停止し、CDP 接続では用途限定ツールだけを公開 |
| E2E | 管理下範囲を実装済み | 常設テストシステムの13シナリオ、重複配送、送信後`uncertain`をproductionで検証済み。外部の実サイト送信は未実施 |
| HTTP API | 部分実装 | Bearer 認証付きのジョブ登録・取得を実装。登録時に`payload.formValues`のキーと値（単一文字列または選択肢候補リスト）を検証。一覧・キャンセルは未実装 |
| Cloudflare 配備 | 実装済み | production の D1、Queue、DLQ、Worker、Secrets、公開 URL、Queue consumer を設定済み。旧 Sandbox Durable Object は削除済み |
| 監査・メトリクス | 部分実装 | Provider 呼び出し回数、retry / DLQ、値を含まないagent tool診断イベント、ジョブ単位の実行メトリクス（turn、Provider 呼び出し、token、送信前レビュー、browser 接続時間、実行時間）。送信前・送信後・禁止判定時のスクリーンショット証跡を Cloudflare R2 へ保存し、D1 の `events` へ sha256 付きで記録する |
| 並列検証 | 部分実施 | 2026-09-03 の 5 並列 19 シナリオで、session 明示停止の前後とも 15 件合格。明示停止後は CDP 切断（1011 / `LIMIT`）と `exceededCpu` が 0 件になり、18 session すべてを停止できたが、session 作成 API が 429 を 15 回返し 2 件が失敗した。実際の同時 session 上限は 5 未満と判断し、consumer を `max_concurrency: 3` にした。3 並列の 19 シナリオでは 17 件合格、429 / CDP 切断 / `exceededCpu` はいずれも 0 件、19 session すべてを停止できた |

本書では、実装済みの構成を現在形で記述し、未実装または未検証の内容は「現在の制約」「PoC 計画」「残タスク・未決事項」に明示する。

## 背景

問い合わせフォームはサイトごとに DOM、ラベル、選択肢、必須項目、禁止事項が異なる。この差異を企業ごとのルールやセレクタとして保守する方式は、対象数が増えるほど更新コストが高くなる。

そのため、フォームマッピングをルールベースで網羅せず、LLM / Agent による画面と項目の意味理解を中心に据える。現在の PoC では、Cloudflare Container を必要としない小さな Agent loop を Worker に実装し、OpenAI Responses API の function calling を利用する。

ブラウザは実行コンテナ内で Chromium を起動せず、BrowserUse Cloud Browser を利用する。BrowserUse Agent は採用せず、standalone browser の CDP 接続だけを利用する。これにより、ローカル PC や Cloudflare 上の各エージェントが Chromium の RAM を保持する構成を避ける。

## 現行の全体構成

```text
Bearer 認証付き HTTP API
（登録・取得を実装。バッチ / 一覧 / キャンセルは未実装）
        │
        ├─ D1 に pending を作成
        └─ jobId を Queue へ登録
                    │
                    ▼
Cloudflare Queue ───────────────► Dead Letter Queue
        │                           │
        │ dispatch / retry          └─ D1 を dead_lettered に更新
        ▼
Cloudflare Worker Queue Consumer
        │
        ├─ D1 の実行権を原子的に取得
        ▼
Worker-native Agent executor
  1 試行 = 1 Responses function-calling loop
  ├─ OpenAI Responses API
  └─ 用途限定 browser tools
       └─ 信頼済み handler
            └─ BrowserUse CDP ──► 対象企業
        │
        ├─ 送信前 / 送信後 / 禁止判定時のスクリーンショット
        │       ▼
        │  Cloudflare R2（証跡スクリーンショット）
        │
        │ 状態・結果・Provider 呼び出し回数
        ▼
Cloudflare D1
  ├─ jobs
  ├─ results
  └─ events（retry / DLQ / agent tool診断 / 証跡）
```

PoC のローカル実行では Wrangler / Miniflare 上の D1 と Queue、外部の OpenAI / BrowserUse を組み合わせる。本番は production 環境だけを対象とし、D1、Queue、DLQ、Worker、Secrets、公開 URL、Queue consumer を設定済みである。2026-09-02 に `https://anyreach.co.jp/contact` を対象とした production dry-run を実行し、`pending → running → prohibited`、`DRY_RUN_COMPLETE`、1 attempt、8 Provider requests、BrowserUse active session 0 件を確認した。`submitting` / `sent` には遷移しておらず、フォーム送信は行っていない。

その後、認証付きrun APIと受信件数を持つ常設テストシステム`siu-issiki/form-agent-test-system`をproductionへ配備した。2026-09-02に13シナリオをForm Agentのproductionから実行し、送信対象11件は最終検証ですべて`sent`、1 attempt、受信1件、送信禁止2件は`prohibited`、1 attempt、受信0件となった。送信対象は標準POST＋redirect、GET、multipart、Ajax、controlled input、確認を含むmulti-step、open / closed Shadow DOM、外部host iframe、画面外submit、サイト内別ページである。送信禁止対象はメールアドレスのみのページと、営業利用禁止のサンプル取り寄せフォームである。外部の実サイトには送信していない。

| 期待結果 | シナリオ | productionでの最終観測 |
| --- | --- | --- |
| `sent` | `native-post-redirect`、`native-get`、`multipart-post`、`ajax-inline`、`controlled-inputs`、`multi-step`、`open-shadow-dom`、`closed-shadow-dom`、`external-iframe`、`offscreen-submit`、`internal-page-form` | 各1 attempt、受信各1件 |
| `prohibited` | `email-only`、`sample-request-only` | 各1 attempt、受信各0件 |

初回検証で見つかったサイト内リンク非観測、iframe内完了表示非観測、GET Document送信非観測と完了判定を修正し、同じ管理下シナリオで再検証した。multi-stepの初回のみBrowserUse / CDPの一時失敗となったが、新規ジョブでの再実行は1 attemptで成功した。productionは`AGENT_DRY_RUN=false`、`AGENT_MODEL=gpt-5.6-luna`で、ジョブ単位の`_formAgentDryRun: true`による送信なし検証は引き続き有効である。

## コンポーネント責務

### Cloudflare Worker / Queue Consumer

- ジョブ登録時に D1 へ `pending` を作成し、Queue へ `jobId` を登録する。
- `JOB_API_TOKEN` による Bearer 認証を必須とし、未設定時はジョブ API を fail-closed で拒否する。
- ジョブ取得レスポンスから実行権を表す `runToken` を除外し、キャッシュを禁止する。
- Queue の at-least-once 配信を前提に、D1 の条件付き更新で実行権を 1 つの Consumer だけに与える。
- Agent の構造化結果を D1 の終端状態へ反映する。
- 再試行可能な失敗は理由、attempt、実行時間をイベントへ保存して Queue retry、再試行上限超過は DLQ へ送る。
- executor 設定が不足している場合は `EXECUTOR_NOT_CONFIGURED` で fail-closed に終了する。

現在の Queue 設定は次のとおり。

| 設定 | 値 |
| --- | --- |
| batch size | 1 |
| max retries | 3 |
| retry delay | 30 秒を基準に配信試行ごとに 2 倍へ増やし、±20% の jitter を掛けたうえで 300 秒を上限とする（Worker 実装） |
| dead letter queue | `form-agent-jobs-dlq` |
| max concurrency | 1（ローカル Wrangler では再現されない） |

### Worker-native Agent executor

- Queue から受け取った 1 ジョブについて Responses API と browser tool の反復を制御する。
- 1 回の実行で 1 社だけを処理する。
- `parallel_tool_calls: false` と strict schema により、1 turn で最大 1 tool だけを処理する。
- `AGENT_DRY_RUN`とbooleanの`_formAgentDryRun`から実効モードをジョブ登録時に保存する。旧形式のジョブは常にdry-runとし、deployment切替で既存ジョブの意味を変えない。dry-runでは`submit`をモデルへ公開したまま、送信対象と同じフォームへの入力成功、現在のsubmit要素、`form.checkValidity()`の成功を実ブラウザで検証し、送信権取得とブラウザsubmitより前に`DRY_RUN_COMPLETE`で終了する。
- 最大 16 turn、ジョブ prompt 最大 64,000 文字とする。
- `sent` / `prohibited` / `uncertain` / `failed` の構造化結果だけを返す。
- `prohibited`のreason codeは`NO_FORM_PRESENT`、`SALES_PROHIBITED`、`FORM_PURPOSE_INCOMPATIBLE`だけを許可し、旧aliasは保存前に正規化する。
- Agent 終了時または timeout 時に browser 接続を閉じる。
- `fill` / `select`ではモデルに生の値を渡させず、`payload.formValues`内の`payloadKey`を指定させる。信頼済みhandlerがD1の保存値を解決し、存在しないキー、契約外の型、上限超過、空文字を拒否する。値は単一文字列（最大8,192文字）または選択肢候補リスト（1〜10要素、各要素1〜256文字、合計2,048文字以下）のいずれかであり、候補リストは`select`だけが受け取る。`fill`に候補リストのキーを渡した場合は`INVALID_TOOL_INPUT`とする。

### 推論 Provider

現在は OpenAI Responses API のみ対応する。Worker がリクエストを組み立て、次を強制する。

- 設定されたモデルと一致すること。
- Responses API だけを利用すること。
- function tool 以外を渡さないこと。
- 1 run の Provider 呼び出しを最大 21 回（agent turn 16 + 修正 3 + 送信前レビュー最大 2）に制限すること。agent と送信前レビューは D1 の同じカウンタを共有する。レビューが deny を返した最初の 1 回だけ turn 上限を 3 増やし、turn 終盤で deny された場合でも修正に必要な fill・observe・submit を実行できるようにする。
- 出力 token を最大 4,096 に制限すること。
- request body を最大 128 KiB に制限すること。送信前レビューだけは証跡スクリーンショットを添付するため 1 MiB を上限とし、超過時は画像を外して再構成する。
- response body を最大 256 KiB に制限すること。
- OpenAI API key、BrowserUse API key、`runToken` をモデル入力へ含めないこと。

DeepSeek / Fireworks 等への切り替え、Provider fallback、品質・レイテンシ・料金比較は未実装である。

### BrowserUse Cloud Browser

- BrowserUse Agent ではなく、standalone browser へ CDP 接続する。
- BrowserUse API key と CDP URL はモデルへ渡さない。
- session は REST API v4（`https://api.browser-use.com/api/v4`）で明示的に作成し、応答の `cdpUrl` へ CDP 接続する。ジョブ終了時は正常・異常・deadline のいずれでも `PATCH /browsers/{id}` の `stop` を呼び、session を停止してから実行を終える。停止は best-effort であり、成否を `browser_use_session_stopped` に記録する。応答が 2xx でも `status` が `stopped` でなければ同時 session 枠は解放されていないため失敗として扱い、失敗理由は `STILL_ACTIVE` / `TIMEOUT` / `API_ERROR` の固定分類だけを記録する。
- 明示停止を行う理由は、CDP 接続を閉じても managed browser が止まらないためである。BrowserUse の公式ドキュメントは「`browser.close()`, disconnecting CDP, or `client.close()` does not stop the managed browser. Use `client.browsers.stop(browser.id)`」と記載しており、2026-09-03 の 5 並列計測では CDP 切断後も session が寿命まで残り、同時 session 数を食いつぶして close code 1011 / `LIMIT` を招いた。
- proxy country は `jp`、session timeout は 12 分とする。12 分は run deadline 10 分と termination grace 30 秒の外側に置いた backstop であり、明示停止が届かなかった場合にだけ効く。
- session には `metadata.jobId` と `metadata.dryRun` を付ける。Queue retry（`attemptCount` が 2 以上）の初回試行と、接続再試行の 2 回目以降では、create の前に `GET /browsers?filterBy=active` から同じ `jobId` の session を stop して残骸を回収し、`matched` / `stopped` / `failed` の件数を `browser_use_session_reclaimed` に記録する。停止を確認できた session だけを `stopped` に数え、1 件でも失敗すれば `ok: false` とする。create の応答が失われた場合や `cdpUrl` を欠く場合でも、次の create までに前回の session を解放できる。同一 `jobId` の session は `claimRun` の排他により同時に 1 件しか存在しないため、回収対象は必ず終了済み attempt のものである。
- attempt 上限に達したジョブは新しい driver を作らずに終端するため、回収する主体がいない。そこで Queue consumer が、`hasExceededAttemptLimit` で `JOB_ATTEMPT_LIMIT_REACHED` を保存する経路と、consumer の例外を attempt 上限で `QUEUE_CONSUMER_ERROR` として確定させる経路の 2 か所で、結果を保存する前に同じ回収を実行する。`BROWSER_USE_API_KEY` が未設定なら何もしない。回収は best-effort であり、10 秒の timeout を置き、失敗してもジョブの結果を変えない。これがない場合、`outcome: exceededCpu` で強制終了した最後の attempt の session が session timeout（12 分）まで枠を塞ぐ。
- 回収は自分の `jobId` に一致する session だけを停止する。`browser_use_session_reclaimed` の `matched` が 0 でも `activeTagged` が同時 session 上限を占めている場合、それは他ジョブの session であるため停止しない。したがって、`exceededCpu` などで leak した他ジョブの session は寿命が尽きるまで枠を塞ぎ続けるリスクが残る。Free プラン（同時 3）では leak が 3 件そろうと以後のジョブが全件 429 となり `BROWSER_TOOL_UNAVAILABLE` へ落ちる。2026-09-03 の計測では `browser_use_session_limit` が activeTotal 3 / activeTagged 3、`browser_use_session_reclaimed` が matched 0 となる連鎖を実際に観測した。手動の復旧は runbook の「BrowserUse sessionの確認と停止」で行う。
- `cdpUrl` は接続前・API key 付与前に host を検証し、`browser-use.com` またはそのサブドメイン以外は `Invalid Browser Use CDP endpoint` として失敗させる。`wss:` はそのまま使い、`https:` の場合だけ `GET <cdpUrl>/json/version` で `webSocketDebuggerUrl` を取得する。取得した URL も同じ host 検証を通し、`ws:` は `cdpUrl` と同一 host のときだけ `wss:` へ昇格させる。
- API key を付ける REST 呼び出しと `/json/version` 取得は `redirect: "manual"` とし、redirect を追わない。3xx 応答は再試行不可の API 失敗として扱い、cross-origin redirect 先へ `X-Browser-Use-API-Key` が転送されないようにする。
- CDP WebSocket が自発的に閉じた場合、close code、reason の文字数、reason を固定分類した hint（`NONE` / `LIMIT` / `AUTH` / `TIMEOUT` / `OTHER`）、`wasClean`、未完了コマンド数を記録する。相手から渡された reason の自由文そのものはログに残さない。
- 接続確立（CDP 接続から初期化完了まで）が一過性の障害で失敗した場合だけ、10 秒 → 20 秒 → 30 秒の待機を挟んで最大 3 回再接続する。再試行は送信前の接続段階に限定し、フォームへの副作用はない。
- 再試行の可否は失敗の種別で決める。WebSocket upgrade が拒否された場合は HTTP status が 408、429、5xx のときだけ再試行し、401 / 403 / 404 等の恒久的な拒否は即座に失敗させる。upgrade 要求自体が失敗したネットワーク障害、接続断、コマンド timeout は再試行する。endpoint 不正や API key 未設定は接続を試みずに失敗させる。
- session の作成・`cdpUrl` の解決が失敗した場合も同じ基準で扱う。REST API の status が 408、429、5xx なら再試行し、それ以外は再試行しない。API へ到達しなかった通信障害と、不正な JSON や `cdpUrl` 欠落のような一過性の応答異常は再試行する。再試行ログ `browser_use_connect_retry` の `reason` には、429 で `SESSION_LIMIT`、その他の作成・解決失敗で `SESSION_CREATE_FAILED` を記録する。
- session を作成した後の失敗（abort、`cdpUrl` 不正、CDP 接続・初期化の失敗）では、元のエラーを投げ直す前にその session を stop する。恒久的に拒否された session 要求は `BROWSER_SESSION_REJECTED` として再試行不可の failed にし、診断イベントには status に応じて `BROWSER_SESSION_LIMIT`（429）または `BROWSER_SESSION_API_FAILED` を記録する。再試行可能な失敗は従来どおり `BROWSER_TOOL_UNAVAILABLE` とする。
- 恒久的な upgrade 拒否（401 / 403 / 404 等）は `BROWSER_UPGRADE_REJECTED` として再試行不可の failed にし、Queue の再配信を行わない。診断イベントには `CDP_UPGRADE_REJECTED` を記録する。
- upgrade 成功後の close も、close code 1008（policy violation）または reason が認証を示す場合は再試行しない。`BROWSER_CONNECTION_REJECTED` として再試行不可の failed にする。
- 再試行の待機は agent の deadline で中断される。実行が abort された時点で待機と接続試行を打ち切り、`AGENT_TIMEOUT` として終了するため、termination grace を待機で消費しない。abort は WebSocket upgrade の要求と接続確立中の CDP コマンドも打ち切り、作成済み session を stop してから終了する。abort 中の失敗は再試行として記録せず、`browser_use_connect_retry` を出さない。接続が abort より後に完了した場合は、scope 設定と bootstrap navigate へ進まずに session を停止する。
- 実行は session の stop が完了するまで戻らない。stop には 10 秒の timeout を置き、termination grace 30 秒の内側に収める。

#### 起動時の読み込み待ち

`navigate`は`Page.navigate`の後に`document.readyState`が`interactive`または`complete`になるまで 100 ms 間隔で待つ。待ち時間は navigation の位置で変える。

- 起動時（run で最初の navigate。coordinator が `job.targetUrl` へ行う bootstrap）だけ 25 秒待ち、`PAGE_NOT_READY`になった場合は driver 内部で 1 回だけ navigate をやり直す。実サイトでは render-blocking な subresource の cold start で 10 秒を超えることがあり、1 件が`PAGE_NOT_READY`で失敗したためである。
- 再試行は navigation 回数を増やす前に行うため、dry-run の「bootstrap 後の再 navigate 禁止」には掛からない。回数は成否にかかわらず bootstrap 全体で 1 回だけ増える。
- モデルが呼ぶ通常の`navigate`は従来どおり 10 秒・再試行なしとする。サイトは既に暖まっており、そこで固まるのはモデルが判断すべき事象だからである。
- 上限は bootstrap 全体で最大 110 秒である。1 回の試行は `Page.navigate`（CDP command timeout 15 秒）と readyState 待ちからなり、後者は締切の直前に開始した `document.readyState` の評価が同じ command timeout まで伸びうるため、25 秒ではなく最大 40 秒を見込む。これを 2 回行う。
- readyState の評価が接続断（`Browser Use CDP connection is closed` / `... connection closed` / `... command could not be sent`）で失敗した場合は待ち続けず、その場で throw する。abort 時は coordinator の`close()`が bootstrap 中の driver（`#pendingDriver`）を閉じるため、待ちは即座に終わり、termination grace 30 秒の内側で session の stop が走る。
- popup、Worker、Service Worker、WebSocket 等の迂回経路を遮断する。
- CDP の `DOM.getDocument` を `pierce: true` で取得し、通常 DOM と open / closed Shadow DOM を Worker 側で走査する。
- 観測した同一ページ・許可hostのリンクを最大20件までモデルへ返し、サイト内別ページのフォーム探索に利用する。
- top documentとiframe documentを同じDOM探索対象とし、送信完了文言も各document bodyで確認する。
- CDP の単一 response は 4 MiB を上限とし、超過時は再試行せず `BROWSER_PAYLOAD_TOO_LARGE` で終了する。

### 制限付き browser tool

モデルに汎用 JavaScript や CDP を公開せず、次の用途限定 tool だけを提供する。

| tool | 責務 |
| --- | --- |
| `navigate` | `observe.navigationLinks`で直前に観察した許可URL、または現在URLへ移動する |
| `observe` | 現在ページのフォーム、ラベル、選択肢、禁止事項を取得する |
| `click` | 非 submit 要素だけをクリックする |
| `fill` | text input / textarea へ値を入力する |
| `select` | select / radio / checkbox を、payload の候補リスト順に一致する最初の選択肢へ設定する |
| `submit` | 送信前に独立レビュー（同一 Provider、ツールなし、strict JSON）を通し、D1 の送信権取得後に 1 回だけ送信する。deny は 1 回だけ修正可、2 回目で `uncertain` |
| `finish` | 送信せず、構造化された終端結果を返す |

driver が submit control と識別した要素は通常の `click` で操作できない。非submitの`click`、`fill`、`select`はDOMイベントを発火する前にbrowser requestを遮断し、`navigate`は直前の観察で得たfragmentを含む完全一致URLのtop-frame Document requestだけを1回許可する。`submit` 中も遮断を解除せず、全入力が同じform ownerに属し、最後の入力・選択・click後に再観察され、選択したformに禁止根拠が検出されていないことを検証してから D1 を `running` から `submitting` へ更新し、最初の期待済み送信requestと、そのrequest IDに直接連なるsafeなredirectだけを許可する。非safe HTTP methodはaction URLとmethod、GETはactionのorigin / path、`Document` resource、送信対象frameを照合する。モデルはDOM activationを優先して選択し、trusted click gestureまたはkeyboard activationが必要な場合だけmouse / Enterを選ぶ。mouseのhit testは1 animation frameごとに最大3回試行する。

#### 選択肢候補（choice candidates）

`payload.formValues`の値には、単一文字列に加えて「登録者が事前に許可した値の順序付き集合」である候補リストを指定できる。モデルは従来どおり`payloadKey`を指すだけで、どの候補が使われるかは信頼済み handler が決める。候補文字列はログ、診断イベント、tool の戻り値、エラーメッセージのいずれにも出さない。

- `select`要素: 候補リストの順に、option の`value`との完全一致、または option の text（`observe`が返す label と同じ。trim・大文字小文字無視）との完全一致を探し、最初に一致した候補の option を選ぶ。`value`が空の placeholder option は候補に一致しても選ばない。ページ側関数の戻り値は boolean だけで、Worker は`=== true`のときだけ成功とみなす。
- radio: 対象 radio の`value`、または関連ラベルが候補のいずれかに一致すれば対象とする。さらに同じ form owner・同じ`name`の radio 群を走査し、対象より前の候補に一致する別の（disabled でない）radio があれば選ばず、`ELEMENT_UNAVAILABLE`を返す。DOM 順ではなく候補順を優先させるためである。ページ側関数の戻り値は`selected` / `not_candidate` / `higher_priority_exists`の 3 値だけで、それ以外が返った場合は要素エラーにする。
- 関連ラベルの照合対象は`observe`がモデルへ報告する形と揃える。`observe`は複数の`labels`を空白 1 つで連結した 1 本の文字列として、`aria-labelledby`の複数 id も同様に連結した 1 本として報告するため、候補と比較するのもその連結形だけであり、個々の断片は比較しない。断片一致を許すと、radio 群が共有する設問文言のような「モデルが見ていない部分文字列」で誤選択が起こりうるためである。`aria-label`と祖先`label`はそれぞれ 1 本の文字列としてそのまま比較する。
- checkbox: 候補リストの順に見て、最初に現れた`checked` / `true`で check、`unchecked` / `false`で uncheck する。状態を表す候補が無い場合は、対象の`value`またはラベル（radio と同じ照合対象）が候補に一致したときだけ check する。いずれにも当てはまらなければ要素エラーとする（任意の文字列を uncheck として扱う旧挙動は廃止した。破壊的変更である）。
- 曖昧一致（部分一致・類義語）は行わない。完全一致だけを認める。

候補一致は必ずページ側の関数で行い、Worker はページから固定 token 以外を受け取らない。ページが任意の文字列を返しても、それが値として使われることはない。

#### 要素操作中の CDP コマンド失敗

`click` / `fill` / `select` の実行中に CDP が error 応答（`Browser Use CDP command failed`）を返した場合は、run 全体の再試行可能エラーにせず要素エラーとして扱い、モデルへ `ELEMENT_UNAVAILABLE` と再観察の guidance を返す。並列実行時は layout 確定前の `DOM.getBoxModel` / `DOM.scrollIntoViewIfNeeded` がこの失敗を返しやすく、ページが動いただけの失敗で run を終わらせないためである。診断イベントには `ELEMENT_OPERATION_CDP_FAILED` を記録し、通常の要素エラーと区別する。

CDP の error 応答は、失敗した CDP メソッド名、error code、および error message を固定分類した kind（`NODE_NOT_FOUND` / `NODE_DETACHED` / `NO_BOX_MODEL` / `NOT_FOCUSABLE` / `NO_EXECUTION_CONTEXT` / `NO_NODE_AT_LOCATION` / `OTHER`）を保持する。`browser_element_operation_failed` にはこの 3 つを併記し、どのコマンドがどの理由で失敗したかを後から追えるようにする。error message の自由文はページ由来の文字列を含み得るため記録しない。

変換する範囲は次のとおりである。

- `click`: 要素の検査から mouse の `mousePressed` 送信まで。`mouseReleased` の失敗は変換しない。press を送った時点で click がページへ届いた可能性があり、要素エラーを返すと再観察後の再 click で二重 click になり得るためである。
- `fill` / `select`: 要素解決後の操作全体。どちらも冪等（select-all して置換、値の setter）であり、再実行しても入力が重複しない。

非 submit の `click` では、要素エラーへ変換する前に準備段階（`DOM.scrollIntoViewIfNeeded` から hit test まで）を 1 animation frame ごとに最大 3 回やり直す。やり直す対象は hit test 不一致と、kind が `NO_BOX_MODEL` / `NODE_NOT_FOUND` / `NODE_DETACHED` / `NO_EXECUTION_CONTEXT` / `NO_NODE_AT_LOCATION` の CDP 失敗に限る。いずれも layout が確定していないだけで、次の frame では解消し得るためである。`NO_NODE_AT_LOCATION` は 2026-09-03 の 3 並列計測で `multi-step` の「確認画面へ」click が `DOM.getNodeForLocation`（code -32000）で失敗した実測から追加した。`NOT_FOCUSABLE` と `OTHER` は要素そのものの状態を表すので再試行しない。再試行のたびに `browser_click_preparation_retry` を `attempt` と `kind`（hit test 不一致は `HIT_TEST`）付きで記録する。`mousePressed` / `mouseReleased` は再試行しない。press を送った時点で click がページへ届いた可能性があるためである。並列実行の `multi-step` で「確認画面へ」の click が再観察後も 3 回連続で CDP error になった事象への対策である。

接続断（`Browser Use CDP connection closed`）、timeout、送信失敗、payload 上限超過は変換せず、従来どおり run の失敗として扱う。後続の tool 呼び出しでも回復しないためである。`submit` 経路は変換対象外であり、送信権取得後の失敗を `uncertain` に倒す既存の契約を維持する。

#### 禁止フォームへの submit

選択した form に禁止根拠がある場合、`submit` は `SUBMIT_PROHIBITED` を返し、`prohibitedReasonCodes` と `pageProhibited` を添える。`prohibitedReasonCodes` には、その form の code のうちページ単位の検出結果にも含まれるものだけを載せる。`finish_prohibited` はページ単位の検出結果に対して検証されるため、モデルが必ず通る code を選べるようにするためである。ページ単位の検出はすべての form に code がある場合にだけ成立するので、複数 form のページで選択 form だけが禁止の場合は `pageProhibited: false` となり、guidance は他の問い合わせフォームを探すか `finish_uncertain` を呼ぶよう指示する。以前は通常の要素エラーだったため、モデルが `finish_failed` を選ぶことがあった。

#### 禁止根拠検証時の再観察

`finish_prohibited` の検証（`validateProhibited`）は、観察が最新でありページ URL も一致しているのに `prohibitedReasonCodes` に該当 code が無い場合だけ、信頼済み handler 自身が 1 度だけ再観察して判定し直す。回数は input revision ごとに 1 回に制限し、結果を `prohibition_reverified` イベント（`verified` の真偽値のみ）へ記録する。禁止文言の読み取りは iframe の描画タイミングに依存し、モデルが読めている禁止を handler が読めないことがあるためである。

観察が最新でない場合（最後の入力後に観察していない場合）と URL が一致しない場合は、従来どおり再観察せずに拒否する。観察義務はモデルの契約であり、URL 不一致は再観察で解消しないためである。再観察は driver の要素集合を新しい generation で置き換えるため、モデルが保持していた elementId は無効になる。`PROHIBITION_NOT_VERIFIED` の guidance は再観察を指示しているため、この副作用は許容する。

### 送信前の独立レビュー

`submit` は送信権を取得する前に、agent とは履歴を共有しない独立したレビューを 1 回通す。レビューは同じ Responses API に対して tool を一切渡さず、strict JSON schema で `allow` / `deny` だけを返させる。

- 入力は、直前の信頼済み観察（URL、form、ページ本文、禁止 reason code）、`payload.formValues` の信頼済み値、`before_submit` スクリーンショット、対象ドメイン・URL、submit 要素 ID である。
- 観察とスクリーンショットは `untrustedPageContent` としてラップし、外部サイト由来のデータであり指示として解釈しないことを instructions で明示する。
- 判定 code は `INPUTS_MATCH`（allow のみ）、`INPUT_MISMATCH`、`SALES_PROHIBITED`、`FORM_PURPOSE_INCOMPATIBLE`、`WRONG_FORM`、`UNCLEAR` の固定値とする。`allow` と deny 系 code、`deny` と `INPUTS_MATCH` のように矛盾する組み合わせは、どちらの判定としても解釈せず応答不正として扱う。
- 修正を許可するのは `INPUT_MISMATCH` の deny だけであり、他の reason code は 1 回目でも `PRE_SUBMIT_REVIEW_DENIED` として `uncertain` で終了する。ページやフォーム自体への判断は入力の修正で覆らないためである。
- 修正が許可された場合はモデルへ `SUBMIT_REVIEW_DENIED` と reason code だけを返し、実際の `fill` / `select` の成功と再観察の両方を次の `submit` の前提にする。さらに deny 時の観察から、比較対象フィールドの tag / type / name / label / value / checked だけを取り出した指紋（elementId は含めない）を保存し、再観察後の指紋が変化していなければ `CORRECTION_REQUIRED` として拒否する。再観察だけ、あるいは同じ値の再入力で、確率的なレビューの再判定を引くことを防ぐためである。送信権は取得せず、ブラウザ送信も行わない。
- deny の 2 回目は `PRE_SUBMIT_REVIEW_DENIED` として `uncertain` を保存し、そのジョブを終了する。
- deny 予算は D1 のジョブ行（`submit_review_denial_count`）へ保存し、Queue 再配信で新しい browser session と Agent 実行になっても 1 attempt 目と同じ予算を共有する。修正を許可しない deny は残り予算をすべて消費するため、`uncertain` の保存に失敗して `running` のまま残っても、後続の allow で送信へ進むことはない。`submit` は冒頭で永続値を読み直し、予算を使い切っていればレビューも撮影も行わずに `uncertain` で終了する。「修正が必要」というフラグ自体は実行単位であり、再配信後の新しい実行はページを最初から入力し直す。
- レビュー自体を完了できない場合は allow にせず、再試行可能な `SUBMIT_REVIEW_UNAVAILABLE` として扱う。Provider の通信失敗、429、応答不正はそれぞれの Provider 用 reason code のまま伝播させ、browser tool の障害へ丸めない。
- モデルへ返すのは固定の code と guidance だけであり、レビューの自由記述はモデルへ渡さない。自由記述は 2 回目 deny 時の `uncertain` の reason にだけ、制御文字を空白へ置換し 500 文字へ切り詰めて保存する。
- レビューが allow を返した直後、送信権を取得する前に、現在 URL と観察済み全フィールドの `value` / `checked` を読み直して観察時と一致することを確認する。1 件でも異なる、要素が消えている、要素が増えている場合は `FORM_STATE_CHANGED` として送信せず、再観察を強制する。レビュー中に非信頼ページの JS が値を書き換えても、レビューされていない内容が送信されないようにするためである。
- あわせて、レビュー呼び出しの直前と allow 直後に、submit 要素が属する form 全体を DOM から再探索した snapshot を取得して比較する。snapshot には hidden と disabled を含む全コントロールの tag / type / name / value / checked / disabled を DOM 順で含め、password の値はマスクする。観察済み要素だけを再訪する照合では見えない、レビュー中の hidden input 追加、`name` の差し替え、disabled の変更もこれで検出する。
- レビューは `running` 状態でのみ Provider 呼び出し回数を消費できるため、必ず `claimSubmission` より前に実行する。
- 既知の残存リスク（2026-09-03 時点で受容し、未対応）:
  - allow 後の最終照合から activation までの間（`claimSubmission` の待ち時間を含む数十 ms）は再照合しない。この窓で非信頼ページの JS がフォームを書き換えた場合、レビューされていない内容が送信され得る。送信先は対象ドメインと期待済み action / method に限定されるため、影響は対象サイト自身のフォームへの内容差異にとどまる。
  - snapshot にはコントロールの基本属性だけを含め、禁止文言、label、select の option、form の action / method の変化は比較しない。レビュー中にこれらが変わった場合、変化後の action へ送信され得る（ドメインと method の制限は network policy が別途強制する）。
  - 修正の証明は「`fill` / `select` の実施」と「観察指紋全体の変化」で判定するため、無関係な動的フィールドや label が変わると、同じ値の再入力でも修正済みと見なされる。
  - form 全体の再探索は候補 200 field / 25 form で打ち切られるため、それを超えるページでは snapshot が form 全体を表さない。

- レビューモデルは既定で `AGENT_MODEL` と同じであり、`AGENT_SUBMIT_REVIEW_MODEL` を設定した場合だけ上書きする。

### Cloudflare D1

- ジョブの現在状態と実行権を保持する。
- 最終結果を 1 ジョブ 1 件で保存する。
- Provider 呼び出し回数を D1 の条件付き更新で制限する。
- DLQ 到達をイベントとして記録する。

状態遷移と結果保存は D1 session / batch と条件付き `UPDATE` を使う。retry / DLQ、agent tool診断、ジョブ単位の実行メトリクス（token、全体処理時間、BrowserUse接続待ち時間を含む）はイベントへ保存する。全状態遷移の記録と費用そのものの保存は未実装であり、費用は token 数と外部の単価から算出する。

### Cloudflare R2（証跡）

- バケット名は `form-agent-evidence`、binding 名は `EVIDENCE_BUCKET` である。
- オブジェクトキーは `jobs/<jobId>/<stage>/<eventId>.jpg` とし、`eventId` は D1 `events.id` と 1 対 1 で対応する。`runToken`、URL、フォーム値はキーへ含めない。
- `contentType` は `image/jpeg` で保存する。
- put 時に sha256 を渡し、R2 側で整合性検証する。D1 の `events` にも同じ sha256 を記録し、取得後に照合できるようにする。
- 公開アクセスは設定しない。読み出しは `wrangler r2 object get` による手動取得だけであり、専用の閲覧 API / UI は未実装である。
- 撮影は表示中の viewport のみとする。フルページ撮影は CDP メッセージ上限（4M 文字）を超えると接続が閉じて回復できないため採用しない。

## ジョブライフサイクル

1. 対象企業、対象 URL、許可ドメイン、送信内容を含むジョブを D1 に `pending` として作成する。
2. `jobId` を Cloudflare Queue へ登録する。
3. Consumer は `pending` から `running` への条件付き更新に成功した場合だけ実行する。
4. Agent には、対象ドメイン内でフォームを探し、営業禁止・用途制限を確認するよう指示する。
5. Agent が禁止または対象フォームなしと判断した場合は、送信せず `prohibited` または `uncertain` を返す。
6. Agent には、フォーム項目を観察し、ジョブ入力に存在する値だけを入力するよう指示する。
7. Agent には、送信前に対象、禁止事項、入力値、必須項目、送信回数を再確認するよう指示する。
8. D1 を `running` から `submitting` へ原子的に更新できた場合だけ `submit` を許可する。
9. 送信完了を確認できた場合は `sent` を保存する。
10. 送信後に結果を確認できない場合は `uncertain` とし、自動 retry を止める。
11. retry しない終端結果を D1 に保存し、browser 接続を終了する。

現在の状態遷移は次のとおり。

```text
pending ── claim ──► running ── claim submit ──► submitting ──► sent
                       │                              │
                       ├─► prohibited                 └─► uncertain
                       ├─► uncertain
                       ├─► failed（再試行不可）
                       └─ retryable error ──► Queue retry
                              └──────────────► running（同じ runToken）

pending / running / failed ── retry 上限超過 ──► dead_lettered
```

`prohibited` と `uncertain` は自動 retry しない。retryable error は `failed` を保存せず、`running` と同じ `runToken` を維持したまま Queue の再配信を待つ。再配信では新しい Agent 実行と browser session を開始する。`submitting` または `sent` を受け取った Consumer は送信を再実行しない。

### 送信証跡スクリーンショット

送信前・送信後・禁止判定時の 3 段階でスクリーンショットを撮影し、上記の Cloudflare R2（証跡）へ保存する。dry-run の `submit` 経路（`_formAgentDryRun: true`）では撮影しない。

| stage | 撮影位置 | ジョブ状態 | 失敗時の扱い |
| --- | --- | --- | --- |
| `before_submit` | `submit` tool内、送信前検証成功の直後、送信前レビューと送信権取得（`claimSubmission`）の前 | `running` | 必須。撮影に失敗した場合はレビューも送信権取得も driver への送信も行わず、何も送信しない。再試行可能なエラーとして扱う。レビュー deny 後の再 submit では再撮影するため、1 attempt に複数件になり得る |
| `after_submit` | driver への送信が成功または例外で終わった直後、結果確定（`sent` / `uncertain`）の前 | `submitting` | ベストエフォート。失敗しても送信結果（`sent` / `uncertain` / 例外経路）は変えない |
| `prohibited` | `finish` tool で禁止判定の結果を返す直前 | `running` | ベストエフォート。ブラウザセッションが未作成の場合は撮影せず、未撮影であることだけを記録する |

`before_submit` の撮影失敗は送信前の唯一のブロッキング条件であり、二重送信防止と同様に「不確実なら送信しない」方針に従う。`after_submit` と `prohibited` は既存の結果確定ロジックに影響しない。送信後 URL の検証に使う値は `after_submit` の撮影より前に取得しておき、撮影失敗で CDP 接続が閉じても送信結果（`sent` / `uncertain`）は変わらない。

撮影・保存・記録は合計 15 秒で打ち切り、超過時は `CAPTURE_TIMEOUT` として記録する。`after_submit` の stall が全体期限による `uncertain` を招かないようにするため。同じ撮影の成功・失敗は共通の `eventId` で排他的に記録し、撮影開始時の attempt を固定する。タイムアウト後に R2 保存または D1 記録が遅れて完了しても成功イベントへ戻さず、保存済みオブジェクトは補償削除する。

## データモデル

### jobs

| 列 | 型 | 内容 |
| --- | --- | --- |
| `id` | TEXT PK | 一意な `jobId` |
| `company_id` | TEXT | 対象企業の識別子 |
| `company_name` | TEXT | 対象企業名 |
| `target_url` | TEXT | 調査開始 URL |
| `target_domain` | TEXT | 遷移と通信を許可する登録可能ドメイン |
| `payload_json` | TEXT | 送信者情報、本文などの入力 |
| `status` | TEXT | `pending` / `running` / `submitting` / `sent` / `prohibited` / `uncertain` / `failed` / `dead_lettered` |
| `attempt_count` | INTEGER | 実行試行回数 |
| `submit_review_denial_count` | INTEGER | 送信前レビューが消費した deny 予算。修正を許可しない deny は残り予算をすべて消費する。Queue 再配信をまたいで共有する |
| `run_token` | TEXT NULL | 現在の実行権を識別する token |
| `provider_request_count` | INTEGER | 現在の run が使用した Provider 呼び出し回数 |
| `created_at` | TEXT | 作成日時 |
| `updated_at` | TEXT | 更新日時 |

### results

| 列 | 型 | 内容 |
| --- | --- | --- |
| `job_id` | TEXT PK | `jobs.id` への参照。最終結果は 1 ジョブ 1 件 |
| `outcome` | TEXT | `sent` / `prohibited` / `uncertain` / `failed` |
| `form_url` | TEXT NULL | 実際に処理したフォーム URL |
| `reason_code` | TEXT NULL | 禁止、判断不能、失敗理由の分類 |
| `reason` | TEXT NULL | 人間が確認できる説明 |
| `completed_at` | TEXT | 完了日時 |

Provider、model、input / output token、処理時間、BrowserUse 待ち時間等の metrics はまだ保存しない。

### events

| 列 | 型 | 内容 |
| --- | --- | --- |
| `id` | TEXT PK | イベント ID |
| `job_id` | TEXT | `jobs.id` への参照 |
| `attempt` | INTEGER | 試行番号 |
| `type` | TEXT | イベント分類 |
| `data_json` | TEXT | 秘密情報を除いたイベント詳細 |
| `created_at` | TEXT | 発生日時 |

現在保存するイベントは `job.retry_scheduled`、`job.dead_lettered`、`job.redelivery_ignored`、`agent.tool_diagnostic`、`agent.run_metrics`、`evidence.intent`、`evidence.captured`、`evidence.capture_failed` である。retry イベントにはreason code、発生元、attempt、実行時間、次回配信までの遅延秒数、retry時点のProvider呼び出し累計を保存する。tool diagnosticにはturn、固定のtool名、処理stage、固定のresult codeだけを保存する。

`job.redelivery_ignored` は、Queue の再配信を実行せずに ack した場合に best-effort で記録し、`data_json` はジョブの `status` だけを保存する。Worker が `submitting` 中に停止したジョブは再配信されても状態が `submitting` のまま残るため、`updated_at` 以外の手掛かりで見つけられるようにするためである。記録に失敗しても ack は変わらない。

`agent.run_metrics` は 1 run に 1 件記録し、`data_json` は `{ turns, providerRequests, reviewRequests, inputTokens, outputTokens, reasoningTokens, cachedTokens, browserConnectMs, browserConnected, submitReviewAllow, submitReviewDeny, durationMs, outcome }` を保存する。数値、boolean、固定の `outcome`（`sent` / `prohibited` / `uncertain` / `failed` / `error`）だけであり、`error` は executor が `AgentExecutionError` を投げて終了した run を表す。`providerRequests` と `reviewRequests` は応答を受け取った Provider 呼び出しの件数、token は応答の `usage` の合計、`browserConnectMs` は browser driver の確立に要した時間（失敗した場合も記録し、確立を試みなかった run では `null`）である。`browserConnected` は CDP driver の確立に成功したかどうかだけを表す。REST API で session を作成した後に CDP 接続で失敗した場合も `false` になるため、課金対象となる session の作成・停止件数は Worker ログの `browser_use_session_created` / `browser_use_session_stopped` で追う。記録は executor の終了時に best-effort で行い、失敗しても run の結果を変えない。書き込みは 2 秒で打ち切り、打ち切りや失敗は Worker ログの `agent_run_metrics_not_recorded`（`reason` は `TIMEOUT` / `WRITE_FAILED`）で検知する。executor の deadline race の内側で走るため、遅い D1 が確定済みの run 結果を `AGENT_TERMINATION_UNCONFIRMED` へ上書きしないようにするためである。

`evidence.captured` の `data_json` は `{ stage, objectKey, sha256, byteLength, contentType: "image/jpeg" }` を保存する。`stage` は `before_submit` / `after_submit` / `prohibited` の固定値であり、`objectKey` は `jobId` / `stage` / `eventId` から機械的に組み立てた R2 オブジェクトキーである。`evidence.intent` の `data_json` は `{ stage, objectKey }` を保存する。`evidence.capture_failed` の `data_json` は `{ stage, failureCode }` に加え、`evidence.intent` / `evidence.captured` から遷移した場合は `objectKey` も保持する。R2 へ書き始めた後に失敗・timeout したオブジェクトを D1 から辿れるようにするためであり、intent を記録する前に失敗した場合（`SCREENSHOT_FAILED` など）は `objectKey` を持たない。`failureCode` は `SCREENSHOT_FAILED` / `OBJECT_STORE_FAILED` / `EVENT_NOT_RECORDED` / `NO_BROWSER_SESSION` / `CAPTURE_TIMEOUT` の固定値である。

どのイベントにも秘密情報、URL、フォーム値、自由記述のエラー本文を含めない。証跡イベントの `objectKey` も `jobId` / `stage` / `eventId` の組み合わせだけで構成されており、この方針を維持している。

## 安全設計 / 冪等性

Cloudflare Queue はメッセージを複数回配信し得るため、処理全体を exactly-once と仮定しない。外部フォーム側には一般に idempotency key を渡せないため、送信処理は自動復旧より二重送信防止を優先する。

### 技術的に強制する境界

- すべての処理を一意な `jobId` に紐付ける。
- Consumer は D1 の条件付き更新で実行権を 1 つの `runToken` だけに与える。
- 送信直前に `running` から `submitting` への条件付き更新を行う。
- `submitting` または `sent` のジョブは自動送信しない。
- 送信後に応答を取得できない場合は `uncertain` として自動 retry を止める。
- driver が submit control と識別した要素は通常の `click` で操作させず、`submit` tool へ限定する。
- HTTP(S) の通信先を対象企業の登録可能ドメインとサブドメイン、またはジョブごとに登録した完全一致の外部hostへ限定する。
- POST 等の非safe HTTP methodまたは期待済みGET Documentは、送信権取得後の最初の 1 回だけ許可する。
- popup、Worker、Service Worker、WebSocket、WebRTC 等の迂回経路を遮断する。
- Provider / BrowserUse の認証情報と D1 の実行権をモデル入力・tool 出力へ渡さない。
- Agent に返すジョブ情報から `runToken` を除外する。
- モデルが`fill` / `select`で指定できるのは`payload.formValues`内のキーだけとし、実際の値は信頼済みhandlerがD1から取得する。候補リストの場合も、どの候補を使うかはページ側の完全一致だけで決まり、モデルは関与しない。
- `observe`の結果を`untrusted_page_content`として明示し、ページ本文が信頼済みhandlerの上限（20,000文字）で切り詰められた場合は`pageTextTruncated`で通知する。
- 送信直前に、直前の観察・`payload.formValues`・`before_submit`スクリーンショットを入力とする独立レビューを通し、`allow`以外では送信権を取得しない。
- レビューのdenyで修正を許可するのは`INPUT_MISMATCH`だけとし、実際の`fill` / `select`と観察指紋の変化を次の`submit`の前提にする。deny予算はD1のジョブ行に保存し、実行と再配信をまたいで共有する。
- レビューのallowから送信権取得までの間に、現在URLと観察済み全フィールドの値・チェック状態を読み直し、あわせてhidden / disabledを含むform全体のsnapshotをレビュー前後で比較し、1件でも異なれば送信しない。
- ジョブ間で browser session、cookie、入力データを共有しない。

`submitting` 中に Worker が停止し、結果保存まで到達しなかった場合は自動再送せず、人間の確認対象にする。人手照合、DLQ確認、緊急停止、安全な再開のrunbookは [operations.md](operations.md) に定義済みである。照合用の専用 API / UI は未実装である。

### キャンペーン取り込み

`tools/campaign-dry-run.ts` は CSV と登録値 JSON からジョブを組み立てる。選択肢が必要なサイト向けに `--choices <path>` を追加した。JSON は `Record<string, string[]>` で、キーは payload key の書式、値は候補リストの契約（1〜10 要素、各要素 1〜256 文字、合計 2,048 文字以下）で検証する。登録値・件名・本文とキーが衝突した場合は優先順位を設けずエラーにする。サンプルは `docs/examples/campaign-choices.example.json` にある。

プライバシーポリシー同意などの必須 checkbox を agent に操作させるかは運用判断であり、サンプルには含めない。同意させる場合は `privacyConsent` のようなキーで `["checked"]` を渡す。

### Agent への安全指示

system prompt では、営業禁止・用途制限の確認と送信前の再観察を指示する。入力値は信頼済みhandlerが`payload.formValues`由来であることを強制する。`prohibited`は、直前かつ現在URLと一致する観察でフォーム不在、または全候補formについてform本文、前方の近接要素、祖先側の近接要素、iframe親ページ側の近接要素から固定パターンの営業禁止・用途制限を検出した場合だけ受理する。送信前には選択したformの禁止根拠、全入力のform owner、native validity、現在のaction / method、入力後の再観察、1回限りの送信権を機械的に検証する。さらに送信直前には、観察・信頼済み入力値・`before_submit`スクリーンショットを入力とする独立レビューを通し、`INPUT_MISMATCH` / `SALES_PROHIBITED` / `FORM_PURPOSE_INCOMPATIBLE` / `WRONG_FORM` / `UNCLEAR`のいずれかでdenyされた場合は送信権を取得しない。修正を許可するのは`INPUT_MISMATCH`だけで、実際の入力変更と再観察に加えて、観察指紋が変化していることを次の`submit`の前提にする。他のreason codeは1回目でも、`INPUT_MISMATCH`は2回目のdenyで`PRE_SUBMIT_REVIEW_DENIED`として`uncertain`で終了する。allow後・送信権取得前には現在URLと観察済み全フィールドの値・チェック状態を読み直し、さらにレビュー前後でhidden / disabledを含むform全体のsnapshotを比較し、レビュー中にページが変化していれば送信しない。レビューを完了できない場合はallowにせず、再試行可能な`SUBMIT_REVIEW_UNAVAILABLE`として扱う。禁止判定時と送信前後には画面のスクリーンショット証跡をR2へ保存する。`observe`の結果は外部サイト由来の非信頼データとして明示し、モデルとレビューの双方へページ内の指示に従わないよう指示する。固定パターンで表現されない禁止事項は独立レビューで補完するが、完全ではない。Shadow DOM内の本文とページ上のprompt injectionに対する完全な判定は引き続き未対応である。

## 現在の制約

### Browser / form 対応

- top-level navigation は対象企業ドメインとそのサブドメイン、またはジョブごとに登録した完全一致の外部hostだけを許可する。
- フォーム入力前に限り、公開HTTPS hostのread-only subresource（`GET` / `HEAD` / `OPTIONS`）を許可する。入力開始後は対象企業ドメインとジョブ固有の許可host以外への通信を遮断する。
- CDP DOM tree から `form` と可視 `input` / `textarea` / `select` / `button` を観察し、`form` 属性による外部関連付けにも対応する。各フィールドは tag、type、name、role、label、placeholder、必須、現在値、選択肢を返し、checkbox / radio では `checked` も返す。password の値は常に空文字で返す。select の option と radio / checkbox の label は、候補一致の根拠としてモデルとレビューの双方が参照する。
- 探索上限は最大 25 form candidate、200 field candidate、モデルへ返す観察結果は最大 10 form、合計 100 field、本文 20,000 文字までとする。
- open / closed Shadow DOMは探索対象で、管理下テストでは送信まで検証済みである。ただし実サイトでの互換性検証は継続する。
- cross-origin iframeはジョブ固有の外部host許可を使う管理下テストで送信まで検証済みである。contenteditableと独自UI componentは未対応または未検証である。
- popup、別 tab、Service Worker を利用するフォームは未対応である。
- 確認を挟むmulti-stepは管理下テストで検証済みである。ファイル添付とCAPTCHAは未対応である。
- 送信完了は、許可したrequestを観測し、日本語の送信完了表現または`thank you`が5秒以内に新たに出現した場合に確定する。期待済みGET Documentは、送信対象frameの遷移と同じframe内の完了文言を必須にする。他frameの完了文言は判定に利用しない。
- submit controlの期待済みGETは送信権で制御する。非submitの`click`、`fill`、`select`がDOMイベントを発火する直前から、その後および`submit`中のbrowser requestを遮断し、観察済みnavigateのtop-frame Document、期待済みsubmit request、またはそのrequest IDに直接連なるsafe redirectだけを許可する。`navigate`は直前の`observe.navigationLinks`で得たfragmentを含む完全一致URLまたは現在URLだけを許可する。観察済みリンク自体がGET型副作用を持つサイトは機械的に識別できないため、対象サイト側がGETをsafe methodとして扱うことは引き続き前提になる。
- 営業禁止判定はフォーム不在と、候補form本文、前方・祖先側の近接要素、iframe親ページ側の近接要素に対する固定の日本語・英語パターンを使う。肯定表現と「禁止していない」は除外し、複数formがある場合のページ全体禁止は全formに何らかの禁止根拠がある場合だけ受理する。送信前確認は選択formの禁止根拠、form owner、native validity、action / method、入力後の再観察、1回限りの送信権を信頼済みhandlerで検証する。固定パターンに加えて送信直前の独立レビューが禁止表現と入力内容を再確認するが、レビューはモデル判断であり完全ではない。未知の禁止表現は`prohibited`として確定できず、追加パターンまたは人手確認が必要になる。
- dry-runではジョブURLへのbootstrap後の再navigateと、最初のclick / fill / select以降に発生するbrowser requestをすべて遮断し、座標click前にCDPのhit targetが検証済み要素またはそのcomposed descendantであることを確認する。
- 送信前の独立レビューとレビュー後の再照合は、レビュー中のページ JS による値の書き換えを検出するが、最終照合から activation までの窓、禁止文言 / label / option / action の変化、200 field を超える form の再探索は対象外である。詳細は「送信前の独立レビュー」の残存リスクを参照する。

### API / 運用

- Worker は認証不要の `GET /health`、Bearer 認証付きの `POST /jobs` と `GET /jobs/:id` を持つ。
- `JOB_API_TOKEN` は単一の共有 secret であり、利用者別の認証・権限・失効管理は行わない。
- ジョブ一覧、キャンセル API は未実装である。
- `submitting` / `uncertain` の照合、DLQ確認、緊急停止、安全な再開はrunbookで運用する。専用 API / UIと自動再投入は未実装であり、再実行時は既存ジョブを変更せず新しいジョブIDを使う。
- payload、理由、ログ、DOM snapshot の保存期間・マスキング方針は未決定である。証跡スクリーンショットは入力済みの個人情報を含む画面を撮影するため保存期間の影響が大きいが、2026-09-02時点では無期限保存（R2ライフサイクル削除ルールなし）と暫定決定しており、運用ポリシー確定時に見直す。閲覧手段は `wrangler` CLI による手動取得だけであり、専用の閲覧 UI は未実装である。

### Provider / observability

- Provider は OpenAI 固定である。
- token、全体処理時間、BrowserUse接続待ち時間は `agent.run_metrics` として1 run に1件保存する。rate limitの詳細と費用そのものは保存せず、費用はtoken数と外部の単価から算出する。
- agent tool診断はbrowser tool、`finish`、unknown tool dispatchを対象とする。`data_json`にはturn、固定tool名、stage、固定result codeだけを保存し、イベント共通列にはjob ID、attempt、記録時刻を保存する。送信前レビューはstage `submit_review`、result code `SUBMIT_REVIEW_ALLOWED` / `SUBMIT_REVIEW_DENIED` / `SUBMIT_REVIEW_UNAVAILABLE`として記録する。入力値、URL、自由記述エラー、全状態遷移は保存しない。
- retry delay は配信試行に応じた指数 backoff（30 / 60 / 120 秒）に ±20% の jitter を掛け、300 秒で上限を設ける。実際に使う遅延秒数は `job.retry_scheduled` の `delaySeconds` に保存する。
- Workers Logs を有効にし、invocation ごとの `outcome`、`cpuTime`、`wallTime`、`console` 出力を head sampling 100% で記録する。保持期間は Free プランで 3 日であり、`outcome = exceededCpu` の調査は Cloudflare ダッシュボードの Workers Logs で 3 日以内に行う。ログに値、URL、自由文、session id を出さない方針は変わらない。
- 送信前レビューのリクエスト構築は `submit_review_request_built` に記録する。`imageBytes`（スクリーンショットのバイト数）、`bodyBytes`（リクエストのバイト数）、`withImage` だけを出し、リクエスト本文は出さない。所要時間は出さない。Workers の時計は I/O 境界でしか進まないため、base64 化や JSON 化のような同期区間の CPU 時間は `Date.now()` でも `performance.now()` でも測れず、ランタイムが報告する `cpuTime` で見る。
- 証跡撮影の各段階の所要時間は `submission_evidence_timing` に記録する。固定の `stage` と `phase`（`screenshot` / `digest` / `put` / `record`）、`timedOut`、`screenshotMs`、`digestMs`、`putMs`（R2）、`recordMs`（D1 の intent、captured、および失敗イベントの合計）、`bytes` だけを出す。各段階は await（I/O）を挟むためこちらは計測できるが、段階のあいだの同期区間は含まれない。1 回の撮影につき必ず 1 行だけ出す。timeout で打ち切った場合は撮影の完了を待たず、timeout 側が `timedOut: true` と到達済みの `phase` を記録する。停滞した撮影は戻らないことがあり、そのときこそ記録が必要なためである。
- Worker の CPU 上限は既定の 30 秒のままである。`limits.cpu_ms` は Workers Free プランでは deploy が拒否される（code 100328）ため設定していない。2026-09-03 の `exceededCpu` は報告 `cpuTime` が 165 ms、`wallTime` が 91 秒であり、上限引き上げでは解消しない可能性が高いため、原因は Workers Logs で追跡する。

## 並列・リトライ方針

PoC はまず 1 並列の production で開始し、管理下テストサイトへの実送信結果を観測してから 5、20、50 へ段階的に引き上げる。設定値だけで並列対応済みとせず、Cloudflare 上での実測を完了条件とする。

2026-09-03 に 5 並列で管理下テストシステムの 12 シナリオを実行し、8 件が合格した。残りのうち 3 件は Worker 診断が stage `driver_connect`、code `CDP_CONNECTION_CLOSED` で、10 秒間に連続して発生した。発生時点で BrowserUse 側に既存 session が 3〜4 件あり、直前 2 分 40 秒で 9 session を作成していた。前後の接続は成功しているため、BrowserUse の同時 session 上限（プラン上 10）または session 作成レートの上限に達したと推定するが、当時は WebSocket の close code / reason を記録していなかったため原因は未確定である。

同日に 19 シナリオを同時登録して 5 並列で再計測し、15 件が合格した。close code 1011、`wasClean`、reason 分類 `LIMIT` の切断が 16 件、接続再試行が 15 回発生し、`native-get` は 10 / 20 / 30 秒の再接続 3 回でも解けなかった。Worker 側では `outcome: exceededCpu` による強制終了が 1 件あった。原因はジョブ終了後に session を停止しておらず、CDP 切断後も session が 15 分の寿命まで残って同時 session 上限を食いつぶしていたことである。REST API v4 での明示的な作成・停止を入れて、同じ 19 シナリオを 5 並列で再計測した。

明示停止後の再計測では 15 件が合格し、18 session すべてを平均約 100 ms で停止できた。CDP 切断（1011 / `LIMIT`）と `exceededCpu` は 0 件になった。一方で session 作成 API が `429 Too many concurrent active sessions` を 15 回返し、10 / 20 / 30 秒の再試行で 3 件は回復したが、`sample-request-only` と `open-shadow-dom` の 2 件は 60 秒待っても回復せず失敗した。回収ログの一致件数は常に 0 で、残骸ではなく同時実行中の session が上限を消費していた。session を毎回停止しても 5 並列で上限に達することから、この account の実際の同時 session 上限は 5 未満（Free プランの 3 と推定）である。残る不合格は、途中の CDP コマンド失敗で止まった `multi-step`（受信 0）と、禁止フォームの submit を信頼済み handler がブロックした後にモデルが `finish_prohibited` ではなく `finish_failed` を選んだ `external-iframe-secondary`（受信 0、3 回中 2 回再現）である。

consumer は `max_concurrency: 3` とする。5 並列では session を毎回停止しても作成 API が 429 を返したため、推定される同時 session 上限（3）に合わせた。3 並列で 19 シナリオを再計測した結果は 17 件合格で、作成 API の 429、CDP 切断、`exceededCpu` はいずれも 0 件、19 session すべてを停止できた。不合格 2 件は、並列時に毎回 turn 6 の `click` で CDP コマンドが失敗する `multi-step`（受信 0）と、iframe 側の禁止文言に対して信頼済み handler の禁止根拠検証が通らずモデルが `uncertain` を選んだ `external-iframe-tertiary`（受信 0、4 回中 1 回）である。接続再試行（10 / 20 / 30 秒、最大 3 回）は緩和策として維持する。再試行でも接続できない場合は再試行可能エラーとして Queue の retry / DLQ へ進む。deploy 後の再計測では `browser_use_connect_retry`、`browser_use_cdp_closed`、`browser_use_session_stopped`、`browser_use_session_reclaimed` の件数を確認する。作成 API が 429 を返した時点（backoff の待機前）と回収時に active session の全件数と `metadata.source = form-agent` 付きの件数を記録し、上限を消費しているのがこの client か外部かを切り分ける。同じ API キーを別の deployment やローカル実行と共有している場合は source タグでも区別できない。並列数を引き上げるのは、BrowserUse のプランと同時 session 上限をダッシュボードで確認し、必要なら Pay as you go（同時 10）へ変更してからとする。

再接続は送信前の接続確立に限定するため、フォームへの副作用は発生しない。

| 分類 | 例 | 現在の方針 |
| --- | --- | --- |
| 再試行可能 | Provider / BrowserUse の一時障害、timeout | `running` を維持し、jitter 付きの指数 backoff（30 / 60 / 120 秒、上限 300 秒）で Queue retry |
| 再試行不可 | 営業禁止、対象フォームなし、入力不足 | 終端結果として保存し、ack |
| 結果不明 | submit 後の timeout、完了確認不能 | `uncertain` として保存し、ack |
| retry 上限超過 | 一時障害の継続 | DLQ へ移動し、`dead_lettered` とイベントを保存 |

指数 backoff と jitter は実装済みであり、`dead_lettered` は人手で確認し、承認のうえ新しいジョブ ID で再登録する（手順は runbook）。一時障害の細分類と設定可能な retry 回数は未実装である。

## コスト / ボトルネック

主な変動費は次のとおり。

1. OpenAI の input / output token と呼び出し回数
2. BrowserUse Cloud Browser の session 時間、並列数、待ち時間
3. Cloudflare Worker、Queue、D1、ログ・イベント保存

`agent.run_metrics` に 1 run あたりの token 数、Provider 呼び出し回数、BrowserUse 接続時間、実行時間を保存するため、外部の token 単価と組み合わせて 1 件原価を概算できる。今後は、全投入件数と `sent` 件数の両方を分母にして原価を計測する。

## PoC 計画と進捗

### フェーズ 1: production / 1 並列

完了済み:

- [x] D1 の条件付き更新で実行権・送信権を制御する。
- [x] Queue の重複配信で二重実行しないことをテストする。
- [x] Worker から Responses API と BrowserUse を利用する実装へ変更する。
- [x] 対象ドメイン、tool、Provider、token、呼び出し回数を制限する。
- [x] 旧 Sandbox 構成で実 Queue / D1 / OpenAI / BrowserUse の送信なし E2E を実行する。
- [x] 旧 E2E 後に Worker、Container、BrowserUse session が残らないことを確認する。
- [x] production Worker へ Secrets、公開 URL、Queue consumer を設定する。
- [x] Worker 直実行構成で AnyReach の送信なし E2E を実行する。
- [x] production送信なしE2Eの成功条件を1 attemptに限定する。
- [x] retryのreason code、発生元、attempt、実行時間、Provider呼び出し累計をD1イベントへ保存する。
- [x] `DRY_RUN_COMPLETE`の前提として入力成功とnative form validityを検証する。
- [x] `fill` / `select`の入力値を`payload.formValues`由来に限定する。
- [x] 実サイトの必須 select / radio / checkbox へ、登録者が許可した選択肢候補リストで対応する。
- [x] 起動時の読み込み待ちを 25 秒へ延ばし、`PAGE_NOT_READY`を 1 回だけ再試行する。
- [x] production から旧 Sandbox Durable Object を削除する。
- [x] CI で typecheck、lint、unit / Workers test、deploy dry-run を実行する。
- [x] 使い捨てサイトでproduction実送信E2Eを3件実行し、`submitting`から`sent`、受信POST、送信ログを照合する。
- [x] Queue重複配送時に実POSTが1回だけであることをproductionで検証する。
- [x] 送信後に完了確認できない場合に`uncertain`となり、自動再送しないことをproductionで検証する。
- [x] `submitting` / `uncertain` / DLQの照合と緊急停止・安全な再開のrunbookを作る。
- [x] 常設の管理下テストシステムをproductionへ配備し、送信11件・送信禁止2件を1 attemptで検証する。
- [x] 標準POST、GET、multipart、Ajax、controlled input、multi-step、open / closed Shadow DOM、外部host iframe、画面外submit、サイト内別ページを管理下サイトで検証する。
- [x] 送信禁止時のreason codeを正規化し、メールのみのページと営業利用禁止フォームで受信0件を確認する。

未完了:

- [x] 認証付きジョブ登録・取得 API を実装する。
- [ ] `submitting` 中にWorkerを強制停止し、状態が`submitting`のまま残って再配信でも送信されないことを検証する。
- [ ] 状態遷移、理由、時間、token、BrowserUse 待ち時間を記録する。
- [x] Cloudflare 上で 5 並列を実行し、BrowserUse の同時 session 上限（429）を観測した。原価の計測は未実施。

### フェーズ 2: 5 並列

- [x] 5 並列で二重実行なし、BrowserUse session の明示停止、作成 API の 429 を確認した。3 並列で 429 が消えることを確認し、consumer を 3 とした。原価の計測は未実施。
- [x] `max_concurrency`を観測結果に基づいて1から5へ引き上げ、429 の観測により 3 へ戻す。

### フェーズ 3: 20 並列

- [ ] Queue の backpressure と retry を検証する。
- [ ] OpenAI / BrowserUse の 429、503、timeout を観測する。
- [ ] 20 並列で指数 backoff、jitter、DLQ 再登録を検証する（実装と runbook 手順は完了）。
- [ ] 実 form の互換性と未対応パターンを分類する。
- [ ] メトリクスの欠損とイベント量を確認する。

### フェーズ 4: 50 並列

- [ ] 連続投入時の安定性とスループットを確認する。
- [ ] 同時実行上限、rate limit、接続待ちから安全な運用値を決める。
- [ ] Provider、model の構成別に 1 件原価を比較する。

並列数を引き上げる条件は、重大な二重送信がなく、`uncertain` と失敗原因を追跡でき、直前フェーズの rate limit と原価が許容範囲に収まることである。

## 残タスク・未決事項

### 実装

- 利用者別の認証・権限管理と、ジョブ一覧・キャンセル API。
- 実Workerを`submitting`中に停止した場合の検証。Workers テストで「再配信は ack され、状態は `submitting` のまま、`job.redelivery_ignored` が記録される」経路は固定済みであり、実機での強制停止確認だけが残る。
- 禁止判定の固定パターンを実サイトの表現へ合わせて拡張し、誤検出と未検出を監査する仕組み。
- 観察済みリンク自体がGET型副作用を持つサイトの識別またはサイト単位の許可方式。
- 全状態遷移の observability（tool、token、時間は `agent.tool_diagnostic` と `agent.run_metrics` で記録済み）。
- `submitting` / `uncertain` の照合を支援する専用 API / UI。
- 実 form のcross-origin iframe、確認画面、複数ページ、Shadow DOM互換性検証と、添付・CAPTCHAの対応方針。
- Shadow DOM 内の禁止文言を含む可視テキストの収集。
- SPA の遅延描画で無関係なbuttonだけが先に現れる場合のフォーム探索再試行。
- CSVから抽出した外部form hostをジョブ単位の完全一致allowlistへ安全に反映する運用検証。
- Provider abstraction と fallback。
- 外部 API E2E は GitHub Actions の通常 CI に含めず、手動実行に限定する。
- Worker の `outcome: exceededCpu` の原因特定。報告 `cpuTime` 165 ms に対して強制終了しているため、CPU 上限の引き上げでは説明できない。Workers Logs の保持期間が Free プランで 3 日であるため、再発時は 3 日以内に調査する。3 件とも `before_submit` の撮影完了直後から送信前レビューの Provider 呼び出しまでの区間で発生している。疑わしいのはスクリーンショットの base64 化とリクエスト構築であるため、`submit_review_request_built` と `submission_evidence_timing` の計測を追加し、base64 化は 8 KiB チャンクごとの一括変換に変更した。次の再発時はこの 2 つのログで切り分ける。3 件目は 2026-09-03 の 3 並列計測 3 回目で、`native-get` の Worker が報告 `cpuTime` 172 ms、`wallTime` 55 秒で強制終了し、ジョブは送信権取得後・activation 前の `submitting` で停止した。Queue の再配信は `job.redelivery_ignored` で ack され自動再送は起きず、テストシステム側の受信 0 件と `after_submit` 証跡なしを照合したうえで、runbook の手順で人手により `uncertain`（`OPERATOR_CONFIRMED_UNCERTAIN`）へ確定した。
- 並列時に `multi-step` で毎回発生する turn 6 `click` の CDP コマンド失敗（3 並列でも再現、受信 0）。click / fill / select 中の CDP コマンド失敗を要素エラーへ変換する対応は実装済みであり、3 並列 3 回の実行で `multi-step` が続行して `sent` になることの確認が残る。`external-iframe` の送信後読み取り失敗は明示停止後の再計測では再現しなかった。
- `external-iframe-tertiary` で、モデルが観察本文から禁止を読み取っているのに信頼済み handler の禁止根拠検証（iframe 親ページ側の近接要素）が通らず `FINISH_PROHIBITION_NOT_VERIFIED` になり、`uncertain` で終了した例が 1 件（4 回中）。`validateProhibited` の 1 回限りの再観察は実装済みであり、3 並列 3 回の実行で `FINISH_PROHIBITION_NOT_VERIFIED` が減ることの確認が残る。残る場合は診断とともに記録する。
- 禁止フォームの submit を信頼済み handler がブロックした後、モデルが `finish_prohibited` ではなく `finish_failed` を選ぶ（`external-iframe-secondary`、3 回中 2 回）。`SUBMIT_PROHIBITED` への分離と guidance、system prompt への追記は実装済みであり、`external-iframe-secondary` が `prohibited` で終わることの確認が残る。
- BrowserUse のプランと同時 session 上限をダッシュボードで確認する。3 並列で 429 が消えることは 19 シナリオで確認済み。並列数を上げる場合は Pay as you go（同時 10）へ変更してから再計測する。
- R2 アップロード前に `evidence.intent` を記録するため、Worker が途中で停止した孤児オブジェクトは `type = 'evidence.intent'` の残存行から特定できる。残存行の定期確認と削除は runbook の手作業であり、自動化と保存期間ポリシーは未決である。
- 送信前レビューの残存リスク対応: `dom` activation で照合と `requestSubmit` を同一 JS 実行内で行い、`mouse` / `enter` は activation 直前に再照合する。snapshot に禁止文言・label・option・action / method を含める。修正の証明を変更したコントロールの value / checked 差分に限定する。form 再探索の切り詰めを検出して fail-closed にする。いずれも管理下テストシステムでの E2E と併せて実施する。
- `agent.run_metrics` の `durationMs` と Workers Logs の `wallTime` を突き合わせられるようになったが、`outcome: exceededCpu` の原因特定自体は未着手である。

### 運用・ポリシー

- 営業禁止判定の基準、根拠保存、監査方法。
- 個人情報、送信本文、ログ、DOM snapshot、証跡スクリーンショットの保存期間とマスキング方針。
- 対象サイトの利用規約、適用法令、社内ルールの確認手順。
- 実送信を許可する対象、承認者、件数上限、緊急停止条件。
- BrowserUse の session 上限、rate limit、保持期間、課金単位。
- OpenAI 以外の Provider を採用するか。

## 決定事項の要約

- ジョブ配送、retry、DLQ には Cloudflare Queue を使う。
- 状態と結果は Cloudflare D1 に保存する。
- 1 ジョブを 1 社に限定し、Worker から OpenAI Responses API の function calling を直接実行する。
- 現在の推論 Provider は OpenAI とし、認証情報と制限は Worker 側で管理する。
- BrowserUse Agent は使わず、standalone browser へ CDP 接続する。
- Agent には用途限定 browser tool だけを公開し、`submit` を独立した制御対象にする。
- `submit` の直前に、agent とは独立したレビューを 1 回通し、`allow` 以外では送信権を取得しない。修正を許可するのは `INPUT_MISMATCH` の 1 回目の deny だけとし、観察指紋が変わる実際の入力変更を必須にする。2 回目の deny と修正不能な deny は `uncertain` とする。
- 送信前レビューの審査と証跡の設計は OpenAI Codex の `node_repl_policy.md` と `node_repl_review_evidence.rs` を参考にした。
- exactly-once を仮定せず、`jobId`、`runToken`、D1 の条件付き状態遷移で二重送信を防ぐ。
- 送信権取得後に結果を確定できない場合は `uncertain` とし、自動 retry しない。
- 本番処理は Cloudflare 上へ置き、手元 PC は開発・検証にだけ使う。
- 5、20、50 並列の順に検証し、安全性、成功率、時間、rate limit、原価を確認してから引き上げる。
- 送信前 / 送信後 / 禁止判定時の 3 段階でスクリーンショットを撮影し、Cloudflare R2 へ sha256 付きで保存し、D1 の `events` から参照する。dry-run の `submit` 経路では撮影しない。保存期間は運用ポリシー確定まで無期限とする。
