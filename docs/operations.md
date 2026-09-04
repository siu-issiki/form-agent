# 本番運用runbook

本書はproduction Worker、Queue、D1で送信ジョブを安全に停止・照合・再開するための手順である。コマンドはリポジトリルートで実行する。

## 基本原則

- `sent`、`submitting`、`uncertain`の既存ジョブは再投入しない。
- 受信側に記録がないことだけを「未送信」の証明にしない。
- D1の既存ジョブを手作業で`pending`へ戻さない。
- 再実行が必要な場合は、人間の明示承認後に新しいジョブIDを発行する。
- 通常時は`AGENT_DRY_RUN=false`とし、送信なしジョブはpayloadの`_formAgentDryRun: true`で固定する。
- 実効dry-run値は登録時にジョブへ保存し、deploy後に既存ジョブの意味を変えない。

## 緊急停止

新規Queue配送を停止する。

```bash
./node_modules/.bin/wrangler queues pause-delivery form-agent-jobs
```

この操作は新規配送を停止するが、既に実行中のConsumerを取り消すものではない。実行中ジョブを確認する。

```bash
./node_modules/.bin/wrangler d1 execute form-agent --remote --command \
  "SELECT id,status,attempt_count,updated_at FROM jobs WHERE status IN ('pending','running','submitting') ORDER BY updated_at;"
```

`submitting`は強制再送せず、後述の照合対象にする。Worker強制終了時はbrowser sessionが残ることがあるため、「BrowserUse sessionの確認と停止」も併せて実施する。`running` / `submitting`が0件になったら、明示的な安全停止設定でWorkerをdeployする。

```bash
./node_modules/.bin/wrangler deploy \
  --var AGENT_EXECUTOR_ENABLED:true \
  --var AGENT_MODEL:gpt-5.6-luna \
  --var AGENT_DRY_RUN:true
```

新規送信を再開する前に、現在のproduction deploymentを確認する。

```bash
./node_modules/.bin/wrangler deployments status --json
./node_modules/.bin/wrangler versions view <ACTIVE_VERSION_ID>
```

deploymentが1つのversionへ100%配信されていること、そのactive versionで`AGENT_DRY_RUN ("true")`であることを確認してから配送を再開する。確認できない場合はpauseのまま停止する。

```bash
./node_modules/.bin/wrangler queues resume-delivery form-agent-jobs
```

通常の実送信運用へ戻す場合は、Queueをpauseした状態で通常設定をdeployし、active versionの`AGENT_DRY_RUN ("false")`を確認してからresumeする。

```bash
./node_modules/.bin/wrangler deploy
./node_modules/.bin/wrangler deployments status --json
./node_modules/.bin/wrangler versions view <ACTIVE_VERSION_ID>
./node_modules/.bin/wrangler queues resume-delivery form-agent-jobs
```

## 初回実送信切替

証跡スクリーンショット機能のdeploy前提として、R2バケットを作成しておく。バケットが存在しない場合、deployは失敗する。

```bash
./node_modules/.bin/wrangler r2 bucket create form-agent-evidence
```

1. Queue配送をpauseする。
2. D1の`pending` / `running` / `submitting`が0件であることを確認する。
3. 通常設定をdeployする。
4. active versionが1つ・100%で、`AGENT_DRY_RUN ("false")`であることを確認する。
5. 1〜4が成功した場合だけQueue配送をresumeする。

切替前に登録された旧ジョブには実効モードが保存されていないため、Consumerは必ずdry-runとして扱う。切替後に登録されたジョブだけが登録時の`false`を保存し、実送信できる。

## 実送信のrunbook

実送信ジョブを作れる経路は`tools/campaign-send.ts`だけである。`tools/campaign-dry-run.ts`は`_formAgentDryRun: true`固定のままで、実送信できない。

Worker側は`POST /jobs`で実送信ジョブ（`_formAgentEffectiveDryRun`が`false`）になる場合だけ次の4つを検証する。1つでも満たさなければジョブを作らない。

