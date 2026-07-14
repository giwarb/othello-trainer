# T085〜T090: Edax level 10 到達に向けた詳細実装設計

## 0. 結論

現状の平均石差 `-35.8` は、T085/T086だけで逆転できる規模ではない。T085は探索予算の浪費と終盤境界の不安定さを直し、T086はTTの明確な品質欠陥を修正するが、両者だけでの見込みは対 level 10 勝率 `0〜10%`、平均石差改善 `2〜7石`程度である。

50%到達には、少なくとも以下が必要になる。

1. T084のクリーンな120局ベンチ完了
2. T085: 完成済み反復深化結果を常に保持するexact予算制御
3. T086: TTの同一局面保護・品質選択
4. T088の学習基盤改善
5. T087の`edge+2X`を中心とするPattern v3
6. T089の実効深さ向上
7. T090のEdax教師値・着手順位蒸留

特に重要なのは、「評価表現を増やすT087」と「教師ラベル・学習法を改善するT088/T090」を混ぜず、v2特徴のまま学習法を先にablationすることである。現行ラベルは「その後の人間の手順による最終石差」であり、局面の最適値ではない。このラベル問題を残したまま特徴だけ増やすと、約3MB増やしても棋力がほとんど伸びない可能性がある。

推奨順序は次である。

```text
T084完了
  ↓
T085a exact/ノード予算制御
  ↓
T085b 予算校正・局面ゲート
  ├──────────────┐
  ↓              ↓
T086 TT品質       T088a 学習実験基盤(v2のまま)
  ↓              ↓
T089a         T087a PWV3・Pattern v3表現
  ↓              ↓
T089b         T087b/T088b ablation
  └──────┬───────┘
         ↓
      T090a/b 蒸留
         ↓
      T085c アプリ配線
         ↓
      T090c 最終60〜200局判定
```

T085cのアプリ配線は、ノード予算値とexactポリシーが確定してから別タスクにする。T085aと同時に`app/`まで変更すると、探索仕様・Workerプロトコル・UIプリセットの三つが一度に動き、回帰原因を分離しにくい。

---

# (a) 推奨設計

## 1. T085a: exact切替とノード予算管理

### 1.1 現状の問題

現行の`search_with_eval_inner`は、ルート空き数が`exact_from_empties`以下なら、反復深化を一度も完了させる前に完全読みを開始する。完全読みは全体の時間・ノード予算を消費し、失敗した後で反復深化へ戻る。

T084で合法手フォールバックは追加されたが、現在も次の問題が残る。

- exact失敗時に完成済みの深い中盤探索結果が存在しない
- exact試行が総予算を使い切り、通常探索へ戻る余地がない
- 探索木内部のexact失敗がイテレーション全体を破棄しやすい
- exactと中盤探索が同じTT型・同じhashで、`depth`と`score`の意味が異なる
- `exactAttempted`はルート条件しか表さず、木内部の試行・消費量が見えない
- 壁時計とノード予算のどちらが打切り原因か、完全には分離されていない

動的exact切替を安全に導入する前に、TT上で中盤結果とexact結果を区別しなければならない。現在の中盤TTスコアはcenti-disc、endgame TTは生の石差であり、同一hashに両者を混在させることは危険である。

### 1.2 TTドメイン分離をT085に含める

`tt.rs`の置換規則改善本体はT086に残すが、型安全性のためのドメイン分離だけはT085aに含める。

```rust
pub enum TTDomain {
    Midgame,
    Exact,
}

pub struct TTEntry {
    pub hash: u64,
    pub domain: TTDomain,
    pub depth: i8,
    pub score: i32,
    pub bound: Bound,
    pub best_move: Option<u8>,
}
```

APIは以下へ変更する。

```rust
tt.probe(hash, TTDomain::Midgame)
tt.probe(hash, TTDomain::Exact)
```

バケットのindexは従来どおり元のZobrist hashから計算する。hashにsaltをxorする方法は、FFOで衝突配置とノード数を不必要に変えるため採用しない。probe時に`hash`と`domain`の両方を一致確認する。

`last_exact_from_empties`によるクリアは当面残す。ドメインを分けても、中盤TTの値は「どの空き数でexactへ接続したか」に依存するからである。

必須テストは次である。

- 同一盤面・同一hashについてMidgame/Exactを同時格納できる
- Exact側の生石差がMidgame探索から参照されない
- Midgame側のcenti-disc値がendgame solverから参照されない
- `solve_exact_with_nodes`の正解値が不変
- 可能ならFFO #40〜44のノード数も分離前と一致

### 1.3 予算付き探索の実行順序

ノード予算付き対局経路では以下の順序にする。

