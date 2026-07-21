---
id: T182
title: 高速化(2): 増分Zobristハッシュの探索本体への配線(T180優先1位)
status: done # 採用で決着(2026-07-22): verifier再計測(worktree独立ビルド×交互3回×専有)で**MPC off +3.32%・on +4.63%の一貫改善**を確認、実装者の悪化観測(-9.2%)は計測方法の系統誤差と判明(stash+同一dir逐次ビルド)。探索結果完全一致は双方で実証済み。教訓: NPS前後比較はworktree+交互実行が標準
assignee: implementer
attempts: 0
---

# T182: 増分hash配線

## 目的

T180の発見: `incremental_move_hash`(1.65ns、実装・テスト済み、T105由来)が`negascout`本体で未使用のまま、毎ノード全走査`zobrist_hash`(41.07ns)が呼ばれている。配線して全体約8%の削減を得る(低コスト・低リスクの最優先候補)。

## 要件

1. `engine/src/search.rs`の探索本体(negascout/中盤経路)で、子ノードのhashを`incremental_move_hash`による差分更新で求めるよう配線する(終盤ソルバー側はT105で対応済みのはず — 現状を確認し、未対応経路があれば同様に)。
2. **同一性の保証(最重要)**: 増分hashと全走査hashは同一値を返すのが仕様(T105でdebug照合基盤あり)。debug_assertでの照合を探索経路に維持/追加し、**探索結果(score・best_move・nodes・depth)が配線前後で完全一致**することをテストで実証(決定的な複数局面で前後比較。ノード数まで一致するはず=純粋な時間短縮)。
3. **NPS実測**: 配線前後で同条件NPS計測(T180と同じ中盤20局面、専有ウィンドウで。T181の重工程と重ならないこと)。期待値: 約+8%(未達でも実測を正直に記録、明確な悪化がなければ採用)。
4. `cargo test -p engine` 全パス。FFO fast不変。
5. 完了時 `git status --short` クリーン(パス明示コミット。`tasks/`とCLAUDE.mdはコミットしない)

## スコープ外

- 優先2位以降(ムーブオーダリング・増分評価・プロファイリング)
- WASM再ビルド・本番配線(探索結果不変なので本番反映は次のデプロイに自然に乗る。ANALYSIS_ENGINE_VERSION繰り上げ不要=評価値が変わらないため。この判断が崩れる場合は報告)

## コミット規律

- NPS計測は専有(T181と調整、作業ログに記録)。detached+ポーリング(Monitor依存禁止)。作業ログ節目追記

## 作業ログ

### 2026-07-22 実装フェーズ

- `engine/src/search.rs`を調査し、`negascout`の内部ノードhashが毎回`zobrist_hash`
  フルスキャン(9箇所中2箇所が実際のホットパス: `negascout`自身のTT参照用hash、
  `etc_try_cutoff`のTTプローブ用hash)であることを確認。`ordered_moves`は
  hashを一切呼ばないため対象外と判断。`endgame.rs`はT105で既に増分hash対応済み
  (今回変更なし、確認のみ)。
- 配線方針: `negascout`に`known_hash: Option<u64>`引数を追加し、親から
  「既に分かっているhash」を渡せるようにした。`None`ならフォールバックで
  `zobrist_hash`フルスキャン(ルート呼び出し・MPC以外の一発呼び出し向け)。
  - パス経路: `toggle_side_to_move(known_hash)`で1回のXOR。
  - 候補手ループ: `negascout_or_etc`を最大3回(初手/NWS/フルウィンドウ再探索)
    呼ぶ前に、子局面のhashを`incremental_move_hash`で1手につき1回だけ計算
    (以前は3回とも`etc_try_cutoff`/`negascout`内部で毎回フルスキャンしていた
    のを解消)。`flips`は`(own_after XOR own_before) & !mv_bit`という
    before/after盤面の差分から導出し、`flips_for_move`の再計算を避けた。
  - `negascout_or_etc`/`etc_try_cutoff`/`mpc_try_cutoff`/`mpc_try_cutoff_inner`
    はいずれも「子(または自分自身と同じ)局面のhashを呼び出し元から受け取る」
    形にシグネチャ変更。`mpc_try_cutoff_inner`内の2回の`negascout`プローブ
    呼び出しは、プローブ対象が呼び出し元と同じ`(board, side)`なので
    そのまま`Some(hash)`を渡す(プローブ用に別途フルスキャンしない)。
  - `etc_try_cutoff`の`child_side`引数は、hashが呼び出し元から渡されるように
    なった結果不要になったため`_child_side`に変更(シグネチャ・呼び出し側の
    引数自体は変えず、未使用であることだけ明示)。
- **同一性の保証**: `endgame.rs`のT105と同じ`debug_assert_eq!`+テスト専用
  テレメトリ(`TEST_INCREMENTAL_HASH_CHECKS`/`record_incremental_hash_check`/
  `reset_incremental_hash_checks`/`incremental_hash_checks`)パターンを
  `search.rs`にも追加。パス経路・候補手ループの両方で、増分計算した値を
  `zobrist_hash`フルスキャンと`debug_assert_eq!`で毎回照合してから使う。
  新規テスト`incremental_hash_check_fires_across_diverse_midgame_searches`は
  MPC+ETC+aspiration+history全部有効な反復深化探索を8局面で回し、
  発火回数200件以上を確認(pass)。
