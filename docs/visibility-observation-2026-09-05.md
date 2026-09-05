# 遅延表示フォームの空観測対策

> 個別実装時点の記録です。統合時点の状態は[信頼性改善の検証記録](reliability-improvements-2026-09.md)を参照してください。

CSV 111 の read-only 再現では DOM 候補 24 件が初回すべて不可視、次の観測ではフォーム 1 件・可視欄 15 件となった。フォームの祖先抽出失敗ではなく、可視性の時点差から NO_FORM_PRESENT を早期確定するケースだった。実サイトの再入力・再送は行っていない。

## 変更

空の観測に、正常検査できた type=hidden 以外の不可視候補がある場合だけ、500 ms 後に fresh DOM を一度再観測する。可視性フィルタを緩めず、hidden/inert/aria-hidden 祖先の通常 native 欄も除外する。追加観測の発生は browser_dom_observation.visibilityRechecked に記録し、durationMs は初回からの合計時間とする。

候補なしページは既存 DOM 発見予算のまま。hidden input のみ、検査失敗のみ、第三者 frame のみ、既に可視フォームがある観測にはこの再観測を追加しない。恒久非表示は追加 scan 後も空のまま。再送・追加クリック・入力を行う処理はない。

## 検証

- 旧実装: 初回全不可視→再観測で可視化する CDP シナリオが red（フォーム 0 件）。最小修正後 green。
- 通常 native 欄が rect-visible でも hidden/inert/aria-hidden 祖先内なら除外する 3 ケースも旧 red→green。
- 遅延可視化、恒久非表示、hidden input のみ、検査失敗、既存可視フォーム、真の候補なしを検証。
- product: typecheck/lint、unit 598 件、Worker 248 件成功。ログ時間集計調整後も typecheck と対象 9 件を再検証。
- test-system: delayed-visible-form、permanently-hidden-form、inert-form の 3 シナリオを追加。typecheck/lint、77 tests 成功。

## 管理下実行と限界

本番適用・管理下 green は統合担当が実施する。新規遅延 fixture は初期 hidden の native form を 4 秒後に表示し、標準 POST/303 で receiver 1 件を期待する。負例 2 件は NO_FORM_PRESENT / receiver 0 件。既存 email-only も真の no-form 負例として併用する。

4 秒という fixture の wall-clock delay だけでは、本番の CDP レイテンシにより旧実装が毎回失敗することまでは保証しない。決定的な red は初回/次回の状態を固定した local CDP シナリオで確認した。現実の表示がこの bounded scan より遅い場合、または一部の欄だけが先に表示される場合まで待機を拡張してはいない。実サイト固有の CSS 原因は未確定。