| 検証 | 失敗時 |
| --- | --- |
| payloadに承認記録`_formAgentSendApproval`があること | 400 `SEND_APPROVAL_REQUIRED` |
| `dryRunJobId`のジョブが存在し、同じ`targetUrl`のdry-runで、`prohibited` / `DRY_RUN_COMPLETE`で終わっていること | 400 `DRY_RUN_NOT_COMPLETED` |
| そのdry-runと実送信の内容フィンガープリント（`targetUrl` + `companyId` + `payload.formValues`のSHA-256）が一致すること | 400 `DRY_RUN_CONTENT_MISMATCH` |
| 当日（UTC）に作成済みの実送信ジョブ数が`REAL_SEND_DAILY_CAP`未満であること | 429 `REAL_SEND_CAP_REACHED` |

承認記録はpayloadへそのまま保存し、`GET /jobs/:id`とD1で「誰がいつどのdry-runに対して承認したか」を後から追える。承認記録はモデルにも送信前レビューにも渡さない。

すでに`pending`で存在する実送信ジョブの再登録は、`created_at`が当日UTCの場合だけ再queueする。日を跨いでいた場合は再queueせず409 `REAL_SEND_STALE`を返す。日次上限は作成時にしか数えないため、翌日に再queueするとその日の枠を消費せずに送信されてしまうためである。

### 日次上限の設定

`REAL_SEND_DAILY_CAP`は`wrangler.jsonc`に置かない。未設定・空・整数以外はすべて0として扱い、実送信ジョブを一切受け付けない。上限を開くのはdeploy時の`--var`だけである。

`--var`を使うdeployでは通常設定の変数もすべて明示する。1つでも落とすとそのdeployから消えるおそれがある。

```bash
./node_modules/.bin/wrangler deploy \
  --var AGENT_EXECUTOR_ENABLED:true \
  --var AGENT_MODEL:gpt-5.6-luna \
  --var AGENT_DRY_RUN:false \
  --var REAL_SEND_DAILY_CAP:5
./node_modules/.bin/wrangler deployments status --json
./node_modules/.bin/wrangler versions view <ACTIVE_VERSION_ID>
```

active versionが1つ・100%で、`AGENT_DRY_RUN ("false")`と`REAL_SEND_DAILY_CAP ("5")`の両方が見えることを確認してから実行する。

### 日次上限の解除

引数なしのdeployは`wrangler.jsonc`のvarsだけを配るため、`REAL_SEND_DAILY_CAP`が消えて上限0に戻る。実送信の枠を閉じる操作はこれで足りる。

```bash
./node_modules/.bin/wrangler deploy
./node_modules/.bin/wrangler versions view <ACTIVE_VERSION_ID>
```

active versionの環境変数一覧に`REAL_SEND_DAILY_CAP`が無いことを確認する。

### 承認ファイルの作り方

対象行はすべて、同じCSV・同じ登録情報でdry-runを通し、`prohibited` / `DRY_RUN_COMPLETE`になっていなければならない。dry-runの`campaign_job_result`ログに出る`jobId`が、そのまま承認ファイルの`dryRunJobId`になる。

```json
{
  "approvedBy": "sales-ops@example.com",
  "approvedAt": "2026-09-04T09:00:00.000Z",
  "entries": [
    { "sourceRow": 12, "dryRunJobId": "<dry-runのjobId>", "note": "目視確認済み" }
  ]
}
```

- `approvedBy`は1〜64文字、`approvedAt`はISO 8601、`note`は200文字以内。
- `sourceRow`はCSVの行番号（ヘッダーを1行目とする2以上の整数）で、dry-runジョブのpayloadの`sourceRow`と同じ定義である。
- `sourceRow`と`dryRunJobId`の重複は拒否する。1つの承認で2件送れてしまうためである。
- サンプルは[examples/campaign-send-approval.example.json](examples/campaign-send-approval.example.json)にある。
- ファイルはリポジトリへ追加せず、ローカルパスから読み込む。

### 実行手順

1. migration `0007_real_send.sql`をremote D1へ適用済みであることを確認する（「D1 schema migrationを含むデプロイ」の手順に従う）。
2. 対象行のdry-runを完了させ、結果を目視で確認する。
3. 承認ファイルを作る。
4. `REAL_SEND_DAILY_CAP`を今回の件数以上にしてdeployし、active versionを確認する。
5. Queue配送がresumeされていることを確認する。
6. 送信を実行する。campaign名はdry-runと必ず別にする。同じ名前にするとジョブIDが衝突し、409 `JOB_ID_CONFLICT`になる。

