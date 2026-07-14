---
id: T090a
title: Edax教師コーパス生成(smoke 1,000局面 → primary 50,000局面、全合法手teacher value付き)
status: todo # todo | in_progress | review | redo | done | blocked
assignee: implementer
attempts: 0
---

# T090a: Edax教師コーパス生成

## 目的

評価関数改善の本命(T090蒸留)の第一段: **Edax level 16 の探索値を教師とする学習用コーパス**をローカル生成する。T087(特徴追加)・T088(学習法改善)がいずれも不採用に終わり、「WTHOR最終石差ラベルの質が律速」とデータで確定したため、教師ラベル自体を置き換える。

## 委譲体制の注記

本来は難易度ルーティングでCodex対象だが、Codex利用上限(〜7/20)のためimplementer(Sonnet)へのフォールバック委譲(ユーザー承認済み)。仕様に無い設計判断が必要になったら、推測で進めず作業ログに選択肢を書いて停止し報告せよ。

## 背景・コンテキスト(必読文書)

- **設計書(規範)**: `tasks/design/T085-beat-level10-report.md` の **§9 T090a節**。
- 既存の道具(必ず再利用する): `bench/edax-compare/vs_edax.py` の Edax呼び出し(OBF一時ファイル・`-solve`・終了コード非ゼロでもstdoutパース等の既知回避策)と provenance/checkpoint 方式、`compare_pattern_v3.py` の全合法手oracle評価(same-root全子評価)、`train/src/experiment.rs` の D4 canonical化、T084 loss-analysis(`vs_edax_results.json` の高regret局面)。
- Edax本体: `bench/edax-compare/edax-extract/wEdax-x86-64.exe` + `data/eval.dat`(ローカル、非コミット)。教師データのローカル生成はユーザー承認済み方針(2026-07-14)。

## 要件(設計書§9 T090a節が規範)

1. **入力局面の抽出**(層化サンプリング):
   - WTHOR 2015〜2024 から phase別(空きマス帯)層化抽出
   - T084/T085 の自作エンジン高regret局面(`vs_edax_results.json` の loss_analysis、loss>=4石)を優先的に含める
   - X/C合法手が存在する局面を別層として確保
   - 同一opening・同一対局からの過剰抽出を制限(1対局あたり上限を設ける。値は作業者が決め、manifestに記録)
   - D4 canonical重複除去(`train/src/experiment.rs` の canonicalize を再利用)
2. **教師値**(1局面ごと):
   - 空きマス数が完全読み可能な範囲(目安: Edaxが即時exactを返す帯)は `exact` フラグ付きの厳密値
   - それ以外は Edax level 16 の探索値。level・探索深さ・elapsed を記録
   - **全合法手の teacher value を保存**(best move だけでなく、各手の best との差も保存)
3. **規模の段階制(いきなり大規模を生成しない)**:
   - まず smoke: 1,000局面 を完走させ、フォーマット・所要時間/局面・エラー率を作業ログに記録
   - 次に primary: 50,000局面(所要見込みをsmoke実測から算出して作業ログに記す。1局面あたり数秒×50k=数十時間級になる場合は、その見積もりを報告して**一旦停止しオーケストレーターの承認を待つ**)
   - 拡張200,000局面は本タスクのスコープ外(T090bの結果を見てから)
4. **長時間実行ルール(CLAUDE.md)厳守**: 1局面ごとのcheckpoint追記・resume。設定・Edax binary hash・git hash が変わったら別run keyとして既存checkpointを拒否(vs_edax.pyのprovenance方式を踏襲)。進捗(N/total、直近レート)を逐次ログ出力。
5. **成果物**: コーパスは `train/data/teacher/`(gitignore領域)に保存。**コーパス自体はコミットしない**が、生成スクリプト・manifest(件数・層別内訳・provenanceハッシュ・生成コマンド)・smoke統計はコミットする。フォーマット仕様(スキーマ)を `train/data/teacher/README.md` またはスクリプトdocstringに明記(T090bの学習が読む契約)。

## やらないこと(スコープ外)

- 蒸留学習そのもの = T090b(コーパス完成後に起票)
- 拡張200,000局面の生成
- エンジン・探索・アプリの変更(生成スクリプトはbench/またはtrain/配下の新規ファイルのみ)
- Edax以外の教師(自作エンジン深読み等)
- 生成済みコーパスのコミット(gitignore必須)

## 受け入れ基準(検証コマンド)

- [ ] smoke 1,000局面が完走し、統計(層別内訳・exact率・平均elapsed/局面・エラー0件)が作業ログにある
- [ ] 中断→resume の実地確認(smoke中に強制killして続きから再開、重複なし)と、設定/バイナリ変更時のcheckpoint拒否の確認
- [ ] primary 50,000局面が完走(または見積もり超過で停止・報告)し、manifest(件数・層別内訳・provenance)が保存されている
- [ ] コーパスの機械検証: 全レコードでteacher valueが全合法手分あること、best値=max(子値)の整合、canonical重複なし、を検証するスクリプトを実行しパス
- [ ] `git status --short` にコーパス実データが現れないこと(gitignore確認)。スクリプト・manifest・smoke統計のみコミットされていること
- [ ] `cargo test -p train` / `cargo test -p engine` 全件パス(既存回帰。エンジンは触らないので不変のはず)
- [ ] 変更対象ファイルのみパス指定でコミット・push、Actions成功確認
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)