1. 合法手確認
2. 決定的なdepth 1探索をexact無効で完走
3. 完成した結果を`last_completed`へ保存
4. 残予算と空き数からexact試行可否を決める
5. exact試行には総ノード予算の一部だけを割り当てる
6. exact完走ならexact結果を返す
7. exactの局所予算切れなら、中盤反復深化を継続
8. 全体ノード予算または壁時計保険に達したら`last_completed`を返す
9. 校正済み通常予算ではdepth 0を一件も発生させない

無制限探索、FFO、詰めオセロなど「正解値が必要な経路」は従来どおり即時完全読みを使う。新しい予算分割は`max_nodes.is_some()`の対局・近似解析経路に限定する。

これにより、T085が詰め問題やFFOの意味論を変えることを防げる。

### 1.4 exact予算

初期値として、depth 1完走後の残ノードの60%をexact用、40%を中盤探索継続用に予約する。

```text
baseline reserve: depth 1を完走するまで
exact quota:      残予算の60%
midgame reserve:  残予算の40%
```

ただし60%を無条件に固定採用せず、空き19〜24の固定局面コーパスで`25% / 40% / 60% / 75%`を比較し、次の目的関数で選ぶ。

```text
優先順位:
1. depth0/static-only率
2. Edax oracle regret
3. exact完走率
4. 完成中盤深さ
5. 消費ノード
```

exact quotaを使い切ったことと、全体max-nodesを使い切ったことを別の打切り理由にする。

```rust
enum AbortReason {
    ExactQuota,
    GlobalNodeLimit,
    WallClock,
}
```

- `ExactQuota`: そのexact試行だけを中止し、中盤探索へ戻る
- `GlobalNodeLimit`: 現在のイテレーションを破棄し`last_completed`を返す
- `WallClock`: 同上。保険発動として記録する

現在の`solve_exact_limited_with_nodes`の`bool`ではこの区別が不足するため、戻り値を構造体化する。

### 1.5 動的exact閾値

空き数だけによる切替は廃止せず、「上限条件」として残す。

```text
empties <= exact_from_empties
かつ
exact_remaining_nodes >= estimated_min_nodes[empties]
```

`estimated_min_nodes`は推測で決めず、T084/T085固定局面コーパスで測った空き数別exactノード数のp75から生成する。ランタイムNPSは切替条件に使わない。NPSを使うと端末速度・JIT・負荷で着手が変わり、ノード予算の決定性を失う。

空き数ごとの初期方針は次でよい。

- 空き0〜14: 原則exact試行
- 空き15〜18: 残ノードと推定コストで判断
- 空き19〜24: データ収集対象。初期既定では無理にexactへ上げない
- 25以上: exact試行しない

空き19〜24への拡大は、「exact_from_emptiesを24に上げる」変更ではなく、測定した推定コストを満たす局面だけに限定する。

### 1.6 木内部のexact失敗

TTドメイン分離後は、木内部でexact quotaを使い切った場合に、中盤探索へ安全にフォールバックできる。

現在のように`ctx.timed_out = true`としてイテレーション全体を破棄せず、以下の扱いにする。

- 壁時計または全体ノード予算切れ: イテレーションを破棄
- exact専用quota切れ: exactを断念し、同じノードを通常のNegaScoutとして続行
- exact試行中に完成したExact-domain TTエントリは再利用可
- 不完全な現在ノードは格納しない
- フォールバック後に格納する中盤値はMidgame-domainへ格納

これがT085の中心的な改善になる。

### 1.7 親αβ窓のexactへの引継ぎ

ルートexactは真の最終石差と最善手を必要とするので、従来どおり`[-64, 64]`のfull-windowで呼ぶ。

探索木内部では、親のcenti-disc窓を安全側へ丸めて石差窓へ変換する。

```text
alpha_disc = floor(alpha_centi / 100)
beta_disc  = ceil(beta_centi / 100)
```

Rustの負数除算はゼロ方向丸めなので、専用の`floor_div_100`と`ceil_div_100`を実装する。単純な`alpha / 100`は使わない。

変換後は`[-64, 64]`へclampする。最大1石弱窓が広がるが、誤った枝刈りより安全である。

新API例:

```rust
solve_exact_window_limited_with_nodes(
    board,
    side,
    alpha_disc,
    beta_disc,
    tt,
    time_budget,
    node_limit,
)
```

window付きexactが完走しても、その返値はfail-soft boundの場合がある。ルート結果の`is_exact=true`はfull-window完走時だけにする。木内部ではBoundとして親探索に利用する。

### 1.8 ノード予算と壁時計の併用

対局経路の主制限は`max_nodes`、`time_ms`は保険とする。

```text
停止条件 = max_nodes到達 OR wall insurance到達
通常期待 = max_nodesが先に発動
異常時   = wall insuranceが先に発動
```

壁時計保険は当初1500msを推奨する。現行の目安1秒に対し、1024ノード間隔の時刻確認、WASM JIT、ブラウザ負荷を吸収するためである。1秒厳守が必要なら後で1200msへ下げる。

