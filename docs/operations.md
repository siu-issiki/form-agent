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

`submitting`は強制再送せず、後述の照合対象にする。新規送信を再開する前に、現在のproduction設定を確認する。

```bash
./node_modules/.bin/wrangler versions view <VERSION_ID>
```

`AGENT_DRY_RUN ("true")`を確認してから配送を再開する。

```bash
./node_modules/.bin/wrangler queues resume-delivery form-agent-jobs
```

## `submitting` / `uncertain`の照合

対象ジョブと保存結果を取得する。

```bash
./node_modules/.bin/wrangler d1 execute form-agent --remote --command \
  "SELECT jobs.id,jobs.status,jobs.attempt_count,jobs.provider_request_count,jobs.target_url,jobs.updated_at,results.outcome,results.form_url,results.reason_code,results.reason FROM jobs LEFT JOIN results ON results.job_id=jobs.id WHERE jobs.status IN ('submitting','uncertain') ORDER BY jobs.updated_at;"
```

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

使い捨てサイトだけを対象にする。実行中ジョブが0件であることを確認後、配送をpauseし、同一内容・同一IDの`POST /jobs`を2回実行する。1回目が`201`、2回目が`200`であることを確認してから配送をresumeする。

合格条件は次のとおり。

- D1の`attempt_count`が1
- 終端状態が`sent`
- 受信側POSTが1件
- 同じジョブIDの追加送信がない

検証コマンドはproduction secretを標準出力へ出さず、終了trapでQueue配送再開と`AGENT_DRY_RUN=true`の再デプロイを必ず行う。
