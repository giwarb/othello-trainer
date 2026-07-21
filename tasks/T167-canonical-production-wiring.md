---
id: T167
title: 候補C(Egaroucid B3-canonical、PWV6)の本番配線 — pattern_v5として公開
status: done # verifier(本番バンドル検査・Pages SHA再DL・全テスト再実行)+代替レビュー(重大0・中1・軽微4)両合格、2026-07-21。中1(test-node-budget-wasm.mjsがv4重み参照のまま=非本番構成のゲート)は次の軽タスクでv5化
assignee: implementer
attempts: 0
---

# T167: 候補Cの本番配線

## 目的

T166対局ゲートで対現行v4 **+17.37石(95%CI[+13.97,+20.87]、p<0.0001)** の有意改善を示した候補C(Egaroucid全量25.5M×B3特徴×D4 canonical、PWV6形式)を本番アプリに配線し、GitHub Pagesで公開する。前例: T122(v3配線)・T147(v4配線)。

## 対象重み

- `train/data/t165/egaroucid-b3/t158-b3-canonical-seed-1-earlystop.bin`
- SHA-256: `9ce0cc05...`(t165_training_report.meta.json の t166Manifest が正、実測照合すること)
- 配置名: **pattern_v5.bin**(T158設計裁定の命名: 採用時はv5)

## 要件

