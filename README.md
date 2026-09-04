# form-agent

企業の問い合わせフォームへの営業送信を、安全かつ並列に実行するエージェント基盤です。

設計方針は [docs/architecture.md](docs/architecture.md) を参照してください。
本番停止・照合・再開手順は [docs/operations.md](docs/operations.md) を参照してください。

## 開発

```bash
bun install
bun run typecheck
bun run lint
bun run test
bun run db:migrate:local
bun run dev
```

ローカル開発では Miniflare 上の D1 と Queue を使用します。Queue の最大並列数はローカル実行では再現されないため、D1 の条件付き更新と重複配信テストで二重実行を防ぎます。

## ジョブ API

`JOB_API_TOKEN`をCloudflare Secret（ローカルでは追跡対象外の`.env`）へ設定すると、Bearer認証付きの登録・取得APIを利用できます。未設定時はAPIをfail-closedで拒否し、`GET /health`だけを認証なしで公開します。

```http
POST /jobs
Authorization: Bearer <JOB_API_TOKEN>
Content-Type: application/json

{
  "id": "job-001",
  "companyId": "company-001",
  "companyName": "Example Inc.",
  "targetUrl": "https://forms.gle/example",
  "targetDomain": "example.com",
  "allowedHosts": ["forms.gle", "docs.google.com"],
  "payload": {
    "formValues": { "message": "お問い合わせ内容" }
  }
}
```

`targetDomain`は企業の登録可能ドメインです。フォームが外部サービスにある場合だけ、CSVのフォームURLと事前に解決したredirect先の**完全一致hostname**をジョブ固有の`allowedHosts`へ設定します。許可は他ジョブへ共有されず、`google.com`のような上位ドメインへ自動拡張しません。

登録成功は`201`、同じID・同じ内容のジョブが既に存在する場合は`200`を返します。既存ジョブが`pending`なら、作成後のQueue投入失敗から復旧できるよう再度Queueへ投入します。同じIDで内容が異なる場合は、既存情報を返さず`409`とします。実送信になるジョブ（`AGENT_DRY_RUN=false`かつpayloadに`_formAgentDryRun: true`が無い）は、承認記録`_formAgentSendApproval`が無ければ`400 SEND_APPROVAL_REQUIRED`、承認が指すdry-runが同じフォームURLで完了していなければ`400 DRY_RUN_NOT_COMPLETED`、そのdry-runと内容が一致しなければ`400 DRY_RUN_CONTENT_MISMATCH`、当日（UTC）の実送信件数が`REAL_SEND_DAILY_CAP`に達していれば`429 REAL_SEND_CAP_REACHED`で拒否します。`pending`のまま日を跨いだ実送信ジョブの再登録は再queueせず`409 REAL_SEND_STALE`を返します。承認記録・dry-run突合・日次上限の3つは、`targetDomain`が`REAL_SEND_GUARD_EXEMPT_DOMAINS`（カンマ区切りの登録可能ドメイン）と一致するか、その配下のホストである場合だけ免除します。**この免除は管理下テストシステム専用です。実サイトのドメインを入れてはいけません。**`GET /jobs/:id`は同じBearer認証で現在状態を返します。いずれのレスポンスにも実行権を表す`runToken`は含めません。一覧・キャンセルAPIは未実装です。

BrowserUse は Agent API ではなく standalone browser API だけを使用します。top-level navigationと入力後の通信は対象ドメイン内に制限し、入力前の公開HTTPS read-only subresourceだけを許可します。送信は D1 上で `running` から `submitting` へ遷移できたジョブにだけ許可します。

実BrowserUse/CDPの送信なしスモークテストは、追跡対象外の`.env`へ`BROWSER_USE_API_KEY`を設定して`bun run test:browser-use-smoke`で実行します。このテストは公開テストフォームの観察と入力、送信ボタンの通常click拒否、対象外ドメイン遷移拒否を確認し、フォーム送信は行いません。通常の`bun run test`には含めず、外部セッションを明示実行時だけ作成します。

