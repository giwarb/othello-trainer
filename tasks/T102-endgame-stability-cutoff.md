---
id: T102
title: 終盤ソルバー: 保守的な辺安定石カット
status: done # todo | in_progress | review | redo | done | blocked
assignee: codex(gpt-5.6-sol)
attempts: 0
---

# T102: 保守的な辺安定石カット

## 目的

終盤ソルバー強化シリーズ第5弾。安定石(絶対に反転しない石)の数から最終石差の安全な上下界を求め、探索せずにfail-low/fail-highを確定、または窓を狭める。第一段階は**隅から連続する辺安定石のみ**(既存 `eval::stable_count` と同等の保守的判定)を使う——安定でない石を安定と誤判定すると正解値が壊れるため、盤内安定石は導入しない(設計レポート§6「full stabilityを最初から導入する案」却下)。

## 規範文書

- `tasks/design/T097-endgame-solver-report.md` §3.5(上下界式・bound種別の整合)・§5 T102節・§7(リスク表: 安定石false positive・上下界式の手番反転・bound種別誤格納)。

## 要件(設計レポート§3.5・§5 T102節が規範)

1. **上下界**: 手番側安定石数 `S_self`・相手側 `S_opp` から、最終石差(手番視点)の安全範囲は 下限 `2*S_self - 64`、上限 `64 - 2*S_opp`。
   - `upper <= alpha` → fail-low(探索不要)
   - `lower >= beta` → fail-high(探索不要)
   - それ以外も `alpha = max(alpha, lower)`、`beta = min(beta, upper)` で窓を狭めてよい
2. **TT格納のbound種別整合**: 安定石カットで返す値はboundであり真値ではない。TTへ格納する際のbound種別(Lower/Upper)を、カットの向きと厳密に一致させること(§7リスク表)。窓を狭めた場合の `alpha_orig` 管理にも注意。
3. **判定は保守的に**: 使用する安定石判定が「安定と判定した石は本当に絶対に反転しない」ことをfalse positive検査で担保する(受け入れ基準参照)。判定の再帰的な拡張(盤内安定)はしない。
4. **適用閾値**: 判定コストとのバランスで適用条件(空き数等)を固定定数で決める。壁時計・NPS依存禁止。
5. **効果がなければ不採用**: ゲート未達なら「既定無効のコードを残す」のではなく、差分を破棄して不採用として報告する(設計レポート§5 T102受け入れ基準)。
6. 変更は `engine/src/endgame.rs`(+必要なら `eval.rs` の安定石mask関数の公開範囲のみ)。公開API・abort契約・論理ノード定義は不変。

## 計測プロトコル(軽量サイクル+ゲート改定2026-07-15)

- **主判定**: FFO #40-44合計ノードがカットon(既定)で**5%以上削減**(同一buildのon/off比較。T101と同様にcfg(test)/フラグでoff側を測ってよい)。
- **C2**: 512k系列で完走数非減・合計ノード非増。**cap 4M系列**のon/off比較を併記。
- 壁時計は参考記録。on側が2%以上悪化する場合は不採用。

## やらないこと(スコープ外)

- 盤内までの完全安定石判定(別タスク候補)
- NWS/PVS(T103)、専用ソルバー(T104)、増分hash(T105)
- exactポリシー変更(T107)、ハーネス変更

## 受け入れ基準(検証コマンド)