```bash
JOB_API_TOKEN=... bun run campaign:send \
  --registration /path/to/registration.json \
  --csv /path/to/targets.csv \
  --approved /path/to/approved.json \
  --campaign agb-shaken-2026-09-send-v1 \
  --max-sends 5 \
  --confirm-real-send
```

`--confirm-real-send`が無い場合、ツールはCSVも承認ファイルも読まずにexit 1で終了する。`--max-sends`の既定は5、上限は50で、承認ファイルのentriesがこれを超えるとexit 1になる。

### 結果と証跡の確認

ツールは`campaign_send_summary`を1行出力する。`sentJobs` + `prohibitedJobs`が`approvedEntries`に満たない場合はexit 1になる。`byReasonCode`の内訳は次のとおりである。

| reason code | 意味 |
| --- | --- |
| `SENT` | 送信完了 |
| `ROW_NOT_ELIGIBLE` | 承認された`sourceRow`がCSVの適格行に無い |
| `APPROVAL_MISMATCH` | `dryRunJobId`のジョブがフォームURL・dry-run・`DRY_RUN_COMPLETE`・内容フィンガープリントのいずれかを満たさない、または照会できない |
| `REDIRECT_PREFLIGHT_FAILED` | redirect preflightに失敗し、登録しなかった |
| `REGISTRATION_FAILED` / `REGISTRATION_UNKNOWN` | dry-runツールと同じ登録失敗・確認不能 |
| `SEND_TIMED_OUT` | 期限内に終端状態へ到達しなかった |
| その他 | ジョブの`result.reasonCode` |

送信後は次を確認する。

```bash
./node_modules/.bin/wrangler d1 execute form-agent --remote --command \
  "SELECT id,status,attempt_count,created_at FROM jobs WHERE real_send=1 ORDER BY created_at DESC LIMIT 20;"
./node_modules/.bin/wrangler d1 execute form-agent --remote --command \
  "SELECT id,json_extract(payload_json,'\$._formAgentSendApproval.approvedBy') AS approved_by,json_extract(payload_json,'\$._formAgentSendApproval.dryRunJobId') AS dry_run_job_id FROM jobs WHERE real_send=1 ORDER BY created_at DESC LIMIT 20;"
```

2つ目のクエリが承認記録の監査に使う行である。`real_send`列は登録時に確定した実効モードと一致するため、当日の実送信件数もこの列で数えられる。

`uncertain`が出た場合は「`submitting` / `uncertain`の照合」に従う。送信前後のスクリーンショットは「証跡スクリーンショットの確認」で取得する。

### 実送信の緊急停止

実送信を止める操作は2つある。両方行う。

```bash
./node_modules/.bin/wrangler deploy
./node_modules/.bin/wrangler queues pause-delivery form-agent-jobs
```

1つ目のdeployで`REAL_SEND_DAILY_CAP`が消え、新しい実送信ジョブは429で拒否される。2つ目のpauseで、すでにQueueへ載っているジョブの配送が止まる。実行中のConsumerは取り消されないため、「緊急停止」の手順で`running` / `submitting`が0件になるまで確認する。

停止中に`pending`のまま日を跨いだ実送信ジョブは、resume後に同じ内容で再登録しても409 `REAL_SEND_STALE`になる。承認と上限判定をやり直す設計であるためで、再開時は次のいずれかを選ぶ。

- そのまま配送をresumeして既存の`pending`を流す。Queueのメッセージは残っているため再登録は不要である。
- 流さない場合は、対象を確認したうえで新しいcampaign名でdry-runからやり直し、承認ファイルを作り直す。既存ジョブを手作業で`pending`へ戻したり削除したりしない。

```bash
./node_modules/.bin/wrangler d1 execute form-agent --remote --command \
  "SELECT id,created_at FROM jobs WHERE real_send=1 AND status='pending' ORDER BY created_at;"
```

## D1 schema migrationを含むデプロイ

D1 migrationはWorker deployでは自動適用されない。新しい列を参照するコードを先にdeployすると全ジョブの読み書きが失敗するため、必ず次の順序で実施する。

