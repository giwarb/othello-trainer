# T156: MPC（Multi-ProbCut）のv4評価関数での再校正と再有効化 — 設計レポート

## 1. 結論

推奨方針は、現行のσテーブルだけをv4向けに差し替えるのではなく、次の順でMPCを作り直すことである。

1. 現行MPCのカット境界式を修正する。
2. 固定`REDUCTION=2`を廃止し、目的深さ`D`とプローブ深さ`d`のペア表にする。
3. v4×WTHOR局面から、空きマス帯別に回帰係数・残差σを再計測する。
4. MPCをコンパイル時featureだけでなく、探索経路別に切り替えられる実行時ポリシーにする。
5. 最初の本番候補では、ノード予算CPU経路を「history + MPC、aspirationなし」とし、`analyzeAll`ではMPCを無効のままにする。
6. 固定深さノード数、160kノード到達深さ、oracle regret、決定性の軽量ゲートを通過した場合だけ、最後に60局対局ゲートへ進む。

最重要点として、現行実装には「σが古い」こととは別に、MPCの境界式そのものに問題がある。`engine/src/search.rs::mpc_try_cutoff_inner`は、fail-high側を`beta - margin`、fail-low側を`alpha + margin`でプローブしている。しかし通常のMPCでは、安全側の判定はそれぞれ概ね`beta + margin`、`alpha - margin`でなければならない。

この符号問題と、直後の`bound > alpha`／`bound < beta`ガードの組み合わせにより、PVS/NWSの主要部分である1 centi-disc幅のnull windowでは、正のmarginを持つMPCプローブがほぼ必ず抑止される。一方、広い有限窓で発動した場合は、本来より内側の閾値で過度にカットする。この状態では、v4向けσだけを測り直してもMPCの有効性を正しく評価できない。

したがって、T156は「再校正タスク」ではあるが、σ測定前にカット式と適用条件を正すことが必須である。

---

## 2. 調査結果

### 2.1 旧校正結果の事実関係

MPCの本来の記録は`tasks/T048-search-mpc.md`にある。依頼文で参照されたT052は終盤パリティ着手順序付けのタスクであり、MPC校正の直接資料ではない。

T048で確認できる事実は次のとおりである。

- 校正局面:
  - `eval_cli gen`
  - ランダム自己対戦
  - 空き22〜50
  - 150局面
  - depth 11/12のみ60局面
- 評価関数:
  - pattern v2
- 比較:
  - 深さ`D`と`D-2`
  - full-window
  - `exact_from_empties=0`
- 実測σ:
  - depth 5〜12で約352〜663 centi-disc
- 初回自己対戦:
  - MPC側7勝17敗
  - 平均石差-13.5
- 重大バグ修正後:
  - 48局合計22勝23敗3分
  - 平均石差-3.13
- 修正後の速度:
  - depth 9でノード数+3.6%
  - depth 11でノード数+13.3%
  - 3秒制限で平均到達深さ11.28対11.32
- `REDUCTION=4`や片側カットも試したが改善なし。

したがって「24局7勝17敗」は現行MPCパラメータの純粋な棋力評価として使うべき数字ではない。これはPV系ノードで番兵窓をそのまま返す重大バグを含む結果である。修正後は明確な棋力崩壊は解消したが、探索効率は依然として悪化していた、という二段階で理解すべきである。

### 2.2 旧校正が失敗した原因

原因は一つではなく、以下の複合と考える。

#### 原因A: 初期実装のPVノード誤カット

T048で特定・修正済みである。

`alpha == -INF`または`beta == INF`の状態でもMPCを試し、実際の子を一つも探索しないまま、祖先の窓境界を連続して返していた。7勝17敗の主因はこれである。

現行の番兵値ガードは維持すべきである。

#### 原因B: 現行カット境界の符号が逆

深い探索値を`y`、浅い探索値を`x`とし、単純化して

```text
y = x + e,  eの標準偏差 = σ
```

とする。

fail-highを安全側に判定するには、

```text
x - tσ >= beta
```

すなわち浅い探索で概ね`beta + tσ`を超える必要がある。

fail-lowでは、

```text
x + tσ <= alpha
```

すなわち浅い探索が概ね`alpha - tσ`以下である必要がある。