実Queue/D1/Responses API/BrowserUseを通す送信なしE2Eは、`.env`へ`OPENAI_API_KEY`と`BROWSER_USE_API_KEY`を設定して`bun run test:agent-e2e`で実行します。専用の`wrangler dev`環境を一時ディレクトリへ起動し、標準ではSelenium公式サイトの空ページ1件をQueue bindingへ登録します。`E2E_TARGET_URL=https://example.co.jp/contact bun run test:agent-e2e`のように実フォームを指定した場合も、`AGENT_DRY_RUN=true`を強制します。モデルには`submit`ツールを公開したまま、Workerが送信対象と同じフォームへの入力成功、現在のsubmit要素、native form validityを実ブラウザで検証し、D1の送信権取得とブラウザsubmitより前に`DRY_RUN_COMPLETE`で終了するため、フォーム送信は行いません。dry-runではジョブURLへの初回遷移後の`navigate`と、最初のclick / fill / select後に発生するbrowser requestを遮断します。終了時にWorkerと一時データを破棄します。外部API利用料が発生するため、通常の`bun run test`には含めません。

production Workerを使う送信なしE2Eは、productionの`JOB_API_TOKEN`と同じ値を一時的な環境変数へ設定し、`bun run test:agent-e2e:production`で実行します。スクリプトはジョブpayloadの`_formAgentDryRun: true`でもdry-runを強制し、リモートの環境変数が誤って解除されても実送信しません。さらに`submitting`または`sent`を観測した場合に即失敗し、1 attemptで`prohibited`かつ`DRY_RUN_COMPLETE`へ到達した場合だけを成功とします。通常のCIは外部APIを呼ばず、typecheck、lint、unit / Workers test、`wrangler deploy --dry-run`だけを実行します。

## CSVキャンペーンのdry-run

登録情報JSONと送信対象CSVはリポジトリへ追加せず、ローカルパスから読み込みます。インポーターは送信済み・NGチェック該当・HTTPS以外を除外し、登録情報の日本語labelを固定のASCII form keyへ変換します。IDはキャンペーン名・企業ドメイン・フォームURLから安定生成し、previewには値・本文・メールアドレス・電話番号を出しません。

CSVは2つの形式を受け付けます。ヘッダーに`問い合わせリンク` / `件名` / `本文`が揃っている場合は簡易形式として読み、企業ドメインはフォームURLのホストから導出します。この形式にはNGチェック列も企業名列も無いため、チェック列による除外は行わず、企業名にはホスト名を入れます（`companyId`は従来どおり登録可能ドメインから決まります）。除外理由は本文または件名が空なら`empty_message`、URLが空なら`missing_form_url`、httpsでない・ホストが不正なら`invalid_or_insecure_form_url`、ホストは有効でも登録可能ドメインを導出できない（public suffix そのものなど）場合は`invalid_company_domain`です。それ以外のヘッダーは従来の30列形式として扱い、必須列が欠けていればエラーにします。`sourceRow`はどちらの形式でもヘッダーを1行目としたCSVの行番号です。

登録情報JSONはlabel名で照合するため、項目の順序と件数は自由です。別名を受け付ける項目は「氏名（フルネーム漢字）」=`フルネーム漢字`、「氏名（フルネームカタカナ）」「フリガナ」=`フルネームカタカナ`、「氏名（フルネームひらがな）」「ふりがな」=`フルネームひらがな`、「苗字（カタカナ）」「名前（カタカナ）」=`苗字（カナ）`「名前（カナ）」、「電話1〜3」=`電話番号1〜3`、「部署名」=`部署`で、正規のlabelと別名が両方ある場合は正規のlabelが勝ちます。`役職`（jobTitle）と`年齢`（age）も取り込みます。`電話番号`が2件ある場合は1件目を`phone`、2件目を数字のみの`phoneDigits`として扱い、1件だけなら両方に同じ値を入れます。値が空の項目と未知のlabelは無視し、`campaign_registration_summary`にはlabel名を出さず件数（`mappedKeys` / `unknownLabels`）だけを出力します。`fullName` / `lastName` / `firstName` / `email` / `phone` / `companyName`が揃わない場合はエラーで停止します。

```bash
bun run campaign:dry-run \
  --registration /path/to/registration.json \
  --choices /path/to/choices.json \
  --csv /path/to/targets.csv \
  --campaign agb-shaken-2026-09-dryrun-v1 \
  --offset 0 \
  --limit 5
```

`--limit`は1〜50、`--offset`は0以上の整数で、既定値はそれぞれ5と0です。適格行の並び（`filterCampaignRows`が返す順序）の先頭から`--offset`件を読み飛ばし、続く`--limit`件を対象にします。窓は適格行の並びに対して固定されるため、redirect preflightで落ちた行もその枠を消費し、同じ`--offset`は常に同じ行を指します。適格行が足りない場合と、選ばれた行が1件でもpreflightで落ちた場合はexit 1になります。次の50件は`--offset 50`のように送ります。

