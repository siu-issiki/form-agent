# フォーム営業自動化アーキテクチャ

- ステータス: PoC 実装中（単一ジョブの送信なし E2E 完了）
- 最終更新: 2026-09-01
- 対象: `siu-issiki/form-agent`

## 目的

企業の問い合わせフォームへの営業送信を、手元 PC の CPU・RAM に依存せず、安全かつ段階的に並列化できるクラウド実行基盤を構築する。

対象企業ごとに異なるフォームの構造や項目の意味を LLM / Agent が理解し、営業禁止判定、フォーム発見、入力、送信、結果記録までを一貫して処理する。一方で、フォーム送信は外部サイトへの不可逆な副作用であるため、二重送信や意図しない操作を防ぐ状態遷移と実行境界をエージェントの外側で強制する。

## 現在地

| 領域 | 状態 | 現在の到達点 |
| --- | --- | --- |
| ジョブ状態管理 | 実装済み | D1 の条件付き更新と `runToken` で実行権・送信権を制御 |
| Queue / DLQ | 実装済み | ローカル Queue、retry、DLQ、重複配信テスト |
| Agent 実行 | 実装済み | Cloudflare Sandbox 上で Pi 0.74.0 を実行 |
| 推論 Provider | 部分実装 | OpenAI API のみ。モデル、回数、本文、出力 token を Worker 側で制限 |
| BrowserUse | 実装済み | standalone browser へ CDP 接続し、用途限定ツールだけを公開 |
| E2E | 部分実装 | 実 Queue / D1 / Sandbox / Pi / OpenAI / BrowserUse の送信なし E2E 成功 |
| HTTP API | 未実装 | 本番 Worker は `GET /health` のみ。ジョブ登録関数は内部実装済み |
| Cloudflare 配備 | 未実施 | ローカル設定のみ。staging / production の Worker、D1、Queue は未作成 |
| 監査・メトリクス | 部分実装 | Provider 呼び出し回数と DLQ イベントのみ |
| 並列検証 | 未実施 | `max_concurrency: 5` は設定済みだが、Cloudflare 上の 5 並列は未検証 |

本書では、実装済みの構成を現在形で記述し、未実装または未検証の内容は「現在の制約」「PoC 計画」「残タスク・未決事項」に明示する。

## 背景

問い合わせフォームはサイトごとに DOM、ラベル、選択肢、必須項目、禁止事項が異なる。この差異を企業ごとのルールやセレクタとして保守する方式は、対象数が増えるほど更新コストが高くなる。

そのため、フォームマッピングをルールベースで網羅せず、LLM / Agent による画面と項目の意味理解を中心に据える。Agent loop は自作せず、現在の PoC では Pi 0.74.0 を採用している。

ブラウザは実行コンテナ内で Chromium を起動せず、BrowserUse Cloud Browser を利用する。BrowserUse Agent は採用せず、standalone browser の CDP 接続だけを利用する。これにより、ローカル PC や Cloudflare 上の各エージェントが Chromium の RAM を保持する構成を避ける。

## 現行の全体構成

```text
ジョブ登録関数
（認証付き HTTP API / バッチは未実装）
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
Cloudflare Sandbox Durable Object / Container
  1 ジョブ = 1 Sandbox = 1 Pi 実行
  ┌─────────────────────────────────────────────┐
  │ Pi 0.74.0                                  │
  │  ├─ Worker 管理の OpenAI proxy             │
  │  └─ 用途限定 browser tools                 │
  │       └─ 信頼済み handler                  │
  │            └─ BrowserUse CDP ──► 対象企業  │
  └─────────────────────────────────────────────┘
        │
        │ 状態・結果・Provider 呼び出し回数
        ▼
Cloudflare D1
  ├─ jobs
  ├─ results
  └─ events（現在は DLQ イベントのみ）
```

PoC のローカル実行では Wrangler / Miniflare 上の D1 と Queue、ローカル Container、外部の OpenAI / BrowserUse を組み合わせる。本番構成は Cloudflare 上で完結させる方針だが、staging / production への配備はまだ行っていない。

## コンポーネント責務

### Cloudflare Worker / Queue Consumer

