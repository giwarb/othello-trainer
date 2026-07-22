---
id: T185
title: 高速化(4): ordered_moves残余最適化(T183優先2・3位)+深さベース時間の更新計測
status: todo
assignee: implementer
attempts: 0
---

# T185: オーダリング残余最適化

## 目的

T184(sort_by_cached_key、2.1-2.3倍)後の残余を削る。T183の改訂リスト優先2位・3位:
- **優先2**: `ordered_moves`のVecヒープ確保を排し固定長配列化(endgame.rsのMoveInfo型と同型の前例あり)
- **優先3**: `ordered_moves`が計算済みの`next_board`(apply_move結果)を`negascout`の候補手ループへ持ち越し、二重の`apply_move`を回避(T182で導入したhash持ち越しと同じ発想)

あわせて、高速化後の**深さベース対局の1手時間分布の更新値**を計測する(ユーザー関心事「深さ12で最大10秒はギリギリ」の現在地更新)。

## 要件

1. 優先2・3を実装(順に。各ステップで独立に効果測定できるなら記録、まとめてでも可)。**キーの値・探索の訪問順・結果は完全不変が絶対条件**(T182/T184方式: 20局面バッチ40探索でmove/score/depth/nodes完全一致+回帰テスト)。
2. **NPS実測は標準手順**(worktree独立ビルド+交互3回+専有確認)。期待は事前予測せず実測で判断(教訓: モデル予測は当てにしない)。明確な悪化なら該当ステップは差分破棄(それも正当な結果)。
3. FFO fast不変・`cargo test -p engine`全パス。
4. **深さベース時間の更新計測**: 最終状態のバイナリで、T175 P1条件(深さ12・MPC t=1.0・vs Edax lv12)の先頭5ペア10局を再実行し、1手時間分布(mean/p50/p90/max)をT175時点(mean 1.68s/p90 6.1s/max 14.1s)と比較。対局結果自体はT175と一致するはず(決定的)で、一致確認も兼ねる。
5. レポート: bench/edax-compare/t185_ordering_opts_report.md + meta。
6. 完了時 `git status --short` クリーン(パス明示コミット。`tasks/`とCLAUDE.mdはコミットしない)

## スコープ外

- 増分評価(T183優先4、大型のためT177諮問へ)・WASM・本番配線

## コミット規律

- 計測は専有・標準手順。ターン終了で通知待ち禁止。作業ログ節目追記

## 作業ログ

### 2026-07-22 実施・完了

- **実装(優先2・3をまとめて実施)**: `ordered_moves`を`Vec<u8>`返却から
  `out: &mut [OrderedMove; 64]`(呼び出し元バッファへ書き込み、返り値は件数)
  へ変更。`OrderedMove{mv, next_board}`は候補手の列挙時に`board.apply_move`
  を1回だけ呼んで`next_board`を保持し、`negascout`の候補手ループはその
  `next_board`をそのまま使う(以前は`ordered_moves`のソートキー計算と
  ループの両方で`apply_move`を呼んでいた二重計算を解消、T183優先3位)。
  `Vec`のヒープ確保も排した(T183優先2位、`endgame.rs`の`MoveInfo`/
  `[MoveInfo; 64]`と同型)。ソート自体は`sort_by_cached_key`のまま維持。
  tt_move昇格は`Vec::remove+insert(0,..)`の代わりに
  `moves[..=pos].rotate_right(1)`(スライスの末尾1要素を先頭へ回す)で
  完全に同じ結果を再現。

- **一度は`sort_unstable_by_key`(+タイブレークに`mv`追加)を試し、実測で
  明確な悪化(worktree独立ビルド+交互3回、専有確認済み)を確認したため
  破棄した**: MPC off -41.3%(1,114,121→653,977 NPS)、MPC on -45.4%
  (1,067,623→583,541 NPS)。原因分析: 標準ライブラリに
  `sort_unstable_by_cached_key`は存在せず、`sort_unstable_by_key`は
  `sort_by_key`と同様に比較のたびにキー関数を再計算する仕様のため、
  T184で解消したはずのO(n log n)回のキー再計算バグが復活し、しかも
  1要素が24バイト(`OrderedMove`)に大きくなった分スワップコストも
  増えて二重に悪化したと考えられる(ノード数自体は変更前後で完全一致
  しており、悪化は純粋に速度面のみ)。この時点のdiffを破棄し、
  `sort_by_cached_key`のまま固定長配列化する現在の実装に差し替えた。