ノード予算はnative CLIのNPSから決めてはいけない。Chromium上のrelease WASMで固定局面を測定する。

校正手順:

1. opening 30局面から序盤・中盤・空き19〜24を各50局面抽出
2. Chromium/WASMで5回warm-up
3. 1000ms探索を各局面3回
4. 1000msまでに探索したノード数のp25、median、p75を保存
5. 初期`max_nodes`をp25付近に設定
6. wall保険発動率が5%以下になるよう調整
7. 設定値・ブラウザ・CPU・WASM hashをmanifestへ保存

現在の途中結果ではsingle-rootの平均ノード数が約24万ノード/手なので、初期候補は20万〜25万ノードだが、これは確定値ではない。

### 1.9 T085テレメトリ

`SearchResult`と`eval_cli best`に以下を追加する。

- `requestedMaxNodes`
- `consumedNodes`
- `baselineDepth`
- `baselineNodes`
- `lastCompletedDepth`
- `staticOnly`
- `exactRootAttempts`
- `exactLeafAttempts`
- `exactCompleted`
- `exactAbortedByQuota`
- `exactNodes`
- `midgameNodes`
- `nodeLimitHit`
- `wallLimitHit`
- `fallbackReason`
- `exactPolicyVersion`

既存の`exact.attempted`はルート空き数だけで事前判定されており、実態とのずれがある。新フィールドは実際の探索イベントから数える。

### 1.10 T085a完了ゲート

機能ゲート:

- 合法手ありで`best_move=None`が0件
- 校正済み通常予算で`depth=0/staticOnly=true`が0件
- 同一局面・同一max-nodesでmove/score/depth/nodes/打切り理由が2回完全一致
- exact quota切れ後も完成済み中盤結果を返す
- Midgame/Exact TTドメイン混同テストが通る
- 無制限exactの正解値不変
- fixed-depth・時間なし探索のbest move/score不変

性能ゲート:

- 空き19〜24固定コーパスで`loss >= 4石`率を現行比20%以上削減、または平均oracle regretを15%以上削減
- 序盤・中盤固定コーパスの平均regret悪化が0.25石以内
- wall保険発動率5%以下
- 総ノード数が`max_nodes + 1024`以内
- exact quota超過がチェック間隔分を除いてない

必須コマンド:

```text
cargo test -p engine
cargo test -p engine --release --test ffo_bench
cargo build --release -p engine --bin eval_cli
```

加えてT085で実装する固定コーパス検証CLIを次で実行可能にする。

```text
cargo run -p engine --release --bin eval_cli -- budget-regression \
  --manifest bench/edax-compare/t085_exact_positions.json \
  --max-nodes 240000 \
  --time-ms 1500 \
  --exact-from-empties 18 \
  --pattern-weights train/weights/pattern_v2.bin
```

期待結果はJSON末尾に以下を出す。

```json
{
  "deterministic": true,
  "nullMoveWithLegal": 0,
  "staticOnly": 0,
  "budgetOvershootMax": 1024
}
```

`240000`は仮値であり、T085bで校正値へ置換する。

---

## 2. T085b: 予算校正と採用判定

変更対象:

- `bench/edax-compare/vs_edax.py`
- 固定局面manifest
- 必要ならWASM校正用の小さなブラウザベンチ

T084のwall系列と、新node-budget系列を別run keyにする。

比較系列:

1. 現行: depth10 / exact18 / wall1000 / node無制限
2. node候補A: 160k / wall1500
3. node候補B: 200k / wall1500
4. node候補C: 240k / wall1500
5. node候補D: 300k / wall1500

20局スモークだけで棋力採用を決めず、固定局面oracle regretを主判定にする。候補を一つに絞った後、level 10 primary 60局を行う。

採用条件:

- 決定性100%
- wall保険発動5%以下
- depth0ゼロ
- 現行wall系列より平均oracle regretが悪化しない
- 20局スモークの平均石差が3石以上悪化しない
- 条件を満たす中で最小ノード予算を選ぶ

---

## 3. T085c: Worker・アプリ配線

T085a/bとは別タスクにする。

変更点:

- `engine/src/protocol.rs`
- `app/src/engine/types.ts`
- Worker/clientのリクエスト型
- `app/src/app.tsx`のCPUプリセット
- キャッシュキー生成箇所
- 関連テスト

`LimitJson`と`AnalyzeLimit`へ追加:

```rust
#[serde(default, rename = "maxNodes")]
pub max_nodes: Option<u64>,
```

CPU対局の非`allMoves`経路では`search_with_eval_with_node_limit`を呼ぶ。

`allMoves:true`は現状、全候補を別々に探索するAPIで総ノード予算の意味が未定義である。T085cでは次のどちらかにする。

- `allMoves:true`かつ`maxNodes`をエラーにする
- `maxNodes`を無視せず、未対応エラーを返す

候補ごとに同じmax-nodesを与える実装は禁止する。合法手数倍の予算になるからである。

