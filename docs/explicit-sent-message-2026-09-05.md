# 明示的なフォーム送信完了文言

> 個別実装時点の記録です。統合時点の状態は[信頼性改善の検証記録](reliability-improvements-2026-09.md)を参照してください。

row809 は入力済みフォームの送信後、フォームが消え「フォームを送信しました。」が新規表示されていたが、SUBMIT_CONFIRMATION_NOT_OBSERVED で終端した。目視転記を c673dfb の実 reader に通して未検出を再現した。当時の DOM 全文・表示時刻、相手側保存結果は未確認であり、過去 job の結果変更や再送はしない。

パターンに独立した文「フォームを送信しました。」のみを追加する。確認画面、未送信・否定・疑問、同一行 FAQ 引用、改行された表示例、送信前からある同文言、request 未観測では成功にしない。FAQ の後に本当の結果が出た場合は認識する。frame、network、許可、再試行は変更しない。

local scenario 10 tests を先に追加し、旧 2 fail / 8 pass → 修正後 10 pass。管理下代表 ajax-form-sent は POST 後にフォームを削除して同じ文を表示し、receiver 1 / sent を期待する。

検証: product typecheck / lint / unit679 / Worker248、system typecheck / lint /84tests が全成功。


## 明示的な障害・人間確認メッセージ（別コミット）

row758 の Service Temporarily Unavailable＋メンテ/容量不足の説明、row777 の Invalid reCAPTCHA Secret key.、row804 の 人間であることを確認してください。を、独立行/完全な文の限定パターンで追加する。これらは受付の証拠ではない。HTTP503や実際の未受信、CAPTCHAの回避可能性を推定しない。

3実例＋driverの新しい人間確認拒否を先に red（4fail/5pass）で確認。修正後11pass。FAQ・表示例・疑問・未完全文・単独再送案内は除外し、送信前からある同じ文言や通信未観測をSUBMIT_PAGE_REPORTED_FAILUREにしない。リクエスト観測済みの新規エラーなら既存のuncertain/SUBMIT_PAGE_REPORTED_FAILUREに詳細化するだけで、送信成功/再送可能には変えない。

代表managed ajax-human-verification-message はPOSTを受信してから人間確認メッセージを表示し、receiver1/uncertainを期待する。実受信があり得る以上、ページの失敗表示だけで再送してはいけない境界を維持する。

障害分類の検証: product typecheck / lint / unit690 / Worker248、system typecheck / lint /85tests が全成功。
