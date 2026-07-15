---
id: T114
title: 拡張教師コーパス200k生成(teacher-only蒸留の本命データ)
status: in_progress # todo | in_progress | review | done | blocked
assignee: implementer(Sonnet, Codex上限フォールバック)
attempts: 0
---

# T114: 拡張教師コーパス200k生成

## 目的

T113でteacher-only蒸留の学習曲線が強い単調改善(R²=0.97)を示し、**200k局面で oracle regret ≈1.92石(現行v2=1.57石に肉薄)** の外挿が得られた(ユーザー裁定 2026-07-16: 「200kを今すぐ生成開始」)。T090a(50k)と同一設計・**T094のバッチ化+決定性(`-n 1`)仕様**で200,000局面の教師コーパスを生成する。生成後のteacher-only学習・v3/ステージ実験は後続タスク。

## 委譲体制の注記

- Codex週間上限(リセット7/22 6:00)のためimplementer(Sonnet)フォールバック。
- **別セッションでT105(終盤ソルバー、NPSゲートあり)が並行実行中**。本タスクの生成はCPU重負荷・長時間のため、以下の調整を厳守:
  - 生成プロセスの並列シャード数はT094の本番構成に従う(生成効率優先。ユーザーが生成開始を承認済み)。
  - **STATUS.mdの調整ルール**: T105側が公式NPS計測を行う際は生成を一時停止できる。生成はシャード/局面単位checkpointからresume可能であること(=いつkillされても損失ゼロ)を起動前に確認する。

## 背景・既存資産(必読)

- `tasks/T090a-teacher-corpus.md` — 50kコーパスの設計(WTHOR 2015-2024層化抽出+engineLoss優先層、全合法手評価値、exact帯(空き24以下)はEdax完全読み・それ以外level 16、D4重複除去、manifest/provenance、verify)。**本タスクは同一設計のスケール版**。
- `tasks/T094-*.md`(tasks/内で検索) — 局面単位バッチ化(壁時計-64.6%)と`-n 1`決定性仕様。**本番生成はこの経路を使う**(旧50kは非決定世代でmanifestフラグ識別可、今回は決定的世代)。
- 生成: `bench/edax-compare/gen_teacher_corpus.py`、検証: `verify_teacher_corpus.py` / `test_teacher_corpus.py`、manifest: `bench/edax-compare/teacher_manifests/`。
- 出力先: `train/data/teacher/`(gitignore領域)。manifest(コミット対象)は既存流儀に従う。

## 要件

1. **規模**: 200,000局面(既存primary 50kとは独立の新規生成。局面選定seedを変えて重複を避けるか、既存50kを包含する設計にするかは既存スクリプトの設計に従い、選択と理由を作業ログに明記)。
2. **オラクル汚染の防止(重要)**: `bench/edax-compare/t096_oracle_positions.json` の60局面(およびそのD4対称形)が**新コーパスに混入しないこと**を選定段階で除外し、生成後にも機械検証する(oracleは独立評価セットとして今後も使うため。混入すると全実験の主指標が自己参照になる)。
3. **決定性**: T094の`-n 1`仕様で生成し、manifestに決定的世代であることを記録する。
4. **長時間実行ルール(CLAUDE.md)厳守**: シャード/局面単位のcheckpoint追記・resume・進捗ログ(何件中何件完了)を起動前に確認。**起動直後に「最初のcheckpointが実際に書かれる」ことを確認してから**長時間実行に入る(T082の教訓)。実行はrun_in_background可(生成スクリプト自体が進捗を外部観測可能なため)。
5. **検証**: 完了後に verify_teacher_corpus.py(全件・否定テスト)+スキーマ契約検査+oracle非混入チェックを実行し、結果を作業ログへ。manifest/provenanceを完備する。
6. **完了時**: manifest等のコミット対象をパス明示でコミット(データ本体はgitignore)。生成の所要時間・シャード構成・中断/再開の有無を作業ログに記録。

## やらないこと(スコープ外)

- 学習の実行(後続タスク: teacher-only 200k学習+v3/ステージ実験)
- コーパス設計の変更・分布多様化(ユーザー裁定で「現行設計のまま」。多様化は将来の増分バッチ候補)
- 採否判定・アプリ配線

## 受け入れ基準(検証コマンド)

- [ ] 200,000局面のコーパスが `train/data/teacher/` に生成され、verify(全件)がパス
- [ ] t096 oracle 60局面(D4含む)の非混入が機械検証されている
- [ ] manifestに決定的世代(`-n 1`)・生成構成・provenanceが記録され、コミットされている
- [ ] 生成がcheckpoint/resume対応で行われた記録(進捗ログ・中断があれば再開記録)が作業ログにある
- [ ] `cargo test -p train` / `python -m pytest bench/edax-compare/test_teacher_corpus.py`(または既存の検証コマンド)がパス
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと(T105由来は除外)

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)
