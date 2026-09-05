# 継続送信runner

固定したCSVの残り行を、通常direct承認のまま最大20件inflightで継続登録する。20件の終端を待たず、空き枠ができたら次の1行を補充する。総件数の上限ではない。

## 初回準備（外部APIなし）

```sh
bun tools/campaign-continuous.ts prepare \
  --state /absolute/path/to/sender-state \
  --csv /absolute/path/to/campaign.csv \
  --registration /absolute/path/to/registration.json \
  --choices /absolute/path/to/choices.json \
  --campaign stripe-20260905-continuous-v1 \
  --start-row 109 --approved-by siu \
  --release d30b4ef1-bd74-4e92-b272-68525bcce20c
```

`--choices`は任意の候補リスト上書きで、元defaultsとマージした結果を固定する。今回初回は「その他問い合わせ」を含む候補を使う。原本は変更せず、mode700のstate内`private/`へmode600でコピーし、CSV・登録値・choicesのSHA-256と行番号・domain・deterministic job ID・内容fingerprintを`manifest.json`に固定する。初期controlはpause状態。全行のremote preflightは行わない。重複domain・資料請求URL・採用URLを除外する。

## 起動・再開

環境に`JOB_API_TOKEN`または`FORM_AGENT_JOB_API_TOKEN`を設定する。`.env.e2e`を使える。初回起動前に差分レビューと本番release確認を済ませる。

```sh
nohup bun --env-file=.env.e2e tools/campaign-continuous.ts run \
  --state /absolute/path/to/sender-state --confirm-real-send \
  > /absolute/path/to/sender-state/runner.log 2>&1 < /dev/null &

bun tools/campaign-continuous.ts resume \
  --state /absolute/path/to/sender-state \
  --release d30b4ef1-bd74-4e92-b272-68525bcce20c
```

再開も同じstateとcampaignを使う。PID lockで複数writerを拒否し、死んだPIDのlockだけを回収する。`registration_intent`をfsyncした後でPOSTするため、応答喪失・crash後も同じIDのGETだけで照合し、POSTを繰り返さない。intent後に実際のPOSTが行われず404が続く場合も、枠を解放せず新規登録を停止する。

枠を使う直前にredirectを解決し、最終URLの用途を検査し、本番D1の全`real_send=1`ドメインと照合する。既往failed/uncertainも再送しない。payloadは`prepared/<jobId>.json`の`{job,sha256}`として保存してから登録し、最大試行1回、direct承認、画像・入力・用途のruntime guardを維持する。通常domainを管理下テスト免除へ追加しない。

## デプロイ時のpause/drain/resume

```sh
bun tools/campaign-continuous.ts pause --state /absolute/path/to/sender-state
bun tools/campaign-continuous.ts status --state /absolute/path/to/sender-state
```

pauseは新規登録だけを止め、activeを監視する。返されたcontrolの`revision`とstatusの`observedControlRevision`が一致し、`drained:true`かつ`activeCount:0`になった場合にだけ本番更新へ進む。過去のstatusにactive0があるだけではdrain確認にならない。controlはrootからatomicに直接置き換えることもできる。

```json
{"revision":"unique-revision","pauseNewAdmissions":true,"releaseVersion":"d30b4ef1-bd74-4e92-b272-68525bcce20c"}
```

deploy・管理下green後、`resume --release <新version>`で新しいrevisionを発行する。runnerは新規投入ごとにそのversionが本番100%であることをread-only確認し、新規行だけに反映する。既登録行はそのまま監視する。

3回連続で照会が解決しない、jobが20分経過、D1履歴やreleaseの確認に失敗した場合はhaltを記録し、新規登録を止める。activeは監視し続ける。原因解決後にrootが`resume --release ... --clear-halt`を使う。未解決のactiveや古いjobがあれば再び停止する。`SIGTERM`/`SIGINT`も新規を止め、activeの終端後に終了する。

## 記録・証跡

- `manifest.json`: frozen source hashes・行identity・除外理由。書き換えない。
- `control.json`: rootのpause/release指示。
- `status.json`: PID、control revision、active、remaining、terminal/excluded件数、halt、drained。
- `journal.jsonl`: intent、照合済みregistered、terminal、excluded、lookup_error、halt。payloadやsecretは出さない。
- terminalイベント: jobId/sourceRow/domain/status/reasonCodeとevidence object keys。R2収集は別collectorで行い、補充をブロックしない。

manifestの除外行には同じjobIdが現れる場合があるが、登録対象行のjobIdは一意。terminal/failed/uncertainを新規IDで再投入しない。raw payloadと個人情報はprivate/preparedにだけ置く。

将来のchoices更新は、未着手かつprepared/intent無しの行だけに新しいimmutable choices versionを割り当てる必要がある。現在のrunnerは一つのmanifest・choicesを不変とし、稼働中の差し替えを行わない。

## 検証

`bun test test/continuous-state.test.ts`は外部APIを呼ばず、slot補充、unknown保持、intent/crash再開、pause競合、release gate、domain除外、timeout/halt、durable journal、single writer、API応答の内容照合を検証する。

clear-haltはactive照会の前に一度だけ適用し、その照会で発見した不整合やtimeoutは再度停止します。release確認を以前のrevisionから使い回しません。
