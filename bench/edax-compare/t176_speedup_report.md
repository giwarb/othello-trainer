# T176 高速化(1): MPC積極化+評価プロファイル 総合レポート

## 結論(要約)

- **Part 1(MPC積極化)**: 事前登録スクリーニング(proxy)でt=1.0が規準(一致率低下≤2pp∧誤差増≤+0.05石)を満たす最も積極的な値として選定された。確認対局30局(vs Edax lv12、T175 P1と同一開幕の前半15ペア)で**強度の大きな悪化は確認されなかった**(開幕単位平均差+1.73石、95%CI[-2.33, +6.00]、T175 P1(t=1.5)比で悪化どころか点推定はやや上振れ、ノイズの範囲)。固定局面での制御実験(depth 12固定、60局面)で**t=1.0はt=1.5よりさらに21%のノード削減**(t=1.5: MPC off比34.3%→t=1.0: 27.1%)を確認。**t=1.0への切り替えを提案する**(採否はユーザー/オーケストレーター判断)。
- **Part 2(評価プロファイル)**: D1 score()の時間内訳はscalar特徴が約17%、パターン46インスタンス分(canonical変換込み)が残り約83%。1点、セルごとに`mover`の分岐をやり直していた`cell_trit`をパターンごとに1回へ集約する安全な簡略化を適用し、**1200局面でのビット完全一致(smoke SHA)を確認**したが、**NPS改善は測定誤差の範囲内(実質ゼロ)**だった(release最適化〔LLVMのloop-invariant code motion〕が既に同等の効果を行っていたためと考えられる)。出力が変わる最適化(増分評価等)は提案のみに留める。

## Part 1: MPC積極化

### 1-1. マージン表(t=1.5, 1.3, 1.2, 1.1, 1.0)

`bench/edax-compare/t176_margin_table.py`が`t172_v6_pilot_stats.json`(既存データ、再計測なし)から`margin=ceil(t*residualSigma)`の式で機械生成。t=1.5の列は本番`engine/src/mpc.rs`のCALIBRATIONS表と全16行で完全一致することを確認済み(詳細: `t176_margin_table_report.md`+meta)。

### 1-2. 事前登録スクリーニング(proxy、要件1-2)

`bench/edax-compare/t176_t_screening.py`。T156b Gate 1のproxy手法(held-out root NWS `[-1,0)`近似)を一般化し、`t172_v6_pilot_measurements.json`(既存測定データ、新規engine探索なし)のみを使用。候補4ペア(d,D)=(3,6),(4,8),(2,10),(4,12)×4空き帯、held-out(tuning+test)split、n=512(全16グループ合算)。

| t | cutRate | agreementRate | meanEvalError(石) | 一致率低下(pp) | 誤差増(石) | 規準 |
|---:|---:|---:|---:|---:|---:|:---:|
| 1.5(現行) | 0.5156 | 0.9863 | 0.0195 | 0.00 | 0.0000 | 合格 |
| 1.3 | 0.5801 | 0.9844 | 0.0235 | 0.20 | 0.0040 | 合格 |
| 1.2 | 0.5977 | 0.9844 | 0.0235 | 0.20 | 0.0040 | 合格 |
| 1.1 | 0.6406 | 0.9766 | 0.0345 | 0.98 | 0.0150 | 合格 |
| 1.0 | 0.6641 | 0.9707 | 0.0501 | 1.56 | 0.0306 | 合格 |

事前登録規準(一致率低下≤2pp かつ 誤差増≤+0.05石で最も積極的なt): **全tが規準を満たしたため、最も積極的なt=1.0を選定**。詳細: `t176_t_screening_report.md`+meta。

**注意(proxy手法の限界)**: 実際の探索木のライブ計測ではなく、単一ノードがたまたま親のNWS `[-1,0)` プローブ対象だったと仮定する静的近似(T156bと同じ手法)。妥当性は下記1-3の確認対局(実際のeval_cli探索)で検証する。

### 1-3. 確認対局(30局、vs Edax lv12、T175 P1と同一開幕の前半15ペア)

エンジン配線(T176新規、既定不変):
- `engine/src/mpc.rs`: `Calibration`に`sigma_centidisc`を追加し、`calibration_with_margin_t(base, t)`でmargin再計算(t=1.5は本番値と完全一致、単体テストで実証)。
- `engine/src/search.rs`: `SearchCtx`に`mpc_margin_t: Option<f32>`を追加(既定`None`=本番表そのまま)。`search_with_eval_with_policy_and_margin_t`(新API)経由でのみ`Some(t)`になる。既存の`search_with_eval_with_policy`は`None`を渡す薄いラッパーへ変更、外部呼び出し元(calibrate_mpc.rs・eval_cli.rs)は無変更。
- `engine/src/bin/eval_cli.rs`・`bin/calibrate_mpc.rs`: `--mpc-margin-t T`(`--enable-mpc`/`--mpc on`併用時のみ有効)。
- `bench/edax-compare/vs_edax.py`: `--engine-mpc-margin-t T`(settings/run_keyに記録)。