しかし現行コードは次の方向である。

```text
fail-high probe: beta - margin
fail-low probe : alpha + margin
```

これはマージンを外側ではなく内側に取っている。

さらに、現行コードはプローブ境界が元の`[alpha,beta)`内にある場合だけプローブする。NWSの`beta=alpha+1`に対しmarginは数百centi-discなので、両方向とも条件を満たさず、探索木の大半でMPCが不発になる。

これは「大きなσのため発動箇所が少ない」というT048の観測を説明するが、単なる評価関数ノイズだけではなく、境界式とガードの組み合わせによる構造的な不発である。

#### 原因C: `D-2`プローブが高価すぎる

目的深さ`D`に対しプローブが`D-2`固定である。深さ9に対する深さ7、深さ11に対する深さ9の探索は、カットに失敗したときの捨てコストとして重い。

T048のdepth 11で+13.3%という悪化は、少数の高価なプローブだけでも説明可能である。

Egaroucid型の`(d,D)`ペア表を採用し、各目的深さに対して「相関」と「プローブコスト」のPareto最適点を選ぶべきである。`D-2`や`D-4`を先に固定してはいけない。

#### 原因D: 校正モデルが平均差を捨てている

旧ツールは`deep - shallow`の平均とσを出力しているが、実装に入るのはσだけである。実測平均は深さごとに約-39〜+30 centi-discあり、完全なゼロではない。

より一般には、

```text
deep = a * shallow + b + residual
```

を校正し、傾き`a`、切片`b`、残差σを使うべきである。少なくとも平均バイアスを無視すべきではない。

#### 原因E: 空きマス22〜50を一括した

旧評価関数v2でもステージ別評価だったが、σは空きマス数を無視して深さだけで集計された。v4は空きマス1個ごとに評価テーブルが変わる61段構成なので、空きマス依存性はさらに無視しにくい。

ただし61ステージ×深さペアの表を直接作ると疎になる。まず空きマス帯別に測り、隣接帯で残差分布が同等なら結合する設計が適切である。

#### 原因F: ランダム自己対戦局面が本番分布と異なる

旧データは合法手を一様ランダムに選んだ自己対戦である。これはWTHOR棋譜や本番CPUが到達する局面と、形・モビリティ・手の難しさが異なる。

また、校正に使った集合の先頭40件を速度ベンチにも再利用している。結果は負だったため楽観バイアスが問題化しなかったが、再試験では校正・選定・最終評価をゲーム単位で分離すべきである。

#### 原因G: 校正経路と本番経路が一致していない

`calibrate_mpc bench`は`search_with_eval`を使うため、現行本番のノード予算経路で有効なhistory・aspiration・exact quotaを通らない。

特に現行MPCプローブは`ctx.suppress_mpc`しか変更しないため、プローブ中に`exact_from_empties`境界へ到達するとexact探索を起動し、ノード予算経路ではexact quotaを消費しうる。これは次の問題を起こす。

- shallow probeが高価なexact探索へ化ける
- 本探索より先にexact quotaを消費する
- exact試行回数や完走する子の集合が変わる
- T048の`exact_from_empties=0`校正では再現されない。

初期再有効化では、MPCを純中盤に限定し、

```text
empties > exact_from_empties + D
```

を適用条件にすることを推奨する。これにより目的深さ`D`の探索範囲がexact境界へ到達しないことを保証できる。終盤向けProbCutは、最終石差との別校正が必要な別施策とする。

---

# (a) 推奨する設計と理由

## 3. 校正モデル

### 3.1 テーブル構造

単一の`REDUCTION`と深さ別σではなく、次のキーを持つ表にする。

```text
(empty_bucket, target_depth D, probe_depth d)
    -> slope a
    -> intercept b
    -> residual_sigma
    -> high_margin
    -> low_margin
    -> sample_count
```

実行時浮動小数演算によるnative/WASM差を避けるため、`a`と`b`はQ16等の固定小数点整数に変換して埋め込む。境界計算には方向別に明示的なceil/floorを使う。

近似式を

```text
deep = a * shallow + b + residual
```

とした場合、概念上のプローブ閾値は次のとおりである。

