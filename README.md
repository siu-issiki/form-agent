# form-agent

企業の問い合わせフォームへの営業送信を、安全かつ並列に実行するエージェント基盤です。

設計方針は [docs/architecture.md](docs/architecture.md) を参照してください。

## 開発

```bash
bun install
bun run typecheck
bun run lint
bun run test
```

現在は、重複した Consumer からの二重実行・二重送信を防ぐジョブ状態機械を実装しています。
