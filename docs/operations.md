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

`dead_lettered`は自動再投入しない。原因を解消し、外部送信が発生していないことを照合し、人間が承認した場合だけ新しいジョブIDで登録する。

## エージェントツールの診断

対象ジョブのツール処理段階と固定結果コードを確認する。

```bash
./node_modules/.bin/wrangler d1 execute form-agent --remote --command \
  "SELECT attempt,data_json,created_at FROM events WHERE job_id='<JOB_ID>' AND type='agent.tool_diagnostic' ORDER BY attempt,CAST(json_extract(data_json,'$.turn') AS INTEGER),created_at;"
```

`data_json`にはturn、固定のtool名、stage、result codeだけが入り、URL、会社名、フォーム値、モデルの自由文は保存されない。

## BrowserUse sessionの確認と停止

通常はジョブ終了時にWorkerがsessionを`stop`する。Workerが強制終了した場合、DLQへ落ちた場合、`stop`が失敗した場合はsessionが残るため、`BROWSER_USE_API_KEY`を持つ環境から確認する。API keyはシェル履歴へ残さず、`--env-file`で渡す。

```bash
bun --env-file=.env.production run tools/browser-use-sessions.ts list
bun --env-file=.env.production run tools/browser-use-sessions.ts stop <SESSION_ID>
bun --env-file=.env.production run tools/browser-use-sessions.ts stop-all
```

`list`はactive sessionのid、開始時刻、寿命、`metadata.jobId`だけを出力する。live viewとCDPのURLはsessionの操作権を与えるため出力しない。停止対象は、対応するジョブがD1上で終端状態になっているsessionに限る。`stop-all`は実行中ジョブがない保守時間にだけ使う。

Worker側の記録は`browser_use_session_created`、`browser_use_session_stopped`、`browser_use_session_reclaimed`である。`browser_use_session_stopped`の`ok`が`false`の場合は`stop`が届いていないため、上記の`list`で残骸を確認する。

`outcome: exceededCpu`によるWorkerの強制終了は、Cloudflareダッシュボードの Workers Logs で`outcome = exceededCpu`を検索して調査する。ログの保持期間はFreeプランで3日であるため、3日以内に確認する。`cpuTime`と`wallTime`を併せて読み、CPU上限（既定30秒。Freeプランでは変更不可）に達していない強制終了であれば上限引き上げでは解消しない。

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
