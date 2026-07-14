//! フェーズ3(WTHOR棋譜データによるパターン評価学習)のための補助クレート。
//!
//! - `wthor`: WTHOR形式(`.wtb`)棋譜ファイルのパーサー(T040)。
//! - `train_data`: WTHOR棋譜から学習サンプル(局面・手番・最終結果)を生成する(T041)。
//! - `regression`: パターン特徴量に対するSGD回帰学習(T041)。
//!
//! パターン形状の定義(行・列・対角線・隅3x3ブロック)と局面からの状態インデックス
//! 抽出、および学習済み重みのバイナリフォーマット入出力は、T043で
//! `engine::patterns` / `engine::pattern_eval` に移動した(`engine`クレート側の
//! 探索(`engine/src/search.rs`)からも同じパターン定義・重み読み込みロジックが
//! 必要になったため、複製によるドリフトリスクを避けて一本化した)。本クレートは
//! それらを`use`する。
//!
//! エンジンへの重み統合(`engine/src/search.rs`)はT043で完了済み(WASM API
//! への配線は後続タスク)。

pub mod experiment;
pub mod regression;
pub mod t088_experiment;
pub mod train_data;
pub mod wthor;
