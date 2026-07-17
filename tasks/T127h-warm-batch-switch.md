---
id: T127h
title: expanded1m生成の親またぎバッチ化への乗り換え(実装→移行→再開)
status: in_progress # todo | in_progress | review | redo | done | blocked
assignee: Codex gpt-5.6-sol(codex-task)
attempts: 0
---

# T127h: 親またぎバッチ化への乗り換え

## 目的(ユーザー方針+T127g判定 2026-07-17 夜)

T127gで「複数親を1プロセスに束ねる」方式が**値全一致・加重1.32倍以上(2親/プロセスでの下限値)**と確定。走行中のexpanded1m生成を本方式へ乗り換え、残り約71万件を約8時間以上短縮する。**既存レコードは1件も捨てない**(ユーザー明示指示。値同一が証明済みのため旧方式レコードはそのまま有効、manifestに方式境界を記録)。

## フェーズ1: 実装+検証(生成は走行継続のまま行う)

1. `gen_teacher_corpus.py`のexpanded1mシャードワーカーに**親またぎバッチモード**を追加: todoの親局面をplan順に`edaxParentsPerProcess`(新設定、例: 16)個ずつ束ね、束内全親の子局面をexact/level16のlevel別に集約して`_edax_solve_batch`を呼ぶ(1束=最大2プロセス)。**親単位のcheckpoint追記は維持**(束の結果をパースした後、親ごとに順次JSONLへ書く)。バッチ失敗時は当該束を親単位の個別実行へフォールバック(全滅回避)。
2. **束サイズのマイクロベンチ**: 8/16/32親で未生成サンプル(各30親程度)を計測し、速度と値一致(cold基準)を確認して採用値を決める(T127gは2親で1.32倍。大きいほど初期化償却が効くが、失敗時の巻き込みとメモリに留意)。
3. runKey/settingsに`edaxParentsPerProcess`を追加(**旧設定のrunKeyは不変**: フィールド無し=旧方式。既存テストで固定)。
4. テスト: 束化の値一致(モック)・親単位checkpoint維持・フォールバック・runKey不変性。`python -m pytest bench/edax-compare/ -q`+`python bench/edax-compare/test_teacher_corpus.py` 全パス。
5. **フェーズ1完了時点で停止して報告**(生成プロセスには触れない。オーケストレーターが停止を実行する)。

## フェーズ2: 移行+再開(オーケストレーターの停止後、SendMessageで指示される)

6. **migrationスクリプト**: 全シャードmeta/jsonlをバックアップ→既存レコード数・SHA検証→metaのrunKey/settingsを新方式(採用束サイズ入り)へ書き換え+provenance現在値化。**切り詰め・削除の経路を作らない**(不整合はエラー停止。T114堅牢化の流儀)。manifest用に方式境界(切替時点の各シャード件数)とT127f/gの値一致証跡を記録する仕込み。
7. 再開はオーケストレーターが実施(detached起動)。再開後、既存レコードが全件ロードされ新方式で続きが生成されること・値の抜き取り一致をログで確認する手順を報告に含める。

## 厳守事項

- **実行中の生成プロセスをkillしない**(停止はオーケストレーター担当)。フェーズ1の間、生成は走行継続(その間のレコードも有効)。
- 既存レコードの削除・切り詰めを行うコードを書かない。migrationはバックアップ→検証→書き換えのみ。
- 生成中のplan/checkpointへの書き込みはフェーズ2まで一切禁止(読み取りのみ)。
- マイクロベンチは生成と並走のためペア比較(比率判定)。

## 受け入れ基準

- [ ] 採用束サイズの根拠(マイクロベンチ結果: 速度・値一致)がある
- [ ] 親単位checkpoint・フォールバック・runKey不変性(旧設定)のテストがある
- [ ] migrationがバックアップ+検証+書き換えのみで、削除経路が無いこと(テストで固定)
- [ ] pytest+unittest全パス
- [ ] 変更対象のみパス指定でコミット(`(T127h)`)(フェーズ1完了時)
- [ ] 当該タスク由来の残差分・未追跡なし

## フィードバック(やり直し時にオーケストレーターが記入)

## 作業ログ(担当エージェントが追記)

### 2026-07-17 20:16 JST — Codex（フェーズ1完了）

- 実施内容: `gen_teacher_corpus.py` の expanded1m worker に親またぎ level 別バッチを追加。plan 順に最大32親を束ね、束全体の結果確定後に親ごとに `append` + `fsync` する。束処理が失敗した場合は、当該束を親単位の `label_position` へフォールバックしてから親順に checkpoint する。新方式の settings/runKey に `edaxParentsPerProcess: 32` と `elapsedMsPolicy: cross-parent-level-batch-averaged` を追加し、引数なし（フィールドなし）の旧方式 runKey は完全一致スナップショットテストで固定した。
- マイクロベンチ: 走行中 checkpoint 289,589件時点の未生成サンプルをサイズごとに30親（計90親）読み取りスナップショットし、同じ親の cold（親別）/warm（親またぎ）を束ごとにペア比較。8親は cold 44.893秒 / warm 37.579秒 = 1.1946x、16親は 39.345秒 / 32.438秒 = 1.2129x、32親は 35.952秒 / 27.829秒 = 1.2919x。全サイズとも比較30親・値不一致0。最速の32親を採用した。ベンチは `%TEMP%/t127h_microbench` に親/束単位で逐次 fsync し、生成中の plan/checkpoint は読み取りのみ、生成プロセスは停止・変更していない。
- 追加テスト: 親またぎで exact/level16 が各最大1 Edax 呼び出しに集約され cold と値一致すること、親単位 checkpoint の plan 順維持、束失敗時の親別 fallback、旧 runKey 不変、新 settings/runKey の束サイズ記録。
- 実行コマンドと結果:
  - `python -m pytest bench/edax-compare/ -q` → 50 passed (3.47s)
  - `python bench/edax-compare/test_teacher_corpus.py` → Ran 34 tests, OK (2.557s)
  - 最終コメント整形後 `python -m pytest bench/edax-compare/test_teacher_corpus.py -q` → 34 passed (2.65s)
  - `python -m py_compile bench/edax-compare/gen_teacher_corpus.py` → 成功
  - `git diff --check` → 成功（警告なし）
- フェーズ境界: 仕様 §5 に従いフェーズ1で停止。migration（バックアップ+検証+meta書き換えのみ）は未着手で、オーケストレーターによる生成停止後の指示待ち。
- コミットハッシュ: 未コミット（`.git` 書き込み禁止のためオーケストレーター代行待ち）。