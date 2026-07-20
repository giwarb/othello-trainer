---
id: T158d
title: 評価特徴追加(4/4): 対Edax対局ゲート — 段階1: パイロット6局(3ペア)
status: done # 段階1(パイロット3ペア12局)完了: verifier合格(全数値独立再集計一致・SHA5点追試一致)、watch-point数値誤記はredoなしの追修正で解消(13c2e32)。段階2(60局本実行、約29分)はユーザー判断待ち、2026-07-21
assignee: implementer
attempts: 0
---

# T158d: 対Edax対局ゲート(段階1: パイロット)

## 目的

T158シリーズ最終段。スクリーニング通過済みの候補重み **B3 seed2** が、本番v4重みより実対局で強いか(少なくとも悪化しないか)を対Edax pairedゲートで判定する。本来は30ペア=60局だが、**ユーザー指示(2026-07-21)によりまず小規模パイロットを実行して所要時間と傾向を評価する**。本タスクは段階1(パイロットのみ)。60局本実行は結果を見てユーザーが判断する。

## 前提(すべて確定済み・変更禁止)

manifest: `bench/edax-compare/t158c_screening_report.meta.json` の `deferredT158d` 節。

- 候補重み: `train/data/t158/full/t158-b3-seed-2.bin`(SHA-256 `dae9af0b4d9e3322c6e2181071b095bca1f2272e69ba85d0e828f21e29c7c5ec`)— gitignore領域。実行前にSHA-256を実測しmanifestと一致確認(不一致なら即停止・報告)
- baseline重み: `train/weights/pattern_v4.bin`(SHA-256 `c372b833...639e383f`、同様に実測確認)
- 開幕セット: manifestの `openingSetSha256` が指すprimaryセット(30ペア)。**パイロットは先頭3ペア=3開幕×色交換=6局**
- 対局プロトコル: manifestの `protocol` 節(160,000ノード・1500ms・exactFromEmpties 16・quota60%・空き20以下無制限・depth12・TT 64MiB)
- Edax: manifestの `edax` 節(実行ファイル・eval.datのSHA-256を実測確認)。レベル等の対局条件は過去の本番採用ゲート(T125、`bench/edax-compare/endgame-results/t125-vs-edax-results.json` とそのレポート)と同一にし、採用した条件を根拠(T125メタの該当値)付きでレポートに明記する
- ハーネス: 既存の `bench/edax-compare/vs_edax.py` を使う(新規ハーネスを書かない)。パイロット局数の制限・checkpoint対応のための最小限の改修は可(既存の挙動・既存結果ファイルは不変)

## 要件

1. **paired構成**: 各開幕ペアについて「候補 vs Edax」「v4 vs Edax」を同一開幕・同一色割当で対局し、ペア単位の石差を比較する。パイロットは3ペア → 候補6局+v4 6局=計12局。
   - v4側について、T125等の過去結果の再利用は**開幕・プロトコル・Edax設定がSHA/メタで機械的に完全一致すると確認できる場合のみ**可(その場合は根拠をレポートに記載し、対局は候補6局のみでよい)。一致確認できなければ両方走らせる。
