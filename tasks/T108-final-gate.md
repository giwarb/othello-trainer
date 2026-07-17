---
id: T108
title: 終盤ソルバー強化シリーズ最終ゲート計測(Edax壁時計比・60局対局)
status: done # todo | in_progress | review | redo | done | blocked
assignee: Codex gpt-5.6-sol(codex-task)
attempts: 0
---

# T108: 終盤ソルバー強化シリーズ最終ゲート計測

## 目的

終盤ソルバー強化シリーズ(T098〜T107、+T116の終盤予算分離)の**最終ゲート計測**。採用施策がすべて本番に入った現時点の実力を、T098で確立したベンチ契約で正式計測し、シリーズの合否(Edax壁時計比)と実戦棋力(対Edax対局)を確定させる。**計測のみ・エンジンのコード変更禁止**(ハーネス・スクリプトの必要最小限の拡張は可)。

## 規範文書・前提

- `tasks/design/T097-endgame-solver-report.md` §5 T108節・C1/C2/C3ベンチ契約。
- `tasks/T098-endgame-bench-baseline.md`(tasks/内でT098-*を検索): baseline確定値(Edax壁時計幾何平均135.7倍・p90 514倍、C2 160k完走1/60)、ハーネス(`bench/edax-compare/endgame_bench.py`、checkpoint方式)。
- 現在の本番設定: quota60%(T107、コミット7e9b121)+**空き20以下は予算無制限・wall保険なしの完全読み**(T116、コミット0452815、app層の`ENDGAME_UNLIMITED_EMPTIES_THRESHOLD=20`でリミット切り替え)。
- **専有CPU可**: 生成・学習系のバックグラウンドプロセスは停止済み。壁時計計測は他の重負荷と並走しないこと(自分が走らせる計測ジョブ自体の並列度は既存ハーネスの流儀に従う)。

## 合格線(シリーズの判定基準、設計レポート§5)

- **空き20〜24帯のEdax壁時計比 幾何平均5倍以内 = シリーズ完了**。2倍以内=ストレッチ(常に併記)。
- 幾何平均が5倍を超えても**計測タスク自体は完了**とする(シリーズ継続可否はオーケストレーター/ユーザーが判定)。数字を正確に出すことが本タスクの成果物。

## 要件

1. **C1/C2/C3ベンチの正式計測**(T098契約どおり、専有条件・checkpoint/resume対応):
   - C2(空き20-24の60局面)のEdax壁時計比(幾何平均・中央値・p90)を、**本番相当の設定**で計測する。「本番相当」は2系統を計測して併記する:
     (a) **無制限完全読み経路**(T116の本番: 空き20以下はmaxNodes/timeMsなし。eval_cli solve相当の全幅) — これが現在の実戦の姿。
     (b) 参考: 160kノード予算経路(旧来の比較可能性のため)。
   - Edax側は既存ハーネスの流儀(同一局面・同一条件)。
2. **E50は参考記録のみ**(ゲートに使わない — 2026-07-16裁定、STATUS申し送り)。
3. **FFO #40-49の正解値不変+壁時計**を記録(現行コミットで)。
4. **対Edax level10 60局対局**(`bench/edax-compare/vs_edax.py`、openings.json既存プロトコル):
   - **本番のCPU方針を対局ハーネスに反映すること**: 空き21以上=160k/quota60%/wall1500ms、**空き20以下=無制限完全読み**(T116のapp層切り替えと同じ方針)。vs_edax.py側にこの切り替えが無い場合は最小限の拡張を行い、run keyに反映する(過去の対局結果と区別できるように)。
   - 60局の勝敗・平均石差を集計し、シリーズ開始時(-37.2)・T089a後(-25.6)と比較する。ただし**過去数値はquota40%・T116なし世代のため参考比較**であることをレポートに明記。
   - 空き20以下で1手数秒かかるため対局時間が従来より伸びる(見積もりを作業ログに)。