```text
fail-high:
    a * shallow + b - margin_high >= beta

fail-low:
    a * shallow + b + margin_low <= alpha
```

`a > 0`を確認したうえで、浅い探索側の閾値へ変換する。

残差分布が非対称なら、単一σだけでなく正負方向を別にする。最初は`t=1.5`を基準とし、1.5、1.75、2.0を校正用候補にする。最終選定はσの小ささではなく、未使用データ上の誤カット率と実探索のノード収支で決める。

### 3.2 `(d,D)`候補

目的深さ`D=5..12`に対して、固定差分ではなく次を候補にする。

```text
1 <= d <= D-3
```

同一局面で深さ1〜12の値とノード数を一度ずつ測れば、後処理で全ペアを評価できる。

候補は次の順で絞る。

1. 残差σが小さい。
2. shallow探索ノード数がdeep探索の20%以下。
3. held-outデータの一方向誤カット率が許容内。
4. 実際のMPC探索でプローブコスト込みの総ノード数が減る。

`D-2`は比較対象には残すが、初期値として優先しない。

## 4. 校正局面

### 4.1 対象範囲

本番の空き20以下無制限exactと重ならない純中盤を主対象とする。

| 空きマス帯 | おおよその着手数 | 位置づけ |
|---|---:|---|
| 45〜52 | 8〜15手後 | 序盤後半 |
| 37〜44 | 16〜23手後 | 中盤前半 |
| 29〜36 | 24〜31手後 | 中盤 |
| 21〜28 | 32〜39手後 | 終盤接続前 |

plyそのものはパスでずれるため、校正キーには空きマス数を使う。

空き53〜60は定石ブックの影響が強く、CPU強化への寄与が小さいため主校正から外す。ただし`analyzeAll`等での利用可能性を見る補助サンプルとして少数を残してよい。

### 4.2 抽出方法

- WTHOR実戦棋譜から抽出する。
- 各空きマス帯を同数に層化する。
- 同一対局から大量の隣接局面を取らず、原則1帯1局面以下とする。
- calibration/tuning/testはゲームID単位で60%/20%/20%に分ける。
- 分割・抽出は固定seedまたは局面ハッシュ順で決定的に行う。
- WTHORファイルのSHA-256、抽出seed、対象年、件数、出力SHA-256をmanifestへ記録する。
- 完全に同一の盤面+手番は重複排除する。
- v4評価はD4非不変性がT145で確認されているため、対称変換した盤面を同一サンプルとして潰さない。
- D4拡張を診断用に行う場合は、元局面と全対称形を同じgame groupへ置き、独立サンプルとして信頼区間を水増ししない。

### 4.3 サンプル数

ユーザー方針に合わせて二段階にする。

#### 軽量pilot

- 合計320局面
- 各空き帯80局面
- 深さ1〜10を測定
- まず`D=6,8,10`を中心に判定
- 目的:
  - v4で残差が旧v2より小さいか
  - 安価な`(d,D)`候補が存在するか
  - 正しい境界式で実際にプローブが発動するか
  - 総ノード減少の兆候があるか。

pilotで有望性がなければ、深さ12・大規模校正へ進まない。

#### 確認校正

- 合計1,200局面
- 各空き帯300局面
- 60/20/20をゲーム単位で分割
- 深さ1〜12
- 各帯・各選定ペアについて、fit約180、tuning約60、最終test約60を確保
- 信頼区間は局面単位ではなくゲーム単位bootstrapで計算する。

10分を超える可能性が高いため、局面×深さ単位で結果をアトミック保存し、同一条件でresumeできるようにする。少なくとも1局面完了ごとに進捗を出す。

## 5. 探索への組み込み

### 5.1 経路別ポリシー

feature flagだけでビルド全体を一括ON/OFFする設計は廃止し、内部探索ポリシーを導入する。

概念上は次の3フラグを分離する。

```text
enable_history
enable_aspiration
enable_mpc
```

比較用に同一バイナリ内で切り替えられるようにする。同一バイナリで比較すれば、コンパイル差やバイナリ配置差による壁時計ノイズも減らせる。

初期ポリシーは次を推奨する。

