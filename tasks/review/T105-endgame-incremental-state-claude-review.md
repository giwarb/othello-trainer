# T105 増分hash・flip再利用・状態の増分更新 — Claude代替最終レビュー

- 日付: 2026-07-16
- レビュアー: Claude(Codex週間上限中の代替レビュー)
- 対象: コミット `5f460c2`(範囲 `a3a91ef..5f460c2`)
  - `engine/src/zobrist.rs`(+138: `FLIP_KEY`テーブル・`incremental_move_hash`・自己対戦毎手照合テスト)
  - `engine/src/bitboard.rs`(+71/-51相当: `legal_moves_relative`/`apply_move_with_flips`抽出、既存メソッドの薄いラッパー化)
  - `engine/src/endgame.rs`(+202相当: 増分hash常時計算・パスhash切替・empties増分・own/opp化・debug照合+発火カウンタ)
- 規範: `tasks/T105-endgame-incremental-state.md`、`tasks/design/T097-endgame-solver-report.md` §5 T105節・§7
- 前提: 性能ゲート未達(NPS約1.03倍)は「基盤整理として採用」のオーケストレーター裁定済みのため、本レビューの焦点は**正しさのみ**。
- 方法: `git show`/`git diff`による差分読了+周辺コード(negamax本体・公開5関数・shallow層・zobrist既存規約)の照合。テスト実行はverifier担当のため行っていない。

## 総合判定: **合格(重大・中指摘なし、軽微3件)**

FFO/C2全ジョブのノード数完全一致(実装者実測)がコード上の分析とも整合する: 本差分で変わるのは「同じ値をどう計算するか」だけであり、探索木・TTキー・ノード計上に影響する値の変更は一切ない。§7の3大リスク(flip石のhash色切替、パス時のside key、黒白絶対/relative混同)はいずれも正しく回避されている。

---

## 重点確認項目への回答

### 1. FLIP_KEYの数学的正しさ — **OK**

- `FLIP_KEY[sq] = SQUARE_KEYS[sq][0] ^ SQUARE_KEYS[sq][1]`。flipは「相手色→自分色」の入れ替えで、hashに含まれる`SQUARE_KEYS[sq][旧色]`を除去し`SQUARE_KEYS[sq][新色]`を加える操作は、旧色が黒でも白でも `hash ^= K[0]^K[1]` の1回のXORと等価(XOR可換・自己逆元)。**色分岐が不要**という性質の利用は正しい。
- 着手石(元空きマス)は`toggle_square(hash, square, mover_side)`で**着手側の色を明示**して加算 — flip石と着手石の区別は正しい。
- パスは`toggle_side_to_move(hash)`のみ(盤面キー変更なし) — §7「パス時のside key」どおり。
- `zobrist::tests::incremental_move_hash_matches_full_recompute_across_random_self_play_including_passes`がseed 1〜30の自己対戦を**毎手**フル再計算とassert_eq(総手数≥500・パス≥1の下限つき)で照合しており、規約(SIDE_KEYがどちらの手番に対応するか等)との整合はテストが構造的に保証する。

### 2. 増分hashの全経路網羅 — **OK**

| 経路 | 実装 | 判定 |
|---|---|---|
| ルート入口(公開5関数、`known_hash: None`) | `known_hash.unwrap_or_else(\|\| zobrist_hash(board, side))`のフルスキャン1回(行1344、従来どおり) | 正 |
| 着手(子生成ループ) | `incremental_move_hash(hash, square, side, flips)`を**常に**計算し`MoveInfo.child_hash`へ。`negamax_child`は常に`Some(child_hash)`を子へ渡す(旧: `etc_eligible`時のみフルスキャン/それ以外`None`で子側フルスキャン) | 正 |
| パス再帰 | `Some(toggle_side_to_move(hash))`(旧: `None`で子側フルスキャン) | 正 |
| shallow層(T104)に入る枝 | shallow層はhashを一切使わない設計のまま(要件8)。親が空き≤4の子にもchild_hashを計算して渡すが、子は`solve_shallow`委譲でこれを未使用のまま捨てる(無駄計算だが正しさに影響なし、軽微3参照) | 正 |
| ETC probe用hashとの一本化 | ETCは`move_info.child_hash`をprobeする構造のまま。値は旧フルスキャン値と同一(debug_assertで担保)なのでprobe結果・cutoff発火も不変 | 正 |

hashの**値**はすべての経路で従来と同一(計算方法だけが変わる)ため、TTキー・probe/store・ETC判定・探索木は構造的に不変。FFO 5問各問+C2全540ジョブのノード数完全一致という実装者の実測はこの分析と整合する。

### 3. 黒白絶対表現とrelative表現の混同 — **なし**

- `(own, opp)`の導出はパス判定直前の1箇所(`match side`)に集約。`legal = legal_moves_relative(own, opp, empty_squares)` = 旧`board.legal_moves(side)`、パス判定の`legal_moves_relative(opp, own, ...)` = 旧`board.legal_moves(side.opposite())`。引数順(own/opp swap)正しい。
- 子生成: `apply_move_with_flips(own, opp, mv, flips)` → `(new_own, new_opp)`はmover視点。`next_board`への戻し(`Black => black: new_own` / `White => black: new_opp`)正しい。`opp_mobility = legal_moves_relative(new_opp, new_own, empty_squares & !mv)` — 次手番(side.opposite())のownは`new_opp`なので引数順正しく、旧`next_board.legal_moves(side.opposite())`と同値。
- **境界の型は不変**: TT格納・`final_score`・再帰引数・公開APIは絶対表現の`Board`のまま(承認済みnarrow化のスコープどおり)。relative表現はホットパスの計算にのみ閉じている。
- `incremental_move_hash`の`mover_side`は絶対`Side`をそのまま渡しており、zobristの絶対色規約と整合(毎手照合テストが担保)。

