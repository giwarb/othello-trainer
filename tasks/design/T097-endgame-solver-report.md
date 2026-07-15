# T097 終盤ソルバー抜本強化 設計レポート

## 1. 結論

推奨方針は、現在の `endgame.rs` を一度に Edax 風へ全面改造するのではなく、次の順序で段階的に強化することである。

1. 終盤専用の再現可能な計測基盤を先に作る
2. TT move・終盤用ムーブオーダリング・ETCでノード数を削減する
3. 安定石による厳密な上下界カットを追加する
4. NWSを中核とするPVS構造へ移行する
5. 空き1～4の専用ソルバーを追加する
6. flip・ハッシュ・空き状態管理を高速化する
7. 必要ならExact TTを上下限同時保持型へ拡張する
8. 全施策完了後にexact quota・閾値・`estimated_min_exact_nodes`を再校正する
9. WASM実機と対Edax 60局で最終確認する

優先順位は明確に「ノード削減が先、NPS向上は後」とする。対局経路が160,000ノード固定だからである。SIMDやflip高速化だけでは、壁時計保険には余裕ができてもexact完走範囲は基本的に広がらない。

「Edax同等」を文字どおり単一スレッドEdaxの2倍以内とすると、現状との差から見て今回の一連の施策だけで必達とは約束できない。現実的な第一到達点は、空き20～24の独立局面群でEdaxの幾何平均5倍以内・p90 8倍以内、160kノードで完全証明できる50%境界を空き23まで上げることである。Edaxの2倍以内・p90 3倍以内をストレッチ目標とし、そこまで到達した場合にのみ「Edax同等」と呼ぶのが妥当である。

---

## 2. 現状調査結果

### 2.1 `engine/src/endgame.rs`

現行ソルバーは次の構造である。

- fail-soft negamax + 通常のαβ探索
- ExactドメインのTT probe/store
- 毎ノードで盤面全体からZobrist hashを再計算
- `Vec<u64>`へ合法手を列挙してソート
- ソートキーは隅優先、相手mobility昇順、連結空き領域の奇数パリティ
- パリティはmobility同率時のタイブレークのみ
- 各候補をソート評価時と実探索時にそれぞれ `apply_move` しており、同じflip計算を2回行う
- TTには `best_move` を保存するが、終盤の手順排序には使っていない
- パス局面はTTへ格納せず、そのまま再帰する
- ETC、安定石カット、PVS/NWS兄弟探索、空き1～4専用処理はない

T052で導入された連結領域パリティは、FFO #40～44合計でノード数を約6.7%削減した一方、#40と#44では増加している。さらに、各ノードでflood fillを行うためNPS面のコストもある。

現在のFFO #40～44は合計約12.99億ノード、専有状態の既存記録で約463秒である。単純なmicro optimizationだけでEdaxとの差を埋められる規模ではない。

### 2.2 bitboard・hashのhot path

`Board::legal_moves` は関数ポインタ配列による8方向処理、`apply_move` は各方向をwhileで走査する。Zobrist hashは毎ノード64マスを走査する素朴な実装である。

いずれも改善余地は大きいが、これらは主にNPS改善であり、160kノード内のexact完走率を直接改善しない。したがってムーブオーダリング、ETC、安定石カット、NWS/PVSより後に扱うべきである。

### 2.3 TT

T086の品質保護は正しく実装されている。

- Exact/Midgameドメイン分離
- 深いエントリ保護
- 両slot probe
- 同一局面ではExact boundや強い同種boundを保護

ただし、現在の1エントリはExact/Lower/Upperのどれか1つしか保持できない。NWSを多用すると同一局面のLowerとUpperが交互に上書きされる可能性がある。Edaxは上下限を同時に扱うため、NWS導入後の計測次第ではExact TTを区間型へ拡張する価値がある。

まずは既存T086を維持したままTT moveとETCを使い、区間型TTは後段の独立タスクにする。

