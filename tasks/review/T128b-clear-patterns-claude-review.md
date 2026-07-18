# T128b 最終レビュー(Claude 代替レビュー)

- 対象: コミット `5214f52`(app: 明確悪手パターン第1波4種を追加+ゲートfallback世代ガード修正(T128b))
- 仕様: `tasks/T128b-clear-patterns-wave2.md`(裁定4点を含む)
- 設計の正: `tasks/design/T128-clear-patterns-report.md`
- 前提レビュー: `tasks/review/T128-clear-blunder-claude-review.md`(中1指摘=catch経路世代ガード)
- レビュー方法: `git show 5214f52`による差分読解+周辺コード(`clearBlunder.ts`全文 / `PracticeMode.tsx`のゲート・`handleModeFailure`・`backToSettings`経路 / `engine/src/explain.rs`の`FeatureSet`計算 / `stagePool.ts`)+ `npx vitest run`(74ファイル/628件 全パス。T128b関連3ファイル30件も個別に確認)+ **テスト局面フィクスチャの独立再検証**(scratchpadに自前のbitboard実装を書き、テスト内の盤面定数の主張を全件再計算して照合)。Rust/wasmビルド・`npm run typecheck`・bench/train には触れていない。

## 総合判定: 合格(重大指摘なし。中0件・軽微5件)

---

## 観点1: 4検出器の意味論 — 設計レポートと厳密に一致。「発火しなかった」観測に実装バグの説明は無い

**4検出器とも設計レポート§(a)①〜④の擬似コードと厳密に一致する**ことを確認した。特に懸念のあった2件:

- **own-mobility-collapse**: 検出器は`playedFeatures.moverMobilityAfter`/`bestFeatures.moverMobilityAfter`を比較し、`diff >= 3 && playedOwn <= 4`で発火(`clearBlunder.ts:367-383`)。エンジン側の定義を`explain.rs:400-403`で確認: `mover_mobility_after = after.legal_moves(side).count_ones()`、すなわち「**着手後局面における着手側(自分)の合法手数**」であり、検出器の「自分/相手」視点解釈は正しい(相手番局面のFeatureSetを自分視点と取り違える種類のバグは無い)。`requestFeatureSet(s.board, s.sideToMove, notation)`の呼び出し(PracticeMode.tsx:697-698)も着手前局面+着手側で正しい。ハイライト(`legalMoves(boardAfter*, preMoveSide)`)も同じ意味論。
- **mass-flip**: `flippedSquares(before, after, side)`は「beforeで相手石・afterで自石」のマスを数える(着手マスはbeforeで空きのため自然に除外、`clearBlunder.ts:394-401`)。フリップ数の算出・差≥4・`countEmpty(preMoveBoard) >= 16`ガード、いずれもレポートの擬似コードどおり。

**「本番Pagesで発火しなかった」観測に対する実装上の説明(バグ)は特定できなかった**。コードは設計に忠実であり、非発火の説明として整合的なのは実装バグではなく観測手法側の要因である:

1. **ゲート前提条件**: 検出器は「`judgeMidgameMove`が評価値で不合格 かつ `judgement.bestMove`あり」のときしか実行されない(PracticeMode.tsx:692-693)。検出条件を満たす手でも評価値判定を通過すれば検出器は走らず、外からは「発火しなかった」ように見える。
2. **差分の基準はエンジンの最善手**: `bestOwn - playedOwn >= 3`・`flipsPlayed - flipsBest >= 4`はいずれも`judgement.bestMove`(エンジンが選んだ最善手)基準。実装者がピクセル読み取り+自前ロジックで「発火するはず」と見込んだ際の想定最善手がエンジンの最善手と違えば、差分は閾値未満になりうる。
3. **表示枠のクラウディング**: 検出器がパターンを返しても、severity上位2件(MAX_PATTERNS=2)に入らなければ表示されない。own-mobility-collapse(severity=diff、最小3)・mass-flip(同、最小4)は、corner-gift(10)/missed-corner(9)/opponent-pass-missed(8)/x-c-danger(6)や大差のopponent-mobility/wall-frontierに劣後しやすい。「検出はされたが3位以下で非表示」は観測上「発火しなかった」と区別がつかない。
4. 実装者自身が認めるとおり、canvasピクセル読み取り+自前オセロロジックによる盤面再構成の誤差の可能性。

なお実装者の代替確認(実盤面のビットボード演算を通した陽性・陰性テスト)は自己参照的でないことを確認済み(観点4)。

## 観点2: missed-corner / opponent-pass-missed のエッジケース — 問題なし

- **最善手情報の欠如時**: ゲート自体が`judgement.bestMove`の存在を前提に分岐しており(無ければ従来どおり評価値のみで不合格、検出器は呼ばれない)、`bestSquare`が未定義のまま検出器に渡る経路は無い。
- **missed-corner**: 実際の手も隅(別の隅を含む)なら`CORNER_SQUARES.includes(playedSquare)`で抑制 — 「隅を取り損ねてはいない」ので設計擬似コードどおり。複数隅が候補でも`bestSquare`は単一なので曖昧さなし。既存corner-giftとの同時発火は裁定どおり許容(両方とも10/9で上位2枠に入る)。
- **opponent-pass-missed**: `bestOppMoves.length !== 0 || playedOppMoves.length === 0`で、両手ともパス強制のケース(悪化なし)を正しく除外。パス強制後の手番連続の扱いは静的判定の範囲外で、文言も「続けてあなたの番になれた」と1手先の事実のみを述べており正直。
- **フィクスチャの実在性**: テストの盤面定数を独立再計算で全件照合した — pass-missed局面(h6→白合法手0 / g5→9、双方黒の合法手)、own-mobility局面(c6→3 / d6→8 / e6→3 / b6→5、**テストで注入しているFeatureSet値が盤面の実値と一致**)、mass-flip局面(空き38、h6=5個 / b5=1個 / g5=1個)、missed-corner局面(黒の合法手は正確に{a1, f5})。すべて主張どおり。

