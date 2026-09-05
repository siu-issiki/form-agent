# 次回のネットワーク失敗を分類する診断

> 個別実装時点の記録です。統合時点の状態は[信頼性改善の検証記録](reliability-improvements-2026-09.md)を参照してください。

分析済みの診断不足283件のうち、SUBMIT_NETWORK_POLICY_BLOCKEDは15件（130/197/198/205/237/244/264/266/357/560/565/604/810/851/1007）。画像にreCAPTCHA接続エラーがあっても、実際に拒否した要求を保存していなかったため因果は未確定。1007は既存の診断分離後でも属性不足が残った例である。今回の情報は今後のジョブだけに残り、過去386件の原因確定・結果変更・再送はしない。

## 8ee4cd3との違い

既存変更は、ポリシー拒否と許可済み要求のCDP継続失敗をreasonCodeで分離した。今回は同じ最初の失敗に固定分類を付け、既存のresult.reason保存経路を通じてD1/APIへ残す。新しいイベント・DBスキーマ・許可ルールは追加しない。

例: `First blocked request: stage=network_policy; method=POST; resource=XHR; origin=other; frame=expected.`

| 分類 | 出力可能な値 |
|---|---|
| stage | expected_request / network_policy / continue_request / request_limit / unknown |
| method | GET / HEAD / OPTIONS / POST / PUT / PATCH / DELETE / other |
| resource | Document / Fetch / XHR / other（欠落も含む） |
| origin | レビュー時のform actionとsame / other / unknown |
| frame | レビュー時の送信controlのframeとexpected / other / unknown |

URL・host・path・query・fragment・認証情報・入力値・本文・request ID・frame ID・例外本文は出力しない。不正URLや非HTTPはorigin=unknown、未知method/resource/stageは固定の代替値になる。origin=otherは単なる属性で、許可外ドメインや拒否理由の確定ではない（許可済みの別ホストもあり得る）。

## 変えない動作と限界

最初に記録したblockのstageと属性を同時に保持し、後続blockで上書きせず、次attemptで消去する。既存のclaim順序・同時要求上限・同期区間・POST/GET/リダイレクト許可・dry-run・CAPTCHA除外・再送禁止は不変。CDPへの追加要求も行わない。

送信処理が確認を得られず通常のuncertain結果を返した時だけ診断文を付ける。既に観測した要求がある場合は従来のSUBMIT_CONFIRMATION_NOT_OBSERVEDが優先し、併記したblockを主原因と断定しない。成功、明示ページエラーによる早期結果、CDP例外による終了、submit前の拒否、後続すべての要求は追加記録の対象外。網羅的なネットワークトレースではない。

## 入力validityと証跡失敗の棚卸し

| 項目 | 現在わかる情報 | 今回変更せず残す不足 |
|---|---|---|
| 入力validity | native checkValidityの真偽とFORM_INVALID診断。novalidate/formNoValidateはHTMLの意味どおり省略。observeは項目の型/必須/値をモデルへ渡す | D1にはinvalidとなった項目・valueMissing/typeMismatch/patternMismatch等の内訳がない。before画像が取得される前に停止すると原DOMを復元できない。validationMessageや任意label/valueを丸ごと保存する案は採らず、将来は固定型・validity bitの安全な範囲を別設計する |
| 証跡capture failure | D1 evidence.capture_failedにstage/failureCode/objectKey。SCREENSHOT_FAILED/SERIALIZE_FAILED/OBJECT_STORE_FAILED/EVENT_NOT_RECORDED/NO_BROWSER_SESSION/CAPTURE_TIMEOUTを区別。既存console timingはphase・所要時間・bytesを記録 | timeoutの下位CDP命令や詳細はD1イベントだけでは復元できず、ログが失われると工程の細分化に限界がある。根本CDP停止を単なるtimeout増加や成功扱いで隠さない |

この15件を含む283件が解消したとは扱わない。次回は「POSTかGETか」「レビューしたframeか」「同originか」を追加で区別できるが、未受信の証明にはならない。

## 検証

実装前、first block属性・機密を含む未知分類・driver外部拒否・driver継続失敗の4テストが失敗。修正後4成功、安全境界とGET/上限を加えた対象15成功。query/credential/識別子/未知methodに機密を模した文字列を入れても保存用文字列に出ないことを検証した。全typecheck/lint/unit858/Worker248成功。ログは `artifacts/diagnostic-observability-20260905/`。

本番管理下は別test-system case `ajax-blocked-network-diagnostic` を用意する。固定の非解決用blocked.invalidへ定数本文だけのPOSTを試み、CDPが到達前に拒否してreceiver0となること、D1/APIの固定分類を確認する。fixture/deploy/本番結果はrootのリリース工程で別記録する。