### 4. debug照合の実効性と配置 — **OK**

- 着手(`MoveInfo`構築時)とパス分岐の**両方**に`debug_assert_eq!(増分hash, zobrist_hash(フル再計算))`があり、増分経路そのものを検証している(別実装の再現ではなく、探索本体が実際に使う値の照合)。
- releaseビルドでは`debug_assert_eq!`はstripされ(release profileは`debug-assertions=false`)、発火カウンタは`#[cfg(test)]`限定 — **release NPS計測に影響しない配置**。
- 発火カウンタテスト`incremental_hash_check_fires_across_random_positions_including_passes`は発火≥200・対象局面≥160・パス局面>0の下限つきで空洞化を防止(要件5の「発火件数の下限つき」を満たす)。zobrist側の毎手照合テストと二重の網。

### 5. 探索木・ノード計上を変えうる変更の混入 — **なし(コード上も確認)**

- `empties`は`empty_squares.count_ones()`に置換。マスクの不変条件(ルート=`!(black|white)`、着手子=`& !mv`(flipは空きを変えない)、パス=不変)は正しく、`board.empty_count()`と常に同値。shallow委譲判定・`empties == 0`終局判定・TT格納depth・`etc_min_empties`比較のいずれも同じ数値。
- 合法手集合・列挙順(LSBから)・`MoveInfo`のソートキー(opp_mobility/is_corner/square_class/parity/tt_move、いずれも同値)・ETC probe順・PVS分岐条件は不変。
- `*nodes += 1`の位置・回数に変更なし(shallow層の計上経路も未変更)。`shallow_budget_guard`・abort契約も未変更。
- `solve_shallow`の空きマス列挙は渡されたマスクからのLSB順で、旧`!(black|white)`導出と同一ビット列 → `order_empties_for_shallow`の入力・出力も不変。
- bitboard.rsの`legal_moves_relative`/`apply_move_with_flips`は既存ロジックの逐語的抽出(`Board::legal_moves`/`apply_move`は薄いラッパー化のみ)。

### 6. is_root(T104 redo#2)との相互作用 — **問題なし**

`is_root`は全シグネチャで維持され、公開5関数=true・`negamax_child`=false・パス再帰=false・テストヘルパー=falseの割り当ては再レビュー時(a3a91ef)と不変。shallow委譲条件は`SHALLOW_ENABLED && !is_root && empties <= SHALLOW_MAX_EMPTIES`で、`empties`の算出元が変わっただけ(同値)。ルートのfull-scan hash(`known_hash: None`)とルートTT格納(B1修正の本体)も不変。

### 7. 既存テストの改変 — **意図の弱体化なし**

既存テストへの変更はテストヘルパー2箇所(`solve_with_etc`/`solve_with_seeded_child_etc`)への`initial_empty_squares(board)`引数追加のみで、アサーションの変更・削除はゼロ。新規テスト2件(zobrist毎手照合・発火カウンタ)は上記のとおり実効的。

---

## 軽微

1. **要件9(T099申し送り: 冒頭コメントの排序説明更新)が本差分で実施されていない**(ヘッダコメントの変更0行、作業ログにも言及なし)。ただし確認したところ、排序説明そのもの(行35-37「TT move → 隅 → 相手合法手数昇順 → square class → 固定4象限パリティ → マス番号」)は**既に現状(T100/T103)と一致しており**、実質的な負債は解消済みだった可能性が高い。一方、直後の行39-41「安定石による静的カットや、**空き4/3/2/1のハードコード専用関数は本実装では行わない**」は**T104でsolve_1〜4が導入済みのため現状と矛盾する古い記述**(T105ではなくT104時点の更新漏れ)。挙動に影響しないdocのみの負債として、次回endgame.rsを触るタスクへの申し送りを推奨。
2. `cargo test --release`でlibテストを実行した場合、`debug_assert_eq!`はstripされる一方`#[cfg(test)]`の発火カウンタは加算されるため、発火カウンタテストが「照合なしの通過」を数えうる(現行の受け入れ基準はdebugプロファイルの`cargo test -p engine`で実行するため実害なし。厳密にしたければカウンタ加算も`#[cfg(debug_assertions)]`で括る)。
3. 子hashの増分計算が「生成した全子」に対して行われるため、(a) beta cutoffで訪問されない子、(b) shallow層(空き≤4)に委譲されhashを使わない子、にも計算コストがかかる(旧実装は訪問された子だけが自前でフルスキャン)。増分計算はフルスキャンより大幅に軽く、実測(FFO/C2ノード完全一致・壁時計-3%)で正味の悪化がないことは確認済み — 情報として記録のみ。

## 補足(良い点)

- 「hashの値は変えず計算方法だけ変える」という不変条件が全経路で守られており、ノード数完全一致という強い検証条件(タスク仕様の狙い)を成立させる実装規律が高い。
- `FLIP_KEY`の色非依存XORはEdax系の定石どおりで、色分岐を持たないぶん§7リスク(色切替ミス)の発生余地自体を消している。
- narrow化スコープ(承認済み)が正確に守られている: relative表現はホットパス内に閉じ、`Board`境界・公開API・TT格納の型は不変。

## 判定の帰結

正しさの観点で指摘なし(軽微はdoc負債とテスト運用上の注記のみ)。verifierの受け入れ基準確認(FFO各問ノード完全一致・C2全ジョブ一致・194テスト・WASM・決定性)の合格をもってdone判定してよい。軽微1のヘッダ記述(T104由来の古い「専用関数は行わない」記述)はSTATUS.mdの申し送りに1行残すことを推奨する。