強いCPUプリセットのみ、校正済み`maxNodes`と1500ms保険を設定する。解析・詰め問題・全合法手比較へ一括適用しない。

---

## 4. T086: TT置換規則

### 4.1 現状の欠陥

現行`store`は同一hashなら無条件で`depth_slot`を上書きする。そのため、深いExactを浅いUpper/Lowerで失うことがある。

現行`probe`はdepth slotを先に返し、両slotに同一hashが存在した場合の品質比較をしない。

### 4.2 品質順序

同一hash・同一domainの品質を次の辞書順で比較する。

1. depthが深い
2. 同深度ならExact
3. 同深度・同Boundなら強いbound
   - Lowerはscoreが大きい方
   - Upperはscoreが小さい方
4. 同品質なら`best_move=Some`を優先
5. 完全同等なら新しい方

重要なのは「浅いExact」と「深いbound」では深い方を優先することである。浅いExactはその浅さでの正確値に過ぎず、深い探索値の代替ではない。

### 4.3 store規則

- 同一hash/domainの既存エントリを両slotから探す
- 新規が劣るなら、score/depth/boundは上書きしない
- ただし既存`best_move=None`、新規`Some`ならmoveだけ補完可
- 新規が優れるなら高品質側へ昇格
- 同じhash/domainを両slotに重複保持しない
- 異なるhashの衝突時は、depth slotに高品質、always slotに最新エントリ
- depth slotを追い出した既存エントリは、always slotより高品質なら退避する

`probe(hash, domain)`は両slotを調べ、一致エントリが二つあれば品質比較して返す。

### 4.4 T086ゲート

- 深いExactへ浅いUpper/Lowerをstoreしても保持される
- 同深度boundへExactをstoreするとExactになる
- Lower/Upperの強いboundが保持される
- probe順序に依存しない
- fixed-depthのbest move/scoreが基準と一致
- FFO正解値一致
- collision stress testで誤probeゼロ
- 固定局面の中央値ノード数が2%以上悪化しない
- 改善ノード数・TT hit/cutoff数を記録

コマンド:

```text
cargo test -p engine
cargo test -p engine --release --test ffo_bench
cargo test -p engine tt::tests -- --nocapture
```

T086だけで対level 10戦績が大きく変わることは期待しない。これは棋力施策というより、以後のhistory/aspiration/exact再利用を安定させる基礎修正である。

---

## 5. T087: Pattern v3

## 5.1 パターン集合

### edge+2X

基準となる上辺パターン:

```text
a1 b1 c1 d1 e1 f1 g1 h1 + b2 g2
```

0-based座標では:

```rust
(0, 0..8) + [(1, 1), (1, 6)]
```

基準パターンにD4全変換を適用し、セル集合で重複除去する。4辺分の4インスタンス、1クラス、各10セルになることをassertする。個別セル番号を4辺分手書きしない。

### offset diagonal 5/6/7

長さ`L`について`offset = 8 - L`とする。基準パターン:

```rust
(0..L).map(|i| (i, i + offset))
```

これへD4全変換を適用し、集合重複を除去する。

- 長さ7: 4インスタンス
- 長さ6: 4インスタンス
- 長さ5: 4インスタンス
- 各長さ1クラス
- 合計12インスタンス、3クラス

### corner 5x2 ablation

基準:

```rust
rank 0..2 × file 0..5
```

D4 orbitで8インスタンス、1クラス、10セルになる。これは`edge+2X`と情報重複が多いため、本採用候補ではなく比較用とする。

### 比較する5構成

1. `v2`
2. `v2-diag567`
3. `v2-edge2x`
4. `v3 = v2-edge2x-diag567`
5. `v2-corner5x2`

`edge+2X + corner5x2`は通常ablationに含めない。両方を入れると8MB上限を超える可能性が高く、特徴重複も大きい。

## 5.2 サイズ

13ステージ、f32、D4クラス共有を維持した場合:

| 追加特徴 | 計算 | 増加量 |
|---|---:|---:|
| edge+2X | `3^10 × 13 × 4` | 3,070,548 bytes |
| diag 5/6/7 | `(3^5+3^6+3^7) × 13 × 4` | 164,268 bytes |
| 現行v2 | 実ファイル | 2,729,420 bytes |
| 推奨v3合計 | ヘッダ除く概算 | 約5.96MB |

推奨v3は8MB以内に収まる。

`edge+2X + corner5x2 + diag567`は約9.0MBとなり通常上限を超えるため、例外12MBを使う前に棋力差を実証する必要がある。

ステージは現行13のままにする。3ステージへの縮約はサイズを大きく減らすが、終盤に近づくにつれて同じ配置の価値が急変するため、Pattern v3と同時には行わない。

## 5.3 PWV3形式

PWV2はセル数しか保存せず、読み込み側が固定の`generate_patterns()`を再生成する。この形式では複数ablationを安全に識別できない。