5. **決定性**: 同一入力再実行での一致確認(サンプルでよい)。
6. **レポート**: `bench/edax-compare/endgame-results/t108-report.md`(コミット対象)に、C2幾何平均(5倍/2倍ラインとの比較)・E50参考値・FFO・60局結果・環境条件(専有・コミットSHA)・過去比較の注意をまとめる。
7. **長時間実行ルール(CLAUDE.md)厳守**: 対局・ベンチとも局/ジョブ単位のcheckpoint追記とresume、進捗の外部観測可能性。中断されても損失ゼロであること。

## 申し送り(計測設計に織り込むこと)

- 過去ベンチJSON(t085/t098系)は**quota40%世代**。素の数値比較をしない(eval_cliのCLIデフォルトは60に変更済み。checkpointのevalCliSha256で新旧混入は構造防止済み)。
- 校正用eval_cliのTT容量(16MiB)と本番WASM(64MiB)の不一致問題(T085c申し送り) — 計測メタデータにTT容量を明記する。
- vs_edax.py申し送り: (1)run keyへopenings.jsonの内容SHA-256追加、(2)冒頭docstringの事前ビルド説明が古い — 触るならついでに直してよい(必須ではない)。
- T107検収観点: root空き14〜17・24〜28帯のregretは未測定のまま(本タスクで測る必要はないが、レポートの限界事項として記載)。
- 時間計測は専有状態で(既知: 環境負荷で実測が数倍膨らむ実例あり)。

## やらないこと(スコープ外)

- エンジン(engine/)・アプリ(app/)のコード変更(計測ハーネスの最小限の拡張のみ可)
- 評価関数・学習系の変更(200k学習はT120)
- 新たな高速化施策の実装

## 受け入れ基準(検証コマンド)

- [ ] C2のEdax壁時計比(幾何平均・中央値・p90)が(a)無制限経路・(b)160k経路の2系統で確定し、5倍/2倍ラインとの比較がレポートにある
- [ ] E50参考値・FFO正解値不変の記録がある
- [ ] 対Edax level10 60局の勝敗・平均石差が確定し、ハーネスのrun keyが本番方針(T116切り替え)を反映している
- [ ] 全計測がcheckpoint/resume対応で実行された記録がある
- [ ] `bench/edax-compare/endgame-results/t108-report.md` がコミットされている(変更対象ファイルのみパス指定、`(T108)`)
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと

## フィードバック(やり直し時にオーケストレーターが記入)

## 作業ログ(担当エージェントが追記)

### 2026-07-17 10:23 JST Codex実装・正式計測