## 観点3: severity入れ替えと統合順 — 裁定準拠・一貫

- 定数は`corner-gift(10) > missed-corner(9) > opponent-pass-missed(8) > x-c-danger(6)`で、裁定「隅の取り逃し>パス取り逃し」を反映(レポート生値8/9からの入れ替え)。入れ替えの経緯は定数のdocコメントに両方とも明記されており、将来の読者がレポートと突き合わせても混乱しない。
- own-mobility-collapse/mass-flipは既存の数量系と同じ「severity=diff」方式で統合順に组み込まれ、`detectClearBlunderPatterns`は9検出器→severity降順→2件切り出しの単一パイプライン。統合テスト(定数の大小関係+missed-corner/own-mobility-collapse同時検出時の並び順)で固定されている。
- 軽微な留保: diff方式のseverityは理論上固定値を超えうる(下記軽微2)。

## 観点4: catch経路世代ガード修正と回帰テスト — 正しく、恒真ではない

- **修正の正しさ**: ガード(`if (sessionGenerationRef.current !== generation) return`)は`Promise.all`のreject後・`handleModeFailure`呼び出し前に置かれている(PracticeMode.tsx:723)。`handleModeFailure`は先頭で**同期的に**`recordStageAttemptNow(s.stageKey, 'fail')`を実行する設計(T117教訓、同関数内の世代チェックはUI確定のみを守る)なので、ここが唯一正しい挿入位置。T128レビュー中1の指摘どおりの修正。
- **テストが恒真でないこと**: `PracticeMode.clearBlunderGateFallbackGuard.test.tsx`は (a)`pendingFeatureSetRejects.length > 0`のアサートでゲート到達(=評価値不合格+bestMoveあり+requestFeatureSet発行)を確認し、(b)ステージセル経由で開始するため`stageKey`は非null(fail記録が書かれうる状態)、(c)「やめる」=`backToSettings`は実際に`sessionGenerationRef`をインクリメントする(PracticeMode.tsx:821-822)、(d)離脱後にrejectさせ、localStorage非書き込み+失敗画面非遷移をアサートする。修正を外せば`handleModeFailure`先頭の同期書き込みが即座に走りlocalStorageアサートが落ちる構造で、恒真ではない。作業ログの「修正前コードを一時復元してテストが実際に失敗することを確認」という手順とも整合する(テスト自体はその手順に依存せず構造的に実効性がある)。

## 観点5: その他(コミット衛生・検証)

- コミットは`app/src/midgame/`配下4ファイルのみで、スコープどおりパス明示。`bench/`・`train/`・エンジンへの変更なし(タスクのスコープ外遵守)。
- `npx vitest run`: 74ファイル/628件 全パス(レビュー時に再実行して確認)。
- `git status --short`にタスク由来の残留なし(レビュー時点、`bench/edax-compare/`のT114由来差分は本タスクと無関係)。

## 指摘まとめ

| # | 区分 | 内容 | 対応推奨 |
|---|---|---|---|
| 軽微1 | 軽微 | opponent-pass-missed発火時(相手合法手≥3)は定義上opponent-mobilityも必ず同時発火し(diff=played−0≥3)、相手合法手≥9なら汎用メッセージ(severity=diff)が専用メッセージ(8)より上位に来る。同系統2件で表示2枠が埋まり、他系統のパターンが隠れうる | pass-missed発火時にopponent-mobilityを抑制する調整を第2波(T128c)で検討 |
| 軽微2 | 軽微 | diff方式severity(own-mobility-collapse等)は理論上10を超えうるため、極端な局面では裁定文言「隅系が最上位」が崩れる(例: bestOwn=15/playedOwn=0でdiff=15>corner-gift 10)。T128以来の既存規約踏襲であり実害は稀 | T128cの閾値調整時に上限クランプを検討(任意) |
| 軽微3 | 軽微 | missed-cornerの第3テストは「実際の手も隅」ケースの代替(両方非隅)であり、「最善=隅かつ実際=別の隅」の抑制分岐は直接テストされていない(ロジックは自明) | 任意 |
| 軽微4 | 軽微 | 作業ログの「josekiEnd開始局面(既に空きマス10前後からスタート)」は誤記(定石終端は10〜20手目≒空き40超。「手数10前後」の書き間違いと思われる)。この記述を真に受けるとmass-flipのガード(空き≥16)が死んでいるように読めてしまう | 作業ログの訂正(任意)。実装への影響なし |
| 軽微5 | 軽微 | fallbackガード回帰テストの非空虚性(ガード無しなら本当に書き込まれること)はテストファイル単体では担保されず、作業ログのred確認手順が根拠。ガード無し相当の陽性ケース(離脱せずrejectさせるとfail記録+失敗画面になる)を同ファイルに足すとより堅い | 任意 |

**結論: 合格。** 重大・中の指摘なし。4検出器の実装は設計レポートの擬似コードと厳密に一致し(own-mobility-collapseの`moverMobilityAfter`の視点解釈をexplain.rsまで遡って確認)、「本番で発火しなかった」観測は実装バグでは説明できない — ゲート前提条件(評価値不合格時のみ実行)・エンジン最善手基準の差分・表示2枠のクラウディング・ピクセル再構成誤差のいずれか(または複合)が原因と判断する。severity入れ替えは裁定準拠で文書化も十分、世代ガード修正と回帰テストは実効性がある。
