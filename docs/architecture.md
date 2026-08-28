# フォーム営業自動化アーキテクチャ

- ステータス: Proposed
- 最終更新: 2026-08-22
- 対象: `siu-issiki/form-agent`

## 目的

企業の問い合わせフォームを利用した営業送信を、手元 PC の CPU・RAM に依存せず、安全かつ段階的に並列化できるクラウド実行基盤を構築する。

本システムは、対象企業ごとに異なるフォームの構造や項目の意味を LLM / Agent が理解し、営業禁止判定、フォーム発見、入力、送信、結果記録までを一貫して処理する。一方で、二重送信や意図しない操作を防ぐため、エージェントが利用できる操作と状態遷移は明示的に制限する。

## 背景

問い合わせフォームはサイトごとに DOM、ラベル、選択肢、必須項目、禁止事項が異なる。この差異を企業ごとのルールやセレクタとして保守する方式は、対象数が増えるほど更新コストが高くなる。

そのため、フォームマッピングをルールベースで網羅するのではなく、LLM / Agent による画面と項目の意味理解を中心に据える。ただし、自前の Agent loop を新規開発することは避け、既存のエージェントランタイムを利用する。第一候補は Pi とし、推論 Provider は実行基盤から分離して差し替え可能にする。

ブラウザは実行コンテナ内で Chromium を起動せず、BrowserUse Cloud Browser を利用する。BrowserUse Agent 自体は採用せず、ブラウザ実行環境のみを利用する。これにより、ローカル PC や Cloudflare 上の各エージェントが Chromium の RAM を抱える構成を避ける。

## 全体構成

```text
ジョブ登録 API / バッチ
        │
        ▼
Cloudflare Queue ───────────────► Dead Letter Queue
        │                           ▲
        │ dispatch / retry          │ retry 上限超過
        ▼                           │
Cloudflare Containers または Sandbox SDK
  1 ジョブ = 1 エージェント実行
  ┌──────────────────────────────────────────┐
  │ Pi                                      │
  │  ├─ 推論 Provider                       │
  │  │    DeepSeek V4 Flash                 │
  │  │    via Fireworks 等                  │
  │  ├─ 制限されたブラウザ操作ツール        │
  │  └─ BrowserUse Cloud Browser ──► 対象企業│
  └──────────────────────────────────────────┘
        │
        │ 状態・結果・イベント
        ▼
Cloudflare D1
  ├─ jobs
  ├─ results
  └─ events
```

本番では Cloudflare 上で完結する構成を第一候補とする。手元 PC は開発、検証、運用確認にのみ使用し、ジョブ実行時の計算資源には含めない。

PoC では、実装速度を優先して SQLite と薄い API を状態管理に利用してもよい。ただし、複数のクラウド実行環境から SQLite ファイルを直接共有しない。本番の Cloudflare 構成では D1 に移行する。

## コンポーネント責務

### Cloudflare Queue

- 企業単位のジョブを保持し、Consumer へ配信する。
- 最大並列数を制御し、下流への backpressure をかける。
- 一時的な失敗を再試行する。
- 規定回数を超えて失敗したジョブを DLQ に移す。
- メッセージの重複配信を前提とし、exactly-once を保証する場所とはみなさない。

### Cloudflare Containers / Sandbox SDK

- Queue から受け取った 1 件のジョブに対して、隔離されたエージェント実行環境を提供する。
- Pi、必要最小限のツール、ジョブ固有の入力だけを起動時に渡す。
- ブラウザ本体は保持せず、BrowserUse Cloud Browser に接続する。
- 処理終了後は構造化結果とイベントを保存し、実行環境を破棄または休止する。

PoC実装はCloudflare Sandbox SDK 1.0 previewを採用する。起動時間、実行時間上限、隔離、同時実行数、運用性、料金を計測し、正式採用はContainersとの比較後に決める。

### Pi

- エージェントランタイムの第一候補。
- 自前の Agent loop を避け、推論とツール呼び出しの制御を担う。
- Provider 固有 API を抽象化し、モデルや Provider を差し替え可能にする。
- 1 回の実行では 1 社だけを担当し、別企業へ遷移しない。

### 推論 Provider

- DeepSeek V4 Flash をモデル候補とする。
- Fireworks など、高速推論と大量並列に適した Provider の API を直接利用する。
- Provider の採用は、品質だけでなくレイテンシ、rate limit、429 / 503 の発生率、token 単価、同時実行制約で判断する。

### BrowserUse Cloud Browser