- ジョブ登録時に D1 へ `pending` を作成し、Queue へ `jobId` を登録する。
- Queue の at-least-once 配信を前提に、D1 の条件付き更新で実行権を 1 つの Consumer だけに与える。
- Agent の構造化結果を D1 の終端状態へ反映する。
- 再試行可能な失敗は Queue retry、再試行上限超過は DLQ へ送る。
- executor 設定が不足している場合は `EXECUTOR_NOT_CONFIGURED` で fail-closed に終了する。

現在の Queue 設定は次のとおり。

| 設定 | 値 |
| --- | --- |
| batch size | 1 |
| max retries | 3 |
| retry delay | 30 秒固定（Worker 実装） |
| dead letter queue | `form-agent-jobs-dlq` |
| max concurrency | 5（ローカル Wrangler では再現されない） |

### Cloudflare Sandbox / Container

- Queue から受け取った 1 ジョブに、隔離された Agent 実行環境を提供する。
- Sandbox には Pi runner とジョブ入力だけを渡し、D1、Queue、OpenAI、BrowserUse の認証情報は渡さない。
- 外向き通信は内部 tool host と OpenAI API だけを許可し、HTTPS interception を必須とする。
- OpenAI と browser tool の実処理は Worker / Durable Object の信頼済み handler で行う。
- Agent 終了時に browser 接続を閉じ、Sandbox を破棄する。

PoC は Cloudflare Sandbox SDK 1.0 preview を採用している。正式採用は、起動時間、同時実行、運用性、料金、preview 依存リスクを確認して決める。

### Pi

- Agent loop、推論、tool call の制御を担う。
- 1 回の実行で 1 社だけを処理する。
- 最大 12 turn、ジョブ prompt 最大 64,000 文字とする。
- `sent` / `prohibited` / `uncertain` / `failed` の構造化結果だけを返す。
- ジョブ入力にない個人情報・企業情報を推測して入力しない。

### 推論 Provider

現在は OpenAI API のみ対応する。Sandbox からのリクエストを Worker の outbound handler で検査し、次を強制する。

- 設定されたモデルと一致すること。
- Responses API または Chat Completions API だけを利用すること。
- function tool 以外を渡さないこと。
- 1 run の Provider 呼び出しを最大 16 回に制限すること。
- 出力 token を最大 4,096 に制限すること。
- request body を最大 128 KiB に制限すること。
- OpenAI API key を Sandbox へ公開しないこと。

DeepSeek / Fireworks 等への切り替え、Provider fallback、品質・レイテンシ・料金比較は未実装である。

### BrowserUse Cloud Browser

- BrowserUse Agent ではなく、standalone browser へ CDP 接続する。
- BrowserUse API key と CDP URL は Sandbox / Pi へ渡さない。
- 1 ジョブにつき 1 browser session とし、終了時に接続を閉じる。
- proxy country は `jp`、session timeout は 15 分とする。
- popup、Worker、Service Worker、WebSocket 等の迂回経路を遮断する。

### 制限付き browser tool

Pi に汎用 JavaScript や CDP を公開せず、次の用途限定 tool だけを提供する。

| tool | 責務 |
| --- | --- |
| `navigate` | 許可された対象企業ドメイン内のページへ移動する |
| `observe` | 現在ページのフォーム、ラベル、選択肢、禁止事項を取得する |
| `click` | 非 submit 要素だけをクリックする |
| `fill` | text input / textarea へ値を入力する |
| `select` | select / radio / checkbox を選択する |
| `submit` | D1 の送信権取得後に 1 回だけ送信する |
| `finish` | 送信せず、構造化された終端結果を返す |

通常の `click` では submit control を操作できない。`submit` は対象要素を検証してから D1 を `running` から `submitting` へ更新し、最初の unsafe request だけを許可する。

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
4. Pi は対象ドメイン内でフォームを探し、営業禁止・用途制限を確認する。
5. 禁止または対象フォームなしの場合は送信せず、`prohibited` または `uncertain` を返す。
6. フォーム項目を観察し、ジョブ入力に存在する値だけを入力する。
7. 送信前に対象、禁止事項、入力値、必須項目、送信回数を再確認する。
8. D1 を `running` から `submitting` へ原子的に更新できた場合だけ `submit` を許可する。
9. 送信完了を確認できた場合は `sent` を保存する。
10. 送信後に結果を確認できない場合は `uncertain` とし、自動 retry を止める。
11. retry しない終端結果を D1 に保存し、browser と Sandbox を終了する。

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

