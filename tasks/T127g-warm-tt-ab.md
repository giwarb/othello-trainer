---
id: T127g
title: 親またぎウォームTTの値一致+速度A/B(長寿命プロセス方式の判定材料)
status: in_progress # todo | in_progress | review | redo | done | blocked
assignee: Codex gpt-5.6-sol(codex-task)
attempts: 0
---

# T127g: 親またぎウォームTT A/B

## 目的(ユーザー関心 2026-07-17 夜、オーケストレーター判断で先行)

T127fで「短命プロセス+ハッシュ拡大」は否定された(値は全一致、速度メリットなし)。本命の「**複数の親局面を1つのEdaxプロセスに束ね、温めた置換表を使い回す**」方式(=読みの内部で重複する探索を再利用)の判定材料を作る。level 16の読みは深さ16なので、同一対局の近い局面同士は探索木の大部分を共有するはず、というのが仮説。

判定式: **値が全一致 かつ 大幅高速(目安25%以上) → 走行中の1M生成を途中から乗り換える価値をユーザーに提示**(既存レコードは全保持でmeta移行)。それ以外 → 4M判断の材料としてのみ記録。

## 厳守事項(T127fと同じ)

- 実行中の生成プロセス群に一切触れない。gen_teacher_corpus.pyは変更しない。生成中のplan/checkpointは読み取りのみ。
- vs_edax.pyの変更が必要な場合は「新引数未指定時は挙動不変」の加算形のみ(既存の`edax_hash_bits`と同じ流儀)。既存の`_edax_solve_batch`は任意局面リストを1プロセスで処理できるはずなので、**コード変更なしで組める可能性が高い**(まず確認)。
- 計測は生成と並走のため、arm同士を交互実行するペア比較(比率で判定)。
- 一時成果物はscratchpadへ(stage単位append+fsync、resume対応)。

## 実験設計

1. **サンプル**: selection planの未生成局面から、(a)**関連グループ**: 同一WTHOR対局(year+gameIndex)から採られた局面が2件以上あるグループを20〜30組(グループ内はply順に整列)、(b)**無関連グループ**: ランダムな親を同数。exact帯/level16帯が混在してよいが帯別に集計。
2. **アーム**(各グループについて交互実行):
   - **cold(現行)**: 親ごとに現行どおり個別バッチ(1親=1〜2プロセス)
   - **warm**: グループ内全親の全子局面を**1つのバッチファイル=1プロセス**で連続処理(親の順序=ply昇順で決定的)
   - **warm+h24**: 同上に`-h 24`を付与(長寿命ならハッシュ拡大が活きる仮説の検証)
3. **比較**: (i)全子局面のscore/bestMove/diffFromBestの完全一致(cold基準)、(ii)グループ合計elapsedの比(幾何平均、関連/無関連・帯別)、(iii)同一arm2回の決定性。
4. **レポート**(`bench/edax-compare/t127g_warm_tt_ab_report.md`、コミット対象): 値一致・speedup(関連 vs 無関連の差=TT温存効果の分離)・残り生成への外挿(乗り換え時の残り時間見積もり)・runKey/resume再設計の必要範囲の見積もり・推奨。

## 受け入れ基準

- [ ] cold vs warm(±h24)の値一致判定が帯別・全件である(不一致なら件数と最大差)
- [ ] 関連/無関連グループ別のspeedup(ペア幾何平均)がある
- [ ] 乗り換え時の残り時間見積もりと推奨判定がある
- [ ] vs_edax.pyを変更した場合: 未指定時挙動不変のテスト+pytest全パス
- [ ] 変更対象+レポートのみパス指定でコミット(`(T127g)`)
- [ ] 当該タスク由来の残差分・未追跡なし(生成中ファイル群・scratchpadは対象外)

## フィードバック(やり直し時にオーケストレーターが記入)

## 作業ログ(担当エージェントが追記)

### 2026-07-17 19:57 JST — Codex gpt-5.6-sol(codex-task)

- 実施内容: selection planの未生成WTHOR局面から、関連（同一year+gameIndex）exact/level16各10組と無関連exact/level16各10組（各2親、計40組・80親・624子）を固定seedで選定。cold（親ごと2プロセス）、warm（2親を1プロセス）、warm+h24をarm順交互化で各2回計測した。`gen_teacher_corpus.py`と生成中plan/checkpointは変更せず、既存`vs_edax.py::_edax_solve_batch`だけを利用した。結果を`bench/edax-compare/t127g_warm_tt_ab_report.md`へ記録した。
- 結果: cold対warm / warm+h24のscore・bestMove・diffFromBestはexact 210子、level16 414子で全一致（不一致0、最大score差0石）。同一arm 2回も全件一致。関連組speedupはwarmがexact 1.5568x / level16 1.0901x、warm+h24が0.9473x / 0.9292x。無関連組はwarmが1.5619x / 1.0657x。最新残件715,121件への加重warm speedupは1.3174x、現行32.55時間から24.70時間（約7.84時間短縮）と外挿した。warm移行は提示価値あり、h24は棄却と判定。
- checkpoint/resume: `train/data/teacher/t127g_scratch/results.jsonl`へstage単位append+flush+fsync。初回を69/240 stage後に中断して再開し、完了キーを再実行せず240/240へ完走することを確認した。scratchpadはgitignore対象でコミット対象外。
- 実行コマンドと結果: `python t127g_tmp.py` → 240/240 stage完走、A/B実測合計2,213.6秒、summary生成。Python受け入れ監査 → PASS（40 groups、240 stages、624 children、exact深さ完了、値/決定性不一致0、プロセス数cold=2/warm=1）。`git diff --check -- bench/edax-compare/t127g_warm_tt_ab_report.md tasks/T127g-warm-tt-ab.md` → PASS。`git status --short` → 最終確認時にレポートと本タスクログのみ（scratchpad・生成中ファイル群はgitignore対象）。
- コミットハッシュ: 未コミット（`.git`書き込み禁止のため、オーケストレーターが代行）。