# 本番運用runbook

本書はproduction Worker、Queue、D1で送信ジョブを安全に停止・照合・再開するための手順である。コマンドはリポジトリルートで実行する。

## 基本原則

- `sent`、`submitting`、`uncertain`の既存ジョブは再投入しない。
- 受信側に記録がないことだけを「未送信」の証明にしない。
- D1の既存ジョブを手作業で`pending`へ戻さない。
- 再実行が必要な場合は、人間の明示承認後に新しいジョブIDを発行する。
- 通常時は`AGENT_DRY_RUN=true`を維持する。

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

`submitting`は強制再送せず、後述の照合対象にする。新規送信を再開する前に、現在のproduction deploymentを確認する。

```bash
./node_modules/.bin/wrangler deployments status --json
./node_modules/.bin/wrangler versions view <ACTIVE_VERSION_ID>
```

deploymentが1つのversionへ100%配信されていること、そのactive versionで`AGENT_DRY_RUN ("true")`であることを確認してから配送を再開する。確認できない場合はpauseのまま停止する。

```bash
./node_modules/.bin/wrangler queues resume-delivery form-agent-jobs
```

## D1 schema migrationを含むデプロイ

D1 migrationはWorker deployでは自動適用されない。新しい列を参照するコードを先にdeployすると全ジョブの読み書きが失敗するため、必ず次の順序で実施する。

1. Queue配送をpauseする。
2. `running` / `submitting`が0件になるまで確認する。残っている場合はmigrationを開始しない。
3. remote D1 migrationを適用する。
4. schemaとmigration一覧を確認する。
5. Workerをdeployする。
6. active versionが1つ・100%で、`AGENT_DRY_RUN ("true")`であることを確認する。
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

次の外部証跡を照合する。

1. 送信先の受信ログ、管理画面または受信メール
2. 対象URLと送信時刻
3. `browser_submit_activation`の`requestObserved`と`hitTestAttempts`
4. D1の`attempt_count`と結果

送信済みの可能性を否定できない場合は再投入しない。未送信と判断して再実行する場合も、既存IDは変更せず、承認記録と新しいジョブIDを使用する。

## DLQの確認

DLQへ移動したジョブを確認する。

```bash
./node_modules/.bin/wrangler queues info form-agent-jobs-dlq
./node_modules/.bin/wrangler d1 execute form-agent --remote --command \
  "SELECT id,status,attempt_count,provider_request_count,updated_at FROM jobs WHERE status='dead_lettered' ORDER BY updated_at;"
```

`dead_lettered`は自動再投入しない。原因を解消し、外部送信が発生していないことを照合し、人間が承認した場合だけ新しいジョブIDで登録する。

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
4. `wrangler versions view <ACTIVE_VERSION_ID>`で`AGENT_DRY_RUN ("true")`を確認する。
5. 1〜4がすべて成功した場合だけQueue配送をresumeする。いずれかが失敗した場合はpauseを維持する。

合格条件は次のとおり。

- D1の`attempt_count`が1
- 終端状態が`sent`
- 受信側POSTが1件
- 同じジョブIDの追加送信がない

検証コマンドはproduction secretを標準出力へ出さない。終了trapでも先にpauseし、`AGENT_DRY_RUN=true`のactive deployment確認前にresumeしてはならない。