- **絶対条件(探索結果完全一致)の実証**: `git worktree add`で変更前
  (T184時点HEAD)を独立ディレクトリにチェックアウトし、`eval_cli`を
  独立ビルド。T180/T182/T183/T184と同じ中盤20局面バッチ(depth12・
  exact_from_empties0、MPC off/on)を変更前/変更後の両バイナリで実行し、
  **20局面×MPC off/onの全40探索でmove/score/depth/nodes/isExact/timedOut
  が完全一致**(mismatch=0件、totalNodes: mpc_off=59,440,032・
  mpc_on=6,487,461)を確認(sort_unstable版・最終版〈sort_by_cached_key〉
  いずれでも一致を確認済み — つまりsort_unstable版を破棄したのは正しさ
  ではなく速度の問題だったことも合わせて実証)。
  新規回帰テスト`t185_ordered_moves_fixed_array_matches_pre_change_baseline`
  を追加(T184の同名テストと完全に同じ値、T185がソートの中身・
  タイブレークを一切変えていないことの直接証拠)。
  `cargo test -p engine --lib`: 247 passed; 0 failed; 2 ignored
  (既存246+新規1)。

- **NPS実測(標準手順: worktree独立ビルド+交互3回、専有確認済み、最終版)**:

  | 条件 | before(3回平均) | after(3回平均) | 倍率 |
  |---|---:|---:|---:|
  | MPC off | 1,109,028 NPS | 1,127,882 NPS | **+1.7%** |
  | MPC on | 1,063,127 NPS | 1,097,162 NPS | **+3.2%** |

  T183の見積り(優先2・3合わせて数%程度)とおおむね整合する、控えめだが
  実測で確認された正の改善。悪化ではないため採用。
  (参考・対Edax倍率: T184の更新値〈mpc off 26.7倍・mpc on 29.6倍〉に
  本タスクの倍率をさらに適用すると mpc off 約26.3倍・mpc on 約28.7倍。
  T185自体には対Edax倍率の再計算は要件外だが参考値として記録。)

- FFO fast(release): `cargo test -p engine --test ffo_bench --release -- --nocapture`:
  #40-#44全問正解、endgame.rsは無変更のため想定通り無影響。

- **深さベース時間の更新計測(T175 P1条件、先頭5ペア10局)**:
  `bench/edax-compare/vs_edax.py --opening-set primary --opening-limit 5
  --engine-modes single-root --levels 12 --engine-depth 12
  --engine-exact-from-empties 16 --engine-exact-quota-percent 60
  --engine-tt-mb 64 --engine-enable-mpc --engine-time-ms 15000
  --engine-max-nodes 100000000 --unlimited-exact-empties 20
  --weights train/weights/pattern_v6.bin --skip-loss-analysis --no-resume
  --allow-dirty`(T175 P1と同一プロトコル、最終状態=T182+T184+T185適用後
  のバイナリ、専有実行・`Get-Process`で競合無し確認)を実行。10/10局完走、
  fixed-depth決定性40/40・node-budget決定性10/10ともPASSED。
  - **対局結果の一致確認**: T175 P1の元データ(先頭10局、
    `bench/edax-compare/endgame-results/t175-p1-vs-edax-lv12-results-full.json`)
    と比較した結果、**9/10局は着手列・エンジンのノード数まで完全一致**。
    残り1局(primary-04・engine=black)はply39(Edaxの手番)でEdaxが
    異なる手を選択(元:a1、今回:h8)した時点から分岐した。それ以前の
    エンジン自身の着手・ノード数はすべて完全一致(ply38まで`g7`/nodes=12015
    /depth=14で一致)しており、分岐要因はエンジン側ではなくEdax自身の
    手番判断にある。これはT094で既知の事実(Edaxの既定マルチタスク探索
    〈`-n`未指定〉は並列負荷下で局面評価が実行間でわずかに揺れうる、
    `vs_edax.py`の`edax_solve`は`n_tasks=None`で呼んでおりこの既定
    マルチタスクのまま)と整合する挙動であり、エンジン(T185)の決定性には
    問題がないと判断した。
  - **1手あたり時間分布(mean/p50/p90/max、ms)**:

    | 対象 | n | mean | p50 | p90 | max |
    |---|---:|---:|---:|---:|---:|
    | T175 P1(元・同じ先頭10局のみ) | 248 | 1751.1 | 707.5 | 6430.2 | 10171.0 |
    | T185最終状態(今回、10局) | 248 | 1290.5 | 332.5 | 6095.8 | 8401.0 |
    | T175 P1(参考: 全60局のヘッドライン値) | 1491 | 1677.4 | 594.0 | 6108.0 | 14121 |

    同一10局条件でmean -26.3%・p50 -53.0%・p90 -5.2%・max -17.4%と、
    T182+T184+T185の累積効果で1手あたり時間が明確に短縮したことを確認。
    ユーザー関心事だった「深さ12で最大10秒はギリギリ」の現在地は、
    (10局サンプルの範囲では)最大8.4秒まで縮小している。

- レポート: `bench/edax-compare/t185_ordering_opts_report.md` +
  `t185_ordering_opts_report.meta.json`。
- worktreeは計測後`git worktree remove --force`で削除済み。
  `git status --short`: `engine/src/search.rs`のみ差分(パス明示コミット
  予定)。