- [ ] `cargo test -p engine` 全件パス(protocolフレーキーは単独再実行で切り分け)
- [ ] **false positive検査**: 空き8以下の到達可能局面(ランダム多seed)で全継続を列挙し、「安定と判定された石が以後どの継続でも反転しない」ことを確認するテストがパス
- [ ] **カットon/offでnaive solver一致**: 狭窓(fail-low/fail-high両方向)とfull-windowの双方で、on/off/naiveの3者のscore(またはbound整合)が一致。**カット発火カウンタで発火0件のままpassしない**こと(T101 redo#1の教訓)
- [ ] `cargo test -p engine --release --test ffo_bench` — FFO #40-44 全問正解
- [ ] FFO合計ノードon/off比較表(5%以上削減で採用)とC2 512k/4M比較表が作業ログにある
- [ ] fresh TT同一局面2回実行の決定性(発火込み)
- [ ] 変更対象ファイルのみパス指定でコミット(オーケストレーター代行、変更ファイル一覧明記)
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと

## フィードバック(やり直し時にオーケストレーターが記入)

## 作業ログ(担当エージェントが追記)

### 2026-07-15 23:16 JST — Codex 実装・計測（主ゲート未達のため不採用）

- `engine/src/endgame.rs` に一時実装として、既存 `eval::stable_mask` と同じ「隅から連続する辺石」だけを用いた上下界 `lower = 2*S_self - 64` / `upper = 64 - 2*S_opp`、fail-low の `Upper` 格納、fail-high の `Lower` 格納、窓狭窄を追加した。公開API・abort伝播・論理ノード定義は変更しなかった。
- 一時テストでは、32 seed の空き8以下到達可能局面から全継続を列挙し、判定された黒白の安定石が以後一度も反転しないことを確認した。16 seed で full-window と fail-low/fail-high 狭窓の stability on/off/naive 整合、カット発火数が0でないこと、fresh TT 2回の `(score, nodes, cutoff count, bound)` 決定性も確認した。
- 適用閾値は固定値20と24を比較した。FFO #40–44では両閾値のノード列が完全に同一だったため、より広い24を最終候補として同一build系列のon/offを計測した。

#### FFO #40–44 stability on/off（TT 256MiB、full window、各1回）

| FFO | score on/off | nodes off | nodes on | 削減率 | wall off | wall on |
|---:|---:|---:|---:|---:|---:|---:|
| 40 | 38 / 38 | 44,106,279 | 37,010,189 | 16.09% | 12.410s | 11.160s |
| 41 | 0 / 0 | 184,072,750 | 179,622,428 | 2.42% | 53.696s | 54.465s |
| 42 | 6 / 6 | 248,730,603 | 233,180,869 | 6.25% | 68.954s | 70.109s |
| 43 | -12 / -12 | 264,260,190 | 259,621,802 | 1.76% | 80.890s | 83.212s |
| 44 | -14 / -14 | 258,951,798 | 258,095,468 | 0.33% | 78.111s | 79.835s |
| 合計 | 全問一致 | 1,000,121,620 | 967,530,756 | **3.26%** | 294.060s | 298.781s |

- 主ゲートの5%削減に対して3.26%で未達。壁時計もonがoffより1.61%遅かった。主判定で不採用が確定したため、C2 512k/4Mは実施していない（C2は主ゲート未達を救済しない補助条件）。要件5に従い、既定無効コードを残さず `engine/src/endgame.rs` / `engine/src/eval.rs` と一時テストの差分をすべて破棄した。

#### 実行コマンドと結果

- `cargo test -p engine endgame::tests::edge_stable_mask_has_no_false_positives_across_all_small_continuations -- --nocapture` — PASS（32 seed、空き8以下、全継続列挙。テストは不採用差分とともに破棄）
- `cargo test -p engine endgame::tests::stability_on_off_and_naive_agree_for_full_and_narrow_windows -- --nocapture` — PASS（full/fail-low/fail-high、発火必須。テストは不採用差分とともに破棄）
- `cargo test -p engine endgame::tests::fresh_tt_runs_are_deterministic_with_stability_cutoff -- --nocapture` — PASS（発火込み。テストは不採用差分とともに破棄）
- `cargo test -p engine` — PASS（一時実装時: 184 passed, 0 failed, 2 ignored）
- `cargo test -p engine`（差分破棄後）— PASS（181 passed, 0 failed, 2 ignored）
- `cargo test -p engine --release --test ffo_bench -- --nocapture` — PASS（on/offとも #40–44 全問正解、上表）
- `git diff --check` — PASS。最終 `git status --short` は必須作業ログ `tasks/T102-endgame-stability-cutoff.md` のみで、T102由来のソース差分・未追跡ファイルなし
- コミット: なし（不採用のためコミット対象ソースなし。`.git`書き込み不可）