| 経路 | history | aspiration | MPC |
|---|---:|---:|---:|
| CPU強・160kノード | ON | OFF候補 | ON候補 |
| fixed-depth校正 | OFF | OFF | 切替可能 |
| `analyzeAll`表示 | OFF | OFF | OFF |
| 空き20以下無制限exact | 非該当 | 非該当 | OFF |
| 終盤ソルバー | 非該当 | 非該当 | OFF |

`analyzeAll`はT139で手ごとに独立TTとなっているが、表示値では近似カットによる速度より説明可能性・安定性を優先する。CPU側で採用しても、別ゲートを通すまでは`analyzeAll`で有効化しない。

### 5.2 aspirationとの整合

MPCは近似枝刈りなので、MPC有効時に「MPC無効full-windowと完全一致」を保証することは原理的にできない。

さらにaspirationの狭窓では、full-window時と異なるMPCカットが発生し、fail後のTT boundにも近似結果の影響が伝播する。`mpc_try_cutoff`自身がTTへ格納しなくても、MPC戻り値を受けた祖先がLower/Upper/Exact boundを格納しうるため、「MPCノードを直接storeしないからTTは厳密」という説明は成立しない。

最初の再有効化ではaspirationとMPCを排他的に比較する。

比較構成は次の4つとする。

| 構成 | history | aspiration | MPC |
|---|---:|---:|---:|
| A: 現本番baseline | ON | ON | OFF |
| B: MPC候補 | ON | OFF | ON |
| C: 併用診断 | ON | ON | ON |
| D: 下限比較 | ON | OFF | OFF |

本番候補は原則AまたはBから選ぶ。Cは決定性・regretを測る診断対象にはしてよいが、T089aのfull-window一致保証を維持する設計としては採用しない。

既存記録ではaspiration単独のノード削減は約0.92%、historyとの合算でも約5.38%だった。したがってMPCが正しく再校正され、BがAより明確に良ければMPCを優先する余地が大きい。ただし判断はv4・160k条件で再計測する。

### 5.3 exact quotaとの隔離

初期版では以下を必須ガードとする。

```text
empties > exact_from_empties + target_depth
```

加えて、MPCプローブ中は`exact_enabled=false`にして、浅い探索がexact quotaやExact TT domainへ入らないようにする。設定はプローブ終了時・ノード上限到達時・壁時計中断時の全経路で必ず復元する。

これにより、

- MPC probe nodesも全体160kへ算入
- exact quotaは本探索だけが消費
- 校正値と実装の探索方式が一致
- 空き20以下無制限exactへ影響しない

という境界を作れる。

将来、終盤接続近傍でもMPCを使う場合は、「深い中盤探索値対浅い探索値」ではなく、「最終石差またはexact bound対浅い探索値」の別校正として扱う。

### 5.4 決定性

MPC自体は乱数を使わず、次の条件を守ればノード予算上の反復決定性を維持できる。

- パラメータは固定整数テーブル。
- runtimeで浮動小数回帰をしない。
- プローブノードも通常ノードと同じカウンタへ加算。
- TTサイズ・ハッシュ・置換規則・着手順を固定。
- node-budget開始時のTTクリアを維持。
- exact quotaとMPC probeを分離。
- `suppress_mpc`、`exact_enabled`等を全return経路で復元。
- 同点時のマス番号等、最終タイブレークを固定。

ただし`time_ms`が結果決定に実際に使われる場合、厳密な「同一入力→同一出力」は保証できない。壁時計が異なるイテレーションで発火しうるためである。

決定性を最優先するなら、160k本番経路では次の契約を推奨する。

- 通常の手選択は`maxNodes=160000`だけで決める。
- 壁時計は異常時のwatchdogとし、発火した部分探索結果を通常結果として採用・キャッシュしない。
- watchdog発火時は、より小さい固定ノード予算で再探索するか、明示的な決定的フォールバックを使う。
- 軽量ゲートでは`time_ms=None`で決定性を検証する。
- 本番相当の`time_ms=1500`試験では`wallLimitHit=0`を必須とする。

MPC有効と無効で着手が変わることは近似探索の仕様上ありうるが、MPC有効構成を同じ入力で繰り返したときに変わることは許容しない。

## 6. テレメトリ

少なくとも比較CLIへ次を追加する。