1. Queue配送をpauseする。
2. `running` / `submitting`が0件になるまで確認する。残っている場合はmigrationを開始しない。
3. remote D1 migrationを適用する。
4. schemaとmigration一覧を確認する。
5. Workerをdeployする。
6. active versionが1つ・100%で、通常運用では`AGENT_DRY_RUN ("false")`であることを確認する。
7. 1〜6がすべて成功した場合だけQueue配送をresumeする。

```bash
./node_modules/.bin/wrangler queues pause-delivery form-agent-jobs
./node_modules/.bin/wrangler d1 execute form-agent --remote --command \
  "SELECT status,COUNT(*) AS count FROM jobs WHERE status IN ('running','submitting') GROUP BY status;"
./node_modules/.bin/wrangler d1 migrations apply form-agent --remote
./node_modules/.bin/wrangler d1 migrations list form-agent --remote
./node_modules/.bin/wrangler d1 execute form-agent --remote --command \
  "SELECT name FROM pragma_table_info('jobs') WHERE name='allowed_hosts_json';"
./node_modules/.bin/wrangler deploy
./node_modules/.bin/wrangler deployments status --json
./node_modules/.bin/wrangler versions view <ACTIVE_VERSION_ID>
./node_modules/.bin/wrangler queues resume-delivery form-agent-jobs
```

途中で失敗した場合はQueueをpauseしたままにする。migration適用後にdeployが失敗しても、`allowed_hosts_json`はdefault `[]`付きの追加列なので旧Workerは継続利用できる。

## `submitting` / `uncertain`の照合

対象ジョブと保存結果を取得する。

```bash
./node_modules/.bin/wrangler d1 execute form-agent --remote --command \
  "SELECT jobs.id,jobs.status,jobs.attempt_count,jobs.provider_request_count,jobs.updated_at,results.outcome,results.reason_code FROM jobs LEFT JOIN results ON results.job_id=jobs.id WHERE jobs.status IN ('submitting','uncertain') ORDER BY jobs.updated_at;"
```

完全な`target_url`、`form_url`、自由文の`reason`は一括出力しない。query tokenやフォーム値を含む可能性があるため、必要な場合だけ対象IDを限定し、標準出力の保存先と閲覧者を確認して取得する。

### Workerが`submitting`中に停止した場合

送信権を取得した直後にWorkerが停止すると、ジョブは`submitting`のまま残る。Queueがそのメッセージを再配信しても、consumerは`pending`以外を実行権として取得せず、状態が`running`でないため実行せずにackする。したがって自動での再送は起きない。

この再配信を検出するため、ackしたときに`job.redelivery_ignored`イベントを記録する。`data_json`はジョブの`status`だけを保存する。

```bash
./node_modules/.bin/wrangler d1 execute form-agent --remote --command \
  "SELECT job_id,attempt,data_json,created_at FROM events WHERE type='job.redelivery_ignored' ORDER BY created_at DESC LIMIT 20;"
```

`status`が`submitting`の行が該当する。対象ジョブは前節の外部証跡照合を行い、送信済みの可能性を否定できない場合は再投入しない。未送信・送信済みのいずれと判断した場合も、状態を`running`へ戻さず、承認記録を残したうえで人手で`uncertain`として確定する。`run_token`は監査のため残す。

```bash
./node_modules/.bin/wrangler d1 execute form-agent --remote --command \
  "INSERT INTO results (job_id,outcome,form_url,reason_code,reason,completed_at) SELECT id,'uncertain',NULL,'OPERATOR_CONFIRMED_UNCERTAIN','Reconciled by an operator after the Worker stopped while submitting.',datetime('now') FROM jobs WHERE id='<JOB_ID>' AND status='submitting' AND NOT EXISTS (SELECT 1 FROM results WHERE results.job_id=jobs.id);"
./node_modules/.bin/wrangler d1 execute form-agent --remote --command \
  "UPDATE jobs SET status='uncertain',updated_at=datetime('now') WHERE id='<JOB_ID>' AND status='submitting';"
```

`results`の挿入を先に行い、挿入件数が1件であることを確認してから状態を更新する。再実行が必要な場合は既存IDを変更せず、新しいジョブIDで登録する。

まず対象ジョブのD1 `evidence.captured`イベントを取得し、`after_submit`のスクリーンショットが記録されているかを確認する。取得手順は次節「証跡スクリーンショットの確認」を参照する。

