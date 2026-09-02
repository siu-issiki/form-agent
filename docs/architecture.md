# フォーム営業自動化アーキテクチャ

- ステータス: PoC 実装中（production実送信有効 / 管理下サイト実送信E2Eを整備中）
- 最終更新: 2026-09-02
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
| BrowserUse | 実装済み | standalone browser へ CDP 接続し、用途限定ツールだけを公開 |
| E2E | 部分実装 | AnyReach dry-runと使い捨てサイト実送信3件、重複配送、送信後`uncertain`をproductionで検証済み。実サイト送信は未実施 |
| HTTP API | 部分実装 | Bearer 認証付きのジョブ登録・取得を実装。登録時に`payload.formValues`のキーと値を検証。一覧・キャンセルは未実装 |
| Cloudflare 配備 | 実装済み | production の D1、Queue、DLQ、Worker、Secrets、公開 URL、Queue consumer を設定済み。旧 Sandbox Durable Object は削除済み |
| 監査・メトリクス | 部分実装 | Provider 呼び出し回数、retry / DLQ イベント |
| 並列検証 | 部分実施 | 安全確認中は `max_concurrency: 1`。Cloudflare 上の単一ジョブを検証済みで、5 並列以上は未検証 |

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
        │ 状態・結果・Provider 呼び出し回数
        ▼
Cloudflare D1
  ├─ jobs
  ├─ results
  └─ events（retry / DLQ イベント）
```

PoC のローカル実行では Wrangler / Miniflare 上の D1 と Queue、外部の OpenAI / BrowserUse を組み合わせる。本番は production 環境だけを対象とし、D1、Queue、DLQ、Worker、Secrets、公開 URL、Queue consumer を設定済みである。2026-09-02 に `https://anyreach.co.jp/contact` を対象とした production dry-run を実行し、`pending → running → prohibited`、`DRY_RUN_COMPLETE`、1 attempt、8 Provider requests、BrowserUse active session 0 件を確認した。`submitting` / `sent` には遷移しておらず、フォーム送信は行っていない。

同日に使い捨てWorkerだけを対象としたproduction実送信E2Eを実行した。独立した3ジョブはすべて`sent`、1 attempt、8 Provider requests、受信POST 1件、mouse activation、`requestObserved=true`、`hitTestAttempts=1`で完了した。同一IDをpause中に2回登録した重複配送試験も、API応答`201 → 200`、`sent`、1 attempt、受信POST 1件で完了した。完了表示を返さない送信先ではPOSTを1件受信した後に`uncertain`、`SUBMIT_RESULT_UNKNOWN`、1 attemptとなり、自動再送しないことを確認した。検証後はproductionを`AGENT_DRY_RUN=true`、`AGENT_MODEL=gpt-5.6-luna`へ戻し、main QueueとDLQのbacklog 0件、active job 0件を確認して使い捨てWorkerを削除した。

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
| retry delay | 30 秒固定（Worker 実装） |
| dead letter queue | `form-agent-jobs-dlq` |
| max concurrency | 1（ローカル Wrangler では再現されない） |

### Worker-native Agent executor

- Queue から受け取った 1 ジョブについて Responses API と browser tool の反復を制御する。
- 1 回の実行で 1 社だけを処理する。
- `parallel_tool_calls: false` と strict schema により、1 turn で最大 1 tool だけを処理する。
- `AGENT_DRY_RUN`とbooleanの`_formAgentDryRun`から実効モードをジョブ登録時に保存する。旧形式のジョブは常にdry-runとし、deployment切替で既存ジョブの意味を変えない。dry-runでは`submit`をモデルへ公開したまま、送信対象と同じフォームへの入力成功、現在のsubmit要素、`form.checkValidity()`の成功を実ブラウザで検証し、送信権取得とブラウザsubmitより前に`DRY_RUN_COMPLETE`で終了する。
- 最大 12 turn、ジョブ prompt 最大 64,000 文字とする。
- `sent` / `prohibited` / `uncertain` / `failed` の構造化結果だけを返す。
- Agent 終了時または timeout 時に browser 接続を閉じる。
- `fill` / `select`ではモデルに生の値を渡させず、`payload.formValues`内の`payloadKey`を指定させる。信頼済みhandlerがD1の保存値を解決し、存在しないキー、文字列以外、上限超過、空文字を拒否する。