1. **重みの配置**: 上記binを `train/weights/pattern_v5.bin` と `app/public/pattern_v5.bin` に配置(コピー、SHA一致確認)。既存 pattern_v4.bin は残す(切り戻し用)。
2. **WASM/エンジン経路のPWV6対応確認**: engineのfrom_bytesはPWV6対応済み(T164)だが、**WASMビルド経由で実際にPWV6が読めてscalar特徴が有効になること**をヘッドレステスト等で確認(T158a/T163のWASM検証の前例に倣う)。engine側の追加変更が必要なら最小限で行い報告。
3. **アプリ配線**: 重みのfetch先を pattern_v5.bin に切り替え(worker.ts等、T147の変更箇所を踏襲)。Service Workerのキャッシュ対象リスト・キャッシュ版数の更新。**ANALYSIS_ENGINE_VERSION を7に繰り上げ**(評価値が変わる変更のため必須。cache.ts)。切り戻しは「fetch先をv4に戻す+版数再繰り上げ」の1手順で可能なようにコメントを残す(T122前例。ロールバックコメントには版数繰り上げ必須の旨を明記=T122申し送りの解消)。
4. **配信サイズ確認**: pattern_v5.bin のサイズとgzip後サイズを記録(v4比)。著しく増える場合は報告(ブロッカーではない)。
5. **テスト**: 既存のapp/engineテスト全パス。重み切替に伴い期待値が変わるテストがあれば、変更理由を作業ログに記録して更新。
6. **本番検証(標準ルール)**: mainへpush→GitHub Actionsのデプロイ成功を確認→Playwrightで本番URL(https://giwarb.github.io/othello-trainer/)にアクセスし、(a)対局でCPUが着手する (b)評価バーが動く (c)解析が動く (d)pattern_v5.binが200で取得される (e)コンソールにエラーがない、を確認。
7. **強度スモーク(軽)**: 配線後のローカルビルド(またはNode headless)で数局面の評価値が候補C重みのネイティブ評価と一致することを確認(取り違え防止)。

## スコープ外

- 対局プロトコル・探索パラメータの変更
- Egaroucidデータ・学習の再実行
- レガシー重みファイルの削除

## 受け入れ基準

1. 本番Pages URLで新重みが動作している実機確認(上記6の(a)-(e))の記録がある
2. ANALYSIS_ENGINE_VERSION繰り上げ済み、SWキャッシュ整合、切り戻し手順のコメントあり
3. WASM経由のPWV6読込+scalar有効の確認記録がある
4. 全テストパス、`git status --short` クリーン(変更はパス明示コミット+push。`tasks/`とCLAUDE.mdはコミットしない)

## コミット規律

- コミットメッセージは `app:`/`engine:` プレフィックス+`(T167)`。作業ログ節目追記

## 作業ログ

- 2026-07-21 実装完了(implementer)
  - **要件1(重み配置)**: SHA-256実測(`9ce0cc054b67807641b759a2e881a87dd562146dee5e4d659bba1efa228f54a4`)が
    `t165_training_report.meta.json`のt166Manifestと一致することを確認。
    `train/data/t165/egaroucid-b3/t158-b3-canonical-seed-1-earlystop.bin`を
    `train/weights/pattern_v5.bin`・`app/public/pattern_v5.bin`へコピーし、
    両コピーのSHA-256も一致することを確認。既存`pattern_v2/v3/v4.bin`は
    削除せず残した。
  - **要件2(WASM/PWV6確認)**: `wasm-pack`でWASMを再ビルド。engine側の
    追加変更は不要だった(T158aで`Engine::benchmark_pattern_eval`が
    既に`scalarFeaturesPresent`/`scalarFeaturesEnabled`をJSONで報告する
    設計になっていたため)。新規`app/scripts/test-pattern-v5-wasm.mjs`
    (`test-node-budget-wasm.mjs`の前例に倣うheadless Nodeスクリプト、
    `npm run build`の一部として実行=恒久的なビルドゲート化)で、
    マジックバイトがPWV6であること・`scalarFeaturesPresent`/
    `scalarFeaturesEnabled`が両方trueであることを確認。
  - **要件3(アプリ配線)**: `worker.ts`の`PATTERN_WEIGHTS_URL`を
    `pattern_v4.bin`→`pattern_v5.bin`へ切り替え。`cache.ts`の
    `ANALYSIS_ENGINE_VERSION`を6→7へ繰り上げ。ロールバック手順のコメントを
    「ファイル名を戻す」と「版数を繰り上げる」を1つの手順として明記し、
    **戻す場合も6ではなく直近の最大値+1(次は8)を使うこと**を明示した
    (T122申し送り事項の解消: 従来のコメントは「ファイル名を戻すだけで
    よい」が先に来る構成で、版数繰り上げの必須性が伝わりにくかった)。
    `sw.js`は`pattern_v4.bin`等のファイル名を一切ハードコードしておらず
    (index.html由来のJS/CSSを動的発見+`CACHE_VERSION`はビルドごとに
    コミットハッシュで自動更新)、追加の変更は不要と判断した。
  - **要件4(配信サイズ)**: raw: pattern_v4.bin=27,986,340B →
    pattern_v5.bin=27,986,840B(+500B、scalarブロック分)。gzip:
    4,379,795B → 5,865,976B(+34%、ブロッカーではないため報告のみ)。
    増加理由はraw差分の小ささから見て「スカラーブロックの追加」ではなく
    canonical化後の重み分布がgzipのLZ77辞書一致を得にくい(レガシー版より
    値の反復パターンが減った)ことが主因と推測されるが、厳密な原因分析は
    本タスクのスコープ外と判断した。
  - **要件5(テスト)**: `npm test -- --run`(app): 98ファイル832件全パス。
    `npm run typecheck`・`npm run build`(WASM再ビルド+2つのwasmゲート
    スクリプト+SW版数注入含む)も成功。`cargo test -p engine`/
    `cargo test -p train`もローカルで全パス(下記CI発見の修正込み)。
  - **CI発見・修正(スコープ外だが本タスク中に発見、train:別コミット)**:
    push後、「Rust Tests」ワークフローが
    `regression::tests::t163_canonical_score_is_invariant_over_real_wthor_positions`
    (T163追加)で失敗しているのを発見した。原因: `train/data/`はライセンス上
    リポジトリにコミットしない(gitignore)ため、CIのフレッシュチェックアウト
    には`WTH_2000.wtb`が無く、元の実装(`.expect`でpanic)が継続的にCIを
    赤くしていた。`train/tests/real_data.rs`が既に採用している
    「ファイル不在ならeprintln!して早期return」パターンを適用して修正
    (ローカルでファイルを退避→スキップすることを確認→復元→通常実行の
    両方を確認済み)。T167の直接スコープではないが、pushして初めて発覚し
    かつ軽微・低リスクな修正だったため、本タスク中に対応した(別コミット
    `9a54a35`、train:プレフィックス)。
  - **要件6(本番検証)**: 2回push(1回目=app配線本体、2回目=上記CI修正)。
    2回ともGitHub Actionsの「Deploy to GitHub Pages」が成功。「Rust Tests」
    は1回目失敗(上記原因)・2回目成功。本番URL
    (https://giwarb.github.io/othello-trainer/)をブラウザ自動操作で確認:
    (a) 黒番で対局開始→c4に着手→石数2-2→3-3(CPU/白が自動応手)を確認
    (b) 評価バー「+0」表示(初期局面、数学的に正しい値と既に検算済み)
    (c) 棋譜解析モードでテキスト入力(`f5d6c3d3c4f4f6f3g4g3`)→
    「解析完了: 10手(解析時間: 15.05秒)」、9手目g4が「-4 中盤(探索)
    疑問手」と分類され中盤ヒューリスティック探索(pattern_v5経由)が
    実際に稼働していることを確認
    (d) `fetch('https://giwarb.github.io/othello-trainer/pattern_v5.bin')`
    で`status:200, contentLength:5881349`(gzip後サイズと同等)を確認
    (e) 上記操作全体を通じてコンソールエラーなし(`read_console_messages`
    で確認)。
    (補足: ブラウザ自動操作ツールの`computer{action:"screenshot"/"zoom"}`
    がこの環境で一貫してタイムアウトしたため、`get_page_text`・
    `read_console_messages`・`read_page`・`javascript_tool`経由の直接DOM
    操作〈実DOM要素への`.click()`/`MouseEvent`ディスパッチ〉で代替検証した。
    座標ベースの`computer{action:"left_click"}`もproduction originへの
    navigate後にヒットテストが機能しなくなる現象があったため、同様に
    JS経由のクリックで代替した——いずれもツール側の制約であり、本タスクの
    変更に起因するものではない。)
  - **要件7(強度スモーク)**: ネイティブ(`eval_cli eval --pattern-weights
    train/weights/pattern_v5.bin`)とWASM(`Engine.analyze`、
    `test-pattern-v5-wasm.mjs`)で同一5局面
    (initial/`benchmark_pattern_eval`と同じ2フィクスチャ/
    `bench/edax-compare/t158a_engine_cost_positions.json`由来の実対局2局面)
    のdepth=0静的評価を比較し、**全5局面で完全一致**
    (0, -8.97, -2.33, 10.48, -1.57)を確認(重み取り違え防止)。
  - **成果物**: `train/weights/pattern_v5.bin`・`app/public/pattern_v5.bin`
    (新規、SHA一致確認済み)、`app/src/engine/worker.ts`・
    `app/src/analysis/cache.ts`(配線・版数)、`app/package.json`
    (`test-pattern-v5-wasm.mjs`をbuildゲートに追加)、
    `app/scripts/test-pattern-v5-wasm.mjs`(新規)、
    `train/src/regression.rs`(CI発見の軽微修正、別コミット)。
    `.claude/launch.json`(ローカルpreview確認用に`app-preview`設定を追加、
    gitignore対象のため差分には出ない)。
  - **受け入れ基準の充足状況**: 1(本番実機確認記録)✓、2(版数繰り上げ・
    SWキャッシュ整合・切り戻しコメント)✓、3(WASM経由PWV6+scalar確認)✓、
    4(全テストパス・`git status --short`クリーン)✓。
