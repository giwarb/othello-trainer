# T158: 評価関数への追加特徴（モビリティ・囲い度）の導入設計レポート

## 1. 結論

推奨する初期候補は、現行 v4 のパターン和に次の2つを61ステージ別の線形項として加える構成である。

```text
score(board, mover)
  = pattern_score(board, mover)
  + mobility_weight[empty_count] * normalized_mobility_advantage
  + exposure_weight[empty_count] * normalized_exposure_advantage
```

特徴量は mover 視点で以下のように定義する。

```text
mobility_advantage
  = legal_moves(mover).count_ones()
  - legal_moves(opponent).count_ones()

exposure_advantage
  = adjacency_incidence(opponent, empty)
  - adjacency_incidence(mover, empty)
```

`adjacency_incidence(side, empty)` は、その色の石と空きマスが8近傍で接する「辺」の本数とする。同じ石が複数の空きマスに接していれば複数回数える。正値が「自分の石は空きに触れにくく、相手石は触れやすい」有利方向になるよう符号を定める。

モビリティはまず正確な合法手数差を採用する。囲い度は合法手生成を使わず、空きビットボードを8方向に1回ずつシフトし、各方向について両色との積集合を `popcount` する。したがって追加コストの大半は、両者分の合法手生成になる。

ただし採用を前提に実装してはならない。現行 `legal_moves_relative` は8方向それぞれで最大6石分を展開するため、葉ごとに2回呼ぶコストは WASM では特に無視できない。計画用の暫定見積もりは次の範囲とする。

- 評価関数単体: 10～30%程度の増加を想定
- 探索全体のNPS: nativeで5～20%、WASMで10～25%程度の低下をリスク枠として想定
- 囲い度だけのコストは低く、モビリティ生成が支配的になる見込み

