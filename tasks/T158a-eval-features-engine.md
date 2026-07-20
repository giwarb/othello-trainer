---
id: T158a
title: 評価特徴追加(1/4): engine側特徴計算・PWV4形式・評価統合・純コスト計測
status: redo # codex-review不合格(2026-07-20): Gate 1計測が単一序盤局面のみ。下記フィードバック参照
assignee: Codex gpt-5.6-sol
attempts: 1
---

# T158a: engine側特徴とコスト計測

## 目的

設計レポート(tasks/design/T158-eval-features-report.md、裁定は同request.md冒頭)の第1段。**スカラー特徴(正確なモビリティ差・8近傍接触辺数の囲い度差)の計算・PWV4形式・評価統合を、既定挙動完全不変で実装**し、**ゼロ係数モデルによる純粋なNPSコストを計測**してGate 1判定の材料を出す。

## 要件(設計レポート§(c)T158a節・§3〜6・§9に忠実に)

1. **特徴primitive**(bitboard.rs): 8近傍接触辺数(空きビットボードを8方向シフト×両色popcount)。モビリティは既存 legal_moves_relative を利用。色交換で符号反転・D4変換で不変。整数演算のみ(決定性・native/WASM整合)。
2. **PWV4形式**(pattern_eval.rs): 新magic "PWV4"、num_scalar_features + featureごと(kind u8/scale_shift u8/reserved u16/weights f32×61)。kind 1=ExactMobilityAdvantage(scale_shift=3)、2=EmptyAdjacencyExposureAdvantage(scale_shift=5)。schema hashに特徴情報を含める。未知kind・重複・非finite・stage数不一致・余剰bytesは拒否。**PWV1〜3のloader/scoreは演算順含め完全不変**。
3. **評価統合**(search.rs等): PWV4ロード時のみscalar項をパターン和の後に固定順で加算。比較用の--disable-eval-features(別プロセス/fresh TT前提)。評価モード切替時のTT混入への配慮は設計§5.2どおり(初期実験は別プロセス条件の明示でよい)。
4. **Gate 0テスト**(設計§8): PWV1-3全既存テストPASS・現行pattern_v4.binのスコア完全一致・PWV4 round-trip/破損拒否・ゼロ係数でPWV3と評価値完全一致・符号反転/D4不変・囲い度の独立8×8二重ループ実装とのfixture比較・決定性・native/WASM fixture一致。
5. **純コスト計測(Gate 1材料)**: ゼロ係数PWV4モデル(baseline PWV3と全評価値・best move・nodes一致、elapsedのみ増)で、(a)評価関数単体throughput(black_box) (b)固定深さ探索NPS (c)160kノード本番相当elapsed、をnative/WASM双方・設計§6.3の計測規律(専有・交互順・7反復中央値)で計測。**ノード上限と時間上限のどちらが支配的かを併記**(裁定22の最終決定材料)。判定: WASM NPS比90%以上→Gate 2へ/85-90%条件付き/85%未満→exact mobility停止(line-LUT近似は別タスク)。
6. レポート: bench/edax-compare/t158a_engine_cost_report.md(+meta)にGate 0結果・計測値・Gate 1判定。

## スコープ外

- trainer拡張・学習(T158b)、スクリーニング(T158c)、本番採用(T158d、後回し)
- app変更・ANALYSIS_ENGINE_VERSION変更(本番はPWV3のpattern_v4.binのまま完全不変)
- line-LUT近似モビリティ(不合格時の別タスク)

## 受け入れ基準

1. `cargo test -p engine` 全パス(Gate 0テスト込み)、FFO fast不変、既存NPSベンチ不変
2. ゼロ係数モデルの「baseline完全一致(値・move・nodes)」が機械検証されている
3. NPS計測結果(native/WASM、3層)とGate 1判定・支配要因(ノードvs時間)がレポートにある
4. 変更ファイル一覧と検証結果を完了報告に明記(コミットはオーケストレーター代行)。一時ファイル不残置

## コミット規律

- `tasks/` と `CLAUDE.md` は変更しない(作業ログ追記は行う)。計測は専有状態で(現在他の重い処理なし)

## フィードバック(redo #1、2026-07-20 codex-review不合格による)

レビュー(tasks/review/T158a-eval-features-engine-codex-review.md)。実装本体(PWV4・ゼロ係数bit-exact・性質テスト)は問題なし。修正点:

1. **[ブロッカー] Gate 1計測の複数ステージ化**: 固定深さNPSと160k計測がnative/WASMとも単一の序盤局面(空き48)のみ。設計§6.3の「序盤・中盤・終盤接続前を含む複数局面」を満たす固定コーパス(例: t156_mpc_positions.jsonの4空き帯から各数局面、または同等の層化選定。決定的に固定しレポートに記録)で、native/WASMの固定深さNPSと160k/1500msを7反復交互順で再計測し、**帯別+集計でGate 1を再判定**。ノードvs時間の支配性も帯別に併記。
2. **[中] PWV3不変のgolden fixture**: 現行pattern_v4.binの複数stage局面の静的評価値f32::to_bits()を親コミット由来のgolden値として固定fixture化し、変更後loaderとの完全一致を機械検証(現行テストはPWV3→PWV4ゼロ係数の相対比較のみで、PWV3自体の不変を独立証明していない)。
3. **[中] 反復間決定性の直接比較**: baseline結果が7反復を通じて同一であることの直接比較(native)、WASM 160kのproductionReferenceと後続反復の比較。
4. [軽微・任意] benchmark_pattern_evalのwasm_bindgen公開APIをベンチ用feature条件付きにする検討(見送り可、理由記録)。

## 作業ログ

(ワーカーが節目ごとに追記)

- 2026-07-20 23:20:44 +09:00 Codex: 8近傍接触辺数primitive、exact mobility差・
  exposure差、PWV4 scalar schema/serialize/loader、pattern和後の固定順評価統合、
  `eval_cli --disable-eval-features`とゼロ係数PWV4生成、native/WASM計測入口を実装。
  Gate 0としてPWV1〜3既存テスト、PWV4 round-trip/破損拒否、ゼロ係数bit-exact、
  色交換/D4、独立8×8二重ループ、fresh TT探索の値/move/depth/nodes/PV一致、
  native/WASM共通fixture一致(move=d6, score=11.09, depth=9, nodes=183318)を確認。
  `cargo test -p engine`=209 passed/0 failed/2 ignored、
  `cargo test -p engine --release --test eval_features_nps_bench -- --nocapture`=PASS、
  `cargo test -p engine --release --test pattern_eval_nps_bench -- --nocapture`=PASS
  (既存pattern/heuristic NPS比0.835)、
  `cargo test -p engine --release --test ffo_bench -- --nocapture`=FFO #40〜44全問PASS
  (641,077,417 nodes, 59.496s, 10,775,072 NPS)。7反復交互順中央値はnative固定深さ
  NPS比94.67%、WASM固定深さ95.94%。WASMが90%を上回るためGate 1合格、Gate 2へ。
  160k/1500msはnative/WASMとも`nodeLimitHit=true`, `timedOut=false`でノード上限支配。
  詳細は`bench/edax-compare/t158a_engine_cost_report.md`と`.meta.json`。
  コミットハッシュ: なし（`.git`書き込み禁止のためオーケストレーターが代行）。