PWV3は自己記述形式にする。

```text
magic                 [u8;4] = "PWV3"
version               u32 = 3
flags                 u32
num_stages            u32 = 13
stage_empty_divisor   u32 = 5
num_instances         u32
num_classes           u32
schema_hash           [u8;32]

instance block × num_instances:
  cell_count          u8
  class_id            u16
  aligned_cells       u8 × cell_count

class block × num_classes:
  cell_count          u8
  num_states          u32
  weights             f32 × num_stages × num_states
```

`schema_hash`はステージ定義、各instanceのclass_id、aligned cell列を直列化したもののSHA-256とする。

読み込み時の検証:

- cellが0〜63
- instance内重複なし
- `num_states == 3^cell_count`
- class_id範囲内
- 同一classのcell_count一致
- D4クラス分類と保存class_idの一致
- f32がfinite
- 余剰bytesなし
- schema hash一致

PWV1/PWV2 loaderは維持する。既存`pattern_v2.bin`を書き換えない。新しいtrainerのみPWV3を書き出す。

## 5.4 NPS

v2は22インスタンス、推奨v3は38インスタンスとなる。単純な特徴抽出回数は約73%増えるため、NPS 80%以上というゲートは容易とは限らない。

対策はパターン削減ではなく、まず次を行う。

- `PatternCells`の小Vec化または固定長配列化
- scoreごとの一時Vec生成を禁止
- 3進multiplierを定数表化
- instanceのclass_id/cell列を連続配置
- `stage_tables[stage]`参照をループ外へ寄せる

採用ゲート:

- 重み8MB以下
- v2比NPS 80%以上
- 3 seedすべてでfrozen test MAEが同方向
- oracle regret 10%以上改善、またはX/C高ロス率25%以上減少
- 20局スモークで重大退行なし

前回案の「MAE 10%、regret 15%、X/C blunder 50%減」はストレッチ目標とし、タスク完了条件にはしない。学習実験が正しく完了して候補が不採用になることも、正常なタスク完了である。

---

## 6. T088: 学習改善

## 6.1 年代分割

ファイルの年情報を使い、対局単位で固定する。

- train: 2015〜2022
- validation: 2023
- frozen test: 2024

分割後にサンプルを混ぜ直さない。2024は最終選択まで一切チューニングに使わない。

## 6.2 D4正規化と重複処理

盤面、手番、直前着手を8対称変換し、次の辞書順で最小となる表現をcanonical keyにする。

```text
(black_bits, white_bits, mover)
```

同一canonical positionに複数の最終結果があることは正当であり、単純に一件だけ残してはならない。canonical positionごとに以下を保持する。

- outcome平均
- outcome分散
- 出現回数
- 年
- phase
- 直前着手種別

学習用targetを`i8`から`f32`へ変更し、canonical positionの平均outcomeを使う。

年代間リーク防止として、canonical keyが複数splitに現れた場合は後年側を優先する。

```text
test > validation > train
```

2024に存在するkeyはtrain/validationから除外し、2023に存在するkeyはtrainから除外する。除外件数をmanifestへ記録する。

## 6.3 Huber loss

初期値は`δ = 8石`を推奨する。

```text
|error| <= 8:  0.5 * error^2
|error| > 8:   8 * (|error| - 4)
```

勾配は`error.clamp(-8, 8)`相当になる。

最終値はvalidationで`δ ∈ {4, 8, 12}`を比較する。2024 testで選ばない。最終石差ラベルには人間の後続手順による大きなノイズが含まれるため、MSEよりHuberが適している。

## 6.4 early stoppingと学習率

- 最大60 epoch
- 初期learning rate: 0.005
- validation MAEが2 epoch改善しなければlearning rateを半減
- 最小学習率: 0.0003125
- 5 epoch改善しなければ停止
- 最小改善量: 0.02石
- validation MAE最良epochの重みを復元
- L2候補: `1e-6 / 1e-5 / 1e-4`

各epoch終了時に以下を保存する。

- weights checkpoint
- optimizer設定
- epoch
- shuffle seed
- train/validation指標
- データmanifest hash

1 epoch単位でresume可能にする。長時間実行で最後に一括保存する設計は禁止する。

## 6.5 ステージ別サンプリング

13ステージを維持し、各ステージのサンプル数を集計する。サンプリング重みは逆数そのものではなく、過補正を避けるため逆平方根を使う。

```text
weight(stage) = sqrt(max_stage_count / stage_count)
```

最大4倍へclampする。各epochの処理件数が無制限に増えないよう、weighted shuffleで元サンプル数と同数を抽出する。

## 6.6 X/C hard-negative

座標:

```text
X: b2 g2 b7 g7
C: b1 g1 a2 h2 a7 h7 b8 g8
```

直前着手がX/Cで、対応する隅が着手前に空いていた局面を`vulnerable_xc`とする。固定罰則は入れず、データの提示頻度だけを増やす。