### 2.4 exact切替ポリシーの実態

依頼文にはexact quota 60%とあるが、現在のコードは次の状態である。

- `EXACT_QUOTA_PERCENT = 40`
- `EXACT_POLICY_VERSION = "t085a-v2"`
- T085aの25/40/60/75%比較で40%が採用された
- T085bの校正は `exact_from_empties=18`
- 本番アプリの強CPUは `exactFromEmpties: 16`
- `estimated_min_exact_nodes` は空き15～18に対し約22万、250万、424万、820万ノード
- 空き19以上は `u64::MAX` で通常はexactへ積極的に上げない

したがって「60%を再校正する」のではなく、現行40%を含む複数候補を再比較すべきである。また、本番閾値16とベンチ閾値18の不一致も同時に解消する必要がある。

もう一点重要なのは、現在の `SearchResult.exact_completed` が「ルート局面を完全に解いた」ことを意味しない点である。探索木内のどれか1回のexact呼び出しが完走しただけでもtrueになる。T085bのnode160系列では48局面中11件がtrueだが、その多くは最終結果の `score.type` がmidgameである。この値をそのまま「空き何マスまで完全読みできたか」の指標にしてはならない。

### 2.5 Edax 4.6との差

Edax 4.6の一次ソースでは次の構造が確認できる。

- 空き1、2、3、4の専用ソルバー
- shallow endgameではNWS、パリティ、マス種別、安定石カットを使用
- より深い終盤ではTT、TT move、mobility、potential mobility、corner stability等による排序
- NWSを中心に探索し、深い局面と浅い局面で処理を分離
- 空きマス状態とパリティを増分管理

