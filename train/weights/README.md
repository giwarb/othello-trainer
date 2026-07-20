# `pattern_v1.bin` / `pattern_v2.bin` / `pattern_v3.bin` / `pattern_v4.bin` フォーマット仕様

T041で生成した、パターン評価(v1、22パターン、インスタンスごとに独立した
重み=重み共有なし)の学習済み重みファイルが`pattern_v1.bin`。T044で
対称変換による重み共有を導入したものが`pattern_v2.bin`(現行の学習出力、
`train/src/bin/train_patterns.rs`が生成するのはこちら)。`pattern_v1.bin`は
比較用にそのまま残しており、削除・上書きはしていない。

T122で本番採用したv3×WTHOR重みが`pattern_v3.bin`(PWV3形式)。T147で
本番採用したv4×WTHOR重み(ステージ1石刻み61段、T124で導入・T125のseed3、
regret 0.9667)が`pattern_v4.bin`(同じくPWV3形式、`num_stages=61`)。比較・
即時の切り戻し用として`pattern_v2.bin`・`pattern_v3.bin`も引き続き残している。

バイナリの入出力ロジック自体はT043で`engine::pattern_eval::PatternWeights::to_bytes`
/ `from_bytes`に一本化した(`train::regression::Model::to_bytes`/`from_bytes`は
これへの薄い委譲)。`from_bytes`はマジックバイトで`"PWV1"`(v1)/`"PWV2"`(v2)/
`"PWV3"`を読み込める(後方互換)。エンジン本体(`engine/src/search.rs`)からも
どちらの重みファイルでも読み込んで中盤探索の静的評価に使える
(`search::search_with_eval`/`search_all_moves_with_eval`、T043。
`eval_cli`の`--pattern-weights PATH`はv1/v2どちらのファイルパスでも動作する)。

## T044: 対称変換による重み共有(v2)とパターンのクラス分類

T043の自己対戦検証で、v1(22インスタンス独立の重みテーブル)は静的評価が
Edaxに近づいた一方、自己対戦では旧3項ヒューリスティック評価に負け越す
(9勝-15敗)という結果が出た。学習データに現れなかった局面パターンで重みが
ゼロのまま残る(汎化性能不足)ことが原因と分析し、T044でオセロ盤の対称性
(二面体群D4、8要素: 恒等・90/180/270度回転・上下反転・左右反転・転置・
反転転置)を使った重み共有を導入した。

22パターンインスタンスは、対称変換で互いに移り合うもの同士でグループ化すると
以下の6クラスになる(`engine::patterns::compute_pattern_classes`が、手作業の
決め打ちではなく8対称変換の総当たりから機械的に導出する):

| クラス | 属するインスタンス(`generate_patterns()`のインデックス) | 内容 |
|---|---|---|
| A | 0, 7, 8, 15 | 行0・行7・列0・列7(盤端からの距離0) |
| B | 1, 6, 9, 14 | 行1・行6・列1・列6(距離1) |
| C | 2, 5, 10, 13 | 行2・行5・列2・列5(距離2) |
| D | 3, 4, 11, 12 | 行3・行4・列3・列4(距離3、中央寄り) |
| E | 16, 17 | 主対角線・反対角線 |
| F | 18, 19, 20, 21 | 隅3x3ブロック4個 |

各クラスは代表インスタンス(グループ内で最小のインデックス)を1つ持ち、
重みテーブルは代表インスタンスのセル順序で符号化される。他のインスタンスは、
代表インスタンスの自然順セル列にそのインスタンス用の対称変換を適用した
セル列(`PatternClassInfo::aligned_cells`)で状態インデックスを計算することで、
同じ重みテーブルを正しく参照する(この対称変換・並べ替えの正しさは、
「インスタンス固有抽出+パーミュテーション」と「盤面全体変換+代表インスタンス
抽出」という2通りの独立した計算方法が一致することをクロスチェックする
ユニットテストで検証している。`engine/src/patterns.rs`の
`cross_check_instance_extraction_matches_whole_board_transform_method`参照)。

## 前提: パターン定義

パターンの形状(セルインデックス列)は`engine/src/patterns.rs`(T043で
`train/src/patterns.rs`から移動)の`generate_patterns()`が機械的に生成する。
生成順序(=このファイル内でのパターンID順)は:

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
詳細は`engine/src/patterns.rs`の`pattern_state_index`を参照。

## ステージ分割

空きマス数`empty_count`から`stage = min(empty_count / 5, 12)`で0〜12の13ステージに
分割し、ステージごとに独立した重みテーブルを持つ(`engine/src/pattern_eval.rs`の
`NUM_STAGES` / `stage_for_empty_count`)。

## バイナリレイアウト(すべてリトルエンディアン)

### v1(`pattern_v1.bin`、重み共有なし)

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

### v2(`pattern_v2.bin`、T044、対称重み共有)

