---
id: T184
title: 高速化(3): ordered_movesのsort_by_key→sort_by_cached_key修正(T183優先1位)
status: done # verifier合格(差分精読・独立ビルドでの完全一致再現・NPS検算+スポット再現2.07-2.34倍・全テスト)、2026-07-22。**実測2.125倍(off)/2.313倍(on)、対Edax倍率57-69→27-30倍に半減**
assignee: implementer
attempts: 0
---

# T184: sort_by_cached_key修正

## 目的

T183の発見: `engine/src/search.rs` の `ordered_moves` 内3箇所の `Vec::sort_by_key` が、高コストなキー計算(`apply_move`+`legal_moves`)を比較のたびに再計算しており(要素あたり65.5〜78.5回)、探索時間の70〜75%を占めている。`sort_by_cached_key`(要素ごと1回)への置換で **MPC off最大-56%(約2.3倍)・on最大-32.6%(約1.5倍)** の実測上限。リスク低(両者とも安定ソートのため順序・探索結果は不変のはず)。

## 要件

1. `ordered_moves`の3箇所を`sort_by_cached_key`へ置換(または同等の「キーを1回だけ計算して並べ替える」実装。実装が単純で速い方。キー型・タイブレークは完全に現状維持)。
2. **絶対条件: 探索結果(score・best_move・depth・nodes)が修正前後で完全一致**(安定ソート同士なので理論上一致するはず。T182と同じ前後比較テスト+T180の20局面バッチでの全探索一致確認)。
3. **NPS実測は標準手順で**(恒常教訓): worktree独立ビルド(修正前)+現HEAD(修正後)、交互3回、MPC off/on、専有確認。平均±レンジで報告。
4. FFO fast不変(endgame.rsは無関係のはずだが回帰確認)。`cargo test -p engine`全パス。
5. 期待効果が大きいため、達成したNPSで**対Edax倍率の更新値**(T180の57-69倍からどこまで縮んだか)も算出して記載。
6. ANALYSIS_ENGINE_VERSION繰り上げ不要の見込み(評価値・探索結果不変)。崩れたら報告。
7. 完了時 `git status --short` クリーン(パス明示コミット。`tasks/`とCLAUDE.mdはコミットしない)

## スコープ外

- T183優先2位以降(固定長配列化・next_board持ち越し・増分評価)— 本修正の実測を見てから
- WASM再ビルド・本番配線(次のデプロイに自然に乗る)

## コミット規律

- 計測は専有・標準手順。ターンを終えて通知待ち禁止(ツール内ループ)。作業ログ節目追記

## 作業ログ

### 2026-07-22 実施・完了

- 修正: `engine/src/search.rs`の`ordered_moves`内3箇所(history=None/Some+HISTORY_BEFORE_MOBILITY/Some既定)の`moves.sort_by_key(...)`を`moves.sort_by_cached_key(...)`へ置換。キーの型・タイブレーク条件・クロージャの中身は一切変更していない(関数名の置換のみ)。

- **絶対条件(探索結果完全一致)の実証**:
  1. `git worktree add`で変更前(HEAD、`sort_by_key`のまま)を独立ディレクトリにチェックアウトし、そこで`eval_cli`をreleaseビルド(現HEADの`target/`とは完全に分離)。
  2. T180/T182/T183と同じ中盤20局面バッチ(depth12・exact_from_empties0、MPC off/on)を、変更前バイナリ(worktree)と変更後バイナリ(現ワークツリー)の両方で実行。
  3. **結果: 20局面×MPC off/onの全40探索で、move/score/depth/nodes/isExact/timedOutが完全一致(mismatch=0件)**。totalNodesもmpc_off=59,440,032・mpc_on=6,487,461で前後一致(T180/T182で確立済みの値とも一致)。
  4. `cargo test -p engine --lib`に新規回帰テスト`t184_sort_by_cached_key_matches_pre_change_baseline`を追加(T180バッチのindex0〈MPC off〉・index2〈MPC on〉をdepth12で探索し、上記(3)で確認した実測値をハードコード)。246 passed; 0 failed; 2 ignored(既存245+新規1)。

- **NPS実測(標準手順: worktree独立ビルド+交互3回、専有確認済み)**:
  `Get-Process`で競合プロセス無しを確認後、変更前(worktree)/変更後(現HEAD)の2バイナリを「mpc_off before→after、mpc_on before→after」の順で3ラウンド交互実行。

  | 条件 | before(3回平均, range) | after(3回平均, range) | 倍率 |
  |---|---:|---:|---:|
  | MPC off | 591,002 NPS [587,631〜593,078] | 1,256,106 NPS [1,246,436〜1,262,613] | **2.125倍(+112.5%)** |
  | MPC on | 521,976 NPS [518,044〜527,264] | 1,207,395 NPS [1,196,507〜1,214,425] | **2.313倍(+131.3%)** |

  3ラウンドとも安定した値(rangeが平均の1%程度に収まる)で、系統誤差の兆候なし。T182で発生した「git stash+同一dir逐次ビルド」の系統誤差問題は、今回のworktree独立ビルド手順では再現しなかった。

- **対Edax倍率の更新値**: T180のEdax NPS実測値(29,426,082、同一20局面バッチ・depth12)は不変のため、T180が報告したうちのエンジンNPS(mpc off 518,217・mpc on 429,832)に今回測定した倍率(2.125倍・2.313倍)を適用して更新値を算出(絶対NPSの直接比較はセッション間変動の影響を受けるため、T182の教訓により相対倍率を適用する方式を採用):
  - MPC off: 518,217 → **約1,101,410 NPS**、対Edax比 **56.8倍 → 約26.7倍**
  - MPC on: 429,832 → **約994,253 NPS**、対Edax比 **68.5倍 → 約29.6倍**

  (参考: 今回の測定セッションでの生の「after」絶対値〈mpc off 1,256,106 / mpc on 1,207,395〉をそのままT180のEdax値と比較すると23.4倍/24.4倍とさらに縮んだ値になるが、セッション間のハードウェア状態変動を含みうるため、上記の相対倍率適用による更新値を正式な報告値とする。)

- FFO fast(release): `cargo test -p engine --test ffo_bench --release -- --nocapture`: #40-#44全問正解(期待値と一致)、endgame.rsは無変更のため想定通り無影響。
- `ANALYSIS_ENGINE_VERSION`: 探索結果(score含む)が40局面全て前後一致のため繰り上げ不要の判断を維持。
- git worktreeは計測後`git worktree remove --force`で削除済み。`git status --short`: `engine/src/search.rs`のみ差分(パス明示コミット予定)。
