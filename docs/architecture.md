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
| BrowserUse | 実装済み | standalone browser へ CDP 接続し、用途限定ツールだけを公開 |
| E2E | 管理下範囲を実装済み | 常設テストシステムの13シナリオ、重複配送、送信後`uncertain`をproductionで検証済み。外部の実サイト送信は未実施 |
| HTTP API | 部分実装 | Bearer 認証付きのジョブ登録・取得を実装。登録時に`payload.formValues`のキーと値を検証。一覧・キャンセルは未実装 |
| Cloudflare 配備 | 実装済み | production の D1、Queue、DLQ、Worker、Secrets、公開 URL、Queue consumer を設定済み。旧 Sandbox Durable Object は削除済み |
| 監査・メトリクス | 部分実装 | Provider 呼び出し回数、retry / DLQ、値を含まないagent tool診断イベント。送信前・送信後・禁止判定時のスクリーンショット証跡を Cloudflare R2 へ保存し、D1 の `events` へ sha256 付きで記録する |
| 並列検証 | 部分実施 | 2026-09-03 に 5 並列で管理下 12 シナリオを実行し 8 件合格。接続段階の `CDP_CONNECTION_CLOSED` が 10 秒間に 3 件発生したため、consumer を `max_concurrency: 10` とし、接続段階だけ再接続する |

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
| retry delay | 30 秒固定（Worker 実装） |
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
- `fill` / `select`ではモデルに生の値を渡させず、`payload.formValues`内の`payloadKey`を指定させる。信頼済みhandlerがD1の保存値を解決し、存在しないキー、文字列以外、上限超過、空文字を拒否する。

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
- 1 試行につき最大 1 browser session とし、終了時に接続を閉じる。Queue retry では同じジョブに対して新しい Agent 実行と session を開始する。
- proxy country は `jp`、session timeout は 15 分とする。CDP URL の `timeout=15` は session の寿命が 15 分であることを意味する。
- CDP WebSocket が自発的に閉じた場合、close code、reason（200 文字まで）、`wasClean`、未完了コマンド数を値を含めずに記録する。
- 接続確立（CDP 接続から初期化完了まで）が一過性の障害で失敗した場合だけ、10 秒 → 20 秒 → 30 秒の待機を挟んで最大 3 回再接続する。再試行は送信前の接続段階に限定し、フォームへの副作用はない。API key 不正や endpoint 不正のような恒久的な失敗は再試行しない。
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
| `select` | select / radio / checkbox を選択する |
| `submit` | 送信前に独立レビュー（同一 Provider、ツールなし、strict JSON）を通し、D1 の送信権取得後に 1 回だけ送信する。deny は 1 回だけ修正可、2 回目で `uncertain` |
| `finish` | 送信せず、構造化された終端結果を返す |

driver が submit control と識別した要素は通常の `click` で操作できない。非submitの`click`、`fill`、`select`はDOMイベントを発火する前にbrowser requestを遮断し、`navigate`は直前の観察で得たfragmentを含む完全一致URLのtop-frame Document requestだけを1回許可する。`submit` 中も遮断を解除せず、全入力が同じform ownerに属し、最後の入力・選択・click後に再観察され、選択したformに禁止根拠が検出されていないことを検証してから D1 を `running` から `submitting` へ更新し、最初の期待済み送信requestと、そのrequest IDに直接連なるsafeなredirectだけを許可する。非safe HTTP methodはaction URLとmethod、GETはactionのorigin / path、`Document` resource、送信対象frameを照合する。モデルはDOM activationを優先して選択し、trusted click gestureまたはkeyboard activationが必要な場合だけmouse / Enterを選ぶ。mouseのhit testは1 animation frameごとに最大3回試行する。

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

状態遷移と結果保存は D1 session / batch と条件付き `UPDATE` を使う。retry / DLQとagent tool診断はイベントへ保存するが、全状態遷移、token、全体処理時間、BrowserUse待ち時間、費用の記録は未実装である。

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

現在保存するイベントは `job.retry_scheduled`、`job.dead_lettered`、`agent.tool_diagnostic`、`evidence.captured`、`evidence.capture_failed` である。retry イベントにはreason code、発生元、attempt、実行時間、retry時点のProvider呼び出し累計を保存する。tool diagnosticにはturn、固定のtool名、処理stage、固定のresult codeだけを保存する。

