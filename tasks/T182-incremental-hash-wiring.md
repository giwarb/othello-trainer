---
id: T182
title: 高速化(2): 増分Zobristハッシュの探索本体への配線(T180優先1位)
status: todo
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

(以降、NPS計測・git stashベースのbefore/after証明・完了報告を追記予定)
