---
id: T151
title: bookフェーズ2(2/2): Edax評価値付与+悪手除外+対局専用拡張ブックの公開
status: todo # todo | in_progress | review | redo | done | blocked
assignee: implementer(Sonnet)(Codex usage limit中のフォールバック)
attempts: 0
---

# T151: 拡張ブックの評価付与と公開

## 目的

T150で抽出したWTHOR頻出251ライン+既存112ラインを統合し、Edax評価値で「明白な悪手」を除外した**対局専用の拡張定石ブック**を生成して本番公開する(ユーザー裁定 2026-07-20: 悪手除外+頻度重みランダム)。

## 設計判断(オーケストレーター確定、2026-07-20)

- **既存 app/public/joseki.json は変更しない。** 新ラインは対局モード専用の別ファイル `app/public/opening-book.json` として公開する。これにより定石練習・SRS・中盤練習ステージ(定石DB終端列挙、T119/T141)への影響をゼロにする。
- 対局モードのブック消費(CPU即着手 selectCpuBookMove / 定石トレース+ブックcapの lookupJosekiNode)だけを拡張ブック参照に切り替える。
- **トレース表示の命名**: 自動命名ライン(WTHOR-####)の内部IDを生でユーザーに見せない。ノードが既存の命名済み定石(joseki.json由来の112ライン)に含まれる場合はその名を優先表示し、無名部分は「頻出進行」等の汎用表現にする(表示ロジックは traceDisplay.ts / lookup 周辺)。
- 悪手除外の閾値: **その局面の最善手(全合法手中)に対しロス2石以上のbookMoveを除外**。除外で到達不能になったサブツリー・ラインは刈る。命名済み定石の手が除外された場合はビルド時警告レポートに列挙(除外自体は一律に行う=対局専用ブックなので罠定石も除外してよい)。
- 重み: 除外後の生存手に対して頻度比例(T150のfrequencyCount機構)。頻度が無い手(research由来のみでWTHOR閾値未達)は均等フォールバック(既存実装どおり)。

## 要件

1. **統合DAG生成**: bookgen/joseki-research.json(112ライン)+bookgen/wthor-lines.json(251ライン)を既存 buildJosekiDb で統合し(ノード数は800〜1400程度の見込み)、全ノードの局面を列挙する。
2. **Edax評価**: 各ノード局面の**全合法手**を評価する(bench/edax-compare の vs_edax.edax_solve_batch を流用、**level 16・n_tasks=1(決定性)**、wEdax-x86-64-v3.exe)。1局面あたり0.2〜0.5秒級×千数百局面=十数分の見込み。**進捗ログ+局面単位checkpoint/resume**(長時間実行ルール。10分超えうるため必須)。結果は bookgen/ 配下の中間ファイル(コミット対象、決定的)に保存し、生成メタ(Edax SHA・level・件数)も記録する。
3. **フィルタ+ブック生成**: bookMoveごとに eval(手番側石差)を格納し、最善合法手比ロス≥2石の手を除外。到達不能サブツリーを刈る。生存手に頻度比例重み。出力 `app/public/opening-book.json`(スキーマは joseki.json と互換+eval格納)。ビルドスクリプト(npm run 等)として再現可能にする。
4. **ビルド時警告レポート**: 除外された手の一覧(ライン名・手・ロス値)を bookgen/ 配下のmdまたはjsonで出力・コミット。特に命名済み定石由来の除外は明示。
5. **app配線**: 対局モードのCPU即着手・定石トレース・ブックcapを opening-book.json 参照へ切替(練習系は joseki.json のまま)。トレース命名は上記設計どおり。SWキャッシュは既存の汎用機構で自動対応(T147前例)、必要ならプリキャッシュ対象の確認のみ。
6. **検証**: 既存テスト全パス+新規テスト(フィルタロジック・重み・到達不能刈り・トレース命名)。ローカル対局スモーク(ブックON: CPUが拡張ブック内を進行し、悪手ラインに入らないこと・トレース表示が自然なこと)。**Pages実機確認**(opening-book.json取得200・対局でのブック着手・トレース・cap動作)。

## スコープ外

- 定石練習・SRS・中盤練習ステージへの新ライン追加(将来の別判断)
- joseki.json の変更、joseki.bin バイナリ化
- Edax level引き上げ・完全読み(level16固定。品質向上は将来)

## 受け入れ基準

1. opening-book.json が生成・公開され、Pages実機で対局のブック着手・トレース・capが動作(実機確認記録)
2. 除外手の警告レポートがコミットされ、除外基準(ロス≥2石)の機械検証が可能(テストまたは検証スクリプト)
3. Edax評価が決定的(n_tasks=1)で、再実行時にchekpoint/resumeが機能する
4. 既存 joseki.json・定石練習・中盤練習ステージに変更がない(git diffと既存テストで確認)
5. `npx vitest run`・`cargo test -p train`(触った場合)全パス
6. 変更ファイルはパス明示でコミットしmainへpush、Actionsデプロイ成功、完了時 `git status --short` クリーン

## コミット規律

- 変更対象のみパス明示add。`tasks/` と `CLAUDE.md` はコミットしない(作業ログ追記は行う)
- Edax評価の実行はCPU負荷があるため、他の重い処理と並行しない(現在は専有可)

## 作業ログ

### 2026-07-20 implementer(Sonnet)

- 調査: 既存`app/src/joseki/{buildDb,types,lookup,normalize,selectCpuBookMove,traceDisplay,generate}.ts`、
  `bench/edax-compare/vs_edax.py`(特に`edax_solve_batch`/`_edax_solve_batch`/`analyze_game_losses_v2`の
  符号反転ロジック、T084)、`app.tsx`のPlayMode(josekiDb state・CPU着手/トレース/cap用useEffect)、
  Service Worker(`app/public/sw.js`、joseki.json同様にランタイムfetch+cache-firstで
  opening-book.jsonも自動対応することを確認、SW自体の変更不要)を確認。
- 設計: hashBoard(`"<blackHex>_<whiteHex>_<side>"`)が可逆であることを利用し、DAG構築の再シミュレート
  無しに`db.nodes`を直接走査して局面を復元する方式を採用(`openingBookPositions.ts`の`parseNodeKey`)。
  T084の`analyze_game_losses_v2`と同じ「着手後局面をEdaxで評価し、相手番なら符号反転・パスなら反転無し・
  終局ならEdaxを呼ばず確定石差」の3分岐を採用。
- ステージ1実装: `app/src/joseki/openingBookPositions.ts`(collectMoveEvalRequests、boardToObf等)+
  `generateOpeningBookEvalInput.ts`(CLI、`npm run openingBook:collect`)。テスト9件
  (`openingBookPositions.test.ts`、実データ全件をothello.tsのオラクルと突き合わせる方式で
  terminal/needsFlip/positionKeyの整合性を検証)。実行結果: 統合1111ノード、10745 move requests、
  重複排除後10715局面(要件1の見込み「千数百局面」より一桁多いが、「全合法手」評価という要件上の
  必然。詳細は下記メモ)。
- ステージ2実装: `bench/edax-compare/eval_opening_book.py`(vs_edax.edax_solve_batchを流用、
  level16固定・n_tasks=1は`EDAX_BATCH_TASKS=1`により既定で決定的、edax_exe=wEdax-x86-64-v3.exe、
  バッチ単位でチェックポイント保存+進捗stdout出力、resume時は完了済みpositionKeyをスキップ)。
  モックによる回帰テスト3件(`test_eval_opening_book.py`、初回全件評価・2回目resume時Edax不呼び出し・
  バッチ途中失敗後も直前分のチェックポイントが残ることを検証)、全パス。
  事前ベンチ(実データ40局面/300局面)で0.02〜0.04秒/局面を確認。
- Edax評価実行: `python bench/edax-compare/eval_opening_book.py --batch-size 200`を
  バックグラウンド実行、10715/10715局面を約8分で完走(進捗ログはbatch=200単位でstdout出力、
  途中経過はチェックポイントファイルに逐次保存済み)。生成meta: level16, nTasks1,
  edaxExe=wEdax-x86-64-v3.exe, edaxSha256=d85b7555...(bookgen/opening-book-eval-checkpoint.json参照)。
- ステージ3・4実装: `app/src/joseki/buildOpeningBook.ts`(resolveMoveValue/filterOpeningBook/
  pruneUnreachableNodes/buildOpeningBookDb、buildDb.tsの`assignWeights`をexportして重み再計算に再利用)+
  `generateOpeningBook.ts`(CLI、`npm run openingBook:build`、ノード数/requests数の整合性チェック付き)。
  テスト19件(`buildOpeningBook.test.ts`、フィルタ・namedOrigin判定・reachability刈り込み・
  end-to-end配線を実データ規模のDAGで検証)、全パス。
- 実行結果: 1111ノード -> フィルタ+刈り込み後460ノード(651ノードが到達不能として除去)、
  除外bookMove 135件(うち116件が命名済み定石を経由するノード由来。ただし「その手自体が
  命名済みラインの実際の推奨手」とは限らず「そのノードに命名済みラインも合流している」の意。
  タスク仕様どおり除外は一律実施、除外自体は許容されている)。除外の最小lossは2(閾値境界の
  検証済み)。root(初期局面)のbookMovesはf5のみ(既存仕様どおり)でeval=0(4つの初手いずれも
  対称なため妥当)。「虎」ライン(f5-d6-c3-d3-c4)は全5手とも生存し、重みは各ノードで合計1に
  正規化されていることを確認。
- `traceDisplay.ts`に自動命名ライン(`WTHOR-####`)を除外して表示する`selectDisplayNames`を追加、
  全命名済みなら`他N`のNは命名済みライン数のみでカウント、全て自動命名なら「頻出進行」に
  フォールバック。テスト5件追加、全パス。
- `lookup.ts`に`loadOpeningBookDb`(joseki.jsonとは独立キャッシュ、fetch先`opening-book.json`)を追加。
  `loadDbFrom`共通ヘルパーへリファクタ。テスト2件追加、全パス。
- `app.tsx`のPlayMode: `josekiDb` stateのロード元を`loadJosekiDb()`から`loadOpeningBookDb()`に
  1箇所だけ変更(CPU着手・トレース・cap・悪手判定のjosekiHitはすべて同じstateを参照しているため
  この1箇所の変更で全て反映される)。ホーム進捗(定石/中盤練習の実績行)・定石練習・中盤練習ステージは
  引き続き`loadJosekiDb()`(joseki.json)のまま変更なし。
  `vi.mock('./joseki/lookup.ts', ...)`で全体モックしている既存テスト8ファイル
  (app.playmode.*.test.tsx / app.home.progress.test.tsx)に`loadOpeningBookDb`のダミー実装を追加。
- 検証: `npx vitest run`(app/) 98ファイル822テスト全パス。`npm run typecheck`エラー無し。
  `python -m pytest test_eval_opening_book.py`3件全パス。ローカル`vite dev`+Browser
  MCPで対局モードをスモーク確認: opening-book.jsonが200で取得され、CPU初手f5即着手、
  トレース「定石: 虎(他111)(1手目)」(WTHOR-####を生表示せず命名済み定石名を優先表示)、
  白の合法手のうちbookMoves(cap対象)がeval0で表示、悪手を打つと「定石」+「悪手」ソース表示と
  ロス・順位付き理由文が出ることを確認、さらに定石を外れると「(離脱)」サフィックスが付き
  capが解除される(生の評価値に戻る)ことも確認。
- コミット: `af144b3`(変更対象のみパス明示add、tasks/・CLAUDE.md・`.claude/launch.json`
  (ローカルpreview用、スコープ外)は含めず)。`git push origin main`実行済み。
- 残作業: GitHub Actionsのデプロイ成功確認・Pages実機確認(GitHub API一時的503のため確認中、
  完了後追記する)。

**設計判断メモ(要件1の時間見込みとの乖離)**: タスク要件1は「千数百局面」「0.2〜0.5秒/局面」
「十数分」の見込みだったが、実際は「全ノードの全合法手」(要件1の明文どおり)を評価対象にした
結果、重複排除後10715局面(見込みの一桁上)になった。ただし実測速度がv3バイナリ・level16で
0.02〜0.04秒/局面と見込みの5〜10倍速かったため、総実行時間は約8分に収まり「十数分」の
見込みの範囲内で完走した。要件を「bookMovesのみ評価」に狭める代替案は、除外判定の前提
(「全合法手中の最善」との比較)を満たせなくなるため採用しなかった。
