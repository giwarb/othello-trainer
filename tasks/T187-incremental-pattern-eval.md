---
id: T187
title: 高速化(6): パターン評価の増分化(incremental pattern evaluation)
status: todo
assignee: implementer
attempts: 0
---

# T187: 高速化(6): パターン評価の増分化(incremental pattern evaluation)

## 目的

中盤探索(NegaScout)の葉評価 `static_eval` は、毎回46パターンインスタンス×約9セルをフルスキャンして3進インデックスを再計算している。T185適用後の推定コスト内訳でこれが**壁時計の約42%と最大バケット**。Edax/Egaroucid流の「着手差分だけパターンインデックスを更新する」増分評価に置き換え、単一スレッドのまま大幅高速化する。**探索結果(best_move / score / depth / ノード数)はビット単位で完全不変であること**が絶対条件。

## 背景・コンテキスト(事前調査済み、2026-07-22 explorer)

このタスクは難度が高い。以下の調査結果を前提として使ってよい(着手時に現物と突き合わせて確認すること)。

### 現行の評価経路
- エントリポイント: `engine/src/pattern_eval.rs:434` `PatternWeights::score(&self, board, mover) -> f32`。
  - `stage = stage_for_empty_count(board.empty_count())`(pattern_v6.bin はV4形式=61ステージ)。
  - 各インスタンス i について `cells = &self.class_info.aligned_cells[i]` → `state = patterns::pattern_state_index(cells, board, mover)`(`engine/src/patterns.rs:294-305`、セル列挙の3進エンコードをフル再計算)→ `index = self.table_index(class_id, state)`(`pattern_eval.rs:387`、canonical形式ならテーブル引き)→ `sum += class_tables[class_id].stage_tables[stage][index]`。
  - 最後にスカラー特徴(モビリティ差等、`pattern_eval.rs:149-160`)を加算。
- 探索からの入口は `engine/src/search.rs:118` `static_eval`(葉 `depth==0`、`search.rs:1813-1815` のみ)。内部ノードのorderingは評価値を使わない(モビリティ・隅ベース)。
- MPCプローブ(`mpc_try_cutoff`)は `negascout` を再帰するだけなので、同じ葉経路が自然に増分化される。特別扱い不要。

### 探索側の構造
- 子盤面コピー方式。T185の `OrderedMove { mv, next_board }`(`search.rs:2296-2314`)で子盤面は事前計算済み。
- flip mask は `negascout` ループ内で既に導出済み(`search.rs:1877-1885`、`let flips = (own_after ^ own_before) & !mv_bit;` — T182の増分hash用)。**増分評価はこれを再利用できる**。
- パス: `search.rs:1789-1811`、盤面不変・手番のみ反転して再帰。
- 終盤ソルバー(`endgame.rs`)は評価関数を一切使わない → スコープ外。

### 設計方針(オーケストレーター指定。合理的な理由があれば逸脱可、ただし作業ログに理由を明記)

1. **絶対色(黒視点)でraw 3進状態を保持する**: `PatternState`(46インスタンス分の `u32` 配列、1深さ分184B)を導入。桁の意味は「0=空 / 1=黒 / 2=白」で固定し、手番に依存させない。
2. **手番はクラス別の事前計算写像テーブルで吸収する**: 重みロード時に各クラスについて
   - `idx_black[class][raw] = table_index(class, raw)`
   - `idx_white[class][raw] = table_index(class, swap12(raw))`(swap12 = 全桁の1↔2入替)
   を構築する(要素型は既存 `canonical_tables` に合わせる。テーブルサイズは 3^セル数 ≤ 3^10 = 59,049/クラス)。根拠: `pattern_state_index` の White 視点raw = 黒視点rawのswap12 が定義上厳密に成り立つ(`cell_trit` は own/opp を mover で選ぶだけ)。これにより**パスは状態更新ゼロ(参照テーブルが切り替わるだけ)**になる。