### 推論 Provider

現在は OpenAI Responses API のみ対応する。Worker がリクエストを組み立て、次を強制する。

- 設定されたモデルと一致すること。
- Responses API だけを利用すること。
- function tool 以外を渡さないこと。
- 1 run の Provider 呼び出しを最大 16 回に制限すること。
- 出力 token を最大 4,096 に制限すること。
- request body を最大 128 KiB に制限すること。
- response body を最大 256 KiB に制限すること。
- OpenAI API key、BrowserUse API key、`runToken` をモデル入力へ含めないこと。

DeepSeek / Fireworks 等への切り替え、Provider fallback、品質・レイテンシ・料金比較は未実装である。

### BrowserUse Cloud Browser

- BrowserUse Agent ではなく、standalone browser へ CDP 接続する。
- BrowserUse API key と CDP URL はモデルへ渡さない。
- 1 試行につき最大 1 browser session とし、終了時に接続を閉じる。Queue retry では同じジョブに対して新しい Agent 実行と session を開始する。
- proxy country は `jp`、session timeout は 15 分とする。
- popup、Worker、Service Worker、WebSocket 等の迂回経路を遮断する。
- CDP の `DOM.getDocument` を `pierce: true` で取得し、通常 DOM と open / closed Shadow DOM を Worker 側で走査する。
- CDP の単一 response は 4 MiB を上限とし、超過時は再試行せず `BROWSER_PAYLOAD_TOO_LARGE` で終了する。

### 制限付き browser tool

モデルに汎用 JavaScript や CDP を公開せず、次の用途限定 tool だけを提供する。

| tool | 責務 |
| --- | --- |
| `navigate` | 許可された対象企業ドメイン内のページへ移動する |
| `observe` | 現在ページのフォーム、ラベル、選択肢、禁止事項を取得する |
| `click` | 非 submit 要素だけをクリックする |
| `fill` | text input / textarea へ値を入力する |
| `select` | select / radio / checkbox を選択する |
| `submit` | D1 の送信権取得後に 1 回だけ送信する |
| `finish` | 送信せず、構造化された終端結果を返す |

driver が submit control と識別した要素は通常の `click` で操作できない。`submit` は対象要素を検証してから D1 を `running` から `submitting` へ更新し、最初の非safe HTTP methodだけを許可する。mouse activationのhit testは1 animation frameごとに最大3回行い、成功時の試行回数を`browser_submit_activation.hitTestAttempts`へ記録する。同一ドメインの GET 型副作用はこの制御の対象外である。

### Cloudflare D1

- ジョブの現在状態と実行権を保持する。
- 最終結果を 1 ジョブ 1 件で保存する。
- Provider 呼び出し回数を D1 の条件付き更新で制限する。
- DLQ 到達をイベントとして記録する。

状態遷移と結果保存は D1 session / batch と条件付き `UPDATE` を使う。監査・計測用イベントはテーブルだけ用意されており、状態遷移、tool 実行、token、処理時間の記録は未実装である。

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

現在保存するイベントは `job.retry_scheduled`、`job.dead_lettered`、`agent.tool_diagnostic` である。retry イベントにはreason code、発生元、attempt、実行時間、retry時点のProvider呼び出し累計を保存する。tool diagnosticにはturn、固定のtool名、処理stage、固定のresult codeだけを保存する。どのイベントにも秘密情報、URL、フォーム値、自由記述のエラー本文を含めない。

## 安全設計 / 冪等性

Cloudflare Queue はメッセージを複数回配信し得るため、処理全体を exactly-once と仮定しない。外部フォーム側には一般に idempotency key を渡せないため、送信処理は自動復旧より二重送信防止を優先する。

### 技術的に強制する境界