2. **長時間実行ルール**: 1局終了ごとにatomic checkpoint(JSON追記/置換)・resume対応・進捗ログ(何局目/経過時間/直近結果)。実行はPowerShell `Start-Process` detached+ツール呼び出しポーリング(**Bash run_in_background・Monitor通知依存は禁止**=不達実績あり)。
3. **時間計測**: 1局ごとの所要時間(wall clock)を記録し、**60局(+必要ならv4側60局)本実行の所要時間見積り**をレポートに書く(ユーザーの本実行判断材料)。
4. **レポート**: `bench/edax-compare/t158d_pilot_report.md`(+`.meta.json`)。内容: 6局(または12局)の結果表(開幕・色・石差・勝敗・所要時間)/候補vs v4のペア差分/異常(クラッシュ・非法手・非決定)の有無/60局見積り/**判定はしない**(パイロットは情報収集であり、n=3ペアで強弱の結論を出さない旨を明記)。
5. 検証watch-point(レビュー申し送り): 空き19前後(終盤入口)で候補側に不審な悪手・石差急落がないか、局ごとの棋譜/石差推移で定性確認しレポートに一言書く。

## スコープ外

- 60局本実行(ユーザー判断待ち。checkpointは30ペア全体スケジュールの先頭6局として保存し、本実行時にresumeで続きから走れる形にする)
- 採否判定・本番採用・重みの`train/weights/`への配置
- engine/trainコードの変更

## 受け入れ基準

1. パイロット全局が完走し、レポート+metaに結果表・時間見積り・SHA検証結果(候補/baseline/Edax/開幕セット)がある
2. checkpoint/resumeが実装され、中断→再開の実地確認(1回でよい)がレポートに記録されている
3. 異常(クラッシュ・非法手・非決定性)0件(発生時は停止して報告)
4. 既存ファイル(t157系・t158a/b/c成果物・T125結果)の値を変更していない
5. タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと(成果物はコミット対象、コミットは自分で行いパスを明示してadd。`git add .`/`-A`禁止。`tasks/`とCLAUDE.mdはコミットしない)

## 作業ログ

### 2026-07-21 実装完了(implementer)

1. **前提SHA-256実測**: `t158c_screening_report.meta.json`の`deferredT158d`節と、候補重み(`train/data/t158/full/t158-b3-seed-2.bin`)・baseline重み(`train/weights/pattern_v4.bin`)・Edax実行ファイル・`eval.dat`・`openings.json`の5点をすべて`certutil -hashfile`で実測し、manifest記載値と完全一致を確認(不一致なし、停止条件に該当せず続行)。
2. **T125再利用可否の検証**: `endgame-results/t125-vs-edax-results.json`のmeta/runKeyを確認。開幕セットSHA・Edax実行ファイルSHA・eval.dat SHA・v4重みSHA・プロトコルパラメータは一致したが、**gitCommit・evalCliSha256(エンジンバイナリ)が不一致**。`git log --oneline ed22fd27b9..HEAD -- engine/`でT125以降に10件のengine/変更コミットがあることを確認し、「機械的完全一致」不成立と判定 → 要件どおりv4側も新規に6局を実行することにした(候補6局のみでは済まさなかった)。
3. **ハーネス改修**: `bench/edax-compare/vs_edax.py`に`--opening-limit N`(既定None、対局(match play)のopeningを先頭N件に制限、fixed-depth/node-budget決定性チェックには不影響、settingsに記録)と、各対局の`wallClockSec`(壁時計所要時間、進捗print行にも表示)を追加。既存呼び出しの挙動は不変(自己テスト`--self-test-checkpoint`で確認)。コミット`04dd37a8`(vs_edax.py単体、`git add`はパス明示)。
4. **候補パイロット実行**: `--opening-set primary --opening-limit 3 --engine-modes single-root --levels 10 --engine-depth 12 --engine-exact-from-empties 16 --engine-time-ms 1500 --engine-max-nodes 160000 --engine-exact-quota-percent 60 --unlimited-exact-empties 20 --engine-tt-mb 64 --weights train/data/t158/full/t158-b3-seed-2.bin --skip-loss-analysis`をPowerShell `Start-Process`でdetached起動、ログ/checkpointをポーリングして完走確認(fixed-depth 40/40 PASSED、node-budget 10/10 PASSED、6局完走、所要95秒)。結果: 1勝5敗、平均石差-17.00。
5. **v4パイロット実行**: 同条件で`--weights train/weights/pattern_v4.bin`のみ変更して逐次実行(候補実行完了後に開始、CPU競合回避のため並行実行せず)。fixed-depth/node-budget決定性ともPASSED、6局完走、所要104秒。結果: 0勝6敗、平均石差-24.67。
6. **中断→再開の実地確認**: scratchpad上で候補重み・1開幕(2局計画)の別実行を用意し、1局完了後に`Stop-Process -Force`で強制終了 → 結果ファイルに1局のみ永続化されていることを確認 → 同一コマンドで再実行し`[resume] loaded 1 already-completed game(s)`・fixed-depth/node-budget決定性チェックのスキップ・2局目のみの新規対局・最終2/2完走(1局目の値が中断前と不変)を確認。PASSED。
7. **watch-point定性確認**: 12局全ての空き16〜22区間の`discDiff`推移を確認。空き20到達で完全読みに切り替わり最終石差に収束する想定どおりの挙動。候補固有の不審な悪手・石差急落は確認されず(唯一の大きい乖離局面はv4側も同開幕で敗北しており開幕自体の不利と判断)。
8. **60局本実行の所要時間見積り**: 候補6局80.4秒(平均13.39秒/局)、v4 6局89.6秒(平均14.93秒/局)、固定オーバーヘッド約14〜15秒/実行から、60局本実行は候補側約818秒(13.6分)+v4側約911秒(15.2分)=**合計約29分(逐次実行)**と見積もり、安全側30〜45分を推奨する旨をレポートに明記。両実行の逐次実行の必要性(wall-clock時間予算の並行実行によるCPU競合汚染リスク)も明記。
9. **レポート作成**: `bench/edax-compare/t158d_pilot_report.md`・`.meta.json`を作成。判定は行わず(要件どおり)、n=3ペアでは結論を出さない旨を明記。
10. **コミット**: `bench/edax-compare/vs_edax.py`(コミット`04dd37a8`)と`bench/edax-compare/t158d_pilot_report.md`+`.meta.json`(コミット`ec411a3`)を別々に、パス明示で`git add`しコミット(`git add .`/`-A`は使用せず)。生の対局ログ(`bench/edax-compare/endgame-results/t158d-candidate-vs-edax-results.json`等)は既存の`.gitignore`ルール(T098由来、`bench/edax-compare/endgame-results/`全体を除外、報告用の`-report.md`のみ個別に過去force-add済み)に従いローカルのみとし、force-addしなかった(T107/T108/T121/T125の前例と同じ扱い)。
11. **受け入れ基準確認**: 完了時点で`git status --short`はクリーン(`tasks/`配下の本ファイル編集分を除く)。`tasks/`・`CLAUDE.md`はコミットしていない(オーケストレーター担当のため)。

実行コマンド・結果の詳細・SHA-256全文は`bench/edax-compare/t158d_pilot_report.md`・`.meta.json`を参照。

### 2026-07-21 verifier検収後の修正(implementer)

verifier合格後、コーディネーターより「セクション5(watch-point定性確認)の数値取り違え」の指摘を受けた。生JSON(`endgame-results/t158d-candidate-vs-edax-results.json`・`t158d-v4-vs-edax-results.json`)からbudgeted→exact乖離を全12局について再計算し確認した:

- 候補側の実際の最大乖離: **primary-02/black、空き22で-16.83→空き20で-38.00、乖離21.17石**(初版の「候補側最大約7石(primary-01/black)」は誤り。指摘どおり初版の約3倍)。
- 同一開幕(primary-02/black)でのv4側乖離は3.79石(初版の「v4側最大約4石(primary-01/black: -35.74→-36)」は誤り。この局は`exactFallback=true`で実際の乖離は0.26石)。
- 追加確認: v4自身の全6局中の最大乖離は実際にはprimary-03/white(5.32石)であり、primary-02/blackの3.79石はv4の最大値ではない。候補側最大(21.17石)はv4自身の最大(5.32石)と比べても約4倍大きい。候補6局の乖離絶対値平均は約9.7石、v4は約1.9石。
- `bench/edax-compare/t158d_pilot_report.md`のセクション5・8を上記の正しい数値・開幕対応に書き直し、候補側の乖離幅がv4よりはっきり大きいという非対称(初版で見落としていた点)を60局本実行の重点観察項目として明記した。結論の骨子(勝敗自体はv4も同局面で敗北しており候補固有の逆転負けではない)は維持。
- `t158d_pilot_report.meta.json`の`watchPointEmpties19.finding`は元々primary-02/black(-16.83→-38)を正しく記載しており誤記がなかったため変更なし。修正後の`.md`と矛盾しないことを確認した。
- 修正版をコミット`13c2e32`(`bench/edax-compare/t158d_pilot_report.md`のみ、パス明示でadd)。
