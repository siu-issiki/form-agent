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

登録成功は`201`、同じID・同じ内容のジョブが既に存在する場合は`200`を返します。既存ジョブが`pending`なら、作成後のQueue投入失敗から復旧できるよう再度Queueへ投入します。同じIDで内容が異なる場合は、既存情報を返さず`409`とします。`GET /jobs/:id`は同じBearer認証で現在状態を返します。いずれのレスポンスにも実行権を表す`runToken`は含めません。一覧・キャンセルAPIは未実装です。

BrowserUse は Agent API ではなく standalone browser API だけを使用します。top-level navigationと入力後の通信は対象ドメイン内に制限し、入力前の公開HTTPS read-only subresourceだけを許可します。送信は D1 上で `running` から `submitting` へ遷移できたジョブにだけ許可します。

実BrowserUse/CDPの送信なしスモークテストは、追跡対象外の`.env`へ`BROWSER_USE_API_KEY`を設定して`bun run test:browser-use-smoke`で実行します。このテストは公開テストフォームの観察と入力、送信ボタンの通常click拒否、対象外ドメイン遷移拒否を確認し、フォーム送信は行いません。通常の`bun run test`には含めず、外部セッションを明示実行時だけ作成します。

実Queue/D1/Responses API/BrowserUseを通す送信なしE2Eは、`.env`へ`OPENAI_API_KEY`と`BROWSER_USE_API_KEY`を設定して`bun run test:agent-e2e`で実行します。専用の`wrangler dev`環境を一時ディレクトリへ起動し、標準ではSelenium公式サイトの空ページ1件をQueue bindingへ登録します。`E2E_TARGET_URL=https://example.co.jp/contact bun run test:agent-e2e`のように実フォームを指定した場合も、`AGENT_DRY_RUN=true`を強制します。モデルには`submit`ツールを公開したまま、Workerが送信対象と同じフォームへの入力成功、現在のsubmit要素、native form validityを実ブラウザで検証し、D1の送信権取得とブラウザsubmitより前に`DRY_RUN_COMPLETE`で終了するため、フォーム送信は行いません。dry-runではジョブURLへの初回遷移後の`navigate`と、最初のclick / fill / select後に発生するbrowser requestを遮断します。終了時にWorkerと一時データを破棄します。外部API利用料が発生するため、通常の`bun run test`には含めません。

production Workerを使う送信なしE2Eは、productionの`JOB_API_TOKEN`と同じ値を一時的な環境変数へ設定し、`bun run test:agent-e2e:production`で実行します。スクリプトはジョブpayloadの`_formAgentDryRun: true`でもdry-runを強制し、リモートの環境変数が誤って解除されても実送信しません。さらに`submitting`または`sent`を観測した場合に即失敗し、1 attemptで`prohibited`かつ`DRY_RUN_COMPLETE`へ到達した場合だけを成功とします。通常のCIは外部APIを呼ばず、typecheck、lint、unit / Workers test、`wrangler deploy --dry-run`だけを実行します。

## CSVキャンペーンのdry-run

登録情報JSONと送信対象CSVはリポジトリへ追加せず、ローカルパスから読み込みます。インポーターは送信済み・NGチェック該当・HTTPS以外を除外し、登録情報の日本語labelを固定のASCII form keyへ変換します。IDはキャンペーン名・企業ドメイン・フォームURLから安定生成し、previewには値・本文・メールアドレス・電話番号を出しません。

```bash
bun run campaign:dry-run \
  --registration /path/to/registration.json \
  --choices /path/to/choices.json \
  --csv /path/to/targets.csv \
  --campaign agb-shaken-2026-09-dryrun-v1 \
  --limit 5
```

`--choices`は省略できます。指定する場合のJSONは`Record<string, string[]>`で、値は「登録者が事前に許可した選択肢の順序付き集合」です。信頼済みhandlerが対象コントロールのoption値・option text・ラベルと完全一致する最初の候補を選び、一致しなければ入力せずエラーにします。候補は1〜10要素、各要素1〜256文字、合計2,048文字以下で、キーが登録情報・件名・本文と衝突した場合はエラーになります。書式は`docs/examples/campaign-choices.example.json`を参照してください。

プライバシーポリシー同意などの必須checkboxをagentに操作させるかは運用判断です。サンプルには含めていません。同意させる場合だけ、`privacyConsent`のようなキーへ`["checked"]`を指定します。

productionへ登録する場合だけ`JOB_API_TOKEN`を環境変数へ設定し、同じコマンドへ`--submit-dry-run`を追加します。生成ジョブは必ず`_formAgentDryRun: true`と`_formAgentMaxAttempts: 1`を持ち、再試行と`submitting` / `sent`を防ぎます。成功条件は各ジョブが1 attemptで`prohibited / DRY_RUN_COMPLETE`になることです。

## エージェント実行境界

Queue Consumer は `AgentRuntime` の結果契約を使い、WorkerからOpenAI Responses APIを直接呼び出します。モデルへ渡すジョブ情報から`runToken`を除外し、OpenAIとBrowserUseの認証情報はWorkerの環境変数にだけ保持します。

Responses APIのfunction callingはstrict schema、1ターン1toolで処理します。Worker側でモデル、request/response本文サイズ、出力token、最大turn、1 runの呼び出し回数を固定し、D1の条件付き更新でProvider予算を原子的に消費します。

Worker内の信頼済みhandlerがBrowserUseへCDP接続し、モデルには`navigate` / `observe` / `click` / `fill` / `select` / `submit` / `finish`の高レベルtool定義だけを渡します。`fill` / `select`ではモデルが生の値ではなく`payload.formValues`内の`payloadKey`だけを指定し、handlerがD1の保存値を解決します。`formValues`の値は単一文字列か選択肢候補リストのいずれかで、候補リストは`select`だけが受け取り、handlerがページ上の選択肢と完全一致する最初の候補を適用します。BrowserUse認証情報とCDP URLはモデルへ渡さず、対象ドメイン外の通信とService Worker経由の迂回を遮断します。browser sessionはREST API v4で明示的に作成し、実行終了時は接続を閉じたうえでsessionを`stop`します。CDPを切断してもmanaged browserは停止しないため、stopを省くと同時session枠を寿命まで占有します。

production executorは`AGENT_EXECUTOR_ENABLED=true`、`AGENT_MODEL`、`OPENAI_API_KEY`、`BROWSER_USE_API_KEY`がすべて設定された場合だけ有効になります。いずれかが不足する場合は`EXECUTOR_NOT_CONFIGURED`でfail-closedに終了します。

`AGENT_DRY_RUN`が明示的な`false`以外の場合は`submit`ツール自体をモデルへ公開したまま、信頼済みWorker handlerが送信権取得・ブラウザsubmitより前にearly-returnします。productionは実送信を有効にしています。実効モードはジョブ登録時に保存され、後のdeployでは変わりません。旧形式のジョブは常にdry-runとして扱います。送信なし検証ではジョブpayloadへbooleanの`_formAgentDryRun: true`を指定すると、production設定より優先してdry-runを強制できます。

executor は `sent` / `prohibited` / `uncertain` / `failed` の構造化結果だけを返します。`sent` は制限付き `submit` ツールが D1 へ結果を保存済みの場合だけ確定し、送信権取得後の切断や矛盾した結果は `uncertain` として自動再試行を止めます。