```text
mpcEligibleNodes
mpcProbeAttemptsHigh
mpcProbeAttemptsLow
mpcProbeNodes
mpcCutsHigh
mpcCutsLow
mpcSkippedPvWindow
mpcSkippedExactBoundary
mpcSkippedUncalibrated
mpcCutDepthHistogram
mpcProbeDepthHistogram
```

「MPC有効時の総ノード数」だけでは、プローブが不発なのか、高価すぎるのか、誤カットで木が変形したのかを区別できない。

`calibrate_mpc bench`には以下も必要である。

- `--max-nodes`
- `--exact-from-empties`
- `--exact-quota-percent`
- `--mpc on|off`
- `--aspiration on|off`
- `--history on|off`
- best move、score、depth、nodes、exact統計、aspiration統計、MPC統計の局面別JSON
- 局面ごとのcheckpoint/resume。

---

## 7. 段階的な採否ゲート

### Gate 0: 実装健全性

必須条件:

- 正しい外向きmargin式の単体テスト。
- fail-high/fail-low両方向の境界直前・直後テスト。
- NWS幅1でも外側のプローブ窓を構築できること。
- PV番兵窓では不発。
- exact境界を跨ぐノードでは不発。
- MPCプローブがexact quotaを消費しない。
- recursive MPCは引き続き禁止。
- MPCカット自身を深さ`D`の厳密TT entryとしてstoreしない。
- ノード上限中断後に各contextフラグが復元される。
- MPC ONを同じ入力で2回実行し完全一致。

### Gate 1: 統計pilot

320局面で判定する。

有望条件:

- 少なくとも1つの`(d,D)`候補で、shallow/deepの中央値ノード比が20%以下。
- held-out相当データの一方向誤カット率が、`t=1.5`なら概ね6.7%前後で、95% Wilson上限が10%以下。
- 空きマス帯の一部だけ極端に悪化していない。
- 正しい式でMPCプローブとカットが実際に発生する。
- 固定深さの総ノード数が少なくとも5%改善する兆候がある。

この段階で候補がなければ、1,200局面校正や60局対局へ進まず、MPCはOFF維持とする。

### Gate 2: 確認校正・固定深さ

校正に使っていないtest splitで、depth 8/10/12を比較する。

合格基準案:

- depth 10および12の集計ノード数がbaseline比10%以上減少。
- ゲーム単位bootstrapのノード比95%上限が0.97未満。
- 局面別中央値でも5%以上減少。
- p90ノード比が1.25以下。
- `mpcProbeNodes / totalNodes`とcut率を併記し、改善理由が説明可能。
- 壁時計は参考指標とし、同一バイナリ・交互順・複数反復でのみ比較する。

固定深さでは`exact_from_empties=0`、aspiration/history OFFとし、MPC単体の収支を見る。

### Gate 3: 本番相当160kノード

構成A〜Dを、v4、160k、quota 60%、本番exact境界で比較する。空き20以下の局面は直接exactへ行くため、中盤比較から除外する。

合格基準案:

- 2回実行で全局面のmove/score/depth/nodes/telemetryが完全一致。
- `wallLimitHit=0`。
- Aに対しBの完成深さ中央値が+1以上、または35%以上の局面で+1以上。
- BがAより浅くなる局面は10%以下。
- oracle regret平均差`B-A <= +0.10石`。
- paired bootstrap 95%上限が+0.50石以下。
- 4石以上のloss局面増加が60局面あたり2件以下。
- exact root/leaf attempt、quota abort、exact完走数に異常な偏りがない。

速度向上だけでregret悪化を相殺しない。MPCはより深く読めても選択的探索誤差を増やすため、到達深さとregretの両方を通す。

既存`t096_oracle_positions.json`の60局面は軽量な最初の評価に利用できる。ただし最終判断の信頼区間は広いため、可能ならWTHOR由来の独立120〜200局面へoracleラベルを付けた補助コーパスを使う。

### Gate 4: analyzeAll分離ゲート

CPU側で採用しても、`analyzeAll`はOFFを維持する。将来有効化する場合のみ別途、

- 手ごとの独立TT維持
- 呼び出し順不変
- 同一入力反復一致
- oracle regret非悪化
- 壁時計2倍未満
- 表示値の大幅ジャンプ増加なし

