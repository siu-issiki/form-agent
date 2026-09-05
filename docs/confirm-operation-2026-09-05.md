# 確認表示と送信の操作選択

> 個別実装時点の記録です。統合時点の状態は[信頼性改善の検証記録](reliability-improvements-2026-09.md)を参照してください。

`input-button-confirm` のローカル確認ボタンを `submit` で操作すると、確認欄と最終送信ボタンは表示されるが要求は発生しない。送信許可を取得した後なので `SUBMIT_DOM_REQUEST_NOT_OBSERVED` で終端する。正しい経路は `click Confirm → observe → submit Send` である。

## 変更

エージェントのsystem promptとclickの説明を明確化した。観測した説明が、入力内容の確認表示とその後の別の最終送信を区別しているtype=buttonでは、ローカル確認表示をclickで行い再観測する。確認欄を見るためにsubmitを試さない。ラベルが「確認」というだけではローカルと断定せず、native submitやサーバー確認ページへの送信は従来どおりsubmitとする。意味が不明なら保留する。

handler、driver、request許可、stage遷移、判定器は変更しない。確認というラベルだけで自動clickへ変更すると、正規のJS確認POSTに退行し得るため採用しなかった。要求未観測を理由に許可を戻したり再送を許可したりしない。

## 旧本番での再現

本番6aef版、入力ボタン確認と通常ボタン確認を各3回、計6回で区切った。5成功/1失敗で、失敗も保存し追加の失敗探しは行わない。

| scenario | job ID末尾 | 結果 | receiver/accepted |
|---|---|---|---|
| input-button-confirm | 75f4b051-08e7-4dcd-ac06-732c3f5822ee | sent | 1/1 |
| input-button-confirm | e59df0eb-56cb-4ea7-8250-5012b3223ea6 | sent | 1/1 |
| input-button-confirm | e3de2e41-0e36-4730-8c12-95304d4986f2 | uncertain / SUBMIT_DOM_REQUEST_NOT_OBSERVED | 0/0 |
| script-button-send | 635b939c-8998-4a79-8334-870513ba2b4f | sent | 1/1 |
| script-button-send | f4ea4522-b3d3-4a1f-85a1-b3b0be019fa8 | sent | 1/1 |
| script-button-send | a7f0e364-bbf6-4cd0-9353-bae4b447363e | sent | 1/1 |

全job attempt1。完全IDは `test-system-<scenario>-<末尾>`。D1の成功e59df0ebはobserve→fill3→observe→click→observe→submit、失敗e3de2e41はobserve→fill3→observe→submitで、clickがない。旧送信は管理下のみ。原CSV/固定値JSON/終了manifest/D1結果や実先を変更していない。

ログはこのworktree `artifacts/confirm-operation-20260905/managed-old-1.log`、`managed-old-2-3.log`、`d1-old-traces.json`。旧歴史redの `test-system-input-button-confirm-cd408394-ef10-4ab7-b157-69940730b534` とは別の新しい再現である。

## 安全境界と検証の限界

追加unitは、ローカルclick時のjobがrunningのまま・review0・submit0であること、最終submit前の再観測必須、最終送信だけ1回review/submitすることを固定する。誤submit後は画面に最終送信が現れてもuncertain終端から再送できないことも固定した。既存のnative/JSサーバー確認POSTの次段階テストと合わせ5ケース成功。これらは既存の安全境界の回帰検証で、promptのモデル判断改善を文字列assertで代用しない。

新本番の同じ6回比較はroot統合・反映後に実行する。仮に全件成功しても、モデルの選択誤りを機械的に根絶した証明や一般サイトでの成功率向上の測定にはならない。一般リストの確認画面停止23件すべてが同じ原因と確定したわけでもない。これは操作選択の改善であり、誤操作後の再送解禁ではない。

最終ローカル検証はunit849件、Worker248件、typecheck/lint成功。rootの独立監査でも旧6件のD1/API/receiverが一致し、17証跡のSHA一致・capture失敗0を確認済み（releaseの `old-confirm-all-evidence/independent-verification.json`）。
