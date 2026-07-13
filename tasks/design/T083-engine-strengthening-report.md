文字化け部分は、末尾の T084〜T090 案と既存資料から意図を復元して調査しました。コード・タスクファイルとも変更していません。

## 結論

Edaxとの差について、現時点で最も疑うべきは評価関数ではなく、対局時のルート探索と時間配分です。

自作側は1秒で単一のPVS探索をしているのではなく、全合法手を個別に full-window 探索し、残り時間を候補数で分割しています。[search.rs](C:/Users/yoshi/work/othello-trainer/engine/src/search.rs:438) [vs_edax.py](C:/Users/yoshi/work/othello-trainer/bench/edax-compare/vs_edax.py:382)

合法手が10手なら、各候補は概ね100ms未満です。この経路ではPVS、TT最善手、将来追加するaspiration/historyの利益も大きく失われます。Preactアプリも同じ `allMoves` 系経路です。

したがって、Edax level 5/10との結果は「depth 10同士の比較」ではありません。

- 自作: depth 10は上限、全候補合計1秒
- Edax: level指定、同一wall timeではない
- 結果: level 1に16–4、level 5/10に0–20という総合性能差は明確
- ただし、その差を評価関数・探索・速度へ分解することはまだ不可能

## 原因の優先順位

| 順位 | 原因仮説 | 判断 |
|---:|---|---|
| 1 | 全合法手への時間分割と単一ルート探索不使用 | 最有力。まず計測・修正対象 |
| 2 | exact切替境界での時間浪費と静的評価fallback | 空き19〜24の大ロスと強く整合 |
| 3 | 評価関数・教師データの不足 | 有力だが、探索要因除去後に判定 |
| 4 | TTの同一hash浅いエントリによる深い情報の上書き | 明確な改善点。低リスク |
| 5 | history/aspiration/hot-path不足 | 有望だがsingle-root化後でないと効果が薄い |
| 6 | CPU並列化・WASM Threads不足 | 現段階の主因ではない |

### exact境界

中盤探索からexactへ入る際、親のαβ窓を引き継がず `[-64, 64]` のfull-window完全読みを開始します。[search.rs](C:/Users/yoshi/work/othello-trainer/engine/src/search.rs:705)

完走できないと、その反復深化結果を破棄します。`allMoves` 経路では着手後がexact閾値内の場合、タイムアウト後に以前の中盤探索結果ではなく静的評価まで落ちる経路があります。[search.rs](C:/Users/yoshi/work/othello-trainer/engine/src/search.rs:523)

これは以下の観測と一致します。

- 空き19〜24: 42手、平均ロス約3.86石
- 空き18でも完全読みが3〜11秒
- 空き19では約17秒
- 1秒制限ではexact試行が探索予算を焼き切る可能性が高い

### TT

同一hashへのstoreは、既存エントリが深くてもdepth slotを上書きできます。[tt.rs](C:/Users/yoshi/work/othello-trainer/engine/src/tt.rs:131)

これは独立した明確な品質問題です。ただし、Edaxとの差の最大原因とまではまだ言えません。T084のテレメトリで発生頻度を測り、T086で修正・A/Bするのが妥当です。

## 60局ベンチの読み方

現在の結果から「大きな棋力差が存在する」とは言えます。しかし原因分析用ベンチとしては不足があります。

主な問題は次のとおりです。

- 各levelで独立な開始局面は10個だけ
- 同じ10局面を色交換して20局にしている
- 固定seedでも過去実行と6局以上勝敗が変化
- 開始局面は一様ランダム進行で、定跡スイートではない
- CLIは各着手で新プロセス・16MB TTを作り、アプリのTT再利用条件と異なる
- 到達深度、nodes、timeout、exact fallbackがJSONに残らない
- phaseは開始局面からのply数なので、実際のゲームフェーズより8〜12手程度ずれる

また、Edax level 16による現在の「loss」はoracleとして不成立です。345件中95件が負値ですが、真の最善手との差なら負にはなりません。着手前後を別探索した近似値の差だからです。

lossは同一root・同一設定で全合法手を一度に評価し、

`loss = 最大child value - 選択したchild value`

として常に非負にする必要があります。

## X/C着手の原因

「現行パターンにX/C情報が存在しない」は誤りです。隅3×3パターンには既にX/Cマスが含まれています。[patterns.rs](C:/Users/yoshi/work/othello-trainer/engine/src/patterns.rs:51)

問題候補は次の複合です。

1. 辺全体とXマスの相互作用を表現できない  
2. 専門家棋譜には破滅的なX打ちが少なく、負例が不足  
3. 全局面に実戦の最終石差を付けており、局面の最適値を学習していない  
4. exact境界・浅い探索によるhorizon effect  
5. 手順序がTT→角→相手mobility中心で、historyがない  

したがって、X/Cへの固定罰則は推奨しません。角が既に取られている場合など、X/Cが最善になる局面もあります。

Pattern v3の第一候補は `edge+2X` です。現行の「辺8」と「隅3×3」の単純加算では持てない共同状態を表現できます。追加は約3.07MBで、全体約5.8MBです。

併せて、欠落している長さ5〜7のオフセット対角線を追加する案はサイズ効率がよく、約0.16MB増です。`corner 5x2` は `edge+2X` と重複が多く、第二段階のablationが妥当です。