- リモート Chromium セッションを提供する。
- ページ遷移、DOM / 画面観察、入力、選択、クリック、送信を実行する。
- BrowserUse Agent は利用せず、Cloud Browser のみ利用する。
- セッションは原則としてジョブ単位で分離し、cookie や入力内容を他ジョブと共有しない。

### 制限付きツール層

エージェントに汎用的なブラウザ操作権限を与えず、次のような用途限定ツールを提供する。

| ツール | 責務 |
| --- | --- |
| `navigate` | 許可された対象企業ドメイン内のページへ移動する |
| `observe` | 現在ページのフォーム、ラベル、選択肢、禁止事項を取得する |
| `click` | 指定した要素をクリックする。送信操作は含めない |
| `fill` | テキスト系の入力欄へ値を設定する |
| `select` | dropdown、radio、checkbox の選択肢を設定する |
| `submit` | 送信前検証を通過したフォームを 1 回だけ送信する |
| `finish` | 構造化された最終結果を返して処理を終了する |

`submit` は通常の `click` から分離し、状態管理層による送信権の獲得後にだけ実行できるようにする。任意 JavaScript 実行、任意 URL への遷移、OS コマンド、認証情報の参照などは既定で許可しない。

### Cloudflare D1

- ジョブの現在状態を保持する。
- 最終結果を保存する。
- 監査、デバッグ、計測に必要なイベントを時系列で保存する。
- `jobId` と状態遷移を利用し、重複配信時の二重送信を防ぐ。

## ジョブライフサイクル

1. 対象企業、対象 URL、送信内容を含むジョブを作成し、D1 に `pending` として保存する。
2. `jobId` を含むメッセージを Cloudflare Queue に投入する。
3. Consumer は D1 の状態を確認し、実行権を獲得できた場合だけ `running` へ遷移する。
4. エージェントは対象企業の公式サイトだけを調査し、問い合わせフォームを発見する。
5. ページ上の営業禁止、売り込み禁止、用途制限などを確認する。
6. 営業送信が禁止されている場合は送信せず、`prohibited` を返す。
7. フォーム項目の意味を理解し、テキスト入力、dropdown、radio、checkbox を設定する。
8. 送信前に、対象企業、禁止事項、入力値、必須項目、送信回数を再確認する。
9. D1 上の状態を原子的に `submitting` へ遷移できた場合だけ `submit` を許可する。
10. 送信完了を確認し、`sent` と送信結果を保存する。
11. 判断不能なら `uncertain`、技術的失敗なら `failed` として、再試行可否を記録する。
12. 最終結果を返し、ブラウザセッションとエージェント実行を終了する。

主要な状態遷移は次の通りとする。

```text
pending ──► running ──► submitting ──► sent
                │              │
                ├──────────────┼─────► prohibited
                ├──────────────┼─────► uncertain
                └──────────────┴─────► failed ──► pending (retry)
                                              └─► dead_lettered
```

`prohibited` は禁止判定、`uncertain` は送信可否やフォーム解釈を安全に確定できない場合を表す。どちらも自動再試行によって送信へ進めない。`failed` のうち、一時的な通信障害など再試行可能と分類されたものだけを Queue retry の対象にする。

## データモデル案

### jobs

| 列 | 型の例 | 内容 |
| --- | --- | --- |
| `id` | TEXT PK | 一意な `jobId` |
| `company_id` | TEXT | 対象企業の識別子 |
| `company_name` | TEXT | 対象企業名 |
| `target_url` | TEXT | 調査開始 URL |
| `target_domain` | TEXT | 遷移を許可するドメイン |
| `payload_json` | TEXT | 送信者情報、本文などの入力 |
| `status` | TEXT | `pending` / `running` / `submitting` / `sent` / `prohibited` / `uncertain` / `failed` / `dead_lettered` |
| `attempt_count` | INTEGER | 実行試行回数 |
| `run_token` | TEXT NULL | 現在の実行権を識別する token |
| `provider_request_count` | INTEGER | 現在のrunが使用した推論Provider呼び出し回数 |
| `last_error_code` | TEXT NULL | 正規化した直近エラー |
| `created_at` | TEXT | 作成日時 |
| `updated_at` | TEXT | 更新日時 |

### results

