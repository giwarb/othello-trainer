---
id: T156b
title: MPC再校正(2/7): pilot統計のGate 1判定と(d,D)候補選定
status: todo # todo | in_progress | review | redo | done | blocked
assignee: Codex gpt-5.6-sol
attempts: 0
---

# T156b: pilot判定

## 目的

T156aのpilot統計(bench/edax-compare/t156_mpc_pilot_stats.json、4帯×66深さペア=264グループ)を設計レポート(tasks/design/T156-mpc-recalibration-report.md)の **Gate 1 基準**に照らして分析し、「MPC再投資の有望性」を判定、有望なら(d,D)候補を選定する。**コード変更は原則なし(分析とレポート)**。必要な追加集計はスクリプトで行ってよい(t156_mpc_stats.py拡張または新スクリプト、コミット対象)。

## Gate 1 基準(設計レポート§7、事前登録)

- 少なくとも1つの(d,D)候補で、shallow/deepの中央値ノード比が20%以下
- held-out相当データ(tuning/test split)の一方向誤カット率が、t=1.5なら概ね6.7%前後で、95% Wilson上限が10%以下
- 空きマス帯の一部だけ極端に悪化していない
- 正しい式でMPCプローブとカットが実際に発生する見込みがある(統計上、marginがNWS窓外プローブとして機能するか)
- 固定深さの総ノード数が少なくとも5%改善する兆候がある(概算でよい: カット率×カット時の節約ノード−プローブコストの粗い収支)

## 要件

1. 264グループの統計から、D=6,8,10(可能なら12も)について候補(d,D)を絞り込み、各候補の「残差σ・傾きa・切片b・ノード比・t=1.5/1.75/2.0の誤カット率(方向別、split別)」を表にする。
2. Gate 1の各基準への当てはめを明記し、**合否と根拠**を結論する(不合格なら「MPC OFF維持で撤退」を明言する。これも正当な結果)。
3. 合格の場合: T156c(式修正)で使う推奨(d,D)表・t値・帯結合案(隣接帯で残差分布が同等なら結合)の初期案を提示する。
4. 分析の再現性: 追加集計スクリプトはコミットし、決定的であること。
5. レポート: bench/edax-compare/t156_mpc_pilot_gate_report.md(+meta json)。

## スコープ外

- mpc.rs/search.rsの変更(T156c)、1,200局面フル測定(T156e)、対局
- 注意: 旧v2評価関数との比較測定は不要(v4のみで判定)

## 受け入れ基準

1. Gate 1の5基準それぞれへの当てはめ(数値根拠付き)と総合合否がレポートにある
2. 追加集計はスクリプト化されコミット済み・決定的(2回実行一致)
3. パス明示コミット・push、完了時 `git status --short` クリーン(コード変更はスクリプトのみのはず)

## コミット規律

- 変更対象のみパス明示add。`tasks/` と `CLAUDE.md` はコミットしない(作業ログ追記は行う)

## 作業ログ

(ワーカーが節目ごとに追記)

- 2026-07-20 18:05 JST (Codex): `t156_mpc_pilot_gate.py` を追加し、264グループから全帯共通の候補 `(d,D)=(3,6),(4,8),(2,10),(4,12)` を決定的に選定。帯別 affine 係数・残差σ・中央値ノード比、t=1.5/1.75/2.0 の方向別/split別 tail、Wilson上限、NWS `[-1,0)` root proxy と粗いノード収支を集計し、report/metaを生成した。Gate 1は `(2,10), t=1.5` を主根拠に5基準すべて合格（held-out結合 high 6/128=4.69%, U95 9.85%; low 2/128=1.56%, U95 5.52%; 最大帯ノード比0.0241%; proxy粗改善25.66%）。結論は「MPC OFFのままT156cへ進む」。
- 2026-07-20 18:05 JST (Codex): 実行確認: `python -m py_compile bench/edax-compare/t156_mpc_pilot_gate.py` 成功、`python bench/edax-compare/t156_mpc_pilot_gate.py --self-test` 成功、生成コマンドを2回実行して report SHA-256 `EC56B261A7BDFAB8527DB0B35754BB45F85C904FED8DF4AD94712B18715EC146`、meta SHA-256 `99772A5509A8F77833EC3F3E5CD81F083B8BCA3D545ADB02FAB5979A1C1A222C` が各回一致。meta仕様検証と `git diff --check` も成功。コミットハッシュ: 環境制約により未コミット（オーケストレーター代行待ち）。