- すべての処理を一意な `jobId` に紐付ける。
- Consumer は D1 の条件付き更新で実行権を 1 つの `runToken` だけに与える。
- 送信直前に `running` から `submitting` への条件付き更新を行う。
- `submitting` または `sent` のジョブは自動送信しない。
- 送信後に応答を取得できない場合は `uncertain` として自動 retry を止める。
- driver が submit control と識別した要素は通常の `click` で操作させず、`submit` tool へ限定する。
- HTTP(S) の通信先を対象企業の登録可能ドメインとサブドメインに限定する。
- POST 等の非safe HTTP method は送信権取得後の最初の 1 回だけ許可する。
- popup、Worker、Service Worker、WebSocket、WebRTC 等の迂回経路を遮断する。
- Provider / BrowserUse の認証情報と D1 の実行権をモデル入力・tool 出力へ渡さない。
- Agent に返すジョブ情報から `runToken` を除外する。
- モデルが`fill` / `select`で指定できるのは`payload.formValues`内のキーだけとし、実際の値は信頼済みhandlerがD1から取得する。
- ジョブ間で browser session、cookie、入力データを共有しない。

`submitting` 中に Worker が停止し、結果保存まで到達しなかった場合は自動再送せず、人間の確認対象にする。人手照合、DLQ確認、緊急停止、安全な再開のrunbookは [operations.md](operations.md) に定義済みである。照合用の専用 API / UI は未実装である。

### Agent への安全指示

system prompt では、営業禁止・用途制限の確認と送信前の再観察を指示する。入力値は信頼済みhandlerが`payload.formValues`由来であることを機械的に強制する。一方、禁止判定の証跡と送信前確認の実施はまだAgentへの指示だけであり、ページ上のprompt injectionやAgentの誤判断に対する完全なハードガードではない。

## 現在の制約

### Browser / form 対応

- top-level navigation は対象企業ドメインとそのサブドメインだけを許可する。
- フォーム入力前に限り、公開 HTTPS host の read-only subresource（`GET` / `HEAD` / `OPTIONS`）を許可する。入力開始後は対象企業ドメイン外への通信を遮断する。
- CDP DOM tree から `form` と可視 `input` / `textarea` / `select` / `button` を観察し、`form` 属性による外部関連付けにも対応する。
- 探索上限は最大 25 form candidate、200 field candidate、モデルへ返す観察結果は最大 10 form、合計 100 field、本文 20,000 文字までとする。
- open / closed Shadow DOM は探索対象とする。ただし実サイトでの互換性検証は継続する。
- cross-origin iframe、contenteditable、独自 UI component は未対応または未検証である。
- popup、別 tab、Service Worker を利用するフォームは未対応である。
- 確認画面、複数ページフォーム、ファイル添付、CAPTCHA は未対応である。
- 送信完了は、送信前にはなかった日本語の送信完了表現または `thank you` が 5 秒以内に出現した場合だけ確定する。
- `GET` / `HEAD` / `OPTIONS` は送信権なしでも許可するため、同一ドメインの GET 型副作用 endpoint を通常の `click` や `navigate` で起動する経路は防止できない。
- 営業禁止判定と送信前確認はAgentへの指示であり、信頼済みhandlerでは未検証である。
- dry-runではジョブURLへのbootstrap後の再navigateと、最初のclick / fill / select以降に発生するbrowser requestをすべて遮断し、座標click前にCDPのhit targetが検証済み要素またはそのcomposed descendantであることを確認する。

### API / 運用

- Worker は認証不要の `GET /health`、Bearer 認証付きの `POST /jobs` と `GET /jobs/:id` を持つ。
- `JOB_API_TOKEN` は単一の共有 secret であり、利用者別の認証・権限・失効管理は行わない。
- ジョブ一覧、キャンセル API は未実装である。
- `submitting` / `uncertain` の照合、DLQ確認、緊急停止、安全な再開はrunbookで運用する。専用 API / UIと自動再投入は未実装であり、再実行時は既存ジョブを変更せず新しいジョブIDを使う。
- payload、理由、ログ、DOM snapshot の保存期間・マスキング方針は未決定である。

### Provider / observability

- Provider は OpenAI 固定である。
- Provider 呼び出し回数以外の token、時間、rate limit、費用を保存しない。
- 状態遷移と browser tool の監査イベントを保存しない。
- retry delay は 30 秒固定で、指数 backoff と jitter は未実装である。

## 並列・リトライ方針

PoC はまず 1 並列の production で開始し、管理下テストサイトへの実送信結果を観測してから 5、20、50 へ段階的に引き上げる。設定値だけで並列対応済みとせず、Cloudflare 上での実測を完了条件とする。