参照: [Edax 4.6 endgame.c](https://github.com/abulmo/edax-reversi/blob/master/src/endgame.c)、[move.c](https://github.com/abulmo/edax-reversi/blob/master/src/move.c)、[search.c](https://github.com/abulmo/edax-reversi/blob/master/src/search.c)。

Edaxとの差は単一の高速化ではなく、ノード数、葉処理コスト、状態更新コストのすべてに存在する。

---

## 3. 推奨設計

### 3.1 終盤探索の二層化

終盤探索を次の二層に分ける。

#### Deep endgame

主に空き12以上を担当する。

- Exact TT
- TT move優先
- ETC
- 終盤用ムーブオーダリング
- 安定石カット
- NWS/PVS
- budget/abort伝播

#### Shallow endgame

空き11以下を目安に担当する。

- 原則としてTTを使わない、または閾値を限定する
- fixed quadrant parityと静的マス順
- 空き5以上は軽量NWS
- 空き4以下は専用 `solve_4` → `solve_3` → `solve_2` → `solve_1`
- ヒープ確保、盤面全体hash、一般用途のmove sortを行わない

深浅境界は定数として固定し、最終的には8、10、12等をベンチで比較する。壁時計や実測NPSから動的に変えてはならない。

### 3.2 NWS/PVS構造

`solve_exact_window_limited_with_nodes` の外部契約は維持し、内部を次の構造にする。

- 狭窓呼び出しは直接NWSへ送る
- full windowでは最初の候補を通常窓で探索
- 2手目以降はnull windowで反証を試みる
- `alpha < score < beta` のときだけ通常窓で再探索
- abortされた探索結果は使用せず、TTにも格納しない
- TT格納時のbound判定には、TTや安定石で変更する前の呼び出し窓を保存して使う

最終石差は実質偶数になるが、当面はこれを利用した2刻み窓最適化を行わず、通常の1刻みnull windowを使う。centi-discから外向き丸めされた窓や境界値との相互作用を避けるためである。

### 3.3 終盤用ムーブオーダリング

各候補を次の情報を持つ固定長 `MoveInfo` として一度だけ生成する。

- 着手マス
- flip mask
- 子盤面
- 子hash
- 相手の合法手数
- 相手のpotential mobilityまたは近似値
- quadrant parity
- static square class
- TT move一致
- ETCに使える子TT bound

推奨優先順は次のとおり。

1. wipeout
2. TT move
3. 即時の厳密ETC cutoff候補
4. 隅
5. 相手mobility最小
6. corner/X/Cを考慮したstatic square class
7. fixed quadrant parity
8. マス番号

最終キーにマス番号を必ず入れ、同点時の順序を明示的に決定する。

既存の連結領域flood fillは、fixed quadrant parityとの比較後に廃止候補とする。Edax式の固定4象限は盤面更新ごとに1bitをXORするだけで増分管理できる。T052の実測から、パリティをmobilityより上位へ置くことは推奨しない。

### 3.4 ETC

親局面の候補手を実探索する前に、子局面のExact TTをprobeする。

親が `score >= beta` を証明したい場合、子手番の値について以下が成立すれば安全にcutoffできる。

- 子のExact値が `<= -beta`
- または子のUpper boundが `<= -beta`
- エントリ深さが子局面の空き数以上

Lower boundをこの向きのcutoffに使用してはならない。符号とbound種別の取り違えが最大のリスクである。

すべての子をprobeするコストもあるため、複数合法手があり、空き数が一定以上のdeep endgameだけで有効化する。採用条件はノード減だけでなく壁時計非悪化も含める。

### 3.5 安定石カット

第一段階では既存 `eval::stable_count` と同等の「隅から連続する辺安定石」だけを使う。これは保守的で、安定でない石を安定と誤判定する可能性が低い。

手番側安定石数を `S_self`、相手側を `S_opp` とすると、最終石差の安全な範囲は次になる。

- 下限: `2 * S_self - 64`
- 上限: `64 - 2 * S_opp`

したがって、

- `upper <= alpha` ならfail-low
- `lower >= beta` ならfail-high
- それ以外でも `alpha=max(alpha, lower)`、`beta=min(beta, upper)` と窓を狭められる

返した値は真値そのものではなくboundでよいが、TTへ格納するbound種別を一致させる必要がある。

盤内まで広げた完全安定石判定は別タスクにする。安定でない石を1個でも安定と誤認すると正解値を壊すため、最初から複雑な判定を導入しない。

### 3.6 空き1～4専用ソルバー

`solve_1`～`solve_4` は、一般の `Board::legal_moves`、`Vec`、TT、Zobrist hashを通さず、空きマス座標とplayer/opponent bitboardを直接受け取る。

特に `solve_1` は、

- 最後のマスに手番側が置ける場合
- 手番側は置けず、相手が置ける場合
- 双方置けず空きが残ったまま終局する場合

を明示的に処理する。

`solve_2`～`solve_4` はパスを含むため、単に合法手を順番に打つ実装では不十分である。すべてのパス組合せを既存naive solverと照合する。

ノード予算の意味を保つため、専用関数内でも「論理的に訪問した局面」ごとに共通カウンタを増やし、同じ地点でabort判定する。専用化によってカウンタを丸ごと省略すると、160kの意味が施策前後で大きく変わる。

### 3.7 状態とhashの増分管理

deep/shallow共通の内部状態として、概ね次を持つ。

```text
EndgamePosition
  player: u64
  opponent: u64
  empties: u64
  quadrant_parity: u8
  hash: u64
```

公開APIでは従来どおり `Board` と `Side` を受け取り、入口でside-relative表現へ変換する。

各着手で、

- `empties &= !mv`
- `quadrant_parity ^= QUADRANT_ID[mv]`
- flip maskからplayer/opponentを更新
- Zobrist hashを着手・flip・手番交代分だけ更新

する。

C版Edaxと同じ連結リストをそのまま持ち込むことは推奨しない。Rustでは再帰中のremove/restoreと借用管理が複雑になり、ビットマスク列挙との差が小さい可能性がある。まず `empties: u64` とfixed parityを採用し、空きマス列挙がprofile上の上位に残った場合だけdoubly-linked listを追加する。

### 3.8 flip高速化とSIMD

`bitboard.rs` には次の低リスクAPIを追加する。

- `flips_for_move(player, opponent, mv) -> u64`
- `apply_move_with_flips(...)`
- 終盤側で計算済みflipを再利用

その後、関数ポインタ配列を使う方向ループと、インライン化しやすいscalar実装を比較する。

AVX/BMI固有実装は本番WASMへ効かないため採用しない。wasm SIMD128も初期採用しない。64bit bitboardの単純方向処理ではscalarの方が有利な可能性があり、ブラウザ互換性・ビルド設定・決定性検証のコストがある。scalar hot path改善後もWASM NPSが目標未達なら、compile-time feature付きの独立実験として扱う。

### 3.9 Exact TTの改善

NWS導入後、同一局面のLower/Upper上書き率をテレメトリで測る。高い場合のみ、次を実験する。

- 同一局面・同一深さのLowerとUpperをマージ
- LowerがUpperへ到達したらExact化
- 可能なら16-byte entry、32-byte bucketを維持
- 深さ、区間幅、best move有無を品質順序に含める
- T086の深いExact保護を維持

エントリ拡大でTT件数を減らす案は、64MiB固定環境では逆効果になりうる。バケットサイズを維持できない場合は、ノード数で明確な改善が出るまで採用しない。

---

## 4. 定量的な受け入れ基準

### 4.1 ベンチコーパス

#### C1: FFO #40～49

- full-window完全読み
- 既知正解値との一致
- 問題ごとにフレッシュな64MiB TT
- #40～46を空き20～24の主性能群
- #47～49を空き25～26のストレッチ群

FFOだけで排序係数を調整してはならない。FFOは正しさと公開比較用に使う。

#### C2: T096独立60局面

`t096_oracle_positions.json` の空き18～26、60局面を終盤ソルバー用に再利用する。Edax level 60、book off、single taskでルートの正確な石差を一度生成し、manifestへ固定する。

既知値を `S` として、各局面で次の証明窓を測る。

- fail-high証明: `[S-1, S]`
- fail-low証明: `[S, S+1]`
- full-window: `[-64, 64]`

これにより、現在の曖昧な `exact.completed` に依存せず、上下両方の証明が予算内に入ったかを判定できる。

#### C3: T085b 48局面

実際の `eval_cli best --max-nodes 160000 --time-ms 1500` 経路を測る。

- oracle regret
- 到達深度
- exact試行数
- exact bound証明完走数
- quota abort
- global abort
- wall保険
- 2回実行の決定性

校正時はTTを本番WASMと同じ64MiBに統一する。

### 4.2 E50の定義

「何空きまで解けるか」を次で定量化する。

- `E50_bound(B)`: 予算Bで、標準証明窓の少なくとも一方向が50%以上完走する最大空き数
- `E50_exact(B)`: 上下両証明の合計が予算B以内に収まり、真値を確定できる局面が50%以上となる最大空き数

最終目標は次とする。

- `E50_exact(160k) >= 23`
- `E50_bound(64k) >= 22`
- T098で測る現行baselineから少なくとも3空き改善
- ストレッチ: `E50_exact(160k) >= 24`

64kは現行40% quotaの実効的な上限に近い比較点である。実際にはbaseline消費後の残予算へ40%を掛けるため、最終校正では固定64kだけでなく実経路も評価する。

### 4.3 Edaxとの壁時計比較

同一マシン、単一スレッド、book off、同一TT容量、専有状態で測る。

- プロセス起動時間を除外できるbatch実行
- 1回warmup後、最低3回
- 実行順を交互にする
- 各局面の中央値を採用
- 比率は幾何平均とp90を併記

判定は次の三段階とする。

| 段階 | 空き20～24 幾何平均 | p90 | 呼称 |
|---|---:|---:|---|
| 最低採用線 | Edaxの5倍以内 | 8倍以内 | 実用同等帯 |
| 目標 | 3倍以内 | 5倍以内 | Edax近接 |
| ストレッチ | 2倍以内 | 3倍以内 | Edax同等 |

エンジン間でノード定義が異なるため、「Edaxのノード数の何倍以内」は主判定にしない。自作エンジン内の施策前後ノード数比較には使える。

### 4.4 ノード数とNPS

シリーズ全体の目標:

- C2証明窓の中央値ノード数をbaseline比20分の1以下
- p90をbaseline比10分の1以下
- scalar hot path施策で、同一ノード列のNPSをnative/WASMとも1.5倍以上
- ただしNPS改善だけではシリーズ完了としない

### 4.5 実対局への波及

T084の最大弱点が空き19～24で平均約5.86石の損失だったことから、exact境界が実効2～3手上がれば、60局平均石差で2～4石程度の改善が現実的な期待値である。

最終確認ではT089a後の約-25.6石に対して、

- 期待目標: -23.5石以上
- 最低条件: 平均石差が1石以上悪化しない
- exact帯のpaired oracle regretが悪化しない

とする。ただし60局対戦は分散が大きく、ソルバー単体の採否はC1～C3を主判定にする。終盤強化だけでEdax level 10への勝率50%到達は期待しない。

---

## 5. 実装タスク分割案

### T098: 終盤ベンチ契約とbaseline固定

変更対象:

- `engine/src/bin/eval_cli.rs`
- `bench/edax-compare/endgame_bench.py` 新規
- `bench/edax-compare/endgame_positions.json` 新規
- 必要に応じて `engine/tests/ffo_bench.rs`

内容:

- full-window、任意窓、node limit、TT容量を指定できる終盤CLI
- C1/C2/C3のcheckpoint付き実行
- Edax batch測定
- solver/node-definition versionを出力
- `exact.completed` をroot exactと誤認しない新テレメトリ

受け入れ基準:

- FFO #40～44の既存ノード数・値を再現
- C2のEdax真値を生成し、全局面で符号規約を検証
- 1局面単位でatomic checkpoint、resume可能
- 同一条件2回でscore/nodes/boundが一致

依存: なし。

主リスク: Edax出力の手番符号、プロセス起動時間混入、長時間ベンチのデータ消失。

### T099: 候補生成の一回化とTT move排序

変更対象:

- `engine/src/endgame.rs`

内容:

- `MoveInfo`を導入
- 子盤面とmobilityを1回だけ計算
- TT moveを先頭へ
- ヒープ依存を固定長配列またはsmall stack bufferへ変更
- マス番号による決定的タイブレーク

受け入れ基準:

- FFO fast全問正解
- naive differential全一致
- C2証明窓の合計ノード数10%以上削減、またはノード同等で壁時計10%以上改善
- fresh TTでnodesまで決定的

依存: T098。

主リスク: TT moveが非合法・古い場合の扱い、同点best moveの変化。

### T100: fixed quadrant parityと終盤排序の調整

変更対象:

- `engine/src/endgame.rs`

内容:

- fixed quadrant parityを増分管理
- corner、mobility、square class、parityの排序
- 既存連結領域flood fillとのA/B比較
- T085群で調整し、T096群を検証用に保持

受け入れ基準:

- C2検証側でノード中央値15%以上削減
- p90ノードが20%以上悪化しない
- FFOを含め正解値不変
- 調整係数・閾値を壁時計依存にしない

依存: T099。

主リスク: FFOへの過学習、パリティとTT moveの優先順位競合。

### T101: 終盤Exact ETC

変更対象:

- `engine/src/endgame.rs`

内容:

- 子Exact TTのUpper/Exact boundによる安全なcutoff
- 空き数・合法手数による適用閾値
- ETC on/offテスト入口

受け入れ基準:

- on/offでscore完全一致
- ランダム小空き局面とFFOで一致
- C2合計ノード5%以上削減
- 壁時計2%以上悪化する場合は既定無効

依存: T099。T100とは順序入替可だが、計測を分離するためT100後を推奨。

主リスク: negamax符号、Upper/Lower取り違え、深さ不足エントリの使用。

### T102: 保守的な辺安定石カット

変更対象:

- `engine/src/endgame.rs`
- 必要なら `engine/src/eval.rs` のmask公開範囲のみ

内容:

- 辺安定石による上下界計算
- fail-low/fail-high cutoff
- 窓の安全な狭窄
- 適用閾値の固定

受け入れ基準:

- 安定石判定のfalse positive検査
- 空き8以下の到達可能局面で全継続を列挙し、安定判定石が反転しないことを確認
- 狭窓/full-window双方でnaive solverと一致
- C2ノード5%以上削減、壁時計非悪化
- 効果がない場合は既定無効のまま残さない

依存: T098。T101後を推奨。

主リスク: 安定石誤判定、上下界式の手番反転、bound種別誤格納。

### T103: NWS中心の終盤PVS

変更対象:

- `engine/src/endgame.rs`

内容:

- `nws_endgame` とfull-window PVSを分離
- 兄弟手をnull windowで探索
- fail時のみ再探索
- abort、pass、TT、安定石カットを共通contextへ統合

受け入れ基準:

- 既存公開APIの戻り値・abort契約維持
- full-window、fail-low、fail-highをnaive solverと比較
- quota abort後にExact TT汚染なし
- C2証明窓ノード25%以上削減
- FFO fast全問正解

依存: T099～T102。

主リスク: 再探索条件、`alpha_orig`管理、abortされた第一探索の値を再利用するバグ。

### T104: 空き1～4専用ソルバーとshallow層

変更対象:

- `engine/src/endgame.rs`
- `engine/src/bitboard.rs`

内容:

- `count_last_flip`相当
- `solve_1`～`solve_4`
- 軽量shallow NWS
- 浅層ではTT/hash/sortを省略
- 論理ノードカウントとabortチェック

受け入れ基準:

- 空き1～4の合法・パス・早期終局を網羅
- 全到達可能小空き局面でgeneric solverと一致
- node limitが専用層内部でも厳守される
- C2同一探索木相当でNPS1.3倍以上
- FFO正解値不変

依存: T103。

主リスク: パス、残り空き総取り規約、ノード数を過少計上してquotaを実質緩和すること。

### T105: 増分hash・flip再利用・状態圧縮

変更対象:

- `engine/src/endgame.rs`
- `engine/src/bitboard.rs`
- `engine/src/zobrist.rs`

内容:

- side-relative `EndgamePosition`
- empties/parity/hashの増分更新
- flip maskの一回計算
- full hashとのdebug照合
- scalar方向処理のinline化比較

受け入れ基準:

- 各着手・パス後の増分hashがfull再計算と一致
- bitboard naive reference全一致
- ノード数と探索順序は意図的変更がない限り完全一致
- native/WASMのNPS1.5倍、または壁時計30%以上短縮
- WASM build/test成功

依存: T104。

主リスク: flip石のhash色切替、パス時のside key、黒白絶対表現とrelative表現の混同。

### T106: Exact TT上下限同時保持実験

変更対象:

- `engine/src/tt.rs`
- `engine/src/endgame.rs`

内容:

- NWSで同一局面のLower/Upperをマージ
- 区間収束時のExact化
- T086品質順序の維持
- 可能なら16-byte entry/32-byte bucket維持

受け入れ基準:

- T086全テスト維持
- collision stress、異種domain、異深度区間マージの追加テスト
- C2ノード10%以上削減かつ壁時計5%以上改善
- TT容量減少を含めた64MiB条件で比較
- 閾値未達なら不採用

依存: T103。T105との順序は入替可。

主リスク: 相容れない深度のboundマージ、区間逆転、バケット拡大によるTT実容量低下。

### T107: exactポリシー再校正

変更対象:

- `engine/src/search.rs`
- `engine/src/bin/eval_cli.rs`
- `bench/edax-compare/vs_edax.py` または専用校正スクリプト
- `app/src/app.tsx`
- `app/src/app.test.ts`
- 関連protocol/searchテスト

内容:

- `estimated_min_exact_nodes` を新ソルバーで再生成
- quota候補25/40/50/60/75%
- `exact_from_empties`候補16/18/20/22/24
- 160k + wall 1500ms、TT 64MiBで共同校正
- policy version更新
- root exact、bound proof、leaf completionを分離したテレメトリ
- 本番強CPU閾値を採用値へ更新

選定優先順位:

1. static-onlyゼロ
2. 決定性100%
3. wall保険5%以下
4. oracle regret最小
5. root/selected-line証明数
6. 平均到達深度
7. 消費ノード

受け入れ基準:

- 平均oracle regretが現行1.604石以下
- 目標1.25石以下
- wall保険5%以下
- `E50_exact(160k) >= 23`
- 同一入力2回でmove/score/depth/nodes一致
- app・protocolテスト成功

依存: T099～T106の採用施策完了後。途中で実施してはならない。

主リスク: quotaと閾値の共同最適化による過学習、exactへ予算を寄せすぎて中盤反復深化が浅くなること。

### T108: WASM・FFO heavy・対Edax最終ゲート

変更対象:

- 原則ベンチ成果物のみ
- 必要なら解析キャッシュのengine version
- `bench/edax-compare/` の結果・レポート

内容:

- FFO #40～49
- C2 Edax速度比
- WASMブラウザ実測
- node-budget決定性
- 60局 vs Edax level 10
- 1局単位checkpoint/resume

受け入れ基準:

- FFO #40～49全問正解
- 空き20～24でEdax幾何平均5倍以内・p90 8倍以内
- stretch判定も併記
- 60局平均石差が1石以上悪化しない
- wall保険5%以下
- WASM同一入力の結果完全一致

依存: T107。

主リスク: 専有状態でない時間測定、旧バイナリ・旧重み・異なるTT容量の混入。

---

## 6. 検討した代替案と却下理由

### SIMD/AVXを最優先する案

却下する。AVX/BMIは本番WASMへ効かず、SIMD128も主にNPS改善である。160k固定経路のexact到達範囲を広げるには、まずノード数を減らす必要がある。

### wasm SIMD128を既定有効にする案

現段階では却下する。scalar改善後のprofileなしでは効果が不明であり、ビルド設定・ブラウザ互換性・フォールバック経路が増える。独立実験としては許容する。

### MPCを終盤へ導入する案

却下する。完全読みの絶対要件と矛盾する。MPCは統計的な選択的探索であり、FFO真値不変を保証できない。

### fixed-depth selective searchでEdaxへ近づける案

却下する。今回の目的はexactの開始を早めることであり、近似値をexactとして扱うことはできない。

### いきなりEdaxの全構造を移植する案

却下する。Cのmutable board、linked empties、複数のCPU固有flip実装を同時に移植すると、正解値・abort・node budgetのどこが壊れたか分離できない。

### 空きリストを最初から連結リスト化する案

保留する。Rustではremove/restoreの複雑性が高く、`u64 empties`列挙で十分速い可能性がある。profileで空き列挙が支配的と確認された場合のみ追加する。

### 連結領域パリティをそのまま強化する案

主案にはしない。T052でmobilityより上へ置くと悪化しており、毎ノードflood fillのコストもある。固定4象限の増分パリティと比較し、勝った側を採用する。

### full stabilityを最初から導入する案

却下する。誤った安定石判定は即座に誤答を生む。まず辺安定石だけで安全性と効果を確認し、盤内安定石は独立タスクにする。

### MTD(f)・SSS*系を主探索にする案

現時点では却下する。良い初期推定値と上下限を保持できるTTが必要で、現行TTは単一boundである。PVS/NWSの方が実装・検証範囲が小さい。区間TT完成後も、PVSに対する明確な優位が計測できる場合だけ再検討する。

### TT容量を増やす案

主施策にはしない。本番WASMは64MiBであり、メモリ増加はPWA環境の制約を受ける。まず64MiB固定でアルゴリズムを改善する。

### FFO #40～59を必須にする案

初期受け入れ基準にはしない。現在のcommit済み正解manifestは#40～49であり、#50以降はさらに重くなる可能性がある。#40～49とT096独立60局面で十分な検証ができる。#50～59はストレッチ回帰群として後から追加する。

---

## 7. リスク横断表

| リスク | 防止策 |
|---|---|
| 安定石のfalse positive | 辺安定から開始、全継続列挙による反転不能テスト |
| Lower/Upperの符号ミス | ETC・安定石・TTごとにfail-low/highの独立テスト |
| PVS再探索漏れ | full αβとのランダム差分テスト |
| abort後のTT汚染 | quota直前で停止させ、対象hashが未格納であることを確認 |
| 専用solve_1～4のパス誤り | 空き1～4の到達可能局面をgeneric solverと総当たり比較 |
| node budgetの意味変更 | 専用層でも論理ノードを数え、node definition versionを固定 |
| TT moveによる非決定性 | 最終タイブレークをマス番号で固定 |
| パリティとTT moveの競合 | TT moveを常に上位、parityはmobilityより下位から開始 |
| 増分hash誤り | 毎手full hashとのdebug assertion、パスも検査 |
| nativeだけ高速化 | 各hot pathタスクでnativeとWASMを別々に計測 |
| ベンチ過学習 | T085群で調整、T096群で検証、FFOは正解確認中心 |
| 時間計測汚染 | 専有状態、warmup、交互順、中央値、provenance保存 |
| policy再校正が早すぎる | すべてのsolver施策後にT107を一度だけ実施 |
| 既存quota-abort契約破壊 | `AbortReason`、親窓、Exact/Midgame domainの既存回帰を維持 |

---

## 8. 未確定事項・オーケストレーターへの確認事項

1. 依頼文の「exact quota 60%」は現行実装と一致しない。現行は40%である。T107では40%を現行baselineとして25/40/50/60/75%を再比較する前提でよいか確認が必要である。

2. 本番強CPUの `exactFromEmpties` は現在16、T085b校正は18である。ソルバー強化後は20～24への引き上げを候補に含めるべきだが、解析・練習・詰めオセロの時間無制限exact設定とは別々に扱う方針でよいか確認したい。

3. 「Edax同等」の正式合格線を、厳密な2倍以内とするか、現実的な第一段階である5倍以内をシリーズ完了条件とするか、ユーザー裁定が必要である。本レポートでは5倍以内を実用同等帯、2倍以内を真のEdax同等と定義した。

4. FFO #50～59をcommit済み回帰資産へ追加するか。今回の主対象である空き20～24には#40～46で足りるため、初期シリーズでは#40～49までを推奨する。

5. node counterは専用solve層でも論理局面単位を維持する案を推奨する。もし「高速な専用処理は1ノード扱いでよい」とするなら160k予算の意味が大きく変わり、T085bとの比較が不能になるため、明示的な裁定が必要である。

6. 対Edax速度比較は同一マシン・単一スレッドでも、Edax側がCPU固有命令を使う可能性がある。本番WASM目標とは別に、native対EdaxとWASM実用時間の二軸で判定する方針を推奨する。

7. T106のExact TT区間化は、NWS導入後の上書き率とA/B結果を採用条件とする。先に必須実装とはしない方針でよいか確認したい。

8. 60局対戦は確認指標とし、ソルバー単体の採否を左右する主ゲートにはしないことを推奨する。終盤の正確性・証明ノード・oracle regretが改善しても、60局平均石差は中盤評価や定石の影響を強く受けるためである。