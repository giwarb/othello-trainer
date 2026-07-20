---
id: T156c
title: MPC再校正(3/7): カット式・適用境界・runtime制御の修正実装(default OFF)
status: todo # todo | in_progress | review | redo | done | blocked
assignee: Codex gpt-5.6-sol
attempts: 0
---

# T156c: MPC本体の修正(OFFのまま)

## 目的

設計レポート(tasks/design/T156-mpc-recalibration-report.md、§(c) T156c節と§5が正)に従い、**正しいMPCをdefault OFFのまま実装**する。Gate 1は合格済み(T156b、候補(d,D)=(3,6),(4,8),(2,10),(4,12)、t=1.5基準)。有効化・採否判定は後続タスク(T156d以降)。

## 要件(設計レポート§3.1・§5・§(c)T156c節に忠実に)

1. **カット式の修正**: 現行の内向きmargin(`beta - margin`/`alpha + margin`)を**外向き**(fail-high: `a*shallow + b - margin_high >= beta`相当、fail-low: `a*shallow + b + margin_low <= alpha`相当)へ。affine係数(a,b)はQ16等の固定小数点整数、方向別margin、丸めは方向別に明示的ceil/floor(native/WASM差防止)。
2. **(d,D)ペア表**: 固定REDUCTION=2を廃止し、(empty_bucket, D, d)キーのテーブルへ(T156bの候補4ペア+pilot統計の係数を初期値として埋め込み。テーブルは後でT156eの確認校正で確定するため差し替え容易に)。
3. **ガード類**: PV番兵窓ガード維持、recursive MPC禁止維持、**exact境界ガード**(`empties > exact_from_empties + D`)、**プローブ中はexact無効**(`exact_enabled=false`、全return経路で復元)、MPCカット自身を深さDの厳密TT entryとしてstoreしない。
4. **runtime制御**: feature flag一括でなく、探索ポリシー(enable_mpc等)で経路別に切替可能に(既定は全経路OFF。analyzeAll・終盤ソルバー・exactは構造的に対象外)。既存feature `mpc_enabled` の扱いは「コードを含めるか」に限定する方向で整理(最終形はT156fで裁定、当面は互換維持でよい)。
5. **テレメトリ**: 設計§6のカウンタ(mpcEligibleNodes/ProbeAttempts/ProbeNodes/Cuts/Skipped系/深さヒストグラム)を追加(テスト・ベンチから読める形)。
6. **テスト(Gate 0、設計§7)**: 外向きmargin式の単体テスト、境界直前直後テスト、NWS幅1で外側プローブ窓が構築できること、PV番兵窓不発、exact境界不発、プローブがexact quota不消費、ノード上限中断後のフラグ復元、MPC ON同一入力2回で完全一致。**default OFFで既存全テスト・FFO・決定性が完全不変であること**(OFF時はビット単位で従来同一が理想。差分が出る場合は理由を明記)。

## スコープ外

- MPCの有効化・採否判定・ベンチ比較(T156d)、確認校正(T156e)、本番配線(T156f)、対局(T156g)
- app変更(Pages確認不要)。ANALYSIS_ENGINE_VERSIONも不変(OFFのままなので表示値不変)

## 受け入れ基準

1. Gate 0テスト一式がグリーン(`cargo test -p engine`全パス、新規テスト含む)
2. default OFFで FFO fast 正解不変・既存決定性テスト全パス(挙動完全不変の確認)
3. `cargo test -p train` 全パス(触った場合)
4. 変更ファイルはパス明示でコミット準備(Codexはコミット不可のため、変更ファイル一覧と検証結果を完了報告に明記。コミットはオーケストレーター代行)
5. 完了時、スコープ外の差分を作らない

## コミット規律

- `tasks/` と `CLAUDE.md` は変更しない(作業ログ追記は行う)。一時ファイルを残さない

## 作業ログ

(ワーカーが節目ごとに追記)