を確認する。

### Gate 5: 最終60局対局

軽量ゲートを全通過した後にだけ実施する。

- T125/T108と同じprimary 30 opening×先後
- v4重み
- level10
- depth12
- 160k
- quota60%
- 空き20以下無制限
- checkpoint/resume
- 1局完了ごとのアトミック保存・進捗表示。

事前登録する合格線の例:

- baseline比平均石差が2石超悪化しない。
- paired opening bootstrapで明白な悪化を示さない。
- 途中終了、wall watchdog発火、決定性不一致が0。
- 勝敗だけでなく平均石差・中央値・opening別paired差を報告。

---

# (b) 検討した代替案と却下理由

## 8.1 σテーブルだけv4で差し替える

却下する。

現行実装にはカット境界の符号、NWSでの不発、固定`D-2`、空きマス非依存、平均差無視という問題がある。新しいσだけではこれらを解消できない。

## 8.2 `REDUCTION=2`を維持する

却下する。

T048でプローブコストが利益を上回った主要候補である。目的深さごとの`(d,D)`選定へ変更すべきである。

## 8.3 v4の61ステージごとに独立σを持つ

初期案としては却下する。

必要サンプル数が急増し、深さペアごとの推定が不安定になる。正確な空きマス別統計は収集するが、実行テーブルは隣接空き帯を統合し、held-outデータで分離が必要と確認できた箇所だけ細分化する。

## 8.4 空きマスを無視した単一σ

却下する。

v4は空きマスごとに異なる重みを使う。終盤接続前と序盤後半では探索値の安定性も異なる可能性が高い。

## 8.5 ランダム自己対戦局面を再利用する

却下する。

本番局面分布との乖離が大きい。WTHORからゲーム単位で層化抽出する。

## 8.6 aspirationとMPCを直ちに併用する

初期本番案としては却下する。

T089aのfull-window一致保証が成立しなくなり、狭窓依存のMPCカットとTT boundの影響を分離できない。まずA/Bでどちらを優先するか決める。

## 8.7 aspirationを常に優先してMPCを諦める

現時点では却下する。

既存実測でaspiration単独寄与は約0.92%と小さい。正しく実装・校正したMPCがそれを上回る可能性がある。v4・160k条件の定量比較で判断する。

## 8.8 feature flagを本番全経路でONにする

却下する。

CPU、fixed-depth、`analyzeAll`、校正探索を分離できず、T139後の表示経路にも近似探索が一括適用される。runtimeポリシーが必要である。

## 8.9 終盤完全読みへMPCを適用する

今回の範囲では却下する。

終盤は真値保証が重要で、現本番は空き20以下無制限exactである。終盤ProbCutは最終石差との別σ校正が必要であり、中盤用テーブルを流用してはいけない。

## 8.10 recursive MPCを再導入する

却下する。

T048でトップ手差が大量発生した実績がある。まず1段MPCで有効性を証明する。

## 8.11 壁時計到達深さを主要ゲートにする

却下する。

決定性最優先方針に反する。固定深さノード数と固定ノード予算到達深さを主指標にし、壁時計/NPSは補助指標にする。

## 8.12 プローブ専用TTを最初から導入する

初期案では見送る。

浅い探索の厳密なTT entryは共有しても論理的には安全で、現行bucket置換規則は深いentryを保護する。専用TTはメモリ増と再利用喪失を招く。まずTT evictionとプローブノードを計測し、共有TTの汚染が性能問題として確認された場合に比較する。

---

# (c) 実装タスクへの分割案

## T156a: WTHOR校正コーパスと再開可能な測定基盤

目的: 本番コードを変えず、決定的な校正データと深さ別測定結果を生成できるようにする。

変更対象候補:

- `engine/src/bin/calibrate_mpc.rs`
- `train/src/bin/extract_mpc_positions.rs`（新規候補）
- `bench/edax-compare/t156_mpc_positions.json`
- `bench/edax-compare/t156_mpc_positions.meta.json`

内容:

- WTHORから空き21〜52を4帯で層化抽出
- ゲーム単位split
- source/output SHA記録
- 深さ1〜12のscore/nodesを局面ごとに保存
- checkpoint/resume
- affine回帰、残差、方向別tail統計
- 旧v2とv4の比較を可能にする。

