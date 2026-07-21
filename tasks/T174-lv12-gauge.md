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

(ワーカーが節目ごとに追記)
