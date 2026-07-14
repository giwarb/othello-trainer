---
id: T085b
title: ノード予算の校正と採用判定(ベンチ基盤の堅牢化+A/B比較+level10 primary 60局)
status: todo # todo | in_progress | review | redo | done | blocked
assignee: codex(gpt-5.6-sol)
attempts: 0
---

# T085b: ノード予算の校正と採用判定

## 目的

T085a で実装したノード数予算ベースの決定論的探索(quota 40%、baseline-first)について、**実際に採用するノード予算値を校正し、壁時計1秒の現行系列に対する非劣性を確認して採用判定する**。あわせて、判定に使うベンチ基盤(`vs_edax.py`)の信頼性問題(T084 codex-review ブロッカー1・中所見2)を先に修正する。

## 背景・コンテキスト(必読文書)

- **設計書(規範)**: `tasks/design/T085-beat-level10-report.md` の **§2(T085b)**。
- T085a の成果(コミット ad88c91 / 05b5267 / cc6e48d): `eval_cli best --max-nodes`(決定論)、quota 40%、`budget-regression`、固定コーパス `bench/edax-compare/t085_exact_positions.json`(48局面・空き13〜30)、quota比較生データ `t085_exact_quota_comparison.json`。
- ベンチハーネス: `bench/edax-compare/vs_edax.py`(T084で single-root 対局・着手単位resume・provenance 実装済み)。
- ユーザー方針: ノード数予算が主制限、壁時計1500msは普段発動しない保険。**無駄な120局全再実行はしない**(採用判定に必要な実行のみ行う)。
- T084 codex-review の申し送り(`tasks/review/T084-bench-single-root-telemetry-codex-review.md`): resume判定の厳格化、チェックポイントのアトミック書き込み。

## 変更対象

- `bench/edax-compare/vs_edax.py` — 前提修正2件+node-budget系列のA/B実行サポート
- `bench/edax-compare/t085_exact_quota_comparison.json` — 改行をLFに正規化(T085a codex-review軽微1。次に触るタスクで直す申し送り)
- `engine/src/bin/eval_cli.rs` — usage表示に `budget-regression` と `--exact-quota-percent` を追記(T085a codex-review軽微2。機能変更はしない)
- 成果物: `bench/edax-compare/` 配下の校正結果JSON+判定レポート(ファイル名は作業者が既存慣例に合わせて決定し作業ログに明記)

## 要件

### 前提修正(ベンチ実行より先に行い、以後の実行はすべて修正版で行う)

1. **resume判定の厳格化**(T084ブロッカー1): `try_resume()` の互換性判定に、設定値(runKey)に加えて (a)エンジン/ハーネスのソースID(gitTree等)、(b)重みファイルのハッシュ、(c)Edaxバイナリのハッシュまたはバージョン、(d)実際に実行する `eval_cli.exe` のハッシュ、を含める。不一致なら既存チェックポイントを**拒否**する(黙って続行しない)。`ensure_engine_built()` はバイナリ存在時もソースが新しければ再ビルドする(または常に `cargo build --release` を実行し、ビルド後のバイナリハッシュを provenance に保存する)。
2. **チェックポイントのアトミック書き込み**(T084中所見2): 一時ファイルに書いてから `os.replace()` で置換する方式に変更(書き込み中クラッシュでJSONが破損しないこと)。

### 校正と採用判定(設計書§2)

3. **比較系列**: (1)現行 wall系列 depth10/exact18/wall1000/node無制限、(2)node 160k/wall1500、(3)node 200k/wall1500、(4)node 240k/wall1500、(5)node 300k/wall1500。wall系列とnode-budget系列は**別run key**にする。
4. **主判定は固定局面 oracle regret**: 48局面固定コーパス(+必要なら既存 loss-analysis 225局面)で各系列の Edax level 16 oracle regret を計測し比較する。20局スモークだけで採用を決めない。
5. **候補を1つに絞った後、level 10 primary 60局**(openingマニフェストの primary 30局面×両色)を実施する(最終非劣性確認)。全系列で60局を回すのは禁止(時間節約)。
6. **採用条件**(すべて満たす中で**最小**のノード予算を選ぶ):
   - 決定性100%(同一設定2回で完全一致)
   - wall保険(1500ms)発動5%以下
   - depth0(static-only)ゼロ
   - 現行wall系列より平均 oracle regret が悪化しない
   - 20局スモークの平均石差が3石以上悪化しない
7. **長時間実行ルール(CLAUDE.md)厳守**: 1局/1局面単位のチェックポイント追記・resume・進捗ログ。フェーズ節目でタスクファイルの作業ログに追記。

## やらないこと(スコープ外)

- アプリ/Workerプロトコルへの配線 = T085c(採用値が決まってから)
- エンジン探索ロジックの変更(quota値・切替条件の再調整等はT085aで確定済み。校正で重大な問題が見つかった場合は変更せずレポートして停止)
- TT置換規則(T086)以降の施策
- wall系列の120局再実行(T084の確定結果を比較基準として再利用する。ただし採用判定に必要な系列の新規実行は行う)

## 受け入れ基準(検証コマンド)

- [ ] resume厳格化: エンジン再ビルドやEdax/重み差し替えを模擬した不一致条件で、既存チェックポイントが拒否されること(テストまたは実地再現の証跡を作業ログに記録)
- [ ] アトミック保存: 保存処理が一時ファイル+`os.replace()` 方式であること(コード確認+書き込み中断シミュレーションで破損しないこと)
- [ ] 4候補+現行系列の固定局面 oracle regret 比較データがJSONで保存され、採用条件の判定表が作業ログまたはレポートに記録されている
- [ ] 採用候補の level 10 primary 60局が完走し、1局単位チェックポイント・resume・進捗ログが機能している
- [ ] 採用値と判定根拠(採用条件6項目それぞれの実測値)が明記されている
- [ ] `t085_exact_quota_comparison.json` がLF改行に正規化され、`git diff --check` がクリーンであること
- [ ] `eval_cli --help`(または usage 表示)に `budget-regression` と `--exact-quota-percent` が記載されている
- [ ] `cargo test -p engine` 全件パス(eval_cli usage変更の回帰確認)
- [ ] コミット対象ファイル一覧が最終メッセージに明記されている(コミット・pushはオーケストレーター代行)
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと(コミット代行後)

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)