`prohibited` と `uncertain` は自動 retry しない。retryable error は `failed` を保存せず、`running` と同じ `runToken` を維持したまま Queue の再配信を待つ。`submitting` または `sent` を受け取った Consumer は送信を再実行しない。

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

現在保存するイベントは `job.dead_lettered` だけである。

## 安全設計 / 冪等性

Cloudflare Queue はメッセージを複数回配信し得るため、処理全体を exactly-once と仮定しない。外部フォーム側には一般に idempotency key を渡せないため、送信処理は自動復旧より二重送信防止を優先する。

- すべての処理を一意な `jobId` に紐付ける。
- Consumer は D1 の条件付き更新で実行権を 1 つの `runToken` だけに与える。
- 送信直前に `running` から `submitting` への条件付き更新を行う。
- `submitting` または `sent` のジョブは自動送信しない。
- 送信後に応答を取得できない場合は `uncertain` として自動 retry を止める。
- `submit` は 1 ジョブにつき 1 回に制限し、通常の `click` で代替できないようにする。
- HTTP(S) の通信先を対象企業の登録可能ドメインとサブドメインに限定する。
- unsafe request は送信権取得後の最初の 1 回だけ許可する。
- popup、Worker、Service Worker、WebSocket、WebRTC 等の迂回経路を遮断する。
- Provider / BrowserUse の認証情報と D1 の実行権を Sandbox へ渡さない。
- Agent に返すジョブ情報から `runToken` を除外する。
- 営業禁止の記述や同意できない規約がある場合は送信しない。
- ジョブ間で browser session、cookie、入力データを共有しない。

`submitting` 中に Worker が停止し、結果保存まで到達しなかった場合は自動再送せず、人間の確認対象にする。現在は人手照合の API / UI / runbook が未実装である。

## 現在の制約

### Browser / form 対応

- 対象企業ドメイン外の CDN、API、外部 form action も遮断するため、外部 SaaS を利用するフォームは動かない可能性がある。
- `document.forms` 配下の可視 `input` / `textarea` / `select` / `button` だけを観察する。
- 観察対象は最大 10 form、合計 100 field、本文 20,000 文字までとする。
- iframe、Shadow DOM、contenteditable、独自 UI component は未対応である。
- popup、別 tab、Service Worker を利用するフォームは未対応である。
- 確認画面、複数ページフォーム、ファイル添付、CAPTCHA は未対応である。
- 送信完了は、送信前にはなかった日本語の送信完了表現または `thank you` が 5 秒以内に出現した場合だけ確定する。

### API / 運用

- 本番 Worker の HTTP endpoint は `GET /health` だけである。
- 認証付きジョブ登録、取得、一覧、キャンセル API は未実装である。
- `submitting` / `uncertain` の照合、DLQ の確認・再投入、緊急停止の運用機能は未実装である。
- payload、理由、ログ、DOM snapshot の保存期間・マスキング方針は未決定である。

### Provider / observability

- Provider は OpenAI 固定である。
- Provider 呼び出し回数以外の token、時間、rate limit、費用を保存しない。
- 状態遷移と browser tool の監査イベントを保存しない。
- retry delay は 30 秒固定で、指数 backoff と jitter は未実装である。

## 並列・リトライ方針

PoC は 5 並列から開始し、観測結果をもとに 20、50 へ段階的に引き上げる。設定値だけで並列対応済みとせず、Cloudflare 上での実測を完了条件とする。

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
3. Cloudflare Sandbox / Container の CPU、メモリ、実行時間
4. Queue、D1、ログ・イベント保存

現時点で記録しているのは Provider 呼び出し回数だけであり、1 件原価は算出できない。今後は、全投入件数と `sent` 件数の両方を分母にして原価を計測する。

## PoC 計画と進捗

### フェーズ 1: staging / 5 並列

完了済み:

