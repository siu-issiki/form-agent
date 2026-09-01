# form-agent

企業の問い合わせフォームへの営業送信を、安全かつ並列に実行するエージェント基盤です。

設計方針は [docs/architecture.md](docs/architecture.md) を参照してください。

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

BrowserUse は Agent API ではなく standalone browser API だけを使用します。ブラウザ操作層は対象ドメイン内のみに制限し、送信は D1 上で `running` から `submitting` へ遷移できたジョブにだけ許可します。

実BrowserUse/CDPの送信なしスモークテストは、追跡対象外の`.env`へ`BROWSER_USE_API_KEY`を設定して`bun run test:browser-use-smoke`で実行します。このテストは公開テストフォームの観察と入力、送信ボタンの通常click拒否、対象外ドメイン遷移拒否を確認し、フォーム送信は行いません。通常の`bun run test`には含めず、外部セッションを明示実行時だけ作成します。

実Queue/D1/Sandbox/Pi/OpenAI/BrowserUseを通す送信なしE2Eは、`.env`へ`OPENAI_API_KEY`と`BROWSER_USE_API_KEY`を設定して`bun run test:agent-e2e`で実行します。専用の`wrangler dev`環境を一時ディレクトリへ起動し、Selenium公式サイトの空ページに固定した1ジョブをQueue bindingへ登録します。ジョブが送信以外の終端状態へ遷移すること、Provider呼び出しがD1へ記録されること、再試行がないことを確認し、終了時にWorker・Container・一時データを破棄します。外部API利用料が発生するため、通常の`bun run test`には含めません。

## エージェント実行境界

Queue Consumer は `AgentRuntime` の結果契約を使います。Cloudflare Sandbox 1.0 preview上でPi 0.74.0 runnerを起動し、D1操作とProvider認証情報はコンテナへ渡さずoutbound handler内に保持します。コンテナの外向き通信は内部tool hostとOpenAI APIだけを許可します。

内部tool hostが公開する状態参照はrun tokenで絞り込み、D1の送信状態を直接更新するAPIはrunnerへ公開しません。OpenAI通信はHTTPS interceptionを必須とし、Worker側でモデル、本文サイズ、出力token、tool種別、1 runの呼び出し回数を制限します。

ブラウザはSandbox Durable Object内の信頼済みhandlerがBrowserUseへCDP接続し、runnerには`navigate` / `observe` / `click` / `fill` / `select` / `submit`の高レベルtoolだけを公開します。BrowserUse認証情報とCDP URLはrunnerへ渡さず、対象ドメイン外の通信とService Worker経由の迂回を遮断し、runner終了時に接続を閉じます。

production executorは`AGENT_EXECUTOR_ENABLED=true`、`AGENT_MODEL`、`OPENAI_API_KEY`、`BROWSER_USE_API_KEY`がすべて設定された場合だけ有効になります。いずれかが不足する場合は`EXECUTOR_NOT_CONFIGURED`でfail-closedに終了します。

runner は `sent` / `prohibited` / `uncertain` / `failed` の構造化結果だけを返します。`sent` は制限付き `submit` ツールが D1 へ結果を保存済みの場合だけ確定し、送信権取得後の切断や矛盾した結果は `uncertain` として自動再試行を止めます。