**ビット不変の実証**: `search.rs`の新規テスト`margin_t_override_at_1_5_is_bit_identical_to_the_default_none_path`で、`mpc_margin_t: None`(既定)と`Some(1.5)`が score/nodes/depth/best_move/mpc_stats すべて完全一致することを確認。`mpc.rs`の新規テスト`calibration_with_margin_t_at_1_5_reproduces_the_stored_table_margin`で全16エントリのmargin再現を確認。eval_cliレベルでも同一局面を`--enable-mpc`単体 vs `--enable-mpc --mpc-margin-t 1.5`で実行し、`elapsedMs`/`nps`(壁時計)以外の全フィールドが完全一致することを確認(スモーク)。

**対局設定**: depth 12固定、ノード上限100M(実質無効)、時間15000ms(wall保険)、exact_from_empties 16(空き20以下は無制限exact)、weights=pattern_v6.bin、Edax lv12、T175 P1と同一「primary」開幕セットの先頭15開幕(30局)。

**強度**(`t176_confirmation_compare.py`、T175 P1の同じ15開幕部分集合とpaired比較):

| 集計単位 | n | 平均差(candidate-baseline) | 95%CI | 符号検定p |
|---|---:|---:|---|---:|
| 開幕単位 | 15 | +1.7333石 | [-2.3333, +6.0000] | 0.4386 |
| 局単位 | 30 | +1.7333石 | [-1.8000, +5.5333] | 0.6831 |

判定基準(「大きな悪化(平均-2石超かつCI全体マイナス)がないこと」): 平均差は正(悪化どころか改善方向)、CI上限は大きくプラス側 → **大きな悪化なし(基準内)**。

**速度**: 壁時計(elapsedMs/wallClockSec)はbaseline(T175 P1)とcandidate(本タスク)が別々のプロセス実行(実行時刻・マシン負荷が異なりうる)のため、参考値に留める(1手あたり1741.3ms→1835.0ms、-5.4%、1局あたり51.26s→53.52s、-4.4%。いずれも負=遅くなっている。ただしゲーム木が両アームで着手選択の時点から分岐していく〔t=1.0とt=1.5で局面ごとの選択が変わりうる〕ため、平均ノード数もこの実対局データからは信頼できる比較にならない〔実測: 1手あたりノード数はbaseline 9,570,877→candidate 12,060,475、+26%——後述の制御実験と矛盾する方向で、対局の分岐に起因するノイズと判断〕)。

決定的で比較に適した速度指標は、下記1-4の制御実験(同一局面集合、t以外は完全固定)。

異常チェック: クラッシュ・非合法手0件(stderr空)、node-budget決定性regression PASSED(10/10)、`engine_mpc_margin_t: 1.0`がsettings/runKeyに記録済み(weights SHA `e69f3b1c...`と一致、pattern_v6.binを正しく使用したことを確認)。

### 1-4. 制御実験: 固定局面集合でのノード数比較(off vs t=1.5 vs t=1.0)

`calibrate_mpc gate`(`--mpc-margin-t`新規オプション、T176)。`bench/edax-compare/t156_mpc_positions.json`のtest split、空き帯21-28の60局面(ファイル先頭から`--max-positions 60`で選択、他帯は時間都合で対象外)、depth 12固定、history/aspiration OFF、pattern_v6.bin。

| 構成 | 合計ノード | off比 |
|---|---:|---:|
| MPC off | 67,423,404 | 1.0000 |
| MPC on, t=1.5 | 23,129,378 | 0.3430 |
| MPC on, t=1.0 | 18,255,643 | 0.2708(t=1.5比0.7893、**t=1.5からさらに21.1%削減**) |

同一局面集合・同一探索条件でtだけを変えた制御実験のため、ゲーム分岐によるノイズがない。**t=1.0はt=1.5よりも明確に高速**(このバケットにおいて)。

## Part 2: 評価ホットパスのプロファイル

### 2-1. 時間内訳(D1、46インスタンス)

使い捨てベンチ(`engine/tests/t176_score_profile_bench.rs`、計測後削除、T168の`npsReference`と同じ運用)。pattern_v6.bin、3フィクスチャ×2,000,000回、release build。

