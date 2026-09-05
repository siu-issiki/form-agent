# 常設の確認案内が送信完了を隠す問題

> 個別実装時点の記録です。統合時点の状態は[信頼性改善の検証記録](reliability-improvements-2026-09.md)を参照してください。

## 再現

管理下 `input-button-confirm` の run `26cede14-1007-438f-bb20-31edff467395`、job `test-system-input-button-confirm-95b280e8-c568-4a51-8952-6a9901999e29` は attempt 1 / receiver accepted 1 にもかかわらず `uncertain / SUBMIT_CONFIRMATION_NOT_OBSERVED` だった。フォーム消去後も常設の「必須項目を入力し、確認画面で内容を確認してから送信してください。」が残り、後から表示された「送信が完了しました。ありがとうございました。」よりページ全体の pending 判定が優先された。

元 fixture と managed ログを `artifacts/static-guidance-20260905/` に保存した。c673dfb 基準の実 reader / driver テストで旧版の positive 2 件が失敗することを先に確認した（red.log）。実サイトへの入力・再送は行っていない。

## 変更条件

次の条件を全て満たす場合だけ、常設の pending 行を完了判定の拒否理由から除く。

- 同じ body backendNodeId の送信前スナップショットがあり、現在の全 pending 行が送信前の行と完全一致する。
- 受付文言が送信前の全候補に存在せず、現在新しく一致する。FAQ の表示例は既存の除外条件を維持する。
- 「まだ送信」「完了していません」等、既存の明示未完了表現がない。
- form（非表示を含む）、入力・選択・ボタン・ARIA 操作要素・onclick 要素が現在の body に存在しない。
- CDP の現在の document tree に iframe / frame / contentDocument / Shadow DOM がなく、ページの selector で消失確認できる。

送信リクエスト観測、frame、成功/失敗優先順位、再操作制御は変更しない。事前の文言はメモリ内だけに保持し、新たな本文ログ・D1・R2 保存は追加しない。比較は最大 20 行（各 500 文字）/ 受付 20 候補を上限にし、超過時は例外を適用しない。

## 検証と限界

typecheck / lint / unit 682 件 / Worker 248 件が成功。対象 13 件は green。フォーム残存、新規確認見出し、明示未完了、送信前からある受付文言（複数候補の順序変化も含む）、FAQ、未観測 POST、body 交換、閉じた Shadow DOM を含む。Shadow DOM 残存と複数旧候補のケースも red → green を保存した。

ヘッダーの検索フォームやボタン、iframe / Shadow DOM が残る完了ページは今回の例外対象外。静的案内の改行や本文が変わる場合も保守的に uncertain を維持する。これらの制限を緩めるには別の実証が必要。

独立レビュー・本番反映後は管理下 `input-button-confirm` を新規 run で実行し、sent / attempt 1 / receiver 1 と結果 JSON を確認する。合わせて `input-button-send` と `input-button-unknown` で直接送信・未知応答の receiver 1 を維持する。本変更時点で本番 green は未実施。

## 独立レビュー指摘への追加対応

Medium 2 件を追加修正した。

1. 既存受付の先頭・内部改行、空白、英字大小文字の変更だけで新規扱いになる問題。比較用の候補だけ空白を除去し case fold する。元の受付 regex・保存文言は変更しない。候補の同一視を増やすため保守的に判定を狭める変更。pending 行は既存の外側 trim のみを維持し、内部改行や文言変更は引き続き例外不可。
2. javascript: リンクや contenteditable の空値・plaintext-only が残る場合の操作消失判定漏れ。これらを消失条件に追加する。リンクは href="#" + listener も属性だけでは送信操作を否定できないため、a[href]/area[href] 全てと tabindex 残存時には本例外を適用しない。通常のナビリンクも対象外になる制約を許容し、通常の受付判定経路は変更しない。contenteditable=false のみなら許可する。

formatting-red.log で 4 失敗、actions-red.log で上記を含む 9 失敗を確認してから修正した。href="#"、通常 href、tabindex の selector 境界でも opaque-action-red.log で追加 3 失敗を確認した。再レビュー対象は初回 commit に対する独立追加 commit。

追加修正後は対象 29 件、unit 698 件、Worker 248 件、typecheck / lint が全て成功。証跡は review-green.log / review-tests.log / review-typecheck.log / review-lint.log。