`--limit`を5より大きくしても、生成ジョブが`_formAgentDryRun: true`固定であることと、実送信経路を持たないことは変わりません。増えるのは1回の実行で検証する件数だけです。

選択肢候補は既定でツールに同梱されており、`--choices`なしでも`inquiryType` / `contactMethod` / `privacyConsent`が適用されます。内容は`src/campaign-import.ts`の`DEFAULT_CHOICE_CANDIDATES`にあり、同じものを`docs/examples/campaign-choices.example.json`に置いています。

`--choices`を指定すると、そのファイルがキー単位で既定を上書きします（ファイル側が勝ち、ファイルに無いキーは既定のまま残ります）。JSONは`Record<string, string[]>`で、値は「登録者が事前に許可した選択肢の順序付き集合」です。信頼済みhandlerが対象コントロールのoption値・option text・ラベルと完全一致する最初の候補を選び、一致しなければ入力せずエラーにします。候補は1〜10要素、各要素1〜256文字、合計2,048文字以下で、キーが登録情報・件名・本文と衝突した場合はエラーになります。既定とファイルをマージした結果も同じ契約で検証します。

既定の`privacyConsent: ["checked"]`は、プライバシーポリシー同意チェックボックスを自動でチェックするという運用判断です。同意を自動化したくない場合は`--no-default-choices`を付けて既定セット全体を無効化し、必要なキーだけを`--choices`のファイルで渡してください。`--no-default-choices`と`--choices`を併用した場合は、ファイルの内容だけが適用されます。

productionへ登録する場合だけ`JOB_API_TOKEN`を環境変数へ設定し、同じコマンドへ`--submit-dry-run`を追加します。生成ジョブは必ず`_formAgentDryRun: true`と`_formAgentMaxAttempts: 1`を持ち、再試行と`submitting` / `sent`を防ぎます。成功条件は各ジョブが1 attemptで`prohibited / DRY_RUN_COMPLETE`になることです。

同じ`--campaign`名で登録値・件名・本文・選択肢を変えて再実行しないでください。ジョブIDはcampaign名・企業ドメイン・フォームURLから決まるため、内容を変えても同じIDになります。登録レスポンスが失われた際の存在確認は入力の一致まで検証するので、不一致は`REGISTRATION_UNKNOWN`として扱われexit 1になります。入力を変える場合はcampaign名も変えてください。

## CSVキャンペーンの実送信

実送信ジョブを作れるのは`campaign:send`だけです。`campaign:dry-run`は`_formAgentDryRun: true`固定のままで、実送信できません。

実行前に、対象行がすべてdry-runを通り`prohibited / DRY_RUN_COMPLETE`で終わっていること、production Workerに`REAL_SEND_DAILY_CAP`が設定されていることを確認してください。手順の全体は[docs/operations.md](docs/operations.md)の「実送信のrunbook」にあります。

```bash
JOB_API_TOKEN=... bun run campaign:send \
  --registration /path/to/registration.json \
  --csv /path/to/targets.csv \
  --approved /path/to/approved.json \
  --campaign agb-shaken-2026-09-send-v1 \
  --max-sends 5 \
  --confirm-real-send
```

`--confirm-real-send`が無い場合、ツールはCSVも承認ファイルも読まずにexit 1で終了します。`--max-sends`の既定は5、上限は50で、承認ファイルのentriesがこれを超えるとexit 1になります。`--choices`と`--no-default-choices`はdry-runと同じ意味です。`--campaign`はdry-runと別の名前にしてください。ジョブIDはcampaign名・企業ドメイン・フォームURLから決まるため、同じ名前だと409 `JOB_ID_CONFLICT`になります。

承認ファイルは「誰がいつどの行を承認したか」の記録です。

```json
{
  "approvedBy": "sales-ops@example.com",
  "approvedAt": "2026-09-04T09:00:00.000Z",
  "entries": [
    { "sourceRow": 12, "dryRunJobId": "<dry-runのjobId>", "note": "目視確認済み" }
  ]
}
```

