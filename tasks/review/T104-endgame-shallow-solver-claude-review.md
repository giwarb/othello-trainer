# T104 空き1〜4専用ソルバーとshallow層 — Claude代替最終レビュー

- 日付: 2026-07-16
- レビュアー: Claude(Codex週間上限中の代替レビュー)
- 対象: コミット範囲 `bdb4389..ce1dacf`(`4bbca88`=専用ソルバー+shallow層、`ce1dacf`=CornerThenParity静的順序付け+閾値4最終設定)
- 対象ファイル: `engine/src/endgame.rs`(shallow層本体+テスト)、`engine/src/bitboard.rs`(`flips_for_move`抽出+テスト3件)、`engine/src/search.rs`(テスト期待値の追従)
- 規範: `tasks/T104-endgame-shallow-solver.md`、`tasks/design/T097-endgame-solver-report.md` §3.1/§3.6/§5/§7
- 方法: メイン作業ツリーがT105実装で汚れているため、`git show`とscratchpad配下の一時worktree(ce1dacf / bdb4389)でコードを読了。重大疑い箇所は一時worktreeでdebugビルドし`eval_cli best`で実挙動を再現確認した(worktree・ビルド成果物はレビュー後に削除済み)。テストスイートの実行はverifier担当のため行っていない。

## 総合判定: **不合格(重大1件)**

探索アルゴリズム本体(solve_1〜4の正しさ・ノード計上・abort契約・順序付け)は高品質で指摘なしだが、**ルート局面が空き4以下のときに`SearchResult.best_move`が`None`になる呼び出し元契約の破壊**を発見した。実対局でCPUが終盤の着手を返せなくなるT084同類のブロッカーであり、修正なしでdoneにできない。

---

## 重大(ブロッカー)

### B1: ルート空き≤4の完全読みで `best_move: None` / `pv: []` が返る(CPUが終盤で着手不能になる)

**機構**: `search.rs`のルート完全読みパスは、solve完了後にルート局面のTTエントリから最善手を取り出す:

- `search_with_eval_inner` 行527–529(`max_nodes`なし・空き≤`exact_from_empties`の直接solveパス):
  `tt.probe(hash, TTDomain::Exact).and_then(|entry| entry.best_move)`
- 同 行733–735(`max_nodes`あり・depth==1後のin-tree exactパス): 同じ構造。

T104で`negamax`は空き`SHALLOW_MAX_EMPTIES`(=4)以下を**ノード計上前に`solve_shallow`へ完全委譲**し、shallow層は設計どおりTT storeを一切行わない。その結果、**ルート自体が空き1〜4の場合はTTに何も格納されず、probeが`None` → `best_move: None`、`pv`空**のまま`is_exact: true`の結果が返る。baseline(`bdb4389`)ではルートの`negamax`がTTエントリ(best_move込み)を格納していたため、これはT104が新規に導入した回帰である。

**実測再現**(空き4・黒に合法手a1が存在する局面、`eval_cli best --depth 8 --exact-from-empties 16`):

| ビルド | max-nodesなし | --max-nodes 160000 |
|---|---|---|
| baseline `bdb4389` | `move: "a1"` | `move: "a1"` |
| **`ce1dacf`(T104)** | **`move: null`** | **`move: null`** |

(いずれも`score.discDiff=64.0, type=exact`でスコア自体は正しい。空き5の局面では両ビルドとも`move`が返ることも確認済み=ルートが専用層に委譲される空き≤4だけの問題。)

**影響範囲**:
- **実対局(最重要)**: `app/src/game/gameLoop.ts` `requestCpuMove`(行263–265)は`response.pv[0]`を着手に使い、`undefined`なら**stateを変えずreturn**する。CPU手番のまま進行しないため、**ほぼ全対局の終盤(空き4以下のCPU手番)でゲームが停止する**。CPUレベル全種が該当(weak/normal=`maxNodes`なしパス、strong=`maxNodes`ありパス、いずれも再現済み)。
- **vs-Edax対局ベンチ**: `eval_cli best`のsingle-root経路が`move: null`を返す。T084事故(「exact時間切れでmove:null→対局80%が途中終了」)と同型。なお`eval_cli budget-regression`は`board.legal_moves != 0 && best_move.is_none()`を`null_move_with_legal`という**欠陥カウンタ**として既に定義しており(eval_cli.rs 行942)、このプロジェクト自身が「合法手があるのにnull move」を欠陥と規定している。
- **詰めオセロ/解析UI**: 空き≤4のexact解析でPV(正解手順)が空になる。
- 今回の受け入れ基準(FFO=スコアのみ照合、C2=証明窓のノード数のみ、`cargo test`)はいずれもルートbest_move契約を踏まないため、テストスイートでは検出されない(既存の`best_move.is_some()`系テストは全て初期盤面=空き60)。

**修正の方向性**(いずれか、実装者判断でよい):
1. `search.rs`の当該2箇所で、TT probeが`None`のときのフォールバックとしてルートの合法手を1手ずつ子solve(返ったスコアと一致する手を選ぶ、タイブレークはマス番号固定で決定性維持)する。
2. または`negamax`のshallow委譲を「ルート呼び出しでは行わない」形にする(例: 公開API入口でルート空き≤4なら1手ループ+子をshallowで解く)。ルートのTT格納・best_move契約がbaselineと完全一致するのでこちらが素直。
3. いずれの場合も**回帰テストを追加すること**: 「空き1〜4・合法手ありのルートに対し`search_with_eval`(max_nodesあり/なし両方)が`best_move.is_some()`かつ`pv`非空を返す」。

