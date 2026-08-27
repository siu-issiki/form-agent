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