- 実装: `endgame_bench.py`の速度系列を無制限/160kの独立checkpoint sectionへ分離し、両方でwarmup 1回・順序交互3反復・局面中央値・幾何平均/中央値/p90を集計するよう最小拡張した。`vs_edax.py`へquota、空き20以下のT116無制限切替、TT容量を追加し、run keyと各手テレメトリへ記録した。`openings.json`内容SHA-256は既存実装ですでにrun keyへ含まれていたため維持した。engine/appは変更していない。
- 長時間実行設計: C1/C2/C3/速度は1 jobごと、対局は1局ごとにatomic保存。C2の再実行で540/540 skip、正式対局の再実行で60/60 skipを確認。FFO無制限、速度2系列、対局は別checkpoint/sectionで新旧混入を防止した。生成checkpoint/集計JSONは既存`.gitignore`対象。
- 事前見積もり: T116の空き20以下で1手数秒、旧無制限速度最重局面約34分を根拠に、60局は数十分〜数時間、無制限速度3反復は約40分と見積もった。実測は正式対局コマンド704.5秒（freshness build/PV sanity/決定性込み）、無制限速度3反復2348.8秒。FFO #45〜49は25.4〜514.8秒/問だった。
- C2壁時計（空き20〜24、34局面、64MiB TT）: 無制限は幾何平均19.165672倍、中央値17.785699倍、p90 47.570238倍、102/102完走。5倍/2倍ラインとも未達。160k参考は幾何平均0.042896倍、中央値0.039906倍、p90 0.151323倍だが0/102完走なので予算打ち切り時間の参考値のみ。
- C1: FFO #40〜49を全問full-window完走、正解一致。壁時計は#40から順に2.912, 7.472, 9.176, 25.195, 14.723, 134.770, 72.248, 25.409, 353.086, 514.784秒。
- C2予算/E50参考: 540/540 job完了。160kはfail-high 1/60、fail-low 0/60、full 0/60。E50_exact(160k)=None、E50_bound(64k)=None（いずれも空き18未満）。裁定どおりゲートには不使用。
- C3: 48/48完了、平均oracle regret 1.5208、決定性48/48、wall保険0/48。
- 対Edax level10正式60局（TT64MiB）: 4勝54敗2分、平均石差-21.85。シリーズ開始時-37.2比+15.35、T089a後-25.6比+3.75（過去はquota40%・T116なしのため参考）。budgeted 890手、空き20以下unlimited-exact 556手で後者556/556完走、最長18.513秒。run key SHA-256=`cbb35f4e5b85fbff3ab11f6cf1d0d4fb65bec2af1683511c90a66cb1a29c98c4`。
- 決定性: C3 48/48、fixed-depth 40/40、node-budget smoke 10/10で同一入力2回一致。
- 環境/provenance: ベースHEAD `f6c4910a72c1baa949ac0d76136f4bb28521c364`、eval_cli SHA-256=`cd30961a8ed1d86235d1fe12334d851fd9ba105a7e8a10f9cc52129c4869d9cf`。自分の重い計測を並走させず1 taskで実行。正式計測はC1/C2/C3/速度/対局すべて64MiB TT。
- 実行コマンドと結果:
  - `cargo build --release -p engine --bin eval_cli` → 成功/fresh。
  - `python bench/edax-compare/endgame_bench.py run --suite c2 ...` → 540/540、再実行all skip。
  - `python bench/edax-compare/endgame_bench.py run --suite c3 ...` → 48/48。
  - `python bench/edax-compare/endgame_bench.py run --suite speed-160k --repetitions 3 ...` → 204/204 records。
  - `python bench/edax-compare/endgame_bench.py run --suite speed-unlimited --repetitions 3 ...` → 204/204 records。
  - `python bench/edax-compare/endgame_bench.py run --suite c1 --heavy-cap 10000000000000 ...` → 10/10完走・正解。
  - `python bench/edax-compare/vs_edax.py --opening-set primary --engine-modes single-root --levels 10 --engine-depth 12 --engine-exact-from-empties 16 --engine-time-ms 1500 --engine-max-nodes 160000 --engine-exact-quota-percent 60 --unlimited-exact-empties 20 --engine-tt-mb 64 --skip-loss-analysis ... --allow-dirty` → 60/60完走、再実行60/60 resume skip。
  - `python -m unittest bench/edax-compare/test_endgame_bench.py` → 7 tests OK。
  - `python bench/edax-compare/vs_edax.py --self-test-checkpoint` → provenance mismatch拒否/atomic中断耐性ともPASSED。
  - `python -m py_compile ...`、T108生データ機械assert、UTF-8レポートassert、`git diff --check` → PASSED。日本語リテラルをPowerShell here-string経由で渡した最初のレポート文字列assertだけシェル側文字コード変換で偽失敗し、ASCIIトークン+`Select-String -Encoding UTF8`で再検証して合格。
- 成果物: `bench/edax-compare/endgame-results/t108-report.md`。既存`.gitignore`対象なのでコミット時は`git add -f`が必要。
- コミットハッシュ: Codex環境は`.git`書き込み禁止のため未作成。オーケストレーターが対象3ファイルを`(T108)`でコミットすること。