3. **逆引きテーブル**: 重みロード時に `cell_to_instances[64] = Vec<(instance_id, pow3_digit)>` を構築する。必ず `class_info.aligned_cells[i]`(代表インスタンスに揃えたセル順序、`patterns.rs:413-419` のドキュメント参照)を基準にすること(自然順セルではない)。`POW3` は `patterns.rs:121`。
4. **差分更新**: 子へ降りるとき、親 `PatternState` をコピーし、着手マス(0→mover色)と flips(相手色→mover色)の各マスについて `state[i] += delta * pow3_digit` を適用する(0→1: +1、0→2: +2、2→1: -1、1→2: +1、いずれもpow3単位)。既存の flips 計算(`search.rs:1877-1885`)を再利用する。
5. **葉評価**: `score_with_state(state, board, mover)` を追加。パターン項は `stage_tables[stage][idx_{black|white}[class][state_i]]` を**現行 `score()` と同一の順序(i = 0..46 の昇順)・同一のf32加算順で**合算し、スカラー特徴は現行どおりフル計算で加算する。**f32の加算順が1箇所でも変わると値がズレて探索結果が変わるので厳守**。
6. **debug照合**: `debug_assertions` 時に増分stateとフル再計算(`pattern_state_index`)の一致を照合する(T105の増分hash debug照合の前例に倣う)。リリースビルドではコストゼロ。
7. **適用範囲**: `negascout` の葉評価経路のみ。既存の公開 `score()` / UI経路(`search_all_moves_with_eval_core_restricted` の `static_eval` 直接呼び出し、`search.rs:1397`)はフル再計算のまま無変更。ヒューリスティック評価フォールバック(`weights: None`)も無変更。
8. 本番 `train/weights/pattern_v6.bin` がPWV4(レガシー)/PWV5(canonical)どちらの形式かを着手時に確認し、両形式で正しく動くこと(レガシーは `table_index` が恒等なので `idx_black` が恒等表になるだけ。実装は両形式ともテーブル経由に統一してよい)。

## 変更対象

- `engine/src/pattern_eval.rs` — 逆引き/写像テーブルの構築、`score_with_state` 追加
- `engine/src/patterns.rs` — swap12・逆引き生成のヘルパー(必要なら)
- `engine/src/search.rs` — `negascout` への `PatternState` の受け渡し(ルートでフル計算1回→以降増分)、flips再利用
- テスト追加(同上ファイル内)、NPSレポート `bench/edax-compare/t187_incremental_eval_report.md`

## 要件

1. 上記設計方針の実装。探索結果はMPC on/off両方でビット単位不変(ノード数まで一致)。
2. **プロパティテスト追加**: ランダム自己対局(パス含む・複数ゲーム)の全局面で (a) 増分 `PatternState` == `pattern_state_index` フル再計算、(b) `score_with_state` のf32ビット表現(`to_bits()`)== 現行 `score()`、を検証する。`engine/src/zobrist.rs:251` の `incremental_move_hash_matches_full_recompute_across_random_self_play_including_passes` が直接のテンプレート。
3. 既存の固定値回帰テスト(t182 / t184 / t185、`search.rs:4534/4599/4660`)が**アサート値を一切変更せずに**パスする。
4. **NPS計測(検証の恒常的教訓に従うこと)**: worktree独立ビルド(変更前=T186完了時点のcommit vs 変更後)+交互実行(A,B/B,A)+各3回以上+マシン専有で、T183/T185と同じ20局面バッチのMPC off/on両方を計測。ノード数が変更前と完全一致することも同時に確認する。レポートに raw JSON を保存し、使用したバッチ・フィルタ条件を明記する(T185申し送り)。
5. 採用条件: ノード数完全一致 + NPS改善が計測誤差を明確に超えること(期待値: パターン項は評価コストの約83%、evalは壁時計の約42%なので、2桁%の短縮が目標。ただし採否は実測で判断)。

## やらないこと(スコープ外)

- スカラー特徴(モビリティ差・空隣接差)の増分化(フル計算のまま。効果測定後に別タスクで検討)
- orderingの変更・futility等の新しい枝刈り・探索アルゴリズム自体の変更
- `endgame.rs`(評価不使用)・重みファイル形式・学習側(`train/`)の変更
- `ANALYSIS_ENGINE_VERSION` のインクリメント(評価結果・探索結果が完全不変のため不要。万一値が変わる実装になったらそれは本タスクの不合格を意味する)
- マルチスレッド・SIMD
- `tasks/` 配下・`CLAUDE.md` のコミット(作業ログ追記はするがコミットはオーケストレーター担当)

## 受け入れ基準(検証コマンド)

- [ ] `cargo test -p engine` 全件パス(`protocol.rs` の既知フレーキーは単独再実行で切り分け)。
- [ ] 新規プロパティテスト(要件2)がパスし、かつ**増分更新ロジックに意図的なバグを入れると失敗する**ことを確認済み(regression-catching実証、確認後は元に戻す)。
- [ ] t182/t184/t185 固定値テストが無改変でパス。
- [ ] NPS計測(要件4)の結果、ノード数完全一致かつNPS改善。レポート `bench/edax-compare/t187_incremental_eval_report.md` + raw JSON をコミット。
- [ ] `cargo test --release -p engine --test ffo_bench` 相当のFFO回帰が従来どおりパス(終盤は評価不使用だが念のため)。
- [ ] 変更を main に push し、GitHub Actions のデプロイ成功を確認し、GitHub Pages 公開URL(https://giwarb.github.io/othello-trainer/)で対局・棋譜解析が動作することを確認する(playwright CLI等、`gh run watch` でデプロイ完了を待つ)。
- [ ] コミットは変更対象ファイルのみをパス明示で add(`git add .` 禁止)。タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと。

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)