| 内訳 | ns/eval | 割合 |
|---|---:|---:|
| フル score()(46インスタンス+canonical変換+scalar特徴) | 538.0〜539.7 | 100% |
| scalar特徴を無効化(46インスタンス+canonical変換のみ) | 446.7〜448.4 | 82.8〜83.3% |
| scalar特徴の寄与(差分) | 90〜91 | 16.7〜17.2% |

**内訳の読み方**: scalar特徴(モビリティ・囲い度の2つ)は全体の約17%を占める。残り約83%はパターン46インスタンス分のテーブル引き(`pattern_state_index`のセル走査+`table_index`のcanonical変換込み)。`table_index`のcanonical変換自体は`Option`分岐1回+配列参照1回というO(1)処理であり(`engine/src/pattern_eval.rs`のコード確認による分析、個別の追加計測はしていない)、支配的なコストは46インスタンス分のセル走査(平均セル数8〜10)の反復そのものと判断する。

### 2-2. 適用した即効改善(ビット不変)

`engine/src/patterns.rs`の`cell_trit`/`pattern_state_index`: 従来はパターン内の**セルごと**に`match mover { Black => ..., White => ... }`をやり直していたが、`mover`は1回の`pattern_state_index`呼び出し(1パターン分)を通じて不変なので、`(own, opp)`をパターンごとに**1回だけ**導出し、セルのループでは使い回すよう変更した(D1では平均セル数×46回の`match`が46回の`match`に減る計算)。

**ビット不変の実証**: `bench/edax-compare/t156_mpc_positions.json`の全1200局面を`eval_cli eval --depth 0 --exact-from-empties 0 --pattern-weights train/weights/pattern_v6.bin`で評価し、出力全体のSHA-256を計測。`git stash`で変更前のpatterns.rsに戻して同じコマンドを再実行し、SHA-256を比較。

- 変更前: `952bb1e70f92e0a672e5e33339c8e2460da73014fd19c2c557eae5d0ca62aa6a`
- 変更後: `952bb1e70f92e0a672e5e33339c8e2460da73014fd19c2c557eae5d0ca62aa6a`
- **完全一致(ビット単位で出力不変)**。

**NPS実測**: 使い捨てベンチ(`engine/tests/t176_score_hotpath_bench.rs`、計測後削除)で、代表的な中盤局面からdepth 12・時間無制限のsingle-root探索(`search_with_eval`)を実行し、探索全体のNPSを比較(各3回計測)。

| | 実測値(3回) | 平均 |
|---|---|---:|
| 変更前 | 892,626 / 879,538 / 862,295 | 878,153 |
| 変更後 | 900,515 / 884,350 / 889,041 | 891,302 |

差は約+1.5%で、3回ずつの測定値のレンジが重なっており(変更前の最大892,626 > 変更後の最小884,350)、**測定誤差の範囲内、実質的な改善とは言えない**。releaseビルドの最適化(LLVMのloop-invariant code motion)が、`mover`不変の分岐をセルのループの外へ既に自動的に押し出していた可能性が高い(手動での簡略化はコードの意図を明確にする効果はあるが、この特定の最適化については計測可能な速度向上をもたらさなかった)。

### 2-3. 提案(出力が変わるため未適用、T176スコープ外)

- **増分評価(differential evaluation)**: 1手ごとに全46パターンを再計算するのではなく、着手で変化したセルを含むパターンだけを再計算する。出力は理論上同じだが、実装ミスで異なる結果になるリスクがあり、また探索全体(TT・ETC等)との相互作用の検証が要る規模の変更のため、本タスクでは着手しない(7/26 Codex諮問または別タスクで検討)。
- **canonical変換テーブルのキャッシュ**: 同一(class_id, raw_state)の再計算が探索木内で頻発する場合、TTと同様のメモ化が効きうるが、効果測定(どの程度重複が起きているか)が別途必要。

## 受け入れ基準の充足状況

1. tスクリーニング表・事前登録規準の当てはめ: `t176_t_screening_report.md`+meta ✓
2. 確認対局30局の結果・時間短縮実測: 上記1-3・1-4(強度悪化なし、決定的な速度指標はt=1.5比21%のノード削減) ✓
3. プロファイル内訳・ビット不変実証・NPS実測: 上記2-1〜2-2(NPS改善は測定誤差内という結果を含めて実測・報告) ✓
4. `cargo test -p engine`全パス(243 passed / 0 failed / 2 ignored、新規3テスト含む)、既定挙動(t=1.5・本番経路)の不変実証(単体テスト+eval_cliスモーク+patterns.rsのSHA一致)、完了時`git status --short`クリーン ✓
