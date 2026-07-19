# T139 最終コードレビュー(Claude代替レビュー、Codex usage limit中のフォールバック)

- 対象: コミット 4612c66(engine/src/{search.rs,protocol.rs,pattern_eval.rs,bin/eval_cli.rs}、app/src/analysis/cache.ts、app/src/engine/worker.ts)
- 総合判定: **合格**(重大なし、中4件・軽微5件)
- 併走verifier検収も合格(199+FFO+vitest 781、Actions成功、Pages実機Playwrightで初手4手同一値を独立確認)

## 中(→T145フォローアップへ)

**M1. 「PatternWeightsは実運用で未配線」という実装者報告は誤り**。本番はT122以降 v3×PatternWeights が配線済み(worker.tsがpattern_v3.binをload、handle_analyze全経路でweights使用)。pattern_eval.rsのテストコメントの「実害なし」根拠はCLAUDE.mdの古い記述に依拠した事実誤認。発見されたcompute_pattern_classesのD4不変性の破れ(機構説明自体は正確、T044由来)は**現在の本番評価に効いている** — 非対称な合同局面ペアでは静的評価レベルで値がズレうる。修正見送り自体は工数的に妥当。テストコメント訂正+フォローアップ化が必要。

**M2. 対称局面同値はMPC有効+本番重み下で理論保証されない**(ordered_movesのタイブレークがD4同変でない+M1の静的評価非不変)。本修正が保証するのは決定性と手間の順序非依存まで。初期局面の一致は経験的成立。新規対称テストはweights=Noneで走るため、**本番重み構成での自動テストが欠落**(Pages手動確認のみ)。

**M3. exact経路の速度影響が未計測**。速度A/Bは中盤depth12のみ。棋譜解析(exactFromEmpties=22、timeMs1500)では共有64MB TTの兄弟手間トランスポジション共有が失われ、時間切れ→静的評価フォールバック(is_exact:false)が増える=空き17〜22帯で「exact」表示が減る退行の余地(値の正しさには影響なし)。

**M4. 新テストのrevert-catching力が未実証**。現実的な退行(ループ先頭のlocal_tt.clear()削除、コンパイル可)で対称テスト(depth10/heuristic)が実際に落ちるかは未確認。

## 軽微

L1. protocol新テストのコメントが厳密には不正確(3回目は1+2回目後のTT状態を引き継ぐ=「2回目で不動点」依存)。L2. 「対称局面の評価値が完全一致する」というdoc表現は一般命題としては過大。L3. 16MB確保+手ごとmemset clearはanalyzeAll 1回あたり最大数十ms(モバイル~100ms台)で許容、メモリは共有64+一時16=80MB前後でwasm上限に対し問題なし。L4. eval_cli moves経由のベンチ系への実影響は僅少(vs_edaxはsingle-root、T085b校正はmaxNodes経路で不変)。L5. ANALYSIS_ENGINE_VERSION 4→5は必要かつ正当(解析キャッシュはanalyzeAll由来)。

## 確認済みの安全性

- cpuLimit経路(対局CPU着手)はdiff上完全不変(元々毎回clear+共有TT)。weak/normal経路は「analyzeAllが共有TTを汚さなくなる」方向の変化のみ(意図どおり)。
- search.rs内に他の共有状態なし(historyはanalyzeAll経路でNone固定)→決定性・順序非依存は構造的に成立。