次の外部証跡を照合する。

1. 証跡スクリーンショット（`after_submit`）
2. 送信先の受信ログ、管理画面または受信メール
3. 対象URLと送信時刻
4. `browser_submit_activation`の`requestObserved`と`hitTestAttempts`
5. D1の`attempt_count`と結果

送信済みの可能性を否定できない場合は再投入しない。未送信と判断して再実行する場合も、既存IDは変更せず、承認記録と新しいジョブIDを使用する。

該当runがどこまで進んだかは、後述「実行メトリクスの取得」の`agent.run_metrics`でも確認する。`outcome`が`error`のrunはexecutorが例外で終了しており、`browserConnected`が`false`ならCDP接続が確立していない。ただしREST APIでのsession作成後にCDP接続で失敗した場合も`false`になるため、session自体の有無は`browser_use_session_created` / `browser_use_session_stopped`のログで確認する。

## 証跡スクリーンショットの確認

対象ジョブの証跡イベントをD1から取得する。

```bash
./node_modules/.bin/wrangler d1 execute form-agent --remote --command \
  "SELECT id, attempt, type, data_json, created_at FROM events WHERE job_id = '<JOB_ID>' AND type LIKE 'evidence.%' ORDER BY created_at;"
```

`evidence.captured`の`data_json`に含まれる`objectKey`を使い、R2から画像を取得する。

```bash
./node_modules/.bin/wrangler r2 object get form-agent-evidence/<objectKey> --file ./evidence.jpg --remote
```

取得したファイルのハッシュを計算し、`data_json`の`sha256`と一致することを確認する。

```bash
shasum -a 256 ./evidence.jpg
```

画像には入力済みの個人情報が写る。確認後は取得したファイルを削除し、共有しない。R2側にはライフサイクル削除ルールを設定していないため、証跡スクリーンショットはR2上に無期限に残り続ける。この方針は運用ポリシー確定時に見直す。

D1へのイベント記録に失敗した場合、または15秒のタイムアウト後にR2保存・D1記録が遅れて完了した場合、Workerはアップロード済みのオブジェクトを補償削除する。同じ撮影の成功・失敗は共通の`eventId`で排他的に記録するため、`CAPTURE_TIMEOUT`確定後に成功イベントへ戻ることはない。補償削除にも失敗した場合は、D1から辿れないオブジェクトが残り、Workerログに`submission_evidence_orphan`イベントとして`objectKey`が出力される。ログから`objectKey`を取得し、手動で削除する。

```bash
./node_modules/.bin/wrangler r2 object delete form-agent-evidence/<objectKey> --remote
```

R2へアップロードする直前に`evidence.intent`イベントを記録するため、R2 put後・D1記録前にWorkerが停止した孤児オブジェクトは、残存する`evidence.intent`行から特定できる。撮影が完了すると同じ`events.id`が`evidence.captured`または`evidence.capture_failed`へ遷移し、失敗側へ遷移した場合も`objectKey`を保持する。したがって孤児候補は次の2種類である。

1. `type='evidence.intent'`のまま残る行（put前後にWorkerが停止した可能性がある）
2. `type='evidence.capture_failed'`で`objectKey`を持ち、`failureCode`が`CAPTURE_TIMEOUT` / `OBJECT_STORE_FAILED` / `EVENT_NOT_RECORDED`の行（補償削除が完了していない可能性がある）

Cloudflare APIトークンは不要である。

```bash
./node_modules/.bin/wrangler d1 execute form-agent --remote --command \
  "SELECT events.id,events.job_id,events.attempt,events.type,json_extract(events.data_json,'$.stage') AS stage,json_extract(events.data_json,'$.failureCode') AS failure_code,json_extract(events.data_json,'$.objectKey') AS object_key,events.created_at,jobs.status FROM events JOIN jobs ON jobs.id=events.job_id WHERE (events.type='evidence.intent' OR (events.type='evidence.capture_failed' AND json_extract(events.data_json,'$.objectKey') IS NOT NULL AND json_extract(events.data_json,'$.failureCode') IN ('CAPTURE_TIMEOUT','OBJECT_STORE_FAILED','EVENT_NOT_RECORDED'))) ORDER BY events.created_at;"
```