| 列 | 型の例 | 内容 |
| --- | --- | --- |
| `job_id` | TEXT UNIQUE | `jobs.id` への参照。同一ジョブの最終結果は 1 件 |
| `outcome` | TEXT | `sent` / `prohibited` / `uncertain` / `failed` |
| `form_url` | TEXT NULL | 実際に処理したフォーム URL |
| `reason_code` | TEXT NULL | 禁止、判断不能、失敗理由の分類 |
| `reason` | TEXT NULL | 人間が確認できる説明 |
| `provider` | TEXT | 使用 Provider |
| `model` | TEXT | 使用モデル |
| `metrics_json` | TEXT | 時間、LLM 呼び出し、token、待ち時間など |
| `completed_at` | TEXT | 完了日時 |

### events

| 列 | 型の例 | 内容 |
| --- | --- | --- |
| `id` | TEXT PK | イベント ID |
| `job_id` | TEXT | `jobs.id` への参照 |
| `attempt` | INTEGER | 試行番号 |
| `type` | TEXT | 状態遷移、ツール実行、retry などの分類 |
| `data_json` | TEXT | 秘密情報を除いたイベント詳細 |
| `created_at` | TEXT | 発生日時 |

エージェントの最終出力例:

```json
{
  "jobId": "job-001",
  "outcome": "sent",
  "formUrl": "https://example.com/contact",
  "reasonCode": null,
  "reason": null,
  "metrics": {
    "durationMs": 48210,
    "llmCalls": 7,
    "inputTokens": 11200,
    "outputTokens": 940,
    "browserWaitMs": 6300
  }
}
```

## 安全設計 / 冪等性

Cloudflare Queue はメッセージを複数回配信し得るため、処理全体を exactly-once と仮定しない。特にフォーム送信は外部サイトへの不可逆な副作用であり、再試行による二重送信を防ぐ必要がある。

- すべての処理を一意な `jobId` に紐付ける。
- Consumer は条件付き更新で `pending` または再試行可能な `failed` から `running` への遷移権を 1 実行だけに与える。
- 送信直前に D1 の条件付き更新で `running` から `submitting` へ遷移する。
- `submitting` または `sent` のジョブを受け取った Consumer は自動送信を行わない。
- 送信後に応答を取得できず結果が不明な場合は、安全側に倒して `uncertain` とし、自動 retry しない。
- `submit` ツールはジョブにつき 1 回に制限し、送信ボタンの通常クリックでは代替できないようにする。
- 対象 URL と遷移先を対象企業の許可ドメインに制限する。
- 営業禁止の記述や同意できない規約がある場合は送信しない。
- 入力値、cookie、認証情報、ページ内容は必要最小限だけ記録し、ログに秘密情報や個人情報を残さない。
- ジョブ間でブラウザセッション、cookie、入力データを共有しない。

なお、外部フォーム側には一般に idempotency key を渡せない。したがって `submitting` 中のクラッシュは自動で再送せず、人間の確認対象にする。この状態を完全に自動復旧させることより、二重送信を避けることを優先する。

## 並列・リトライ

Queue Consumer の最大同時実行数を設定し、Provider、BrowserUse、D1、対象サイトへ過剰な負荷をかけない。PoC は 5 並列から開始し、観測結果をもとに 20、50 へ段階的に引き上げる。

再試行は次のように分類する。

| 分類 | 例 | 方針 |
| --- | --- | --- |
| 再試行可能 | Provider / BrowserUse の 429、503、一時的な timeout | 指数 backoff と jitter を付けて Queue retry |
| 再試行不可 | 営業禁止、対象フォームなし、必須情報不足 | 最終結果として保存し retry しない |
| 結果不明 | submit 後の timeout、完了画面を確認できない | `uncertain` とし、自動 retry しない |
| 恒久的な技術失敗 | 非対応 CAPTCHA、繰り返す解析失敗 | 上限到達後に DLQ |

retry 回数、遅延、同時実行数は設定値とする。一定回数を超えたジョブは DLQ に送り、原因、最終状態、試行回数を D1 に記録する。DLQ からの再投入は、人間が原因と二重送信リスクを確認した後に、新しい実行権を明示的に付与して行う。

## コスト / ボトルネック

主な変動費は次の通り。

1. LLM 推論の input / output token と呼び出し回数
2. BrowserUse Cloud Browser のセッション時間、並列数、待ち時間
3. Cloudflare Containers / Sandbox の CPU、メモリ、実行時間
4. Queue、D1、ログ・イベント保存