| 分類 | 例 | 現在の方針 |
| --- | --- | --- |
| 再試行可能 | Provider / BrowserUse の一時障害、timeout | `running` を維持し、30 秒後に Queue retry |
| 再試行不可 | 営業禁止、対象フォームなし、入力不足 | 終端結果として保存し、ack |
| 結果不明 | submit 後の timeout、完了確認不能 | `uncertain` として保存し、ack |
| retry 上限超過 | 一時障害の継続 | DLQ へ移動し、`dead_lettered` とイベントを保存 |

将来は一時障害を分類し、指数 backoff と jitter、設定可能な retry 回数、DLQ の人手確認・再投入を実装する。

## コスト / ボトルネック

主な変動費は次のとおり。

1. OpenAI の input / output token と呼び出し回数
2. BrowserUse Cloud Browser の session 時間、並列数、待ち時間
3. Cloudflare Worker、Queue、D1、ログ・イベント保存

現時点で記録しているのは Provider 呼び出し回数だけであり、1 件原価は算出できない。今後は、全投入件数と `sent` 件数の両方を分母にして原価を計測する。

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
- [x] production から旧 Sandbox Durable Object を削除する。
- [x] CI で typecheck、lint、unit / Workers test、deploy dry-run を実行する。
- [x] 使い捨てサイトでproduction実送信E2Eを3件実行し、`submitting`から`sent`、受信POST、送信ログを照合する。
- [x] Queue重複配送時に実POSTが1回だけであることをproductionで検証する。
- [x] 送信後に完了確認できない場合に`uncertain`となり、自動再送しないことをproductionで検証する。
- [x] `submitting` / `uncertain` / DLQの照合と緊急停止・安全な再開のrunbookを作る。

未完了:

- [x] 認証付きジョブ登録・取得 API を実装する。
- [ ] `submitting` 中にWorkerを強制停止し、状態が`submitting`のまま残って再配信でも送信されないことを検証する。
- [ ] 状態遷移、理由、時間、token、BrowserUse 待ち時間を記録する。
- [ ] productionで`hitTestAttempts=2`または`3`となる自然な再試行を観測する。
- [ ] Cloudflare 上で送信なし 5 並列を実行し、rate limit と原価を計測する。

### フェーズ 2: 5 並列

- [ ] 送信なし5並列で二重実行、rate limit、BrowserUse session、原価を計測する。
- [ ] `max_concurrency`を観測結果に基づいて1から5へ引き上げる。

### フェーズ 3: 20 並列

- [ ] Queue の backpressure と retry を検証する。
- [ ] OpenAI / BrowserUse の 429、503、timeout を観測する。
- [ ] 指数 backoff、jitter、DLQ 再投入を実装・検証する。
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
- 実Workerを`submitting`中に停止した場合に、`submitting`のまま再配信がackされ、再送されないことの検証。
- productionでhit testの2回目または3回目による回復を観測する。
- 禁止判定の証跡と送信前確認を信頼済みhandlerで検証する境界。
- 同一ドメインの GET 型副作用を submit gate 外から起動させない設計。
- 状態遷移、tool、token、時間、費用の observability。
- `submitting` / `uncertain` の照合を支援する専用 API / UI。
- 実 form の cross-origin iframe、確認画面、複数ページ、添付、CAPTCHA 対応方針と Shadow DOM の互換性検証。
- Shadow DOM 内の禁止文言を含む可視テキストの収集。
- SPA の遅延描画で無関係なbuttonだけが先に現れる場合のフォーム探索再試行。
- 外部 CDN / API / form action を許可する場合の安全な allowlist 設計。
- Provider abstraction と fallback。
- 外部 API E2E は GitHub Actions の通常 CI に含めず、手動実行に限定する。

### 運用・ポリシー

- 営業禁止判定の基準、根拠保存、監査方法。
- 個人情報、送信本文、ログ、DOM snapshot の保存期間とマスキング方針。
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
- exactly-once を仮定せず、`jobId`、`runToken`、D1 の条件付き状態遷移で二重送信を防ぐ。
- 送信権取得後に結果を確定できない場合は `uncertain` とし、自動 retry しない。
- 本番処理は Cloudflare 上へ置き、手元 PC は開発・検証にだけ使う。
- 5、20、50 並列の順に検証し、安全性、成功率、時間、rate limit、原価を確認してから引き上げる。