| フィールド | 型 | 内容 |
|---|---|---|
| magic | 4バイト | ASCII `"PWV2"` |
| version | u32 | 2 |
| num_patterns | u32 | 22(整合性検証用。実際のパターン形状は保存しない) |
| num_classes | u32 | 6(上記のクラスA〜F) |
| num_stages | u32 | 13 |

続けて、`num_classes`個分のクラスブロックを**`representative_of_class`の順序
(クラスA〜Fの順、各クラスの代表インスタンスは`generate_patterns()`内での
最小インデックス)で**並べる。各クラスブロックは:

| フィールド | 型 | 内容 |
|---|---|---|
| cell_count | u32 | このクラスの代表インスタンスのセル数(8または9) |
| weights | f32 × (`num_stages` × 3^cell_count) | ステージ0の状態0..N, ステージ1の状態0..N, ... の順(v1と同じ並び) |

読み込み側は`engine::patterns::compute_pattern_classes`でクラス分類を
再計算し、`num_classes`・各クラスの`cell_count`が一致することを検証する
(v1同様、クラス分類自体はファイルに保存せず読み込み時に再導出する)。

### v3(PWV3、T087、自己記述形式)

PWV3は複数のablation構成を安全に識別するため、instanceのセル列とclass IDを
保存する。ヘッダは`magic[4]`, `version:u32=3`, `flags:u32`,
`num_stages:u32=13`, `stage_empty_divisor:u32=5`, `num_instances:u32`,
`num_classes:u32`, `schema_hash[32]`の順。続いてinstanceごとに
`cell_count:u8`, `class_id:u16`, `aligned_cells:[u8; cell_count]`、classごとに
`cell_count:u8`, `num_states:u32`, `weights:[f32; 13 * num_states]`を置く。

`schema_hash`はステージ数・ステージ除数と、全instanceのclass ID・cell count・
aligned cell列を直列化した値のSHA-256。loaderはセル範囲、instance内重複、
`num_states == 3^cell_count`、class ID範囲、同一classのセル数、D4分類、finite重み、
余剰bytes、schema hashを検証する。既存trainerは引き続きPWV2を書き、
`train_patterns_v3`だけがPWV3を書く。

T124のv4もPWV3を使用する。パターン形状はv3と同一で、ヘッダの
`num_stages=61`、`stage_empty_divisor=1`だけが異なる。loaderは従来の
13段/5石刻み(v2/v3)と61段/1石刻み(v4)を識別し、重み自身のステージ定義で
評価する。従来のPWV1/PWV2と13段PWV3の動作は変更しない。

### v4(PWV4、T158a、scalar feature付き自己記述形式)

PWV4は61段/1石刻みのPWV3 pattern本体にscalar featureを追加する実験形式。
ヘッダは`magic[4]="PWV4"`, `version:u32=4`, `flags:u32=0`,
`num_stages:u32=61`, `stage_empty_divisor:u32=1`, `num_instances:u32`,
`num_classes:u32`, `num_scalar_features:u32`, `schema_hash[32]`の順で、instance/class
ブロックはPWV3と同じ。その後、featureごとに`kind:u8`, `scale_shift:u8`,
`reserved:u16=0`, `weights:[f32; num_stages]`を置く。

既知kindは`1=ExactMobilityAdvantage`(`scale_shift=3`, 合法手数差/8)と
`2=EmptyAdjacencyExposureAdvantage`(`scale_shift=5`, 相手接触辺数−自分接触辺数/32)。
schema hashにはPWV3のschema情報に加え、feature数と各featureのkind・scale shift・順序を
含める。loaderは未知/重複kind、kindと異なるscale shift、非0 reserved、finiteでない係数、
ステージ定義不一致、schema hash不一致、余剰bytesを拒否する。scalar項はpattern和の後に
kind 1、kind 2の固定順で加算する。現行本番`pattern_v4.bin`は引き続きPWV3のため、
既定評価にはscalar計算も加算も入らない。

## 予測値の計算

局面(`board`, `mover`)に対する予測値(mover視点の最終石差の予測)は、
22パターンインスタンスそれぞれについて `stage = stage_for_empty_count(board.empty_count())`、
`state = pattern_state_index(aligned_cells[instance], board, mover)`
(v1では`aligned_cells[instance]`はそのインスタンス自身の自然順セル列と同じ。
v2では代表インスタンスのセル順序に揃えた実セル列)を求め、対応する重み
(v1は`weights[instance_id][stage][state]`、v2は
`weights[class_of[instance]][stage][state]`)の総和(バイアス項なし)。

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
  T044(v2)時点でも学習データ・ハイパーパラメータはv1と同一のまま
  (対称重み共有によるデータ効率の改善効果だけを見るため)。

学習誤差・ホールドアウト誤差・ベースライン誤差の実測値は
`tasks/T041-pattern-feature-training.md`(v1)・`tasks/T044-pattern-symmetry-weight-sharing.md`
(v2、ホールドアウトMSE/MAE・Edax比較・自己対戦結果)の作業ログを参照。