`sourceRow`はCSVの行番号（ヘッダーを1行目とする2以上の整数）で、dry-runジョブのpayloadの`sourceRow`と同じ定義です。`dryRunJobId`はdry-runの`campaign_job_result`ログに出た`jobId`です。`sourceRow`と`dryRunJobId`の重複は拒否します。サンプルは[docs/examples/campaign-send-approval.example.json](docs/examples/campaign-send-approval.example.json)にあります。承認ファイルと登録情報JSONはリポジトリへ追加せず、ローカルパスから読み込みます。

各行は登録前に`GET /jobs/<dryRunJobId>`でdry-runの完了と内容の一致を確認し、満たさない行は登録せず`APPROVAL_MISMATCH`として集計します。内容の比較は`targetUrl` + `companyId` + `payload.formValues`のSHA-256で、承認したdry-runと違う本文や入力値では送信できません。Worker側でも`POST /jobs`が承認記録（400 `SEND_APPROVAL_REQUIRED`）、dry-run完了（400 `DRY_RUN_NOT_COMPLETED`）、内容の一致（400 `DRY_RUN_CONTENT_MISMATCH`）、当日（UTC）の日次上限（429 `REAL_SEND_CAP_REACHED`）を検証します。`REAL_SEND_DAILY_CAP`は未設定なら0で、実送信ジョブを一切受け付けません。`REAL_SEND_GUARD_EXEMPT_DOMAINS`に載せたドメイン宛のジョブだけがこの3つの検証と日次上限を免除され、`real_send`としても数えません。管理下テストシステム（`form-agent.workers.dev`配下）の回帰確認のためのもので、実サイトのドメインを入れると人間の承認なしに送信できてしまいます。承認記録はモデルにも送信前レビューにも渡しません。

承認されたentriesがすべて`sent`または`prohibited`で終わった場合だけexit 0になります。`prohibited`は実サイト側の判断による正常な終了です。

## エージェント実行境界

Queue Consumer は `AgentRuntime` の結果契約を使い、WorkerからOpenAI Responses APIを直接呼び出します。モデルへ渡すジョブ情報から`runToken`を除外し、OpenAIとBrowserUseの認証情報はWorkerの環境変数にだけ保持します。

Responses APIのfunction callingはstrict schema、1ターン1toolで処理します。Worker側でモデル、request/response本文サイズ、出力token、最大turn、1 runの呼び出し回数を固定し、D1の条件付き更新でProvider予算を原子的に消費します。

Worker内の信頼済みhandlerがBrowserUseへCDP接続し、モデルには`navigate` / `observe` / `click` / `fill` / `select` / `submit` / `finish`の高レベルtool定義だけを渡します。`fill` / `select`ではモデルが生の値ではなく`payload.formValues`内の`payloadKey`だけを指定し、handlerがD1の保存値を解決します。`formValues`の値は単一文字列か選択肢候補リストのいずれかで、候補リストは`select`だけが受け取り、handlerがページ上の選択肢と完全一致する最初の候補を適用します。BrowserUse認証情報とCDP URLはモデルへ渡さず、対象ドメイン外の通信とService Worker経由の迂回を遮断します。browser sessionはREST API v4で明示的に作成し、実行終了時は接続を閉じたうえでsessionを`stop`します。CDPを切断してもmanaged browserは停止しないため、stopを省くと同時session枠を寿命まで占有します。

production executorは`AGENT_EXECUTOR_ENABLED=true`、`AGENT_MODEL`、`OPENAI_API_KEY`、`BROWSER_USE_API_KEY`がすべて設定された場合だけ有効になります。いずれかが不足する場合は`EXECUTOR_NOT_CONFIGURED`でfail-closedに終了します。

`AGENT_DRY_RUN`が明示的な`false`以外の場合は`submit`ツール自体をモデルへ公開したまま、信頼済みWorker handlerが送信権取得・ブラウザsubmitより前にearly-returnします。productionは実送信を有効にしています。実効モードはジョブ登録時に保存され、後のdeployでは変わりません。旧形式のジョブは常にdry-runとして扱います。送信なし検証ではジョブpayloadへbooleanの`_formAgentDryRun: true`を指定すると、production設定より優先してdry-runを強制できます。

executor は `sent` / `prohibited` / `uncertain` / `failed` の構造化結果だけを返します。`sent` は制限付き `submit` ツールが D1 へ結果を保存済みの場合だけ確定し、送信権取得後の切断や矛盾した結果は `uncertain` として自動再試行を止めます。