対象は「X/C着手後の局面」である。次手側から見たoutcomeを学習することで、相手へ与えた利益を表現させる。

初期値:

- hard-negative 3倍sampling
- 各epoch全体の25%を上限
- XとCを別集計
- 隅が既に確保済みのX/Cは対象外

比較:

1. hard-negativeなし
2. 2倍、上限15%
3. 3倍、上限25%
4. 4倍、上限25%

X/Cは文脈によって最善手になり得るため、target変更や固定減点はしない。

## 6.7 v2特徴のまま行うablation

Pattern v3より先に、以下を同じv2特徴で比較する。

1. 現行再現: MSE、ランダム90/10、20 epoch
2. 年代分割のみ
3. 年代分割 + D4 canonicalization
4. 上記 + Huber
5. 上記 + early stopping/LR decay
6. 上記 + stage sampling
7. 上記 + X/C oversampling
8. 全部

3 seedで実行する。

CLI例:

```text
cargo run -p train --release --bin train_patterns -- experiment \
  --pattern-set v2 \
  --train-years 2015-2022 \
  --validation-years 2023 \
  --test-years 2024 \
  --loss huber \
  --huber-delta 8 \
  --early-stop-patience 5 \
  --stage-sampling inverse-sqrt \
  --xc-oversample 3 \
  --xc-cap 0.25 \
  --seed 1 \
  --checkpoint-dir <repo外の出力先> \
  --resume
```

出力には、設定・データhash・epoch別指標・最良epoch・frozen test値を含める。

T088採用ゲート:

- 3 seedすべてで現行v2よりvalidation MAEが改善
- frozen 2024 testの中央値MAEが5%以上改善
- oracle position regretが10%以上改善
- X/C high-loss率が20%以上改善
- NPSは重み形式が同じなので95%以上
- 失敗実験も設定・指標を残す

---

## 7. T089a: history + aspiration

T085/T086後の固定ノード予算で再計測してから実装する。

### history

- `(side, move)`の64要素表
- beta cutoff時に`depth²`加算
- root探索ごとに全値を半減して飽和防止
- TT moveを最優先
- corner/既存mobility順の後にhistoryを使う構成と、historyをmobilityより前にする構成をablation
- exact solverには適用しない

### aspiration

前イテレーションscoreを中心に初期窓±2石。

```text
±200 → ±400 → ±800 → ±1600 → full window
```

fail-low/high時は必ず再探索し、最終score/best moveをfull-window基準と一致させる。MPCは引き続きOFF。

ゲート:

- fixed-depth score/best moveがfull-window baselineと全件一致
- 固定ノード予算で完成深さ中央値+1、または中央値ノード20%減
- aspiration再探索率を記録
- 60局で平均石差の重大退行なし

---

## 8. T089b: hot path

プロファイルで上位を確認してから変更する。候補は以下。

- `ordered_moves`のVec allocation除去
- legal move metadataの一回計算
- apply_moveと相手mobilityの重複計算削減
- PV抽出を探索後だけに限定
- pattern state抽出の固定配列化
- empty-region計算の適用範囲縮小
- sortを最大64要素の固定配列/insertion sortへ変更

各変更を小分けにし、まとめて最適化しない。

ゲート:

- best move/score完全一致
- native release NPS +10%以上、またはWASM p50 wall -10%以上
- WASM p95も悪化しない
- FFO正解値一致
- ノード数変化と1ノード単価変化を分離して報告

---

## 9. T090: Edax教師蒸留

T090は一つの大タスクにせず、生成と学習を分ける。

### T090a 教師コーパス生成

入力局面:

- WTHOR 2015〜2024からphase別層化抽出
- T084/T085の自作エンジン高regret局面を優先
- X/C合法局面を別層
- 各opening・対局からの過剰抽出を制限
- canonical D4重複除去

教師値:

- 終盤で完全読みできたものは`exact`
- それ以外はEdaxのlevel、探索深さ、elapsedを記録
- 全合法手のteacher valueを保存
- best moveだけでなくbestとの差も保存

1局面ごとにcheckpointしresume可能にする。生成途中で設定、Edax binary hash、git hashが変わったら別run keyとする。

初期規模:

- smoke: 1,000局面
- primary: 50,000局面
- 拡張: 200,000局面

いきなり数十万局面を生成しない。

### T090b 蒸留学習

目的関数は次の混合を比較する。

```text
0.6 × Huber(局面teacher value)
+ 0.3 × pairwise ranking loss
+ 0.1 × WTHOR outcome Huber
```

pairwiseはteacher best childと、自作エンジン選択または上位候補childの差を学習する。全合法手総当たりではなく、best、engine choice、X/C candidate、teacher上位2手に限定してデータ量を抑える。

WTHOR outcomeを完全に捨てず、teacher近似の癖へ過適合するのを防ぐ。

