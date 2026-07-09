//! フェーズ3(WTHOR棋譜データによるパターン評価学習)のための補助クレート。
//!
//! - `wthor`: WTHOR形式(`.wtb`)棋譜ファイルのパーサー(T040)。
//! - `patterns`: 盤面パターン特徴量の定義(行・列・対角線・隅3x3ブロック)と
//!   局面からの状態インデックス抽出(T041)。
//! - `train_data`: WTHOR棋譜から学習サンプル(局面・手番・最終結果)を生成する(T041)。
//! - `regression`: パターン特徴量に対するSGD回帰学習と重みファイルの入出力(T041)。
//!
//! エンジンへの重み統合(`engine/src/eval.rs`への反映)は後続タスクで行う。

pub mod patterns;
pub mod regression;
pub mod train_data;
pub mod wthor;
