# 管理画面

本人だけが送信結果と証跡を見るための閲覧画面。`/admin` が送信状況、`/admin/jobs` が一覧、`/admin/jobs/:id` が詳細です。D1/R2を直接読み取り、送信・再送・ステータス変更の操作は持ちません。

## 表示と集計

- 期間、種別、ステータス、企業名・ドメイン・ジョブID、キャンペーンで検索。1ページ50件。
- 日付は日本時間。初期表示は直近14日、最大93日。
- 登録件数・状態分布は `jobs.created_at` が期間内のジョブを対象に、現在の状態を表示します。
- 日別の送信完了件数は `results.completed_at` が期間内、かつジョブ・結果とも送信完了のものを数えます。期間より前に登録され、その期間に完了したジョブも含みます。
- ステータスの絞り込みは一覧だけに適用します。上部の件数・日別推移は期間と種別・検索語・キャンペーンを共有します。
- 初期表示は通常の実送信。管理下免除フラグのあるジョブは管理下テスト、実効dry-runフラグ等でdry-runを分離します。過去の種別が確定できないジョブは種別不明に残します。
- 詳細は送信内容、状態の理由、時刻、試行回数、取得順の証跡を表示します。証跡取得失敗と、取得済み記録に対応するR2ファイルの欠落を区別します。

## 本番の認証設定

Cloudflare Accessの自己ホスト型アプリケーションで、Workerの `/admin` および `/admin/*` を保護し、本人のメールアドレスだけを許可します。既存のジョブAPIやQueueを含むWorker全体へAccessを掛けると現在のCLIが影響を受けるため、管理画面のパスだけを対象にしてください。

Worker側にも以下を設定します。実際のアドレスや認証設定値は公開Gitへ含めません。

- `ADMIN_EMAIL`: 許可する本人のメールアドレス1つ
- `ADMIN_ACCESS_ISSUER`: `https://<team>.cloudflareaccess.com`
- `ADMIN_ACCESS_AUDIENCE`: 管理画面AccessアプリケーションのAUD

[Cloudflare公式のJWT検証手順](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/) に沿い、RS256署名、issuer、audience、有効期限、本人emailを検証します。メールヘッダー単独や `JOB_API_TOKEN` は管理画面への入場に使えません。設定が欠けている場合は拒否します。

画面と証跡の全リクエストに認証を適用し、レスポンスはprivate/no-store、CSP、nosniff、no-referrerで返します。R2は公開せず、URLのイベントIDが当該ジョブの証跡として記録されていることとキーの所属を確認してから読みます。JPEG/PNG/JSONのみを返します。

本番反映時は認証設定を確認し、D1 migration `0008_admin_read_indexes.sql` を適用してWorkerをデプロイします。migrationは読み取り用インデックスの追加のみです。未ログイン・別アドレスの拒否と、本人の実データ表示を確認して公開完了とします。

## ローカルで表示を確認する

```sh
bun tools/admin-preview.ts
```

`http://127.0.0.1:8788/admin` を開きます。メモリ上のSQLiteと架空データだけを使い、環境ファイル・本番DB・本番R2・外部APIには接続しません。127.0.0.1にだけbindするプレビュー専用プロセスで、本番Workerから到達する経路はありません。

`/preview-form` は架空の受付画面です。そのスクリーンショットを `artifacts/admin-dashboard/preview-evidence.png` に保存すると証跡プレビューへ表示します。画像がない場合はファイル欠落の表示になります。`artifacts/` はGit対象外です。

## 検証

`test/admin.test.ts` で、実際の署名鍵から作ったJWTとHTTP鍵取得のモックを使い、本人認証・拒否・設定欠落を確認します。同テストでJST境界、種別分離、文字列検索、ページング、HTMLエスケープ、証跡所属、R2欠落、HTML証跡の拒否、空状態、DBエラーを検証します。

`bun run typecheck`、`bun run lint`、`bun run test` と Wrangler deploy dry-run を実行します。認証設定・本番デプロイ・本番ログインの検証はローカルテストやCIとは別です。