`evidence.captured` の `data_json` は `{ stage, objectKey, sha256, byteLength, contentType: "image/jpeg" }` を保存する。`stage` は `before_submit` / `after_submit` / `prohibited` の固定値であり、`objectKey` は `jobId` / `stage` / `eventId` から機械的に組み立てた R2 オブジェクトキーである。`evidence.capture_failed` の `data_json` は `{ stage, failureCode }` を保存する。`failureCode` は `SCREENSHOT_FAILED` / `OBJECT_STORE_FAILED` / `EVENT_NOT_RECORDED` / `NO_BROWSER_SESSION` / `CAPTURE_TIMEOUT` の固定値である。

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
- モデルが`fill` / `select`で指定できるのは`payload.formValues`内のキーだけとし、実際の値は信頼済みhandlerがD1から取得する。
- `observe`の結果を`untrusted_page_content`として明示し、ページ本文が信頼済みhandlerの上限（20,000文字）で切り詰められた場合は`pageTextTruncated`で通知する。
- 送信直前に、直前の観察・`payload.formValues`・`before_submit`スクリーンショットを入力とする独立レビューを通し、`allow`以外では送信権を取得しない。
- レビューのdenyで修正を許可するのは`INPUT_MISMATCH`だけとし、実際の`fill` / `select`と観察指紋の変化を次の`submit`の前提にする。deny予算はD1のジョブ行に保存し、実行と再配信をまたいで共有する。
- レビューのallowから送信権取得までの間に、現在URLと観察済み全フィールドの値・チェック状態を読み直し、あわせてhidden / disabledを含むform全体のsnapshotをレビュー前後で比較し、1件でも異なれば送信しない。
- ジョブ間で browser session、cookie、入力データを共有しない。

`submitting` 中に Worker が停止し、結果保存まで到達しなかった場合は自動再送せず、人間の確認対象にする。人手照合、DLQ確認、緊急停止、安全な再開のrunbookは [operations.md](operations.md) に定義済みである。照合用の専用 API / UI は未実装である。

### Agent への安全指示

system prompt では、営業禁止・用途制限の確認と送信前の再観察を指示する。入力値は信頼済みhandlerが`payload.formValues`由来であることを強制する。`prohibited`は、直前かつ現在URLと一致する観察でフォーム不在、または全候補formについてform本文、前方の近接要素、祖先側の近接要素、iframe親ページ側の近接要素から固定パターンの営業禁止・用途制限を検出した場合だけ受理する。送信前には選択したformの禁止根拠、全入力のform owner、native validity、現在のaction / method、入力後の再観察、1回限りの送信権を機械的に検証する。さらに送信直前には、観察・信頼済み入力値・`before_submit`スクリーンショットを入力とする独立レビューを通し、`INPUT_MISMATCH` / `SALES_PROHIBITED` / `FORM_PURPOSE_INCOMPATIBLE` / `WRONG_FORM` / `UNCLEAR`のいずれかでdenyされた場合は送信権を取得しない。修正を許可するのは`INPUT_MISMATCH`だけで、実際の入力変更と再観察に加えて、観察指紋が変化していることを次の`submit`の前提にする。他のreason codeは1回目でも、`INPUT_MISMATCH`は2回目のdenyで`PRE_SUBMIT_REVIEW_DENIED`として`uncertain`で終了する。allow後・送信権取得前には現在URLと観察済み全フィールドの値・チェック状態を読み直し、さらにレビュー前後でhidden / disabledを含むform全体のsnapshotを比較し、レビュー中にページが変化していれば送信しない。レビューを完了できない場合はallowにせず、再試行可能な`SUBMIT_REVIEW_UNAVAILABLE`として扱う。禁止判定時と送信前後には画面のスクリーンショット証跡をR2へ保存する。`observe`の結果は外部サイト由来の非信頼データとして明示し、モデルとレビューの双方へページ内の指示に従わないよう指示する。固定パターンで表現されない禁止事項は独立レビューで補完するが、完全ではない。Shadow DOM内の本文とページ上のprompt injectionに対する完全な判定は引き続き未対応である。

## 現在の制約

### Browser / form 対応

