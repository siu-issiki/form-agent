# 登録 URL の fragment を初期遷移許可に保持する

> 個別実装時点の記録です。統合時点の状態は[信頼性改善の検証記録](reliability-improvements-2026-09.md)を参照してください。

19:41 の継続 campaign failed 14 件中 6 件（追加調査では 9 件）に、fragment 付き登録 URL と bootstrap_navigate / NAVIGATION_POLICY の反復が共通していた。最終 PROVIDER_RESPONSE_INVALID は二次結果で、provider 全体の障害を意味しない。実サイトへの入力・送信・再登録は行っていない。

## 原因と変更

初期許可の登録だけが canonicalNavigationUrl で hash を除去していた。一方、navigate の許可照合は canonicalNavigationPermissionUrl で hash を保持する。登録 #contact は許可集合に存在せず、driver.navigate 前に拒否されていた。

constructor の初期許可も canonicalNavigationPermissionUrl(targetUrl) に揃える。登録 URL を変更せず、既存 navigation 比較・ネットワーク制限・送信許可は維持する。これは未観測の別 hash/query や外部 URL を許可する変更ではない。

## 検証

専用 worktree の local シナリオを先に追加し、旧実装で 4 fail / 3 pass、最小変更後 7 pass を確認した。

- 登録 #contact / #/contact は初回遷移 1 回、同一 URL の再呼出は no-op。
- 登録 fragment に対する未観測の別 fragment、query 追加、fragment 除去、外部 URL は拒否。
- 初回遷移後に観測された別 anchor は通常どおり遷移可能。
- product typecheck / lint / unit 627 件 / Worker 248 件が全成功。
- test-system typecheck / lint / 78 tests が全成功。

## 管理下シナリオ

native-post-fragment を追加。run 作成 API が #contact を持つ targetUrl を返し、ページの form id=contact に標準 POST フォームを置く。完了は通常の 303、expected sent / receiver 1 件。テストでは fragment 登録、正しいページ配信、受信と finalization の契約も確認した。

本番 deploy と管理下 agent green は統合担当が行う。実先の目的適合性や CAPTCHA 通過・送信成功を確認したものではない。