## 推奨ロードマップ

既存案の番号では、T084が計測、T085がexactです。

### T084 — ベンチ補正・single-root比較・テレメトリ

最優先です。

対象候補:

- `bench/edax-compare/vs_edax.py`
- `engine/src/bin/eval_cli.rs`
- `engine/src/search.rs`
- 固定opening manifest

必要事項:

- single-root best-move探索と旧allMovesを同予算で比較
- fixed-depth/node-budgetと1秒wall-timeを別系列化
- depth、nodes、NPS、elapsed、timeout、exact試行・完走・fallbackを保存
- TT/ETC統計を保存
- oracle lossを同一root方式へ修正
- build hash、weights hash、TT再利用条件を記録

合格条件:

- fixed-depthを2回実行して全着手・nodes一致
- lossが全件0以上
- 全手に必要テレメトリが存在
- 20/60/200局のopening prefixが固定

T084が完了するまで、他施策の対局結果を採否判断に使うべきではありません。

### T085 — exact切替・時間管理

- 親のαβ窓を安全にexact探索へ渡す
- exact用予算を制限する、または動的閾値を導入
- exact失敗後も最後に完了した反復深化結果を保持
- 空き13〜30の固定局面セットで検証

主要ゲート:

- exact値が既知解・naive solverと全一致
- 空き18〜24、1秒条件でdepth 0/static-onlyがゼロ
- p99 wall timeが予算を大幅超過しない
- 空き19〜24の `loss >= 4` 率が改善

### T086 — TT深度・品質保護

- 同一hashの浅い結果で深い結果を破壊しない
- 同深度ではExactをboundより優先
- probe時に同一hash候補から最深・最高品質を選ぶ

低リスクなのでT085と実装上独立なら並行可能ですが、ベンチ解釈はT085後が明瞭です。

### T087 — Pattern v3表現実験

同一trainer・同一データで以下を比較します。

1. v2再現
2. v2 + d5〜d7
3. v2 + edge+2X
4. v2 + edge+2X + d5〜d7
5. corner 5x2 ablation

現形式は座標をweights内に持たず、コードの生成順に依存するため、PWV3などの新versionが必要です。[weights README](C:/Users/yoshi/work/othello-trainer/train/weights/README.md:61)

暫定ゲート:

- 原則8MB以下、例外上限12MB
- midgame MAE 10%以上改善、または合法手regret 15%以上改善
- X/C局面の8石以上blunder率を50%以上削減
- v2比NPS 80%以上
- 3つのtraining seedすべてで同方向

### T088 — 学習データ・目的関数

まずv2特徴のまま学習法だけを比較し、表現変更と混ぜないことが重要です。

優先候補:

- MSEからHuber loss
- validation early stoppingと学習率減衰
- 年代・対局・定石接頭辞を考慮した分割
- D4正規化局面の重複除去
- ステージ別sampling
- Edax teacher value
- 小さいpairwise ranking補助損失
- X/C hard-negative oversampling

現在のラベルは「その後の人間の手順による最終石差」であり、探索葉の最適値ではありません。[train_data.rs](C:/Users/yoshi/work/othello-trainer/train/src/train_data.rs:3)

推奨分割は2015〜2022 train、2023 validation、2024 frozen testです。

### T089 — 探索効率

一括変更せず、少なくとも二分割が安全です。

- T089a: history + aspiration
- T089b: move metadata再利用、allocation/sort/apply/legalなどhot-path

ゲート:

- fixed-depthでbest move/scoreがbaselineと一致
- nodes中央値20%減、または同1秒で完了深度+1
- WASM wall p95改善
- 60局pairedで非劣性

MPCは評価分散が改善するまでOFFを維持すべきです。

### T090 — Edax教師蒸留・最終評価

T084〜T089の採用構成を確定してから、本格的なteacher corpusを生成します。

- exact oracleとapproximate teacherを区別
- Edax複数levelで値・best moveが収束した局面を優先
- WTHORラベルとの混合比をablation
- checkpoint、再開、設定manifestを必須化
- candidate対直前baselineとEdax level 1/5/10を別々に評価

## 対局数の使い分け

- 20局: smoke、クラッシュ・重大退行検出のみ
- 60局: 30 opening pairで一次判定
- 100〜200局: 60局の95% CIがゼロを跨いだ場合のみ追加

色交換した2局を1 clusterとして扱い、cluster bootstrapまたはpaired permutation testを使います。60局でCI下限が0より上ならgo、上限が0未満ならstop、跨いだ場合だけ追加します。

## 今は行わない方がよいもの

- WASM Threads対応
- TT容量増加
- MPC再有効化
- X/C固定罰則
- opening bookによる弱点の隠蔽
- Pattern v3とtrainer刷新を同時に入れた比較
- いきなり大規模Edax教師データ生成

最終的な優先順は、

**T084 → T085 → T086 → T087/T088の独立ablation → T089a → T089b → T090**

です。

最大のポイントは、Pattern v3へ進む前に「自作AIが本当に1秒の単一ルート探索を使った場合」を測ることです。現状の0–20という結果は深刻ですが、評価関数の限界を測った結果ではなく、候補別時間分割を含む対局経路全体の結果です。