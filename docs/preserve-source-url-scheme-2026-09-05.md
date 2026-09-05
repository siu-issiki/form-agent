# CSVに明示されたURL schemeを保持する

> 個別実装時点の記録です。統合時点の状態は[信頼性改善の検証記録](reliability-improvements-2026-09.md)を参照してください。

## 問題と変更

簡易CSVのHTTP URLをHTTPSへ強制変換すると、HTTPで公開応答するサイトでもHTTPS接続失敗で登録前に除外される。最終除外調査の固定12件では、元CSVが全てHTTP、HTTPSは全て失敗、HTTP GETは8件200/4件404だった。この比率は189件全体へ外挿しない。

明示HTTP/HTTPSを簡易・通常CSVの両方で保持するようにした。URLのschemeを変えず、既存どおり前後空白だけを除く。scheme省略は元実装でも拒否していたため、その扱いを維持する。provider等の別モジュールのHTTPS既定値は変更しない。

preflightもHTTP開始を受け付け、HTTP継続・HTTPSへの昇格を許可する。一度HTTPSになった後のHTTP降格は、従来の全HTTPS制約を維持する範囲として拒否する。HTTP(S)以外、認証情報付きURL、IP/localhost等の危険なhost、遷移上限7回は引き続き拒否。HEADと405/501時のGET代替も維持する。

出力互換の`upgradedToHttps`は残し、強制変換廃止により常に0となる。

## 検証

baseline `2c2819417be3b9e8d99a68b29ddd7bcd576f7f7c`。先にテストを作り、対象旧版13pass/8failを確認してから修正した。証跡は `artifacts/preserve-source-url-scheme-20260905/red.log` と `green.log`。

修正後は対象23件 / campaign85件 / unit755件 / Worker248件 / typecheck / lintが成功。

簡易/通常CSVでのHTTP・HTTPS保持、scheme省略/不正scheme/認証情報/危険host拒否、HTTP redirect/GET代替、HTTPSからの降格拒否を確認。HTTPとHTTPSでは生成job ID/承認用input fingerprintが異なり、変換前後を同一承認と扱わないこと、HTTP redirectループが7要求で止まることも検証した。全テストはfake fetchで、実サイトへのアクセス/入力/送信なし。

## 利用箇所と反映範囲

- `tools/campaign-common.ts` がCSV filterを利用し、`tools/campaign-dry-run.ts` / `tools/campaign-send.ts` がpreflightを利用する。
- `src/worker.ts`等のWorker runtimeから本モジュールへのimportはない。WorkerのURL検証は従来どおりHTTP(S)に対応しており、本変更でWorkerの通信/送信境界は変わらない。反映にWorker deployは必要ない。
- 実運用の停止済`sender-20260905` worktreeでは独自の`tools/campaign-continuous.ts`が同worktreeの`../src/campaign-import`を使う。integrationへの統合だけではそちらの実装は変わらないため、レビュー後にrootがsenderソースへの適用を調整する。

## 今回変更していないもの

終了済campaignのCSV、manifest、journal、prepared payload、承認記録は変更していない。旧HTTPS化済みtargetをHTTPへ自動移行する処理、再投入、再送は追加していない。既存manifestを新filterで再開する場合はtargetが一致しない可能性があるため、別途rootが適用範囲を判断する。TLS検証の無効化や、75秒まで待機したBun timeout問題の修正は含めていない。
