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
- 悪手除外の閾値(**2026-07-20仕様更新v2**: 初版の一律除外は、検収データで命名済み112ライン中69本が途中切断(32本がply≤5、虎D/E等)・除外135件中76件が境界のロス2ちょうど、と定石カバレッジを削りすぎることが判明したため改定): **除外は自動抽出(WTHOR)ラインのみに乗る手に適用し、命名済みライン(joseki-research由来112ライン)の進行に含まれる手は除外しない**(ロス値は格納し、警告レポートには従来どおり記載)。到達不能刈りは除外後のグラフに対して同様に実施。これにより命名済み112ラインは全手順生存し、従来(フェーズ1)の定石体験を維持する。
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
- Actionsデプロイ確認: push直後はGitHub API側の一時的503(GitHub全体の障害、`gh run view`が
  複数回503を返した)でログ取得が難航したが、オーケストレーターがAPI復旧後に確認し、
  `af144b3`のrunおよびそれ以降のコミットのDeploy runもすべてsuccessであることを報告。
  自分でも`gh run list`で最新の連続コミット(T153関連push)のDeploy to GitHub Pages runが
  いずれも`completed success`であることを確認した(af144b3自体のrunはこの時点でリストの
  射程外になっていたが、それ以降全てsuccessが続いていることは同じデプロイパイプラインが
  正常に動作している十分な傍証)。