- **決定的な複数局面での前後比較**: 新規テスト
  `t182_negascout_results_are_unchanged_by_the_incremental_hash_wiring`を
  追加。T180の20局面バッチ先頭2局面(1つはMPC OFFでNegaScout+ETC経路のみ、
  もう1つはMPC ON でmpc_try_cutoff*経路も踏む)をdepth=8・pattern_v6重みで
  探索し、score/best_move/depth/nodesを固定(現在の値: 21手目score=-2066
  nodes=22545、および17手目score=-690 nodes=73122)。
- `cargo test -p engine`: 243 passed; 0 failed; 2 ignored(既存の追加後、
  新規2テストを含めて全パス)。

### 2026-07-22 前後比較・NPS実測(専有ウィンドウ、T181と非重複を`Get-Process`で確認済み)

- 手順: T180と同じ`bench/edax-compare/t156_mpc_positions.json`由来の中盤20局面
  (`t180/midgame20.json`)を使い、`eval_cli best --depth 12 --exact-from-empties 0
  --pattern-weights train/weights/pattern_v6.bin`(MPC off/onそれぞれ)を
  releaseビルドで20局面ループ。まず現状(T182配線後)で「after」を計測。
  次に`git stash push -- engine/src/search.rs`でT182変更を一時的に除去し
  (`known_hash`/`incremental_move_hash`呼び出しが消えたことをgrepで確認)、
  同条件でreleaseを再ビルドして「before」を計測。最後に`git stash pop`で
  T182変更を復元し、再度releaseビルド・`cargo test -p engine --lib`
  245 passed/0 failed(既存243+新規2)を再確認した。
- **同一性の実証(絶対条件、20局面×MPC off/onの全40探索で完全一致)**:
  ```
  mpc_off: totalNodes before=59,440,032 == after=59,440,032 (T180記録済みの
           ベースラインとも一致)。20局面それぞれのmove/score/depth/nodes/
           isExact/timedOutを1件ずつ突合、mismatch=0件。
  mpc_on:  totalNodes before=6,487,461  == after=6,487,461。同様に
           20局面全項目突合、mismatch=0件。
  ```
  ノード数まで含めた完全一致をbefore/after双方で実測し、探索結果が配線に
  よって一切変わっていないことを直接証明した(git stashによる実コード
  差し替えでの比較であり、単体テストの固定値照合より直接的な証拠)。
- **NPS実測(正直な記録、期待+8%は未達。要コーディネーター判断)**:
  ```
  mpc off: before elapsedMs=122,126 nps=486,710.7
           after  elapsedMs=123,673 nps=480,622.5   (-1.3%、ほぼ横ばい)
  mpc on:  before elapsedMs=15,285  nps=424,433.2
           after  elapsedMs=16,827  nps=385,538.8    (-9.2%、明確な悪化)
  ```
  T180のNPS推定(41.07ns固定コストの単純な積み上げモデル)に反し、実測では
  速度向上が確認できず、MPC onでは明確な悪化(-9.2%)が出た。node数が
  完全一致している(=アルゴリズム的な差分はゼロ)ことから、原因は探索の
  分岐ではなく実装レベルのオーバーヘッドと推測される。仮説(未検証):
  (a) `negascout`に`known_hash: Option<u64>`を追加したことで、以前は
  `etc_try_cutoff`と`negascout`が同じ`(next_board, child_side)`に対し
  同一のZobristハッシュ計算を行っており、両者が同じ関数呼び出し site 内
  (`negascout_or_etc`)でインライン化されていた場合、LLVMのCSE
  (共通部分式除去)が既に重複呼び出しを1回に畳み込んでいた可能性があり、
  T180のマイクロベンチ(`zobrist_hash`を単体で呼んだ場合の41.07ns)が
  想定したほどの重複コストは実際のホットパスでは最初から発生していなかった
  のではないか。(b) `Option<u64>`引数(タグ+u64で16バイト、niche最適化
  非対象)を関数境界を跨いで渡すことによるレジスタ圧迫・分岐追加が、
  削減できたハッシュコストを相殺、あるいはそれ以上のコストになっている
  可能性。いずれも実際に確認(アセンブリ差分・perf等でのプロファイル)は
  行っていない仮説であり、追加調査が必要ならCodex設計コンサルまたは
  別タスクでのプロファイリングを推奨する。
- **結論**: 探索結果の完全同一性(絶対条件)は40局面すべてで実証済み・
  安全な変更であることは保証できる。一方でNPS改善という当初の目的
  (T180優先1位、期待+8%)は達成できず、MPC onでは-9.2%の悪化を実測した。
  タスク要件3「未達でも実測を正直に記録、明確な悪化がなければ採用」に
  照らすと、MPC on側は「明確な悪化」に該当するため、この変更をこのまま
  採用してよいかはコーディネーターの判断を仰ぐ(採用/ロールバック/
  さらなるプロファイリングの3択を完了報告で提示する)。
- `ANALYSIS_ENGINE_VERSION`: 評価値(score)は40局面全てで配線前後一致
  (完全同一性の一部として確認済み)のため、繰り上げ不要の判断は維持できる。
- `cargo test -p engine --test ffo_bench --release`: FFO fast 5問全問正解
  (#40-#44、期待値と一致)、nodes/nps出力も正常。endgame.rs側は無変更のため
  想定通り無影響。