採用ゲート:

- frozen teacher setでbest-move agreement改善
- mean regret 20%以上改善
- WTHOR 2024 MAEが10%以上悪化しない
- NPS 80%以上
- level 10の20局スモークで平均石差5石以上改善した候補だけ60局へ進む

### T090c 最終棋力判定

- 20局: クラッシュ、重大退行検知
- 60局: 一次判定
- 100〜200局: 60局の色交換ペア単位CIが50%を跨ぐ場合のみ
- opening pairをクラスタとして扱う
- paired permutationまたはcluster bootstrap
- book off
- node budget固定
- wall保険発動率を併記
- build/weights/teacher manifest hashを保存

---

# (b) 代替案と却下理由

## exactを最初に全予算で試す

現行方式であり却下する。成功時は強いが、失敗時に完成済み中盤結果がなく、予算の大半を捨てる。T084の合法手フォールバックは対局終了バグを防ぐだけで、棋力上の浪費は解消していない。

## exact失敗時に単純なstatic評価を返す

通常予算でdepth 0を生み、終盤境界で着手品質が急落する。完成済み反復深化結果を保持する設計に劣る。

## 実測NPSから毎手max-nodesを動的変更する

JIT、端末負荷、ブラウザ差により同一局面の着手が変わる。決定性を主目的にnode budgetへ移行する方針と矛盾する。NPSは事前校正にだけ使う。

## exact_from_emptiesをすぐ24へ上げる

現在のendgame solverは安定石cutや空き4〜1専用処理を持たず、空き20前後でも極端に重い局面がある。空き数だけを上げるとexact失敗率が増える。推定コストと残予算を併用する。

## TT容量増加

同一hashを浅い値で上書きする規則を直さず容量だけ増やしても、品質問題を隠すだけである。WASMメモリと初期化コストも増える。T086を先に行う。

## X/C固定罰則

X/Cが最善になる局面が存在するため却下する。`edge+2X`表現、hard-negative sampling、teacher pairwise lossで文脈を学習する。

## Pattern v3と学習法刷新を同時投入する

改善原因を識別できない。v2特徴でT088を先に評価し、同じtrainerでPattern v3を比較する。

## corner5x2をedge+2Xと同時採用

情報重複が大きく、約3MB追加で8MB通常上限を超える可能性がある。独立ablationでedge+2Xより明確に良い場合のみ置換候補にする。

## 3ステージへ縮約

サイズは減るが、評価値のphase依存を粗くする。Pattern追加・学習変更と交絡するため今回は行わない。

## MPC再有効化

現状の評価誤差が大きく、MPCの統計前提が弱い。過去にも再帰適用で重大な棋力低下があった。評価・探索基盤が改善するまでOFFを維持する。

## opening book

目標がbook offのEdax level 10であり、序盤の弱点を隠すだけになる。練習モードの定石DBとは分離する。

## WASM Threads

ユーザー方針で不採用確定。今回の差の主因でもない。

---

# (c) タスク分割・依存関係・受入基準

| タスク | 主変更対象 | 依存 | 1セッションの成果 |
|---|---|---|---|
| T085a | `search.rs`, `endgame.rs`, `tt.rs`, `eval_cli.rs` | T084 | TTドメイン、baseline-first、exact quota、abort理由、テレメトリ |
| T085b | `vs_edax.py`, 固定manifest、WASM校正 | T085a | max-nodes確定、空き19〜24ゲート |
| T086 | `tt.rs`, TT統計 | T085a | 同一hash保護、品質probe/store |
| T088a | `train/src/`, trainer CLI | T084 | 年代分割、Huber、early stop、resume、v2 ablation |
| T087a | `patterns.rs`, `pattern_eval.rs`, weights README | T088aのCLI仕様確定後 | PWV3、pattern-set、サイズ/NPSテスト |
| T087b | `train/`, 重み候補 | T087a,T088a | 5構成×3 seed学習・offline比較 |
| T088b | `train/src/` | T088a | D4 dedupe、stage sampling、X/C hard-negative |
| T089a | `search.rs` | T085a,T086 | history、aspiration |
| T089b | search/eval hot path | T087候補,T089a | profile駆動のWASM高速化 |
| T090a | 教師生成ツール | T087/T088候補確定 | checkpoint付きteacher corpus |
| T090b | trainer | T090a | value+ranking蒸留 |
| T085c | protocol/app | T085b | maxNodes配線、CPU preset |
| T090c | bench成果物 | 全採用候補 | 60〜200局最終判定 |

実装ワーカーが一人なので、同時に複数のコード変更は行わない。並列化できるのは以下に限る。

- T085/T086の実装中に、既にコミット済みtrainerからT088の長時間学習を別のクリーンworktreeで実行
- T089実装中に、コミット済みPWV3候補の学習を別worktreeで実行
- T090教師生成中に、生成済みcheckpointまでを使った小規模学習