`status`が`running` / `submitting`の行は撮影中の可能性があるため削除しない。終端状態のジョブに残る行だけを孤児候補として扱い、`object_key`をR2から削除する。多くの候補はWorkerが補償削除に成功しておりR2上に存在しないが、`wrangler r2 object delete`は存在しないキーに対しても成功扱いで終了するため、候補すべてに対して実行してよい。削除後も元のイベント行はrunの記録として残す。

```bash
./node_modules/.bin/wrangler r2 object delete form-agent-evidence/<objectKey> --remote
```

`wrangler`にはR2オブジェクトを一覧するコマンドが無い（`get` / `put` / `delete`のみ）ため、孤児オブジェクトの網羅的な突き合わせにはCloudflare REST APIを使う。R2読み取り権限を持つAPIトークンとアカウントIDが必要。

```bash
curl -s "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/r2/buckets/form-agent-evidence/objects?prefix=jobs/<JOB_ID>/" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" | jq -r '.result[].key'
```

出力された各キーを、対象ジョブのD1 `evidence.captured`イベントの`objectKey`一覧（前掲の`SELECT ... WHERE type LIKE 'evidence.%'`で取得できる）と突き合わせる。D1側に対応するキーが無いオブジェクトは、補償削除にも失敗した孤児（`submission_evidence_orphan`ログが出ていない場合は、R2 put後・D1記録前にWorkerが停止したケースも含む）とみなし、`wrangler r2 object delete`で手動削除する。

## DLQの確認

DLQへ移動したジョブを確認する。

```bash
./node_modules/.bin/wrangler queues info form-agent-jobs-dlq
./node_modules/.bin/wrangler d1 execute form-agent --remote --command \
  "SELECT id,status,attempt_count,provider_request_count,updated_at FROM jobs WHERE status='dead_lettered' ORDER BY updated_at;"
```

`dead_lettered`は自動再投入しない。原因を解消し、外部送信が発生していないことを照合し、人間が承認した場合だけ新しいジョブIDで登録する。既存IDの再キュー、`pending`への差し戻し、Queueへの直接再投入はいずれも行わない。

再登録は次の順序で実施する。

1. 対象ジョブの`payload_json`と`target_url`を取得し、送信内容と送信先を確認する。出力にはフォーム値が含まれるため、対象IDを限定し、保存先と閲覧者を確認してから実行する。
2. 「`submitting` / `uncertain`の照合」と同じ外部証跡で、受信側に送信が無いことを照合する。
3. 再送信の承認者、日時、根拠を記録する。
4. 承認後に、新しいジョブIDで`POST /jobs`へ登録する。

```bash
./node_modules/.bin/wrangler d1 execute form-agent --remote --command \
  "SELECT target_url,payload_json FROM jobs WHERE id='<JOB_ID>';"
./node_modules/.bin/wrangler d1 execute form-agent --remote --command \
  "SELECT attempt,type,data_json,created_at FROM events WHERE job_id='<JOB_ID>' ORDER BY created_at;"
```

`job.retry_scheduled`の`delaySeconds`には、その配信試行で実際に指定したQueue retryの遅延秒数（30秒を基準にした指数backoffへ±20%のjitterを掛け、300秒で上限を設けた値）が入る。DLQ到達までに要した時間の確認に使う。

## 実行メトリクスの取得

1 runにつき1件の`agent.run_metrics`イベントを記録する。値は数値、boolean、固定コードだけであり、URL、会社名、フォーム値、モデルの自由文は含まない。`browserConnected`はCDP driverの確立に成功したかどうかだけを表すため、課金対象のsession作成・停止件数は`browser_use_session_created` / `browser_use_session_stopped`のログで追う。

```bash
./node_modules/.bin/wrangler d1 execute form-agent --remote --command \
  "SELECT job_id,attempt,data_json,created_at FROM events WHERE type='agent.run_metrics' AND created_at >= '<ISO8601>' ORDER BY created_at;"
```

期間内のtokenと実行時間を集計する場合は次を使う。