- [x] D1 の条件付き更新で実行権・送信権を制御する。
- [x] Queue の重複配信で二重実行しないことをテストする。
- [x] Sandbox 上の Pi から OpenAI と BrowserUse を利用する。
- [x] 対象ドメイン、tool、Provider、token、呼び出し回数を制限する。
- [x] 実 Queue / D1 / Sandbox / Pi / OpenAI / BrowserUse の送信なし E2E を実行する。
- [x] E2E 後に Worker、Container、BrowserUse session が残らないことを確認する。

未完了:

- [ ] 認証付きジョブ登録・取得 API を実装する。
- [ ] staging の D1、Queue、DLQ、Secrets、Worker を作成する。
- [ ] 管理下のテストフォームで `submitting` から `sent` まで検証する。
- [ ] Queue 重複配信時に実 POST が 1 回だけであることを検証する。
- [ ] `submitting` 中断時に `uncertain` となり再送しないことを検証する。
- [ ] 状態遷移、理由、時間、token、BrowserUse 待ち時間を記録する。
- [ ] `submitting` / `uncertain` / DLQ の人手確認手順を作る。
- [ ] Cloudflare 上で送信なし 5 並列を実行し、rate limit と原価を計測する。
- [ ] CI で typecheck、lint、unit / Workers test、deploy dry-run を実行する。

### フェーズ 2: 20 並列

- [ ] Queue の backpressure と retry を検証する。
- [ ] OpenAI / BrowserUse の 429、503、timeout を観測する。
- [ ] 指数 backoff、jitter、DLQ 再投入を実装・検証する。
- [ ] 実 form の互換性と未対応パターンを分類する。
- [ ] メトリクスの欠損とイベント量を確認する。

### フェーズ 3: 50 並列

- [ ] 連続投入時の安定性とスループットを確認する。
- [ ] 同時実行上限、rate limit、接続待ちから安全な運用値を決める。
- [ ] Provider、model、Sandbox / Container の構成別に 1 件原価を比較する。

並列数を引き上げる条件は、重大な二重送信がなく、`uncertain` と失敗原因を追跡でき、直前フェーズの rate limit と原価が許容範囲に収まることである。

## 残タスク・未決事項

### 実装

- 認証付きジョブ登録・取得・一覧・キャンセル API。
- staging / production の Cloudflare resource と環境分離。
- 管理下テストフォームを使う実送信 E2E。
- 状態遷移、tool、token、時間、費用の observability。
- `submitting` / `uncertain` の照合、DLQ 再投入、緊急停止の運用機能。
- 実 form の iframe、Shadow DOM、確認画面、複数ページ、添付、CAPTCHA 対応方針。
- 外部 CDN / API / form action を許可する場合の安全な allowlist 設計。
- Provider abstraction と fallback。
- GitHub Actions による CI。外部 API E2E は手動実行に限定する。

### 運用・ポリシー

- 営業禁止判定の基準、根拠保存、監査方法。
- 個人情報、送信本文、ログ、DOM snapshot の保存期間とマスキング方針。
- 対象サイトの利用規約、適用法令、社内ルールの確認手順。
- 実送信を許可する対象、承認者、件数上限、緊急停止条件。
- BrowserUse の session 上限、rate limit、保持期間、課金単位。
- Cloudflare Sandbox preview を正式採用するか、Containers を直接使うか。
- OpenAI 以外の Provider を採用するか。

## 決定事項の要約

- ジョブ配送、retry、DLQ には Cloudflare Queue を使う。
- 状態と結果は Cloudflare D1 に保存する。
- 1 ジョブを 1 社に限定し、PoC は Cloudflare Sandbox で Pi 0.74.0 を実行する。
- 現在の推論 Provider は OpenAI とし、認証情報と制限は Worker 側で管理する。
- BrowserUse Agent は使わず、standalone browser へ CDP 接続する。
- Agent には用途限定 browser tool だけを公開し、`submit` を独立した制御対象にする。
- exactly-once を仮定せず、`jobId`、`runToken`、D1 の条件付き状態遷移で二重送信を防ぐ。
- 送信権取得後に結果を確定できない場合は `uncertain` とし、自動 retry しない。
- 本番処理は Cloudflare 上へ置き、手元 PC は開発・検証にだけ使う。
- 5、20、50 並列の順に検証し、安全性、成功率、時間、rate limit、原価を確認してから引き上げる。