同じworktreeで長時間ベンチを実行しながらコードを編集すると、T084のdirty-tree拒否とprovenance要件に反する。並列実行するなら、固定コミットの別worktreeまたはリポジトリ外の実行環境を使う。

全エンジンタスク共通受入:

```text
cargo test -p engine
cargo test -p engine --release --test ffo_bench
```

train変更共通受入:

```text
cargo test -p train
cargo test -p engine
```

Pattern loader・推論変更時:

```text
cargo test -p engine pattern
cargo test -p train
cd app
npm run build
```

長時間学習・教師生成・100局以上のベンチは、1 epoch・1局面・1局ごとのcheckpoint、resume、逐次進捗を必須にする。

レビュー体制は各タスクで次の順がよい。

1. Codex実装
2. Sonnet verifierがコマンド実行・成果物再集計
3. codex-reviewが差分・境界条件・provenance確認
4. オーケストレーターが採用/不採用を決定

T085、T086、PWV3 loaderは境界バグの影響が大きいため、verifierとreviewerの両方を必須とする。学習実験は「棋力が伸びなかった」こと自体を不合格にせず、実験設計・再現性・集計の正しさと候補採用を分けて判定する。

---

# 寄与の定量見積もり

数値はT084のクリーンなloss分析完了前の粗い見積もりであり、加算可能とは限らない。

| 施策 | 平均石差改善見込み | level 10勝率見込みへの寄与 | 確信度 |
|---|---:|---:|---|
| T085 exact/予算 | 2〜6石 | 0〜8ポイント | 中 |
| T086 TT | 0〜1.5石 | 0〜3ポイント | 中 |
| T088 学習法(v2) | 2〜6石 | 3〜10ポイント | 中低 |
| T087 Pattern v3 | 3〜8石 | 5〜15ポイント | 中低 |
| T089a/b | 2〜5石 | 3〜10ポイント | 中 |
| T090 蒸留 | 4〜12石 | 8〜25ポイント | 低 |
| 合計 | 13〜30石 | 大きく重複 | 低 |

T085+T086後も平均`-29〜-34石`程度が中心予想で、勝率50%には遠い。Pattern v3/T088は必要であり、それでもT090なしでは50%到達は難しい。

また、現在のendgame solverは空き4〜1専用処理、安定石cut、高度な終盤手順付けを持たない。T085後もexact完走率が低い場合は、T089とは別に終盤高速化タスクを追加すべきである。これは単なる最適化ではなく、同一ノード予算内でexact完走可能な空き数を広げる施策になる。

平均`-35.8`を50%まで縮めるには、平均石差だけでなく「序中盤で一度に10石以上失う着手」の頻度を落とす必要がある。T084の修正版loss分析で、次を主要KPIにする。

- `loss >= 4石`率
- `loss >= 8石`率
- X/C vulnerable着手の平均loss
- phase別mean regret
- engine choiceとteacher bestの一致率
- 完成探索深さ
- exact失敗後のfallback深さ

---

# (d) 確認事項

1. **通常重み上限は8MB、例外12MBで確定としてよいか。**  
   推奨v3は約5.96MBで8MB以内。edge+2Xとcorner5x2の同時採用だけが通常上限を超える可能性が高い。

2. **T090教師生成用のEdax binaryと生成物を非コミットのローカルデータとして扱ってよいか。**  
   コミット対象は生成コード、manifest仕様、採用済み重みだけとするのが妥当である。

3. **教師コーパスの初期上限を50,000局面としてよいか。**  
   まず1,000局面smokeでthroughput・resume・ラベル整合性を確認し、その後50,000へ進む。200,000は改善が確認された場合だけにする。

4. **アプリの強いCPUだけをnode-budgetへ移行し、全合法手解析・詰め問題は当面従来仕様を維持してよいか。**  
   `allMoves`の総ノード予算は別設計が必要であり、一括移行は避けるべきである。

5. **T084の進行中成果物は意思決定用の確定値としないことでよいか。**  
   調査時点の`vs_edax_results.json`は更新中でdirtyであり、single-root 60局は依頼記載の`0勝20敗 / 4勝16敗 / 14勝6敗`と一致していたが、allmovesとloss分析は未完である。T085の採用基準値はT084完走後のコミット済み成果物から固定すべきである。

6. **目標を「60局で観測勝率50%以上」とするか、「色交換ペアを考慮したCI下限50%以上」とするか。**  
   後者は必要局数が大幅に増える。現実的には、60局で観測50%以上を一次達成、僅差なら100〜200局でCIを報告する現在方針が妥当である。

最終的な推奨開始点は、T084完了後にT085aを実装し、同時にT088aの詳細タスク仕様を起こすことである。T085/T086だけでlevel 10到達を期待せず、そこで得た決定的なnode-budgetと正しいloss計測を、T087〜T090の採否判定基盤として使うべきである。