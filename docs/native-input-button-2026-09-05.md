# input type=button の確認・送信対応

> 個別実装時点の記録です。統合時点の状態は[信頼性改善の検証記録](reliability-improvements-2026-09.md)を参照してください。

CSV 200の公開フォームでは「確認画面へ」「入力内容で送信する」がinput type=buttonだった。既存実装は同じ役割のbutton type=buttonを受け付けるがinput版を拒否し、再観測してもELEMENT_UNAVAILABLEになっていた。実先の入力・再送は実施していない。

## 変更と安全境界

既存のbutton経路へinput type=buttonを追加した。観測は実際のtag/type/valueを保ち、ボタン値は入力値のreview比較から除外する。確認ラベルは観測されたlabel/valueで判定する既存処理を使う。

- clickはページ内の操作だけ。入力を含む未許可POSTは既存ネットワークガードが拒否する。
- 送信は既存submit経路でのみ許可。新規DOM探索や未観測IDの操作、送信許可の再取得は行わない。
- 同一form所有、可視性、disabled、form action/method/target、独立review、送信回数の制限を維持する。
- 未知/最終送信ラベルで結果不明になった場合、値が残っていても送信は1回で止まる。
- reset/checkbox/radioなどをclick対象に追加していない。資料請求や登録候補の変更もない。

## 再現と検証

製品変更より先に既存のbutton検証・DOM activation・click対象のテストへinput版を追加し、旧実装で1 pass / 3 failを確認した。最小修正後、同条件で4 passになった。logsはartifacts/input-button-20260905/unit-red.logとunit-green.log。

追加検証では入力buttonの観測値、未観測ID拒否、clickで発生したPOSTのブロック、直接送信の結果不明後に新しい要素IDでも再送しないこと、input-buttonの確認→最終送信が最大2段階で終わることを確認した。DOM activationは不可視/disabled/reset/切断済みとform所有不一致を拒否する。

製品のtypecheck/lint、unit636件、Worker248件が成功した。管理下test-systemの独立commit60e2e69はtypecheck/lintと81 tests成功、catalog56件。

## 管理下シナリオ

- input-button-confirm: 局所的な確認表示から最終送信。sent、receiver1。
- input-button-send: 直接最終送信。sent、receiver1。
- input-button-unknown: 未知の応答で入力/ボタンを保持。uncertain/SUBMIT_CONFIRMATION_NOT_OBSERVED、receiver1。

旧製品で管理下red、統合後の製品で管理下greenの実行と本番D1/API/receiver照合はrootの統合・反映担当が行う。ここで確認したのはlocal unit/Workerであり、本番green完了とは扱わない。

CSV200固有のvalidate.phpへの検証POST→再検証POST→通常submitは今回のfixtureでは再現しない。既存の要求許可・回数制限を緩めずに、input-buttonというcontrol種別だけを対応した。実サイトでの目的適合性、入力制約、通信経路、最終送信成功は未検証。