---

## 中

なし(重大1件に集約)。

## 軽微

1. **仮想ノード増分がbudget guardを通らない**: `solve_1`の仮想子(+1/+2)と`solve_shallow`の空き0分岐(+1)はノードを加算するがlimit/時間チェックをしない。このため (a) `nodes`が`node_limit`を最大+2超過しうる(baselineのnegamaxは超過ゼロ)、(b) limitちょうどの境界でnegamaxならabortしたはずのsolveが完走する、(c) `*nodes % 1024 == 0`の時間チェックが増分ジャンプで稀にスキップされ、チェック間隔が最悪〜2倍に伸びる。いずれも決定的・有界(±2ノード/1インターバル)で、過少計上ではなく、(b)はテスト`solve_1_node_limit_aborts_exactly_at_the_documented_call_counts`のコメントで設計判断として明示済み。quotaの実質緩和には当たらないと判断する。
2. **`negamax`で`board.empty_count()`が2回計算される**(行1239のshallow判定と行1269)。popcountなので実害は無視できる。
3. **`solve_shallow`の空き0分岐が`timed_out`既立時にも実スコアを返す**(negamaxは0を返す)。全呼び出し元が`timed_out`フラグで値を破棄するため実害なし(値の意味論としてはフラグが正)。

## 確認済み項目(重点確認1〜8への回答)

| # | 観点 | 結果 |
|---|---|---|
| 1 | solve_1〜4の正しさ(パス/早期終局/総取り規約) | **OK**。solve_1の3ケース分岐はnegamaxの終局規約(`final_score`)と一致(`final_score_relative`は手番相対の同一実装)。solve_2〜4のパスは同関数へのrole入れ替え実再帰、両者パスは総取り規約で即return。符号・窓反転(`-beta,-alpha`)正しい。naive_solve・shallow無効negamaxとの3者一致テストが両者パス局面(明示構築)込みでカバー |
| 2 | ノード計上の整合 | **OK(過少計上なし)**。guard(`shallow_budget_guard`)がnegamaxと同じ「呼び出しごと+1→timed_out→limit→時間」の順序で判定。solve_1の仮想カウント2/3/1は「negamaxなら何回呼ぶか」の定義と手計算一致(テストで直接照合)。過大計上もなし。境界±2ノードの差のみ(軽微1) |
| 3 | abort契約 | **OK**。solve_2〜4は子の戻り値を`best`/`alpha`に反映する**前**に`*timed_out`を確認して0でreturn。パス再帰・guard即断も同様。打ち切り値の伝播経路なし |
| 4 | shallow層root呼び出しの戻り値契約 | **スコア・nodes・abort_reasonはOK**(`solve_exact_window_limited_with_nodes`の分類は`nodes >= limit`判定で整合)。**ただしTT未格納によりsearch.rsのbest_move抽出が破壊される(重大B1)** |
| 5 | CornerThenParity順序付け | **OK**。コンパイル時定数、最終キーにマス番号で決定性確保、`solve_shallow`入口で1回のみの挿入ソート、正しさへの非干渉は一致テストが担保。parityはnegamax既存管理値(`negamax_child`がXOR更新)を受け取っており正しい |
| 6 | ETC/PVS/パリティ境界(空き5) | **OK**。ETCは`ETC_MIN_EMPTIES=15`以上のみで境界に関与しない(子hash計算の無駄もなし)。空き5のNWS/PVSのnull window・再探索窓はshallow層のfail-soft alpha-betaが正しく処理。パス局面の委譲もなし(空き5以上のパスはnegamax内で処理) |
| 7 | テストの実効性 | **OK(自己参照・空洞化なし)**。発火カウンタ(`TEST_SHALLOW_DISPATCH_COUNTS`)で空き1〜4全ての発火>0を強制、独立参照naive_solveとの3者比較、両者パスは明示構築で確実にカバー、solve_3/4は閾値を経由しない直接呼び出しテストで死角化を防止、node limit abortは8局面以上を強制。ただし**ルートbest_move契約のテストが欠落**(B1の一部として修正時に追加すべき) |
| 8 | search.rsテスト期待値更新 | **OK(機械的追従)**。`leaf_exact_quota_abort_...`の期待値(attempts 4→2、completed 3→1、exact_children 2→1)とコメント更新のみで、TTドメイン分離という検証意図は不変。閾値変遷(4→2→4)の経緯もコメントに記録済み |

## 補足(良い点)

- `flips_for_move`の抽出は`apply_move`内ループの逐語的な単一ソース化で、同値性テスト(自己対戦30手×全64マスの`flips!=0 <=> legal`同値)も適切。
- ノード計上契約をモジュール冒頭+各関数docに明文化し、`nodeDefinitionVersion`の意味を保存した点は設計レポート§7の要請に忠実。
- 閾値ablation(4/3/2)と順序付け変種比較の計測記録が作業ログに残っており、追跡可能性が高い。

## 判定の帰結

B1の修正(+回帰テスト)後、verifierによる受け入れ基準の再実行と、本レビューB1再現手順(空き4局面での`eval_cli best`のmove非null確認、可能ならappのgameLoop経由の終盤完走確認)の再確認をもって合格とできる。探索本体の再レビューは不要(B1はsearch.rs/委譲境界の契約問題であり、solve_1〜4のアルゴリズムは合格水準)。