Chromium を BrowserUse 側に分離するため、Cloudflare のエージェント実行環境は Pi とツール制御に必要なリソースへ絞れる。想定される主要ボトルネックは、推論 Provider の rate limit、BrowserUse セッションの確保と操作待ち、対象サイトの応答、CAPTCHA である。Cloudflare 実行基盤の費用は計測対象に含めるが、事前に主要原価と決めつけない。

1 件原価は、成功件数だけでなく `prohibited`、`uncertain`、`failed` も含む全投入件数と、実際の `sent` 件数の両方を分母として算出する。

## PoC 計画

### フェーズ 1: 5 並列

- Queue から 1 社 1 ジョブで実行できることを確認する。
- Pi から Provider と BrowserUse Cloud Browser を操作する最小経路を作る。
- D1、または PoC 用 SQLite + API に状態と結果を保存する。
- 禁止、成功、判断不能、一時失敗の代表ケースを確認する。
- `submitting` を跨ぐ重複配信テストで二重送信が起きないことを確認する。

### フェーズ 2: 20 並列

- Queue の backpressure と retry を検証する。
- Provider / BrowserUse の 429、503、timeout を観測する。
- DLQ への移動と、人間による確認手順を検証する。
- メトリクスの欠損やイベント量を確認する。

### フェーズ 3: 50 並列

- 連続投入時の安定性とスループットを確認する。
- 同時実行上限、rate limit、接続待ちをもとに安全な運用値を決める。
- Provider、モデル、Container / Sandbox の構成別に 1 件原価を比較する。

各フェーズで最低限、次を計測する。

- `sent` / `prohibited` / `uncertain` / `failed` の件数と比率
- 送信対象に対する成功率
- 平均、中央値、p95 処理時間
- 1 ジョブあたりの LLM 呼び出し回数
- input / output token
- Provider と BrowserUse の 429 / 503 / timeout
- BrowserUse セッション確保時間と操作待ち時間
- retry 回数と DLQ 件数
- 全投入 1 件あたり、および送信成功 1 件あたりの原価

並列数を引き上げる条件は、重大な二重送信がなく、`uncertain` と失敗原因を追跡でき、直前フェーズの rate limit と原価が許容範囲に収まることとする。

## 未決事項

- Cloudflare Containers と Sandbox SDK のどちらを正式採用するか。
- Pi を Cloudflare 実行環境へ組み込む具体的なパッケージング方法。
- DeepSeek V4 Flash の利用 Provider と、品質・レイテンシ・料金比較。
- Provider 切り替えの抽象化範囲と fallback 方針。
- BrowserUse Cloud Browser のセッション上限、rate limit、保持期間、課金単位。
- Cloudflare Queue の retry 回数、backoff、最大同時実行数の初期値。
- D1 の条件付き更新と transaction を使った実行権・送信権の具体的な実装。
- `submitting` のまま停止したジョブを人間が照合する運用手順。
- CAPTCHA、ファイル添付、確認画面、複数ページフォームの対応範囲。
- 営業禁止判定の基準、根拠保存、監査方法。
- 個人情報、送信本文、スクリーンショット、DOM snapshot の保存期間とマスキング方針。
- 対象サイトの利用規約、適用法令、社内ルールに対する運用上の確認。
- Cloudflare、BrowserUse、各 Provider の本番導入時点における最新の制限・料金・利用条件。

## 決定事項の要約

- ジョブ配送、並列制御、retry、backpressure、DLQ には Cloudflare Queue を使う。
- 1 ジョブを 1 社に限定し、Cloudflare Containers または Sandbox SDK で 1 エージェントを実行する。
- Agent loop は自作せず Pi を第一候補とし、推論 Provider は差し替え可能にする。
- 推論は DeepSeek V4 Flash、Provider は Fireworks 等を候補とする。
- BrowserUse Agent は利用せず、BrowserUse Cloud Browser のみを利用する。
- フォームマッピングはルールベースで網羅せず、LLM / Agent の意味理解を中心にする。
- エージェントには用途限定ツールだけを与え、`submit` を独立した制御対象にする。
- 結果は `sent` / `prohibited` / `uncertain` / `failed` を中心とする構造化 JSON で返す。
- 本番の状態管理は D1 とし、PoC では SQLite + 薄い API を許容する。
- exactly-once を仮定せず、`jobId` と `pending` / `running` / `submitting` / `sent` の状態遷移で二重送信を防ぐ。
- 本番処理は完全にクラウドへ置き、手元 PC は開発時だけ利用する。
- 5、20、50 並列の順に検証し、成功率、時間、LLM 使用量、エラー、待ち時間、原価を計測する。