これは実測値ではなく、現行実装の演算量から置く計画レンジである。Egaroucid自身も、評価精度と評価速度のトレードオフを明示し、6系で使っていた合法手位置パターンを7系で速度優先のため外している。したがって「強豪AIが使っているからコストは相殺される」とは仮定できない。[Egaroucid Technical Explanation](https://www.egaroucid.nyanyan.dev/en/technology/explanation/)

採用判断は次の四段階とする。

1. 特徴なし経路の完全不変性と、native/WASMの一致を確認する。
2. ゼロ係数の追加特徴モデルで、評価値・探索ノード集合を変えずに純粋なNPSコストを測る。
3. WTHOR frozen MAE、T157 oracle 180、少数局の対baseline paired smokeで候補を1つに絞る。
4. 最終採用判定は後回しリストの対Edax 60局pairedゲートに委ねる。

T157の結果から、oracle 180は0.1～0.3石級の候補順位を決める昇格ゲートには使えない。T158では「明確な悪化を落とす安全柵」に限定し、frozen指標と少数局対局も含めた複数の安価な指標で、最終ゲートへ送る候補を1つだけ選ぶ。

---

# (a) 推奨する設計とその理由

## 2. 現行実装からの設計上の前提

現行本番経路は次の構造である。

- `engine/src/pattern_eval.rs`
  - v4は38 pattern instances / 10 classes
  - `empty_count` をそのままstageとする61段
  - `PatternWeights::score` は mover 視点の素の石差 `f32`
- `engine/src/search.rs`
  - `static_eval` が `score * 100` を丸め、centi-discへ変換
  - 最後に `[-6400, 6400]` へクランプ
  - `depth == 0` では合法手生成やTT参照より先に直接評価する
- `train/src/regression.rs`
  - パターン重みをオンラインSGDで同時更新
- `train/src/bin/train_patterns_v3.rs`
  - v4、WTHOR、簡易コーパス、epoch単位checkpoint/resumeが既にある
- `engine/src/bitboard.rs`
  - 合法手生成は `legal_moves_relative` に一本化済み
  - 8方向×最大6石のKogge-Stone系処理

特に、葉では既存の合法手生成結果を再利用できない。`depth == 0` が合法手判定より先に返るため、モビリティ追加は純増コストになる。

## 3. 特徴量の定義

### 3.1 モビリティ

初期候補は正確な合法手数差とする。

```rust
mover_moves = legal_moves_relative(mover_bits, opponent_bits, empty).count_ones()
opponent_moves = legal_moves_relative(opponent_bits, mover_bits, empty).count_ones()

mobility_advantage = mover_moves - opponent_moves
```

理由は次のとおり。

- 意味が明確で、学習データ生成側と推論側を同一関数にできる。
- 色交換で符号が反転し、D4対称変換で値が不変になる。
- 近似モビリティと異なり、複数方向で合法な同一マスを重複カウントしない。
- 現行の合法手生成が既に十分テストされており、新規の合法手判定ロジックを増やさない。

値域は安全側に `[-64, 64]` とみなせる。実戦上ははるかに狭いが、バイナリ形式やテストを経験的最大値へ依存させない。

### 3.2 囲い度

「囲い度」は実装によって少なくとも以下の3種類に分かれる。

1. 空きに接する自石のユニーク個数（frontier discs）
2. 自石と空きマスの8近傍接触辺数
3. 自石に接する空きマスのユニーク個数（potential mobility）

OthelloAI Textbookのサンプルは、行・列・対角線の1次元表を合算し、石と空きの接触を方向ごとに数えている。すなわちユニークな石数ではなく、概ね8近傍の接触辺数である。またモビリティも線ごとの合法性を加算するため、複数方向で合法な同一マスを重複しうる近似になっている。[サンプル実装 `pattern_mobility_surround_evaluation.hpp`](https://github.com/Nyanyan/OthelloAI_Textbook/blob/main/pattern_mobility_surround_evaluation.hpp)

本リポジトリでは、囲い度についてはこの意味に近い「接触辺数」を採用する。

```text
adjacency_incidence(side, empty)
  = Σ direction popcount(side_bits & shift_direction(empty))
```

8方向を数えるため、斜め接触も含む。同じ石が3つの空きに接していれば3として数える。

評価へ入れる値は次とする。

```text
exposure_advantage
  = opponent_incidence - mover_incidence
```

自石のfrontier/exposureが少ないことを正方向にする。一般的なOthello文献でも、frontier discは空きに接する石、potential mobilityは空きと石の隣接として説明され、実モビリティを補完する特徴とされている。[Buroの評価関数研究](https://skatgame.net/mburo/ps/pattern.pdf)、[OthelloAI Textbook解説](https://note.com/nyanyan_cubetech/n/nb6067ce73ccd)

理論上の絶対値上限は8×8盤の隣接辺総数以下であり、符号付き16ビットで十分である。実装では計算途中も `i32` を使う。

### 3.3 スケーリング

生値をそのままSGDへ渡すと、パターン特徴が0/1であるのに対し追加特徴が数十となり、現在の学習率 `0.005` では追加係数の勾配が過大になりうる。

以下の2進スケーリングを初期値として推奨する。

```text
normalized_mobility_advantage = mobility_advantage / 8.0
normalized_exposure_advantage = exposure_advantage / 32.0
```

理由は次のとおり。

- 典型値を概ね1前後へ寄せられる。
- 除数が2の累乗なので `f32` で厳密に表現できる。
- native/WASM間で不要な除算差を作りにくい。
- 稀な最大値でも、現行の38個のone-hot pattern特徴と合わせた特徴ベクトルノルムが極端になりにくい。
- stageごとの平均・標準偏差を追加保存する方式より、形式と推論が単純である。

実装前にWTHOR train splitの分布を出し、P50/P95/P99/最大値を確認する。`/8` と `/32` が明らかに不適切な場合だけ、同じく2の累乗の除数へ変更する。値のclampは情報を失うため初期案では行わない。

## 4. 評価モデル

stage `s = empty_count` に対して、追加するパラメータは122個だけである。

```text
mobility_weight[61]
exposure_weight[61]
```

増加サイズは `61 × 2 × 4 = 488 bytes` 程度で、現行約28MBのv4重みに対して無視できる。

バイアス項は追加しない。stageごとの定数バイアスは既存のパターン表へ任意に分散でき、識別不能になるためである。

推論式は次とする。

```rust
let mut sum = pattern_score_unchanged(...);

if scalar_features_are_enabled {
    let features = eval_scalar_features(board, mover);
    sum += weights.mobility[stage] * (features.mobility_advantage as f32 / 8.0);
    sum += weights.exposure[stage] * (features.exposure_advantage as f32 / 32.0);
}
```

追加特徴はパターン合算の後に固定順で加える。演算順を固定し、`f64`、fast-math、ターゲット固有SIMDを初期版では使わない。

## 5. 重み形式と既定挙動の不変性

### 5.1 PWV4形式を新設する

既存PWV3の `flags` を流用したり末尾へ暗黙に追記したりせず、新しいmagic `"PWV4"` を使う。

既存PWV3 loaderは余剰bytesを拒否し、schema hashにも追加特徴が含まれないため、PWV3を拡張すると安全な後方互換性を損なう。

PWV4はPWV3の内容に次を追加する。

```text
num_scalar_features: u32

featureごと:
  kind: u8
  scale_shift: u8
  reserved: u16
  weights: f32 × num_stages
```

初期の `kind` は次とする。

```text
1 = ExactMobilityAdvantage
2 = EmptyAdjacencyExposureAdvantage
```

`scale_shift` は `/ 2^scale_shift` を意味し、初期値は3と5である。

schema hashには以下を含める。

- 既存のstage・pattern schema
- scalar feature数
- feature kind
- scale shift
- feature順

未知のfeature kind、重複kind、非finite係数、stage数不一致、余剰bytesは拒否する。

### 5.2 切替方式

安全境界は「読み込んだモデルがscalar featureを持つか」とする。

- 現行 `pattern_v4.bin` はPWV3であり、追加特徴なし
- T158候補はPWV4であり、追加特徴あり
- 同じエンジンバイナリで両者を読み分けられる
- PWV1～3の `PatternWeights::score` は演算順も含めて変更しない

比較用CLIには `--disable-eval-features` を追加してよいが、比較は必ず別プロセスまたはfresh TTで行う。評価モードを同じTT上で切り替えると、旧評価で作ったMidgame TT entryが新評価へ混入するためである。

より堅牢にするなら、`TranspositionTable` に直前の評価モードを記録し、feature on/offが変わったら `exact_from_empties` 変更時と同様にclearする。ただし本番の通常経路は重みを探索前に1回だけloadするので、初期実験では「別プロセス/fresh TT」を明示的な比較条件としてよい。

## 6. hot pathとNPSの評価方法

### 6.1 囲い度の計算コスト

囲い度は次の形で計算できる。

```rust
for dir in 8_directions {
    let adjacent = dir(empty);
    mover_incidence += (adjacent & mover).count_ones();
    opponent_incidence += (adjacent & opponent).count_ones();
}
```

必要なのは8シフト、16 AND、16 popcount程度であり、合法手生成より明らかに軽い。関数ポインタ配列の既存実装をそのまま転用するか、専用の8方向直接式にするかはmicrobenchで決める。T105では展開版の優位が確認できなかったため、根拠なくunrollしない。

### 6.2 ゼロ係数モデルによる純粋なコスト計測

学習済み候補では評価値が変わり、反復深化の手順・TT・探索ノード数も変わる。その状態のNPS差だけでは、評価関数単体のコストとmove ordering変化を分離できない。

そこでPWV4のfeature係数を全てゼロにしたモデルを作り、特徴計算だけを強制する。

このモデルは次を満たすべきである。

- baseline PWV3と全葉評価値が一致
- best move、score、depth、nodesが一致
- elapsedだけが増える

これにより追加特徴の純粋なhot pathコストを測れる。

### 6.3 計測条件

専有状態で以下を守る。

- release build
- 電源設定、CPUクロック条件を固定
- background負荷を止める
- warm-up後に計測
- baseline/candidateを交互順に実行
- 最低7反復、中央値と範囲を記録
- 同じ局面集合、fresh TT、`exact_from_empties=0`
- 序盤・中盤・終盤接続前を含む複数局面
- nativeとWASMを別々に計測
- elapsedが短すぎる単一局面テストに依存しない

測定は次の3層に分ける。

1. `black_box` を用いた評価関数単体throughput
2. ゼロ係数featureモデルによる固定深さNPS
3. 学習済みモデルによる160kノード本番相当のelapsed・到達深さ・評価結果

暫定ゲートは次とする。

- native/WASMともゼロ係数モデルの探索NPS比がbaselineの90%以上: 通過
- 85～90%: frozen改善が実用差を示す場合のみ継続
- 85%未満: 正確モビリティ案を最終対局ゲートへ送らず、近似案へ戻る

これは「10%までは必ず許容する」という意味ではなく、安価なスクリーニングを続ける上限である。最終的な相殺可否は対局でしか判断できない。

160kノード固定では評価が重くても訪問ノード数自体は原則同じ予算まで進むため、評価精度向上とNPS低下は単純に相殺しない。時間上限へ先に到達する経路ではNPS低下が直接不利になる。一方、評価改善により反復深化のmove orderingが改善し、同じ固定深さに必要なノード数が減る可能性はある。両効果を分離して記録する必要がある。

## 7. 学習側の拡張

### 7.1 同時学習

`train::regression::Model` にscalar feature重みを持たせ、predictionをエンジンと共通化する。

1サンプルの予測を

```text
prediction = pattern_sum + wm[s] * xm + we[s] * xe
```

とした場合、追加係数の勾配は次である。

```text
grad_wm = loss_gradient * xm + l2 * wm[s]
grad_we = loss_gradient * xe + l2 * we[s]
```

現在のpattern更新と同じ `loss_gradient` を使うが、追加係数では特徴値 `x` を必ず掛ける。これを忘れると線形回帰にならない。

特徴抽出はengine側の共通関数を呼ぶ。train側で合法手や囲い度を再実装しない。

### 7.2 初期化と学習条件

本比較では全重みゼロからパターンと追加特徴を同時学習する。

現行 `pattern_v4.bin` からwarm-startして追加係数だけ、または全係数を微調整する案は初期実験では採らない。現行の固定20 epoch・オンラインSGDでは、warm-start後のパターン係数のdriftや学習率再設定が新しい交絡要因になるためである。

比較構成は次の4つを用意する。

| 構成 | pattern | mobility | exposure |
|---|---:|---:|---:|
| B0 | 有 | 無 | 無 |
| B1 | 有 | 有 | 無 |
| B2 | 有 | 無 | 有 |
| B3 | 有 | 有 | 有 |

pilotでB1/B2/B3を比較し、full 3seedへ進める追加特徴候補は原則1つに絞る。B0は同じデータhash・seed・学習器での対照であり、既存T124成果物を使える場合もfrozen再採点は同一コードで実施する。

既存の特徴なしconfig、既定CLI、run identity文字列、PWV3出力は変更しない。追加configだけ新しいidentity schemaとPWV4を使う。

### 7.3 checkpoint/resume

既存のepoch単位checkpoint、atomic replace、identity検証を維持する。10分を超える可能性があるfull学習では、最低でも各epoch完了時に次を保存する。

- PWV4 checkpoint
- run identity
- epoch番号
- train/frozen件数
- corpus hash
- feature schema
- seedと学習パラメータ
- frozen MSE/MAEまたは後続再計算に足るモデル

既存処理が古いcheckpointを削除する点は、直前epochからresumeできるという要件を満たす。ただし結果比較用のbest epochを導入するなら別タスクとし、T158でearly stoppingまで同時導入しない。

## 8. 実験プロトコル

### Gate 0: 正しさ・不変性

必須条件:

- PWV1～3を読む既存テストが全PASS
- 現行 `pattern_v4.bin` の局面スコアが変更前と完全一致
- 特徴なしのbest move、score、nodesが固定fixtureで完全一致
- PWV4 round-tripと破損拒否
- feature係数ゼロでPWV3と評価値が完全一致
- 色交換でfeature値が符号反転
- 全D4変換でfeature値が不変
- 囲い度は独立な8×8二重ループ実装とのfixture比較
- 同一入力・fresh TTでbest move、score、depth、nodesが反復一致
- native/WASMの固定fixtureでscore・best move・nodes一致

### Gate 1: コスト

前節のゼロ係数モデルでNPSを測る。

- 90%以上: Gate 2へ
- 85～90%: 条件付き継続
- 85%未満: exact mobility案を停止し、代替案の近似モビリティを検討

WASMの結果をnativeより優先する。本番はGitHub Pages配信のWASMだからである。

### Gate 2: 学習pilot

推奨pilot:

- WTHORの決定的な層化180kサブセット
- seed 1
- B0/B1/B2/B3
- 20 epoch
- 既存の対局単位frozen split
- stage別および全体のfrozen MAE/MSE
- game単位paired bootstrap

「対局ゲートへ送る価値がある」pilot条件:

- frozen MAEがB0より0.05石以上改善
- game単位paired bootstrapで改善方向
- 特定stage帯で大幅悪化していない
- 係数がfiniteで、隣接stage間に説明不能な極端な振動がない
- NPS Gate 1を満たす

in-corpus/train lossは診断用に記録するが、昇格条件には使わない。追加特徴は全サンプルで活性になるためtrain lossだけは改善しやすく、汎化性能の根拠にならない。

### Gate 3: full学習

pilot最良の1構成だけを次へ進める。

- WTHOR全74,024局、約443万サンプル
- 3seed
- 20 epoch
- 現行v4と同じsplit・shuffle規約
- corpus hashを固定
- epoch単位checkpoint/resume

推奨条件:

- 3seed平均frozen MAEがbaselineより0.05石以上改善
- 少なくとも2/3 seedで非悪化
- game単位paired bootstrapで改善方向
- stage別MAEに局所的な重大退行がない

0.05石は最終棋力差を意味せず、ノイズのあるWTHORラベル上でも全く差が見えない候補を重い対局へ送らないための実用下限である。

### Gate 4: T157 oracle 180による害検出

T157 oracle 180は昇格判定ではなく、次の粗い退行を検出するために使う。

- mean regret
- Edax top move agreement
- baselineとcandidateのpaired win/loss position数
- empties別regret
- 既存M2・provenance guard

候補がbaselineより0.2石以上悪化する、またはtop-move agreementが明確に低下する場合は停止する。

逆に0.1～0.3石の改善が出ても、それだけでは採用根拠にしない。T157ではWTHOR/Egaroucid系の全候補がv2と統計的に識別できず、60局面で見えた約0.46石差も180局面では約0.015石まで縮小しているためである。

### Gate 5: 少数局paired smoke

最終Edaxゲート前にbaselineとの自己対戦を行う。

- 12 opening pairs、色交換込み24局程度
- 160kノード
- 同じopening、同じ色条件
- 1局ごとにatomic checkpoint
- resume可能
- 1局ごとに進捗出力
- crash、非法手、非決定性、極端な負け越しを検出

このsmokeは有意差検定ではない。明白な棋力崩壊を落とすだけであり、勝ち越しを採用根拠にしない。

### 最終ゲート: 対Edax 60局paired

Gate 0～5を通過した1候補だけを後回しリストへ追加する。

manifestには次を固定する。

- candidate weight SHA-256
- baseline weight SHA-256
- engine/eval_cli SHA-256
- git commit/tree
- opening set SHA-256
- Edax executable・eval.dat SHA-256
- maxNodes、time、exact設定
- nativeビルド条件
- feature schema
- NPS結果
- frozen/T157/smoke結果

複数候補を同じ最終ゲートへ送り、最良結果だけ採る運用は避ける。多重比較と対局コストを抑えるため、T158内の安価な指標で候補を1つに固定してから積む。

## 9. 決定性・WASM整合

追加特徴の生値は整数演算だけで求める。

- bit shift
- AND/OR
- popcount
- 整数差

乱数、壁時計、iteration順依存の集合は使わない。

学習済み係数は既存と同じlittle-endian `f32` とし、推論の加算順を固定する。スケーリングは2の累乗にする。native/WASM差が丸め境界で発生した場合だけ、scalar係数を固定小数点へ量子化する案へ戻る。既存pattern本体が `f32` であるため、初期段階からscalarだけを固定小数点化する必要性は薄い。

`ANALYSIS_ENGINE_VERSION` は、実験コードとPWV4 loaderを追加しただけでは上げない。現行アプリが引き続きPWV3の `pattern_v4.bin` を読み、結果が完全不変だからである。

最終採用時に次を行う。

- `app/public` の重みをfeature付き候補へ変更
- `app/src/analysis/cache.ts`
  - `ANALYSIS_ENGINE_VERSION = 6` から7へ更新
- `app/src/engine/worker.ts`
  - 新重み名と切戻し手順を更新
  - 切戻し時もversionを再度上げる注意を維持
- native/WASMの固定fixture一致を再確認

---

# (b) 検討した代替案と却下理由

## 10. 正確な合法手数ではなく、線ごとの近似モビリティ

OthelloAI Textbookのサンプルは、事前計算した各行・列・対角線の合法性を加算する。複数方向で合法な同一マスを重複カウントしうるが、盤面のline indexを維持しているため高速である。[サンプル実装](https://github.com/Nyanyan/OthelloAI_Textbook/blob/main/pattern_mobility_surround_evaluation.hpp)

現行エンジンはline indexを着手ごとに増分維持していない。38 pattern stateも評価時に盤面から抽出している。この構造で同方式を導入すると、

- 特定pattern schemaへのfeature計算の結合
- 合法手LUTの追加
- 対角線のpadding規約
- mover/opponent双方のLUT
- 自己記述PWV3 patternとの対応付け

が必要になる。正確な合法手生成より速い可能性はあるが、初期版の意味と実装リスクが増える。

したがって初期候補にはしない。ただしexact mobilityがWASM NPS 85%未満なら、第一のfallbackとして検討する。その場合は「mobility」ではなく `directional_mobility_incidence` と明示し、exact版と同じ係数を流用しない。

## 11. 自分の合法手数だけを使う

Textbookサンプルは手番側の近似モビリティを黒視点へ符号変換して使っており、両者の差ではない。

これは合法手生成を1回にできる利点がある。一方、

- 相手の選択肢を直接表さない
- 手番の違いにより特徴の意味が変わる
- 標準的なmobility differentialより解釈しにくい
- パス付近の値が不連続になりやすい

ため、初期の最小線形モデルとしては採用しない。exact差のコストが不合格だった場合の第二候補とする。

## 12. ユニークfrontier disc数

```text
frontier_mask = side_bits & neighbors_of(empty)
frontier_count = popcount(frontier_mask)
```

で計算でき、接触辺数より安い。一般文献のfrontier discs定義にも合う。

ただし依頼背景の「空きマスに接する度合い」およびTextbookサンプルは、接触の強さを複数回数える実装に近い。接触辺数がNPS上問題になる可能性も低いため、初期案では意味の忠実度を優先する。

囲い度単体が計測上支配的だった場合のfallbackとする。

## 13. 自分と相手の囲い度を別々の2特徴にする

Textbookサンプルは黒・白の囲い度を別入力とし、非線形テーブルへ渡している。差だけでは両者が共に高い局面と共に低い局面を区別できない。

しかしT158の目的は最小のstage別線形項であり、初期から別々にすると、

- 係数が2本増える
- 差・和との多重共線性
- pattern側が既に持つ局所隣接情報との重複
- 候補数増加

を招く。まず差1本で寄与を確認し、residual分析で「和」に追加価値がある場合だけ後続候補にする。

## 14. mobility/exposureの2次元テーブル

値域を離散化し、

```text
additional_table[stage][mobility][exposure]
```

を学習する案である。Textbookの前計算型非線形モデルに近い。

相互作用を表現できる一方、未観測セル、補間、値域clamp、ファイル形式、過学習の問題が増える。WTHOR 443万サンプルでも61 stageへ分けるとstageごとの疎性がある。線形項の寄与を確認する前に採用すべきではない。

## 15. stageを13段へ戻す、または追加特徴だけ共通係数にする

追加特徴は122係数しかなく、61段でもデータ量・ファイルサイズ上の問題は小さい。pattern v4と同じstageを使えばstage境界の意味も統一できる。

追加特徴だけ13段または全stage共通にすると実装は少し簡単だが、phase依存性を表現できず、モデル内に2種類のstage規約を持つことになる。初期案では採用しない。

ただし学習後に係数が激しく振動する場合は、61段を廃止するのではなく隣接stage正則化を別候補として検討する。

## 16. 既存PWV3のflags拡張

PWV3 loaderは余剰bytesを拒否し、schema hashはscalar featureを含まない。flagsだけで末尾形式を変えると、古いloaderとの関係が分かりにくくなる。

明示的なPWV4の方が破損・誤読をfail-fastできるため却下する。

## 17. feature重みを別sidecarファイルにする

pattern重みと追加係数を別ファイルにするとPWV3を変更せずに済む。しかし、

- 2ファイルの組合せhash管理が必要
- 一方だけ古い状態をロードしうる
- appのfetch/fallbackが複雑化
- checkpointの原子性が崩れる
- trainerとengineのモデルidentityが分離する

ため却下する。488 bytesのために運用上の不整合リスクを増やす価値はない。

## 18. 既存v4からのwarm-start

短時間で収束する可能性はあるが、追加特徴の寄与と既存pattern係数の再調整が混ざる。固定20 epoch SGDの現状では比較条件も不明瞭になる。

初回はゼロ初期化・同一seedでの同時学習を使う。warm-startは、full学習コストが問題になった場合の独立した実験とする。

---

# (c) 実装タスクへの分割案

## T158a: engine側特徴計算・形式・評価統合・純コスト計測

### 変更対象

- `engine/src/bitboard.rs`
  - 8近傍接触辺数の共通primitive
  - 必要なら手番相対bitboard helper
- `engine/src/pattern_eval.rs`
  - scalar feature構造
  - PWV4 serialize/deserialize
  - feature付きscore
  - PWV1～3の既存score不変
- `engine/src/search.rs`
  - feature付きモデルのstatic eval接続
  - 比較用feature disable経路
  - 必要なら評価モード変更時TT clear
- `engine/src/bin/eval_cli.rs`
  - feature modeの表示
  - 比較用 `--disable-eval-features`
  - 生feature出力またはベンチ入口
- `engine/tests/pattern_eval_nps_bench.rs`
  - 現行テストを残し、PWV4ゼロ係数比較を追加
  - または専用 `engine/tests/eval_features_nps_bench.rs`
- `train/weights/README.md`
  - PWV4仕様
- 必要に応じて `app/scripts/test-node-budget-wasm.mjs`
  - このタスクでは本番重みを変えず、feature fixtureを扱える場合だけ

### 依存関係

なし。T158b/cの前提。

### 受け入れ確認

```text
cargo test -p engine
cargo test -p engine --release --test ffo_bench
cargo test -p engine --release --test pattern_eval_nps_bench -- --nocapture
```

加えてrelease native/WASMの固定fixture比較を実施する。

### 主なリスク

- PWV1～3のloader/scoreを誤って変える
- feature on/off比較でTTが混ざる
- zero coefficientでもコンパイラや分岐によりfeature計算を省略してしまう
- 8方向境界マスクの誤り
- feature追加でf32加算順が既存モデルにも波及する
- 単一局面NPSのノイズを性能差と誤認する

## T158b: trainer拡張とpilot/full学習

### 変更対象

- `train/src/regression.rs`
  - scalar feature prediction
  - 正しい `loss_gradient * feature_value`
  - PWV4入出力
- `train/src/bin/train_patterns_v3.rs`
  - B0/B1/B2/B3 config
  - 既存config・identity不変
  - feature schemaを追加run identityへ記録
  - 分布統計の出力
- `train/tests/real_data.rs` またはregression内tests
  - 単一sample収束
  - round-trip
  - resume同一性
  - featureなしconfig不変
- 実験成果物
  - `train/data/t158/...`（非コミット）
  - 採用裁定前は `train/weights/` に置かない

### 依存関係

T158aのPWV4と共通feature primitive。

### 実行順

1. feature分布取得
2. 180k pilot、B0～B3、seed 1
3. Gate判定
4. 最良1構成のみ全量3seed
5. epoch単位checkpoint/resume確認

### 受け入れ確認

```text
cargo test -p train --release
```

学習コマンドは各epochで保存・進捗出力し、途中中断後のresumeを実測する。

### 主なリスク

- feature値を勾配へ掛け忘れる
- スケール過大による発散
- 追加configが既存v4のrun identityや出力形式を変える
- patternとscalarが相互に説明を奪い、frozenが改善しない
- 61段係数の局所的過学習
- full 3seedへ複数候補を進めて比較コストを膨らませる

## T158c: スクリーニング・決定性・NPSレポート

### 変更対象

- `bench/edax-compare/t158_screen_features.py`
- `bench/edax-compare/test_t158_screen_features.py`
- 必要に応じて自己対戦ハーネスのT158用wrapper
- `bench/edax-compare/t158_eval_features_report.md`
- `bench/edax-compare/t158_eval_features_report.meta.json`
- `bench/edax-compare/t158_smoke_checkpoint.json`
- 後回しリストの既存管理ファイルがある場合は、候補確定後の記録のみ

既存のT157 corpus/labelsは変更しない。

### 依存関係

T158a、T158b完了後。

### 実施内容

- frozen paired指標の集計
- stage別MAE
- T157 oracle 180再採点
- native/WASM NPS
- feature on/off決定性
- 24局程度のpaired smoke
- 候補1つのhash固定
- 対Edax 60局pairedを後回しリストへ登録

### 主なリスク

- oracle 180の微差を昇格根拠にしてしまう
- in-corpus lossを汎化指標と誤認する
- NPS計測時にbaseline/candidateで局面・TT・実行順が異なる
- 少数局smokeを有意な棋力判定として扱う
- 複数候補を最終対局ゲートへ送る
- 10分超のsmokeで局単位checkpointを持たない

## T158d: 最終対局ゲートと本番採用（後回し）

### 変更対象

採用時のみ:

- `train/weights/pattern_v5.bin` または合意した名称
- `app/public/<同重み>`
- `app/src/engine/worker.ts`
- `app/src/analysis/cache.ts`
- `train/weights/README.md`
- 関連テスト
- 対局結果・report・meta・checkpoint

### 依存関係

T158cで候補が1つに固定され、後回しの対Edax 60局pairedが実行可能になった後。

### 主なリスク

- 重み名のv4とPWV4形式を混同する
- `ANALYSIS_ENGINE_VERSION` を上げ忘れる
- app/publicとtrain/weightsのSHA不一致
- nativeだけで採用しWASM性能を見落とす
- paired条件・opening・色交換の不整合

---

# (d) 未確定事項・オーケストレーターへの確認事項

## 19. 「囲い度」の最終定義

本レポートではTextbookサンプルに近い「石と空きの8近傍接触辺数」を推奨した。

確認したい選択肢は次の2つである。

1. 接触辺数を採用する（推奨）
2. ユニークfrontier disc数を採用する

両者は別特徴であり、同じ名前・係数で差し替えてはならない。

## 20. modern Egaroucidとの差の扱い

依頼背景の「Egaroucid系の標準構成」は、少なくとも公開されているTextbookサンプルと現在のEgaroucid 7系で同一ではない。

- Textbookサンプル: pattern + 近似mobility + 黒白surroundの非線形追加入力
- 現行Egaroucid公式解説: 追加特徴として手番側石数を明記
- 6系の合法手位置patternは7系で速度優先のため削除

したがってT158は「現行Egaroucidの構成をそのまま移植」ではなく、「Othelloで一般的なmobility/frontier情報を、現行v4へ最小線形項として検証する実験」と位置付けるのが正確である。この表現でタスク仕様を確定してよいか確認が必要である。

## 21. PWV4という形式名

現在の本番モデル名「pattern v4」はPWV3形式である。追加特徴形式をPWV4とすると、モデル世代とファイル形式世代がさらにずれる。

推奨は以下で分離すること。

- ファイル形式: PWV4
- 実験成果物: `t158-v4-features-...bin`
- 本番採用名: 採用時に `pattern_v5.bin`

この命名でよいか確認が必要である。

## 22. NPSゲート閾値

本レポートでは次を暫定提案した。

- 90%以上: 継続
- 85～90%: frozen改善次第
- 85%未満: exact mobility停止

WASMで160kノードに到達する前に時間上限へ当たりやすいなら、90%未満を一律停止にする方がよい。現行本番でノード上限と時間上限のどちらが支配的かを、T158a計測時に併記して最終決定すべきである。

## 23. frozen改善の実用下限

0.05石を暫定値としたが、これは過去タスクで確立済みの基準ではない。

オーケストレーターはT158開始前に、少なくとも以下を事前登録すべきである。

- 全体frozen MAEの実用下限
- game単位bootstrapの扱い
- 2/3 seed非悪化を必須とするか
- stage別の許容最大悪化

結果を見てから閾値を変えないことが重要である。

## 24. 少数局smokeの規模

12 opening pairs / 24局を提案した。これはクラッシュ・極端な棋力低下の検出用であり、有意差判定には不足する。

既存の対局ハーネスでより安価な標準opening setがある場合は、それを優先してよい。局数、opening set、色交換、引分の点数を実行前に固定する必要がある。

## 25. 最終対Edaxゲートの採用基準

依頼では「対Edax 60局paired」とあるが、採用に必要な勝点差・平均石差・信頼区間の基準は明示されていない。

後回しリストへ積む時点で次を固定する必要がある。

- baselineとの差を比較するpaired方式か
- Edaxレベル・時間・hash・book条件
- 勝点を主指標にするか、平均石差も必須にするか
- 引分の扱い
- NPS悪化を対局結果とは別の拒否条件にするか
- 統計的同等時に現行v4を維持するか

推奨裁定は「有意または実用的な改善が確認できない場合は、複雑性とNPSコストの小さい現行v4を維持」である。

## 26. exact mobility不合格時のfallback範囲

exact版がNPS Gate 1で不合格だった場合、同じT158内でline-LUT近似まで実装するか、別タスクへ分けるかを確認したい。

推奨は別タスク化である。line-LUT近似は単なる最適化ではなく特徴の意味が変わり、別の学習済み係数と検証が必要になるためである。