依存: なし。

リスク:

- WTHOR実体は非コミットなので、source hashと再現手順が必要。
- 深さ11/12は10分を超えうるため、局面単位保存が必須。
- v4のD4非不変性を誤ってcanonical化で隠さないこと。

## T156b: pilot校正と`(d,D)`候補選定

目的: 320局面でMPC再投資の有望性を判定する。

変更対象候補:

- `bench/edax-compare/t156_mpc_pilot.meta.json`
- `bench/edax-compare/t156_mpc_pilot_report.md`
- 必要な場合のみ`engine/src/bin/calibrate_mpc.rs`

内容:

- 深さ別回帰
- 空き帯別残差
- `D-2`を含む候補ペア比較
- shallow/deepノード比
- t=1.5/1.75/2.0の誤カット率推定
- Gate 1判定。

依存: T156a。

リスク:

- 小標本のため、採用決定ではなく「確認校正へ進むか」の判断に限定する。
- 有望候補がなければここで終了する。

## T156c: MPCカット式・適用境界・runtime制御の修正

目的: 正しいMPCをdefault OFFのまま実装する。

変更対象:

- `engine/src/mpc.rs`
- `engine/src/search.rs`
- `engine/src/lib.rs`（公開型が必要な場合）
- `engine/Cargo.toml`

内容:

- 固定`REDUCTION`からペア表へ移行
- affine/fixed-point境界
- 外向きmargin
- 方向別margin
- PVガード維持
- recursive MPC禁止
- exact境界ガード
- プローブ中exact無効
- runtime `enable_mpc`
- MPC統計
- default OFF。

依存: T156bで候補設計が確定していること。

リスク:

- カット式の丸め方向を誤ると安全度が逆転する。
- contextフラグ復元漏れ。
- 近似結果を祖先TT boundが取り込む影響。
- `engine/src/`変更なので、`cargo test -p engine`とFFO回帰が必須。

## T156d: 同一バイナリA/B CLIと軽量ゲート

目的: feature別バイナリではなく、同一バイナリでA〜D構成を比較する。

変更対象:

- `engine/src/bin/eval_cli.rs`
- `engine/src/bin/calibrate_mpc.rs`
- `bench/edax-compare/compare_mpc.py`（新規候補）
- `engine/src/search.rs`（テレメトリ公開が必要な範囲のみ）

内容:

- MPC/history/aspiration独立切替
- `--max-nodes`
- quota/exact設定
- 局面別JSON
- checkpoint/resume
- fixed-depth Gate 2
- 160k Gate 3
- 反復決定性検査。

依存: T156c。

リスク:

- ベンチ専用スイッチが本番APIへ漏れる。
- exact quota消費順の差を単なるMPC性能として誤解する。
- wall-clockを主要評価に使わないこと。

## T156e: 確認校正と本番ポリシー選定

目的: 1,200局面でパラメータを固定し、AまたはBを選ぶ。

変更対象:

- `engine/src/mpc.rs`（確定テーブル）
- `bench/edax-compare/t156_mpc_calibration.meta.json`
- `bench/edax-compare/t156_mpc_calibration_report.md`

内容:

- calibration/tuning/testの独立評価
- 空き帯の結合・分割決定
- `(d,D)`表確定
- A〜D比較
- oracle regret
- 決定性
- 採用候補確定。

依存: T156d。

リスク:

- tuning結果をtestへ混入させる選抜バイアス。
- 61ステージを過剰分割すること。
- 10分超のため、逐次checkpoint/resume必須。

## T156f: CPU強経路限定の仮採用

目的: 軽量ゲート合格構成をCPU強経路だけで有効にする。

変更対象候補:

- `engine/src/search.rs`
- `engine/src/protocol.rs`
- `app/src/analysis/cache.ts`
- `app/src/engine/build-wasm.mjs`または該当ビルド設定
- `engine/Cargo.toml`

内容:

- node-budget CPU経路だけMPC ON
- 選定に応じてaspiration OFF
- historyはON維持
- `analyzeAll`はMPC OFF
- 空き20以下exactは不変
- 解析キャッシュversion更新
- native/WASM決定性テスト。