- Pages実機確認(https://giwarb.github.io/othello-trainer/ 、Browser MCP): `opening-book.json`が
  200で取得されることを`read_network_requests`で確認。白番で対局開始→CPU(黒)がf5を即着手し、
  トレース表示が「定石: 虎(他111)(1手目)」(自動命名WTHOR-####を生表示せず、命名済み定石名
  「虎」を優先表示、他の命名済みライン数111を正しくカウント)。白の合法手のうちブックcap対象の
  3マスがeval 0で表示。あえて悪手(f4、ロス4石)を打つと「定石」+「悪手」のソースラベルと
  「最善手 f6(-19)に対し、あなたの手 f4 は-23(ロス4石、順位3位)でした」の理由文が表示。
  さらに続けて定石を外れる手(d2、ロス7石)を打つと、トレースが
  「定石: ネズミ定石：基本(他2)(3手目)(離脱)」に変わり、cap が解除されて生の評価値
  (-36/-29/-19)がそのまま表示されることを確認。ローカル`vite dev`での確認結果と完全に一致。
- 以上によりPages実機確認(受け入れ基準1・6)が完了。

**設計判断メモ(要件1の時間見込みとの乖離)**: タスク要件1は「千数百局面」「0.2〜0.5秒/局面」
「十数分」の見込みだったが、実際は「全ノードの全合法手」(要件1の明文どおり)を評価対象にした
結果、重複排除後10715局面(見込みの一桁上)になった。ただし実測速度がv3バイナリ・level16で
0.02〜0.04秒/局面と見込みの5〜10倍速かったため、総実行時間は約8分に収まり「十数分」の
見込みの範囲内で完走した。要件を「bookMovesのみ評価」に狭める代替案は、除外判定の前提
(「全合法手中の最善」との比較)を満たせなくなるため採用しなかった。

### 2026-07-20 実装redo(v2仕様、命名済みライン除外免除)

オーケストレーターより、両検収(verifier・codex-review)で実装の正しさ自体は合格したものの、
検収データで「命名済み112ライン中69本が途中切断(32本がply<=5、虎D/E等)、除外135件中76件が
境界のロス2ちょうど」と、初版(v1)の一律除外が定石カバレッジを削りすぎることが判明し、
タスクファイルの設計判断セクションがv2に更新された。以下を実施。

- **フィルタ規則v2**: `app/src/joseki/buildOpeningBook.ts`を改修。
  - `walkRawLine`(内部、`buildDb.ts`の`buildJosekiDb`と同じ正規化+シミュレーション手順を
    独立に再現)を土台に、`collectNamedLineMoveKeys(namedLines)`で命名済みライン
    (`bookgen/joseki-research.json`の`lines`)の実際の(局面,着手)の組を全て集合化する。
  - `filterOpeningBook`に`protectedMoveKeys`引数を追加。除外判定を
    `excludedFromBook = isHighLoss(loss>=lossThreshold) && !isProtected`に変更。保護対象は
    lossに関わらず生存し、evalは通常どおり格納する。「高lossだった」事実自体は
    `flagged`配列(旧`excluded`から改称)に`protectedByNamedLine`/`excludedFromBook`フィールド
    付きで引き続き記録する(警告レポート用、要件どおり)。
  - `checkNamedLineSurvival(namedLines, bookDb)`: 命名済み各ラインの全手順が最終ブックに
    残っているかを検証する関数。`generateOpeningBook.ts`のビルド時ガード
    (1本でも途中切断があればビルドを失敗させる)と、実データ(112ライン)を使った
    回帰テストの両方で使用。
  - 到達不能刈り(`pruneUnreachableNodes`)は変更後のグラフに対して再実施するのみ(ロジック自体は
    不変)。命名済みラインの手が一切除外されなくなったため、112ライン全ての経路が自動的に
    ルートから到達可能になる(証明: 各ラインは根から辿る一続きの保護済みエッジ列であり、
    保護済みエッジは決して除外されないため、帰納的に全ノードが到達可能)。
- **軽微指摘2件を修正**:
  (a) `filterOpeningBook`内で、ノードの全bookMovesが除外された場合そのノードの`isLeaf`を
      `true`に補正する処理を追加(元が`false`でも)。これにより`app.tsx`の
      `evaluateHumanMove`の`!josekiHit.isLeaf`判定が、続きの無いノードを誤って「定石」
      ソースと判定する不整合を防ぐ(app.tsx自体は無変更、データ側で解消)。
  (b) `AUTO_NAME_RE`(自動命名ライン`WTHOR-####`の判定)の二重定義(`traceDisplay.ts`と
      `buildOpeningBook.ts`)を新規`app/src/joseki/lineNaming.ts`に一本化し、両方から
      `isAutoGeneratedLineName`をimportするよう変更(`buildOpeningBook.ts`は後方互換のため
      re-export)。
- **Edax評価データは再利用**(要求どおり再評価不要)。`bookgen/opening-book-eval-checkpoint.json`
  はそのまま、`npm run openingBook:build`のみ再実行。
- **テスト**: `buildOpeningBook.test.ts`をv2ポリシー用に全面更新(29→45テストケースへ拡充、
  保護時の除外免除・isLeaf補正・`collectNamedLineMoveKeys`/`checkNamedLineSurvival`単体、
  実データ112ライン+敵対的疑似乱数評価値によるend-to-end生存確認を含む)。
  `npx vitest run`: 98ファイル832テスト全パス(v1の822から+10)。`npm run typecheck`エラー無し。
- **再生成結果**: `npm run openingBook:build`実行。
  - ノード数: 1111 -> フィルタ+刈り込み後935ノード(刈り込み176、v1の460/651から大幅改善)
  - flagged(高loss)135件(v1と同数、同じEdaxデータのため): 内訳 excludedFromBook=76件
    (自動抽出ラインのみに乗る手、実際にopening-book.jsonから除外)、
    kept(保護により生存)=59件
  - **命名済み112/112ライン全生存を確認**(`checkNamedLineSurvival`のビルド時ガードが
    パスし、かつ`generateOpeningBook.ts`のログ出力でも「named lines fully survived
    112/112」と確認)。具体例として「虎D」(f5-d6-c3-f4)のf4(loss=3、
    `bestValue=1, moveValue=-2`)が`protectedByNamedLine: true, excludedFromBook: false`
    としてbookMoves内に生存(weight=0.057, eval=-2)していることをNodeスクリプトで直接確認。
- **ローカルBrowser MCP確認**: 開発サーバー再起動後、複数タブで`computer`ツールのクリックが
  反映されない事象が発生(DOM上のcanvas要素が1x1に潰れて描画されていないタブが確認され、
  Board.tsx等レイアウトコードは本タスクで一切変更していないため、ブラウザ自動操作環境側の
  一時的な問題と判断)。ローカルでの視覚確認は完了できなかったが、v1で確立済みの本番Pages
  実機確認手順に切り替えて検証を継続した(下記)。
- コミット: `bd46763`(変更対象のみパス明示add。`tasks/`・`CLAUDE.md`は含めず。同時並行の
  T153/T154由来と思われる未追跡ファイル`train/src/bin/egaroucid_filter_stones.rs`・
  `train/src/bin/wthor_to_simple.rs`はスコープ外のためcommitに含めていない)。
  `git push origin main`実行済み(`eea9ebc..bd46763`)。
- **Actionsデプロイ確認**: push直後は`Deploy to GitHub Pages`(run 29716456704)が
  `in_progress`→`queued`を経て`completed success`になることをポーリングで確認。
- **Pages実機確認(v2、再検証)**: https://giwarb.github.io/othello-trainer/
  (新規タブ経由だとcanvasが1x1で描画されない事象が再発したため、既存タブ+実際の
  `click`イベントをcanvas座標へ直接dispatchする方式で操作した。`opening-book.json`が
  200で取得されることを`read_network_requests`で確認)。
  1. 白番で開始 → CPU(黒)がf5を即着手、トレース「定石: 虎(他111)(1手目)」。
  2. 白がd6を打つ(`定石`+`悪手`表示、ロス3石。d6自体は虎ラインの実際の手であり
     除外されないが、盤面全体の最善手f6とは別なので悪手判定は独立に付く)→
     CPU(黒)がc3を自動応手、トレース「定石: 虎(他41)(3手目)」。
  3. **白が虎Dの手順どおりf4を打つ**(盤面座標を直接計算してcanvasへclickイベントを
     dispatch)→ 着手が受理され、盤面が進行し、CPU(黒)が自動応手、トレースが
     「定石: 龍定石(他2)(5手目)」に更新(v1ならこのノードのbookMovesが空になり
     即座に定石から外れていたはずの箇所)。**v1で途中切断されていた虎D
     (f5-d6-c3-f4)のf4が実際にブック内の一手として機能することを実機で確認**。
  4. 続けて定石外の手(f7、ロス15石)を打つとトレースが
     「定石: 龍定石(他2)(5手目)(離脱)」に変わり、cap が解除されて生の評価値
     (-56/-45/-37/-34)がそのまま表示され、ソースラベルも「定石」から
     「中盤(探索)」+「悪手」に切り替わることを確認
     (isLeaf整理の効果を含む、離脱後の分類が正しく機能している)。
- 以上によりv2仕様での受け入れ基準1・6(Pages実機確認・デプロイ成功)、および
  今回の追加指示(命名済み112/112ライン全生存の確認・虎Dのf4がブック内でcap表示
  されることの実機確認)が完了。