```bash
./node_modules/.bin/wrangler d1 execute form-agent --remote --command \
  "SELECT COUNT(*) AS runs, SUM(json_extract(data_json,'$.inputTokens')) AS input_tokens, SUM(json_extract(data_json,'$.cachedTokens')) AS cached_tokens, SUM(json_extract(data_json,'$.outputTokens')) AS output_tokens, SUM(json_extract(data_json,'$.durationMs')) AS duration_ms, SUM(json_extract(data_json,'$.browserConnectMs')) AS browser_connect_ms FROM events WHERE type='agent.run_metrics' AND created_at >= '<ISO8601>';"
```

1件原価は、上記の集計とProvider側の単価から概算する。単価はこのリポジトリに保存せず、算出時にOpenAIの料金表を参照する。

```text
1件原価 ≒ ((input_tokens - cached_tokens) × input単価
        + cached_tokens × cached input単価
        + output_tokens × output単価) ÷ 対象run数
        + BrowserUse session費用 + Cloudflare費用
```

`outputTokens`には`reasoningTokens`が含まれる。分母は目的に応じて全run数と`outcome='sent'`のrun数の両方で計算する。BrowserUseとCloudflareの費用はD1に記録していないため、各サービスの請求から按分する。

## エージェントツールの診断

対象ジョブのツール処理段階と固定結果コードを確認する。

```bash
./node_modules/.bin/wrangler d1 execute form-agent --remote --command \
  "SELECT attempt,data_json,created_at FROM events WHERE job_id='<JOB_ID>' AND type='agent.tool_diagnostic' ORDER BY attempt,CAST(json_extract(data_json,'$.turn') AS INTEGER),created_at;"
```

`data_json`にはturn、固定のtool名、stage、result codeだけが入り、URL、会社名、フォーム値、モデルの自由文は保存されない。

## 検証サービスhostの追加と削除

reCAPTCHA / hCaptcha / Turnstileのhostは`src/browser-network-policy.ts`の`VERIFICATION_PROVIDER_ALLOWLIST`にコードとして固定されている。運用中に設定で変えることはできず、変更にはコード変更・レビュー・deployが必要である。追加する場合は、そのhostが検証widgetの配信・検証だけに使われることを確認し、可能な限り`pathPrefix`でパスを絞る（例: `/recaptcha/`）。パスを絞れないhostは全パスが開くため、検証サービス専用のhostに限る。サブドメインを開く`allowSubdomains`は、そのドメイン全体が検証サービスのものである場合だけに使う。追加後は`test/restricted-browser.test.ts`の`pins the verification provider allowlist to known hosts`が期待値を固定しているので併せて更新し、`bun run test`で全件を確認してからdeployする。削除する場合は、対象サービスを使うフォームで`CAPTCHA_REQUIRED`が増えないかをdry-runで確認する。deploy後は`browser_verification_requests`の件数を追い、想定外に増減していないかを見る。

## BrowserUse sessionの確認と停止

通常はジョブ終了時にWorkerがsessionを`stop`する。Workerが強制終了した場合、DLQへ落ちた場合、`stop`が失敗した場合はsessionが残るため、`BROWSER_USE_API_KEY`を持つ環境から確認する。API keyはシェル履歴へ残さず、`--env-file`で渡す。

```bash
bun --env-file=.env.production run tools/browser-use-sessions.ts list
bun --env-file=.env.production run tools/browser-use-sessions.ts stop <SESSION_ID>
bun --env-file=.env.production run tools/browser-use-sessions.ts stop-all
```

`list`はactive sessionのid、開始時刻、寿命、`metadata.jobId`だけを出力する。live viewとCDPのURLはsessionの操作権を与えるため出力しない。停止対象は、対応するジョブがD1上で終端状態になっているsessionに限る。`stop-all`は実行中ジョブがない保守時間にだけ使う。

週次で`list`を実行し、activeが0件でない場合は各`metadata.jobId`をD1で確認する。対応するジョブが終端状態（`sent` / `prohibited` / `uncertain` / `failed` / `dead_lettered`）であれば`stop`し、`running` / `submitting`のままであれば停止せず、「`submitting` / `uncertain`の照合」を先に実施する。

```bash
./node_modules/.bin/wrangler d1 execute form-agent --remote --command \
  "SELECT id,status,updated_at FROM jobs WHERE id='<JOB_ID>';"
```

