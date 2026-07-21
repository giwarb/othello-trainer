---
id: T174
title: 対Edax lv12実力計測(v6本番構成、60局) — 物差しの更新
status: todo
assignee: implementer
attempts: 0
---

# T174: 対Edax lv12計測

## 目的

v6(現本番)が対Edax lv10でほぼ互角(-2.22石)に達したため、次の目標設定用に**lv12での現在地を計測**する(採否判定ではなく純粋な計測。今後のゲートにlv12を加える基準線になる)。

## 実行

- エンジン側: 現本番構成(pattern_v6.bin、160kノード・quota60%・空き20無制限、T169と同一プロトコル)
- Edax側: **level 12**(それ以外の条件はT169と同一)
- 開幕: primary 30ペア=60局。`vs_edax.py --levels 12`(ハーネス対応済みのはず。未対応なら最小限の改修可、既存挙動不変)
- 逐次・専有・detached+ツール呼び出しポーリング(Monitor通知依存禁止)、1局ごとcheckpoint

## レポート

`bench/edax-compare/t174_lv12_report.md`(+meta): 勝敗・平均石差・帯別傾向(序中終盤どこで離されるか、budgeted→exact乖離の定義明記込み)・lv10(T169のv6=26勝1分33敗-2.22)との比較・所要時間。判定はしない(計測のみ)。

## 受け入れ基準

1. 60局完走、レポート+metaに結果・SHA検証(重み・Edax)・lv10比較がある
2. 異常0件、決定性PASSED
3. 既存ファイル不変、完了時 `git status --short` クリーン(レポートはパス明示コミット。`tasks/`とCLAUDE.mdはコミットしない)

## 作業ログ

### 2026-07-21 実装開始(implementer)

1. **SHA実測照合**: `train/weights/pattern_v6.bin`(`e69f3b1c33432bafd388af82adde64270ec8c51acaab070bbfff4cf4caf20fc9`、T169候補D1と同一ファイル=採用済み)・Edax実行ファイル(`aabb5ac7...`)・eval.dat(`f8b22996...`)・openings.json(`7a340c17...`)を実測し、いずれもT158d/T162/T166/T169から不変であることを確認。
2. **`--levels`対応確認**: `vs_edax.py`の`--levels`はカンマ区切り任意整数リスト(`int(x)`でパース、`-l <level>`としてそのままEdaxに渡す設計)であり、level 12は既存のまま対応済み。改修不要。
3. **engine変更確認**: `git log <T169時点>..HEAD -- engine/`でT170(本番配線)・T172(MPC再校正、Gate3不合格で撤退)の2コミットを確認。`cargo build --release -p engine --bin eval_cli`で再ビルド(SHA `cfd600e6...`)。本タスクはEdaxレベルがT169(lv10)と異なる新規計測のため、過去データの再利用判定は不要(必ず新規60局)。
4. **実行**: 17:53:38開始、18:07:55完走(約857秒=約14.3分、事前見積り30〜60分より大幅に短時間)。60/60局、fixed-depth決定性40/40・node-budget決定性10/10ともPASSED、stderr空(異常0件)。結果: 18勝1分41敗、平均石差-6.07(lv10のT169結果-2.22石より約3.85石悪化)。
5. **帯別傾向・乖離指標の算出**: `classify_phase()`(opening≦20手・midgame21〜40手・endgame41手〜)に基づき各フェーズ最終着手のdiscDiff平均を算出。lv10はendgameで初めて明確に離れる(-0.33→-0.53→-2.23)のに対し、lv12はopening時点から劣勢が始まりmidgameで大きく開く(-0.79→-2.16→-6.07)。budgeted→exact乖離はT158d/T162/T166/T169と同一定義(遷移点1手のみ)を踏襲・明記、lv12平均4.68石・lv10平均4.31石で大差なし。
6. **レポート作成・検証**: `bench/edax-compare/t174_lv12_report.md`・`.meta.json`を新規作成。全数値(W/D/L・帯別傾向・乖離指標)を生JSONから独立再計算しクロスチェック、0件不一致を確認。T158d/T162/T166/T169系ファイルは無変更を`git diff --stat`で確認。
7. **コミット**: `bench/edax-compare/t174_lv12_report.md`+`.meta.json`をコミット`95e9e8d`(パス明示でadd、`git add .`/`-A`不使用)。生の対局ログは既存`.gitignore`ルールによりローカルのみ。
8. **受け入れ基準確認**: 60局完走、異常0件・決定性PASSED、既存ファイル無変更、`git status --short`はタスクファイル編集分を除きクリーン。
