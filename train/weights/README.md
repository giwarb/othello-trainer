# `pattern_v1.bin` フォーマット仕様

T041で生成した、パターン評価(v1、22パターン)の学習済み重みファイル。
`train/src/bin/train_patterns.rs`が生成し、`train/src/regression.rs`の
`Model::to_bytes` / `Model::from_bytes`が入出力ロジックを持つ。

## 前提: パターン定義

パターンの形状(セルインデックス列)は`train/src/patterns.rs`の
`generate_patterns()`が機械的に生成する。生成順序(=このファイル内でのパターンID順)は:

1. 行パターン8個(パターンID 0〜7、各8セル)
2. 列パターン8個(パターンID 8〜15、各8セル)
3. 主対角線1個(パターンID 16、a1-h8方向、8セル)
4. 反対角線1個(パターンID 17、a8-h1方向、8セル)
5. 隅3x3ブロック4個(パターンID 18〜21、各9セル。a1側・h1側・a8側・h8側の順)

合計22パターン。本ファイルはパターンのセル座標そのものは保存せず、読み込み側が
`generate_patterns()`を再生成してセル数の整合性を検証する前提になっている
(セル座標自体が変わるバージョンアップ時は`version`を上げること)。

## 状態エンコーディング

各パターンの状態は、パターン内の各セルを「着目手番(mover)視点」で
0=空・1=自石・2=相手石の3値に写し、パターン内の並び順を3進数の桁として
エンコードした整数(8セルなら`0..3^8=6561`、9セルなら`0..3^9=19683`)。
詳細は`train/src/patterns.rs`の`pattern_state_index`を参照。

## ステージ分割

空きマス数`empty_count`から`stage = min(empty_count / 5, 12)`で0〜12の13ステージに
分割し、ステージごとに独立した重みテーブルを持つ(`train/src/regression.rs`の
`NUM_STAGES` / `stage_for_empty_count`)。

## バイナリレイアウト(すべてリトルエンディアン)

| フィールド | 型 | 内容 |
|---|---|---|
| magic | 4バイト | ASCII `"PWV1"` |
| version | u32 | 1 |
| num_patterns | u32 | 22 |
| num_stages | u32 | 13 |

続けて、`num_patterns`個分のパターンブロックを**上記の生成順序で**並べる。
各パターンブロックは:

| フィールド | 型 | 内容 |
|---|---|---|
| cell_count | u32 | このパターンのセル数(8または9) |
| weights | f32 × (`num_stages` × 3^cell_count) | ステージ0の状態0..N, ステージ1の状態0..N, ... の順 |

## 予測値の計算

局面(`board`, `mover`)に対する予測値(mover視点の最終石差の予測)は、
22パターンそれぞれについて `stage = stage_for_empty_count(board.empty_count())`、
`state = pattern_state_index(pattern.cells, board, mover)` を求め、
対応する重み`weights[pattern_id][stage][state]`の総和(バイアス項なし)。

## 学習方法の概要(再現・後続作業の参考用)

- 学習データ: WTHOR棋譜(`train/data/`、2015〜2024年、計19,119対局・約114万局面)を
  1対局ごとに初手適用後の各局面(mover視点)+その対局の最終結果(mover視点の
  最終石差)のペアに変換したもの。
- 手法: オンラインSGD(`train/src/regression.rs`の`Model::train`)。
  学習率0.005・L2正則化係数1e-5・20エポック(`TrainConfig::default()`)。
  対局単位で末尾10%をホールドアウトとして分離(データリーク防止のため
  同一対局のサンプルが学習・検証の両方に混ざらないようにしている)。
- 生成コマンド: `cargo run -p train --release --bin train_patterns`
  (引数省略時は`train/data/`配下の`*.wtb`を自動的にすべて対象にする)。

学習誤差・ホールドアウト誤差・ベースライン誤差の実測値は
`tasks/T041-pattern-feature-training.md`の作業ログを参照。
