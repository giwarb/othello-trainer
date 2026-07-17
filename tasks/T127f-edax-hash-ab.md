---
id: T127f
title: Edaxハッシュ拡大の値一致+速度A/B(1M生成の乗り換え判定材料)
status: in_progress # todo | in_progress | review | redo | done | blocked
assignee: Codex gpt-5.6-sol(codex-task)
attempts: 0
---

# T127f: Edaxハッシュ拡大A/B

## 目的(ユーザー指示 2026-07-17 夕)

走行中のexpanded1m生成(残り約77万件・約40時間)を「Edaxハッシュ拡大(`-h`)で作り直すべきか」を数時間で判定する材料を作る。判定式: **値が完全一致 かつ 実測15%以上高速 → 生成を止めて乗り換え**(新規分3.4%のみ破棄)。それ以外 → 現行続行。

## 厳守事項(生成が並行稼働中)

- **実行中の生成プロセス(python 8シャード+Edax群)に一切触れない・killしない。**
- **`bench/edax-compare/gen_teacher_corpus.py`は変更しない**(生成中コード凍結)。`vs_edax.py`への変更は**「新フラグ未指定時は1バイトも挙動が変わらない」加算的な形**に限定する(走行中プロセスはメモリロード済みだが、クラッシュ時のresume安全のため)。
- 計測はCPU競合下になるが、**with/withoutを同一負荷下で交互実行するペア比較**にすることで公平性を保つ(絶対値でなく比率で判定)。

## 要件

1. `vs_edax.py::_edax_solve_batch()`に任意引数(例: `edax_hash_bits: int|None = None`、Noneなら現行どおり`-h`を渡さない)を追加。既存呼び出しはすべてNone(挙動不変)。
2. **A/Bスクリプト**(scratchpadまたはbench/edax-compare/の一時扱い): expanded1mのselection planから**未生成の局面をサンプル**(exact帯・level16帯それぞれ150親程度、決定的に選ぶ)し、各親の子局面を現行設定(hashなし)と`-h 22`(64MiB)・`-h 24`(256MiB)で**交互に**ラベル付け。
   - **値の比較**: score/bestMove/diffFromBestが全件一致するか(1件でも不一致なら「値変化あり」と結論)。exact帯は理論上一致するはず、level16帯が本題。
   - **速度の比較**: ペアごとのelapsed比(幾何平均)。exact帯/level16帯を分けて報告。
   - 決定性: 同一設定2回で完全一致することも確認。
3. サンプルのラベル結果は一時ファイル(scratchpad)に保存し、リポジトリ・train/data/teacher/を汚さない。**生成中のcheckpoint/planファイルへの書き込み禁止**(読み取りのみ)。
4. レポート: 値一致の有無・帯別speedup・乗り換えた場合の残り時間見積もり(残り77万件×短縮率)・推奨判定を `bench/edax-compare/t127f_edax_hash_ab_report.md`(コミット対象)に。
5. `python -m pytest bench/edax-compare/ -q` 全件パス(vs_edax.py変更の回帰確認)。

## やらないこと(スコープ外)

- 生成の停止・再開・乗り換え実施(オーケストレーターがA/B結果を見て判断)
- 親またぎバッチ化(4M判断の別件)
- gen_teacher_corpus.pyの変更

## 受け入れ基準

- [ ] 値一致判定(全件一致/不一致の別、不一致なら件数と最大差)が帯別にある
- [ ] 帯別speedup(ペア幾何平均)と残り時間の見積もりがある
- [ ] 既存呼び出しの挙動不変(フラグ未指定でコマンドラインが従来と同一)のテストがある
- [ ] pytest全パス
- [ ] vs_edax.py+レポートのみパス指定でコミット(`(T127f)`)
- [ ] 当該タスク由来の残差分・未追跡なし(生成中ファイル群は対象外)

## フィードバック(やり直し時にオーケストレーターが記入)

## 作業ログ(担当エージェントが追記)

- 2026-07-17 Codex: `vs_edax.py::_edax_solve_batch()`へ既定`None`の`edax_hash_bits`を加え、指定時だけ`-h <bits>`をコマンド列へ追加した。既存呼び出しは変更せず、scratchpad一時pytestで未指定時のコマンド列が従来と同一（`-h`なし）であることと、22指定時だけ`-h 22`が入ることを確認（1 passed）。
- expanded1m selection plan SHA `2f26451299ea000c2ee118ab91330d1cdbc283903b0f23474b882210f2698483`からsnapshot時点の未生成局面を固定seedで決定的にexact/level16各150親選び、hashなし対h22/h24の直結・先後交互ペアと各設定2回の決定性確認を実行。scratchpad `%TEMP%\t127f_edax_hash_ab`へstage単位append+flush+fsync（resume対応）し、生成中plan/checkpointは読み取りのみ。6,149.4秒で全1,200 stage完走。
- 結果: exact 840子、level16 1,676子のscore/bestMove/diffFromBestはh22/h24とも不一致0・最大差0石。同一設定2回も全件一致。幾何平均speedupはexact h22=0.9899x/h24=0.6409x、level16 h22=0.9986x/h24=0.8301x。残件帯比率でh22=0.9943x（40.23時間）、h24=0.7304x（54.76時間）と推定し、15%以上高速を満たさないため現行続行を推奨。レポート`bench/edax-compare/t127f_edax_hash_ab_report.md`を作成。
- 検証: `python -m pytest bench/edax-compare/ -q` 46 passed、`git diff --check` PASS。コミットハッシュ: 未作成（`.git`書き込み禁止のためオーケストレーターが代行）。コミット対象は`bench/edax-compare/vs_edax.py`と`bench/edax-compare/t127f_edax_hash_ab_report.md`のみ（タスク作業ログはコミット対象外）。