Worker側の記録は`browser_use_session_created`、`browser_use_session_stopped`、`browser_use_session_reclaimed`である。`browser_use_session_stopped`の`ok`が`false`の場合は`stop`が届いていないため、上記の`list`で残骸を確認する。

attempt上限で終端したジョブは、Queue consumerが結果を保存する前に同じ`jobId`のsessionを回収する。`browser_use_session_reclaimed`の`matched`が0のまま`activeTagged`が同時session上限に達している場合は他ジョブのleakであり、自動では解放されないため、上記の`list`とD1のジョブ状態を照合して終端済みジョブのsessionを`stop`する。

BrowserUse devプランの同時ブラウザ上限は25で、Queue consumerの`max_concurrency`は20である。上限25のうち5は、leakしたsessionが寿命まで枠を塞ぐ分の余裕として空けている。`list`のactiveが常時5件を超えて残る場合は余裕を食い潰しているため、`max_concurrency`を下げるかleakの原因を先に解消する。

`outcome: exceededCpu`によるWorkerの強制終了は、Cloudflareダッシュボードの Workers Logs で`outcome = exceededCpu`を検索して調査する。ログの保持期間はPaidプランで7日であるため、7日以内に確認する。`cpuTime`と`wallTime`を併せて読む。CPU上限は、Freeプランが公称10 ms/呼び出し（実測では数百 msまで通ることが多いが、負荷時にisolateごと強制終了される）、Paidプランが既定30秒で`limits.cpu_ms`により最大5分まで変更できる。現在はPaidプランで`limits.cpu_ms`は未設定である。

既知事象（2026-09-03、原因は推定）: 選択肢候補リストのdeploy以降、`exceededCpu`の発生率が1%程度から30〜40%へ急増した。同時刻に複数呼び出しが揃って停止するクラスターが多く、停止時の`cpuTime`は正常完了時より小さい値だった。当日夕方にCloudflare WorkersをPaid、BrowserUseをdev（有料）プランへ移行し、同一コードを再deployしたところ、9呼び出しで`exceededCpu`が0件、6シナリオ6/6合格となった。CPU総量では説明できないため、原因はFreeプランの負荷時のisolate強制終了と推定する。確定ではなく、23シナリオ2巡で再発しないことの確認が残っている。再発する場合は、`job.redelivery_ignored`とセッションleakの有無（本節前段の「attempt上限で終端したジョブ」の記述を参照）を併せて確認する。

## 重複Queue配送の検証

使い捨てサイトだけを対象とし、他のproducerがジョブを登録しない排他的な保守時間に実行する。最初に配送をpauseし、Cloudflare Queuesのbacklogが0件であることをDashboardで確認する。次にD1を確認し、`pending`、`running`、`submitting`がすべて0件でなければ検証を中止する。

```bash
./node_modules/.bin/wrangler queues pause-delivery form-agent-jobs
./node_modules/.bin/wrangler d1 execute form-agent --remote --command \
  "SELECT status,COUNT(*) AS count FROM jobs WHERE status IN ('pending','running','submitting') GROUP BY status;"
```

pause中に同一内容・同一IDの`POST /jobs`を2回実行し、1回目が`201`、2回目が`200`であることを確認する。resume直前にD1上のclaim可能なジョブが対象テストIDの1件だけであることを確認する。他のジョブまたは想定外のbacklogがあれば、dry-run解除もresumeも行わない。

復旧処理は必ず次の順序にする。

1. Queueをpauseする。既にpause中でも続行する。
2. 通常設定でWorkerを再デプロイする。
3. `wrangler deployments status --json`でactive versionが1つ、100%であることを確認する。
4. `wrangler versions view <ACTIVE_VERSION_ID>`で`AGENT_DRY_RUN ("false")`を確認する。
5. 1〜4がすべて成功した場合だけQueue配送をresumeする。いずれかが失敗した場合はpauseを維持する。

合格条件は次のとおり。

- D1の`attempt_count`が1
- 終端状態が`sent`
- 受信側POSTが1件
- 同じジョブIDの追加送信がない

検証コマンドはproduction secretを標準出力へ出さない。終了trapでも先にpauseし、通常運用へ戻す場合は`AGENT_DRY_RUN=false`、安全停止を継続する場合は`AGENT_DRY_RUN=true`のactive deployment確認前にresumeしてはならない。