依存: T156e合格。

リスク:

- feature/runtime設定の二重管理。
- `allMoves`への誤適用。
- nativeとWASMの整数丸め差。
- engine変更のためcargo test・FFO・WASM回帰が必須。

## T156g: 最終60局対局ゲート

目的: 重い検証を最後に一度だけ行う。

変更対象候補:

- 原則コード変更なし
- `bench/edax-compare/t156_mpc_results.json`
- `bench/edax-compare/t156_mpc_report.md`
- 既存ハーネス不足時のみ`bench/edax-compare/vs_edax.py`

内容:

- primary 60局
- baseline/MPCのpaired比較
- checkpoint/resume
- 決定性・watchdog発火確認
- 最終採用/撤回判定。

依存: T156f。

リスク:

- 長時間実行。
- CPU競合。
- run keyにMPC policy、テーブルversion、重みSHAが含まれないと結果を混同する。
- 60局だけで有意差が出ない可能性が高いため、平均石差・paired CIを主に見る。

---

# (d) 未確定事項・オーケストレーターへの確認事項

1. **MPCの初期適用経路**  
   推奨は「CPU強の160kノード経路のみON、`analyzeAll`はOFF」である。この経路分離を正式方針としてよいか。

2. **aspirationとの排他**  
   推奨は、初回採用候補をA（aspiration）対B（MPC）から選び、併用Cは診断だけにすることである。T089aのfull-window一致保証を維持するため、この方針でよいか。

3. **本番exact境界の正規条件**  
   コード履歴上はnode-budget側`exact_from_empties=16`、quota 60%、アプリ側は空き20以下で別途無制限exactである。T156の正規ベンチ条件をこの組み合わせで固定してよいか。

4. **壁時計watchdog発火時の扱い**  
   厳密な決定性を求めるなら、壁時計で中断した部分探索を通常結果として返す現行方式には理論上の非決定性が残る。発火時に固定小ノード予算で再探索する等の決定的フォールバックまでT156へ含めるか、MPCゲートでは`wallLimitHit=0`を条件として既存方式を維持するか、裁定が必要である。推奨は後者をT156の範囲とし、watchdog再設計は別タスクにすること。

5. **WTHOR校正コーパスのコミット可否**  
   固定JSON局面とmanifestを`bench/edax-compare/`へコミットするか、局面本体は非コミットとしてmanifestと抽出手順だけを残すか。再現性の点では、ライセンス上問題がなければ局面JSONのコミットを推奨する。

6. **pilot／確認校正の件数**  
   推奨はpilot 320局面、通過後1,200局面である。計算時間をさらに抑える場合、確認校正を800局面へ下げることは可能だが、空き帯別tail検証の精度が落ちる。

7. **軽量oracleコーパスの拡張**  
   既存T096の60局面だけでGate 3を行うか、WTHOR独立120〜200局面へEdax oracleを追加するか。ユーザー方針に合わせ、まず60局面で判定し、境界的な結果の場合のみ拡張する案を推奨する。

8. **最終採用基準**  
   本レポートでは固定深さノード10%以上減、160k完成深さ+1、regret差+0.10石以内を案とした。これを事前登録するか、速度改善幅に応じてregret許容量を変更するか確認が必要である。

9. **feature flagの最終形**  
   校正中は`mpc_enabled`をコンパイルガードとして残してよいが、本番採用時はruntime route policyを正とし、featureは「コードを含めるか」だけに限定するのが望ましい。最終的にdefault featureへ入れるか、feature自体を廃止するかはT156fで裁定する。

---

## 最終推奨

まずT156a〜T156dまでを実施し、320局面pilotと軽量A/Bで有望性を判定するべきである。現行σテーブルの単純再測定や60局対局から始めるべきではない。

特に、現行の`beta - margin`／`alpha + margin`と窓内ガードは、NWS主体の現在の探索にMPCが効かない主要な構造原因である可能性が高い。ここを正したうえで、v4、WTHOR分布、空き帯別、`(d,D)`ペア、160kノード予算という現在の本番条件へ校正し直せば、旧T048の負の結果とは独立した、意味のある再評価が可能になる。