- top-level navigation は対象企業ドメインとそのサブドメイン、またはジョブごとに登録した完全一致の外部hostだけを許可する。
- フォーム入力前に限り、公開HTTPS hostのread-only subresource（`GET` / `HEAD` / `OPTIONS`）を許可する。入力開始後は対象企業ドメインとジョブ固有の許可host以外への通信を遮断する。
- CDP DOM tree から `form` と可視 `input` / `textarea` / `select` / `button` を観察し、`form` 属性による外部関連付けにも対応する。各フィールドは tag、type、name、role、label、placeholder、必須、現在値、選択肢を返し、checkbox / radio では `checked` も返す。password の値は常に空文字で返す。
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
- Provider 呼び出し回数以外のtoken、rate limit、費用を保存しない。retryイベント以外の全体処理時間とBrowserUse待ち時間も保存しない。
- agent tool診断はbrowser tool、`finish`、unknown tool dispatchを対象とする。`data_json`にはturn、固定tool名、stage、固定result codeだけを保存し、イベント共通列にはjob ID、attempt、記録時刻を保存する。送信前レビューはstage `submit_review`、result code `SUBMIT_REVIEW_ALLOWED` / `SUBMIT_REVIEW_DENIED` / `SUBMIT_REVIEW_UNAVAILABLE`として記録する。入力値、URL、自由記述エラー、全状態遷移は保存しない。
- retry delay は 30 秒固定で、指数 backoff と jitter は未実装である。

## 並列・リトライ方針

PoC はまず 1 並列の production で開始し、管理下テストサイトへの実送信結果を観測してから 5、20、50 へ段階的に引き上げる。設定値だけで並列対応済みとせず、Cloudflare 上での実測を完了条件とする。

2026-09-03 に 5 並列で管理下テストシステムの 12 シナリオを実行し、8 件が合格した。残りのうち 3 件は Worker 診断が stage `driver_connect`、code `CDP_CONNECTION_CLOSED` で、10 秒間に連続して発生した。発生時点で BrowserUse 側に既存 session が 3〜4 件あり、直前 2 分 40 秒で 9 session を作成していた。前後の接続は成功しているため、BrowserUse の同時 session 上限（プラン上 10）または session 作成レートの上限に達したと推定するが、当時は WebSocket の close code / reason を記録していなかったため原因は未確定である。

現在、Queue consumer は `max_concurrency: 10` とし、接続段階だけ 10 秒 → 20 秒 → 30 秒の待機を挟んで最大 3 回再接続する。再接続は送信前の接続確立に限定するため、フォームへの副作用は発生しない。

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
- [x] 常設の管理下テストシステムをproductionへ配備し、送信11件・送信禁止2件を1 attemptで検証する。
- [x] 標準POST、GET、multipart、Ajax、controlled input、multi-step、open / closed Shadow DOM、外部host iframe、画面外submit、サイト内別ページを管理下サイトで検証する。
- [x] 送信禁止時のreason codeを正規化し、メールのみのページと営業利用禁止フォームで受信0件を確認する。

未完了:

- [x] 認証付きジョブ登録・取得 API を実装する。
- [ ] `submitting` 中にWorkerを強制停止し、状態が`submitting`のまま残って再配信でも送信されないことを検証する。
- [ ] 状態遷移、理由、時間、token、BrowserUse 待ち時間を記録する。
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
- 禁止判定の固定パターンを実サイトの表現へ合わせて拡張し、誤検出と未検出を監査する仕組み。
- 観察済みリンク自体がGET型副作用を持つサイトの識別またはサイト単位の許可方式。
- 状態遷移、tool、token、時間、費用の observability。
- `submitting` / `uncertain` の照合を支援する専用 API / UI。
- 実 form のcross-origin iframe、確認画面、複数ページ、Shadow DOM互換性検証と、添付・CAPTCHAの対応方針。
- Shadow DOM 内の禁止文言を含む可視テキストの収集。
- SPA の遅延描画で無関係なbuttonだけが先に現れる場合のフォーム探索再試行。
- CSVから抽出した外部form hostをジョブ単位の完全一致allowlistへ安全に反映する運用検証。
- Provider abstraction と fallback。
- 外部 API E2E は GitHub Actions の通常 CI に含めず、手動実行に限定する。
- BrowserUse の同時 session 上限と、切断後に session が解放されるまでの遅延を、ダッシュボードまたは記録した close code で確定する。
- R2 アップロード後・D1 記録前に Worker が停止した場合の孤児オブジェクトは検出できない。intent イベントの先行記録または R2 ライフサイクルルールで対処する。
- 送信前レビューの残存リスク対応: `dom` activation で照合と `requestSubmit` を同一 JS 実行内で行い、`mouse` / `enter` は activation 直前に再照合する。snapshot に禁止文言・label・option・action / method を含める。修正の証明を変更したコントロールの value / checked 差分に限定する。form 再探索の切り詰めを検出して fail-closed にする。いずれも管理下テストシステムでの E2E と併せて実施する。

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
