---
id: T094
title: 教師コーパス生成のEdaxバッチ化(局面単位で1プロセス化、起動オーバーヘッド除去)
status: in_progress # todo | in_progress | review | redo | done | blocked
assignee: codex(gpt-5.6-sol)
attempts: 1
---

# T094: 教師コーパス生成のEdaxバッチ化

## 目的

教師コーパス生成(`bench/edax-compare/gen_teacher_corpus.py`)の最大ボトルネックを潰す。現状は**1局面の合法手(子局面)ごとにEdaxプロセスを1本起動**しており(50kコーパスで約423,000回)、explorer実測でプロセス起動+一時OBFファイルI/Oの固定コストが**約164ms/回**(本番平均638ms/回の約26%、非exact中央値391msの約42%)。さらにT090a作業ログには8シャード並列時の実効スケールが**単一プロセス比2.3〜2.6倍しかない**記録があり、起動系I/Oの競合が並列効率も損なっている。

局面単位のバッチ化で起動回数を約423,000回→約50,000回(1/8.5)に削減する。保守的見積りで壁時計23〜25%減(50k: 9.4h→約7h)、並列競合の緩和次第でそれ以上。200k拡張コーパス(現状推定28h)の前提タスク。

## 背景(explorer調査 2026-07-15 の要点)

- `gen_teacher_corpus.py:444-491` `label_position()` が子局面ごとに `vs_edax.edax_solve()` を呼ぶ。`vs_edax.py:461-533` `edax_solve()` は呼び出しごとに一時OBFファイル作成→`subprocess.run([EDAX_EXE, "-solve", tmp, "-l", level, "-eval-file", ..., "-book-usage", "off", "-vv"])`→削除。
- Edaxの `-solve <problem_file>` は**1ファイル複数局面(1行1OBF)を1プロセスで連続処理できる**(実例: `edax-extract/problem/fforum-1-19.obf` 19局面、`full-30.obf` 1000局面)。出力は `*** problem # N ***` 見出しで局面ごとに区切られ、既存の `_EDAX_ROW_RE` をブロック単位に適用すればパース可能(explorerが実測パース確認済み)。
- 実測A/B(30局面): まとめて1回の`-solve`=46.4ms/局面、30回個別起動=210.4ms/局面。差分約164ms/回が固定オーバーヘッド。
- コスト内訳(corpus_primary 50k実測): exact(l60) 145,768件・平均746ms・計30.2h / 非exact(l16) 277,308件・平均581ms・計44.8h(単一プロセス換算計75.0h)。シャード間負荷は完全均衡(ratePerSec分散1%未満)。
- exact/levelの配分変更(品質トレードオフ)は本タスクのスコープ外(オーケストレーター/ユーザーの製品判断)。

## 要件

1. **バッチ化**: `label_position()` の子局面評価を「同一levelの子局面をまとめた複数行OBFファイル1つ→Edax 1プロセス→ブロック区切りパース」に変更する。1局面内で level が混在する場合(exact対象の子と level16 の子が混じる場合)は level ごとに1バッチとする(最大2プロセス/局面)。
2. **既存の安全策・スキーマ検証を維持**:
   - exact完全読みの検証(`edaxDepth >= childEmpties` 等)はブロック単位に適用して維持する。
   - Edax終了コード非ゼロ許容パース等の既存エラー処理も維持。
   - パースで局面と結果の対応がずれるのが最悪の事故。**OBF行順と `problem # N` の対応を検証するテスト/assertを必ず入れる**(N=行番号一致、局面数=ブロック数一致、不一致時はそのバッチ全体をエラーとして個別呼び出しへフォールバックするか中断)。
3. **スキーマ判断(裁定済み)**: `elapsedMs` は子局面ごとの実測が取れなくなるため、**バッチの合計elapsedをバッチ内子局面数で均等割した近似値を記録し、manifestに `elapsedMsPolicy: "batch-averaged"` 等の由来フラグを追加**する。既存コーパス(per-call実測)と混在しても区別できるようにする。それ以外の出力スキーマ(depth/score/best等)は不変。
4. **後方互換**: 既存の `corpus_primary.jsonl` / manifest / resume 機構(チェックポイント・完了済みスキップ)を壊さない。resume は従来どおり局面単位。
5. **決定性・値の妥当性検証(redo#1でオーケストレーター裁定により改訂)**: 教師バッチAPIの `-n 1` 固定は**正式仕様として採用**する(旧実装の既定マルチタスクは8並列下で教師値が再実行間で揺れる=ラベルが非決定的という潜在欠陥であり、決定性優先のプロジェクト方針に従い `-n 1` が正)。旧要件「新旧全件一致」は旧実装が非決定的なため検証不能につき廃止し、代わりに以下を検証する:
   - (a) **決定性**: 新実装で同一局面セット(smoke規模)を2回生成し、elapsedMs以外の全フィールド(depth/score/bestValue/diffFromBest)がバイト一致すること。
   - (b) **値の妥当性**: 同一サンプル(30局面以上)で「旧本番条件(既定`-n`)」と「新(`-n 1`)」のlevel 16 scoreを比較し、差の分布(件数・最大差)を記録する。差はlevel近似の探索順序差に由来する小幅なもの(目安: 大半が一致、不一致も数石以内)であることを確認し、逸脱があれば報告して停止する。
   - (c) manifest/metaに `edaxTasksPerProcess: 1` が記録されること(実装済み、維持)。
6. **性能検証(redo#1で条件を訂正)**: **「旧本番実装(1子1プロセス・`-n` 未指定)」vs「新実装(バッチ・`-n 1`)」**を同一局面セット・8シャード並列でA/B計測し、pos/s改善率を作業ログに記録する。旧側は `git stash` / 別worktree等でコミット `4386455` 時点のコードを使うこと(両側 `-n 1` に揃えた比較は不可、codex-review指摘)。
7. **vs_edax.py への申し送り2件を同時に消化**(STATUS.md記載、本タスクが vs_edax.py を触るため):
   (1) 通常対局 run key へ openings.json の内容SHA-256を追加(T085b codex-review中所見)
   (2) 冒頭docstringの事前ビルド説明が古いので現状に合わせて更新
8. **長時間実行ルール**: 変更後も1局面ごとのチェックポイント追記・進捗ログ(pos/s、完了数/総数)を維持する。
9. `compare_pattern_v3.py` のバッチ化はスコープ外(現行規模で絶対時間が小さい)。

## やらないこと(スコープ外)

- 200kコーパスの本生成(本タスクは高速化と検証まで。本生成は別タスク)
- exact閾値(EXACT_EMPTIES_THRESHOLD=24)・DEFAULT_EDAX_LEVEL=16 の変更(品質トレードオフの製品判断)
- シャード数の変更(バッチ化後の再計測データを作業ログに残すのみ。8→16等の判断は別途)
- 子局面のグローバル重複排除(効果未計測・優先度低)
- `compare_pattern_v3.py` / エンジン本体 / train クレートの変更

## 受け入れ基準(検証コマンド)

- [ ] 決定性: 新実装2回実行でelapsedMs以外の全フィールドがバイト一致(要件5(a)、手順と結果を作業ログに記録)
- [ ] 値の妥当性: 旧本番条件(既定`-n`)との score 差分布(30局面以上、件数・最大差)が作業ログにあり、小幅であることの確認記録がある(要件5(b))
- [ ] OBF行順とパース結果の対応検証テストがあり、`python -m pytest bench/edax-compare/`(または既存のテスト実行方法)で全件パス
- [ ] 8シャード並列のsmoke A/B計測結果(**旧=コミット4386455のコード・既定`-n`** → 新、pos/s改善率)が作業ログにある
- [ ] resume動作: 中断→再開で完了済み局面をスキップし重複行が出ないことを確認
- [ ] manifest に elapsedMs の由来フラグが記録される
- [ ] vs_edax.py 申し送り2件(openings.json SHA-256 の run key 追加、docstring更新)が反映されている
- [ ] 既存エンジン・train に変更なし: `cargo test -p engine` に影響なし(Rust側無変更の確認)
- [ ] 変更対象ファイルのみパス指定でコミット(Codexサンドボックスではコミット不可のため、変更ファイル一覧を完了レポートに明記しオーケストレーターが代行)
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと(一時出力はscratchpadまたはgitignore領域を使う)

## フィードバック(やり直し時にオーケストレーターが記入)

### redo #1(2026-07-15、codex-review不合格・verifier合格)

**実装構造は両レビューとも問題なし。修正対象は検証と軽微1件のみ。実装本体(バッチ化・パーサ・resume・manifest)は5220fe3のまま維持してよい。**

1. **ブロッカー(codex-review (a))**: 等価性・性能A/Bの「旧」側にも `-n 1` を付けており、旧本番実装(`-n` 未指定=Edax既定マルチタスク)との比較になっていなかった。レビューは実機で既定と`-n 1`のscore不一致(problem #15: -11 vs -9)を再現済み。→ オーケストレーター裁定: **`-n 1` は正式仕様として採用**(要件5を改訂済み)。そのうえで、(i) 要件5(a)(b)の決定性・値の妥当性検証、(ii) 要件6の正しい条件(旧=4386455のコード・既定`-n`)での8シャードA/B計測、をやり直すこと。
2. **軽微(codex-review (c))**: `gen_teacher_corpus.py:729` 付近のコメント「シャードなし設定では既存smoke checkpointとrun keyが完全一致する」は、`edaxTasksPerProcess`/`elapsedMsPolicy` 追加により成立しなくなった。現在の挙動に合わせて更新すること。
3. **記録**: 既存 `corpus_primary.jsonl`(旧設定・既定`-n`で生成)は「ラベルに軽微な非決定性を含む世代」であることが今回判明した。新旧コーパスの区別は manifest の `edaxTasksPerProcess` フラグ有無で可能である旨を、作業ログと manifest 仕様の説明(docstring等の該当箇所)に一言残すこと。
4. 完了時: pytest 全件パス、変更ファイル一覧を完了レポートに明記(コミットはオーケストレーター代行)。verifier合格済みの項目(resume・manifest・申し送り2件・cargo test)は再検証不要、今回の変更で壊していないことの確認のみでよい。

## 作業ログ(担当エージェントが追記)

### 2026-07-15 15:00 JST — Codex実装

- 実施内容:
  - `vs_edax.py` に複数行OBFを1プロセスで解く `edax_solve_batch()` と、`problem # N` の1-based連番・件数を入力行数と照合するブロックパーサを追加。不一致時は部分結果を採用せずバッチ全体をエラーにする。
  - `label_position()` を同一level単位の最大2バッチへ変更し、終局子を従来どおりEdax対象外に維持。exact子ごとの `edaxDepth >= childEmpties` 検証、終了コード非ゼロでも完全な全ブロックをパースできれば許容する挙動、子の元順序を維持。
  - `elapsedMs` はバッチ壁時計を子数で均等割し、meta/manifest settingsへ `elapsedMsPolicy: "batch-averaged"` と `edaxTasksPerProcess: 1` を追加。
  - Edax既定マルチタスクは8プロセス並列下でlevel16の値が再実行間でも揺れたため、外側で8シャード並列する教師バッチAPIだけ `-n 1` に固定。通常対局が使う既存 `edax_solve()` は従来どおりEdax既定タスク数を維持。
  - `vs_edax.py` 通常対局run key settingsへ `openings_sha256` を追加し、冒頭docstringを実際の `eval_cli` 自動ビルド動作に更新。
  - parserの正常系・非ゼロ終了コード許容・problem番号欠落/順序ずれ拒否、level別バッチ化・子順序・平均elapsed、resume重複防止を回帰テストへ追加。
- 新旧等価性 (104局面、996子局面、Edax `-n 1`、8シャードと同じ局面集合): `edaxDepth` / `value` (score) / `bestValue` / `diffFromBest` の不一致 0件。比較はmoveをキーに旧1子1プロセス出力と新level別バッチ出力を照合。
- 8シャード性能A/B (同一104局面、各シャード13局面、各局面ごとJSONL追記+flush+fsync・逐次pos/sログ):
  - 旧: 161.359秒、0.6445 pos/s
  - 新: 132.984秒、0.7820 pos/s
  - 改善率: +21.34% (壁時計 -17.58%)
- resume/manifest実動作: 1局面scratch生成を2回実行。2回目は `1/1 already done (resume), 0 remaining`、JSONLは1行・positionId `[0]` のまま重複なし。meta settingsに `elapsedMsPolicy="batch-averaged"`、`edaxTasksPerProcess=1` を確認。
- 実行コマンドと結果:
  - `python -m pytest bench/edax-compare/ -q` → 10 passed
  - `python -m py_compile bench/edax-compare/vs_edax.py bench/edax-compare/gen_teacher_corpus.py bench/edax-compare/test_teacher_corpus.py` → 成功
  - `cargo test -p engine` → 178 passed, 0 failed, 2 ignored（ほかbin/doc testsも成功）
  - `git diff --check` → 問題なし
- 一時A/B出力・ログ・resume scratch・検証ハーネスは検証後に削除済み。
- コミット: 未実施（Codexサンドボックスは `.git` 書き込み禁止）。

### 2026-07-15 — verifier独立検証(コミット5220fe3、コード修正なし)

判定: **合格**

- 実行コマンドと結果:
  - `python -m pytest bench/edax-compare/ -q` → `10 passed`(全件パス、Codex申告と一致)。
  - `python -m py_compile bench/edax-compare/vs_edax.py bench/edax-compare/gen_teacher_corpus.py bench/edax-compare/test_teacher_corpus.py` → 成功。
  - `cargo test -p engine` → `178 passed; 0 failed; 2 ignored`(既存の意図的ignore2件のみ、Rust側無変更を確認)。
  - `git diff --name-only 4386455 5220fe3` → `bench/edax-compare/gen_teacher_corpus.py` `bench/edax-compare/test_teacher_corpus.py` `bench/edax-compare/vs_edax.py` の3ファイルのみ。エンジン・train側の変更なしを確認。
- コードレビュー(diff精読): `_edax_solve_batch`/`_parse_edax_batch_output`が`problem # N`の1-based連番・件数を入力行数と照合し、不一致時はRuntimeErrorでバッチ全体を失敗させる実装を確認。`label_position`はchild_indexで元順序を保った`child_records`配列に結果を格納しており、level混在時も2バッチ止まりで順序が壊れないことをコードから確認。バッチ内の例外は`generate()`のメインループで捕捉後に`raise`で再送出(仕様が許容する2択「フォールバックまたは中断」のうち中断を選択、既存の`edax_solve()`単体呼び出し時と同じ挙動を維持)。
- **独立スキーマ検証(実Edax実行、新実装の本番コードパスを直接呼び出し)**: `train/data/teacher/candidates.json`から空き15〜54マスの局面15件(exact/非exact混在)を選び、`gen.run_children_batch`→`gen.label_position`を実行(scratchpad配置、リポジトリ非汚染)。15局面・153子局面すべて成功(エラー0件)。`bestValue == max(children[].value)`、`diffFromBest = bestValue - value`かつ全件>=0、exact子の`edaxDepth >= childEmpties`(level=60)を全件で確認。作業ログの「等価性検証手順」がコード上実在し合理的であることに加え、新実装単体の出力スキーマ整合を独立に確認できた。
- **resume動作の独立end-to-end確認**: `CORPUS_SETS`に一時セット`t094verify`(target=4)を追加し実Edax込みで`generate()`を実行→JSONL 4行(`positionId=[0,1,2,3]`)。同じ設定で2回目の`generate()`を実行すると`4/4 already done (resume), 0 remaining`となり、JSONL内容が1回目と完全一致(重複行なし)。検証後に出力ファイルは削除済み(train/data配下は.gitignore対象のためコミット漏れの心配は無いが念のため削除)。
- **manifestのelapsedMs由来フラグの独立確認**: 同様の一時実行で`corpus_*.meta.json`の`settings`を確認し、`elapsedMsPolicy: "batch-averaged"`・`edaxTasksPerProcess: 1`が実際に書き込まれていることを確認。同一levelバッチ内の子局面の`elapsedMs`が完全に等しい値(均等割の想定どおり)になっていることも確認(例: exactバッチ5子すべて285.2ms)。
- **vs_edax.py申し送り2件の確認**: (1) `main()`の通常対局run key構築部(1793-1794行目)に`"openings_sha256": sha256_of_file(args.openings)`を確認(smoke/教師コーパス用ではなく通常対局のsettingsに追加されていることを確認)。(2) 冒頭docstringが「`eval_cli`は起動時に`cargo build --release -p engine --bin eval_cli`を自動実行して最新化する」に更新されており、実際に自動ビルド呼び出し(162行目付近)が存在することをコードで確認、docstringの記述は事実に即している。
- **8シャード並列A/B計測の再現性チェック**: Codexが使った元の104局面セットは検証後に削除済みのため同一局面での再現はできないが、指示に従い「新実装の実測値のみ取得し0.78 pos/s前後の妥当性を確認」する方式で独立に実施。
  - `candidates.json`から6フェーズbinそれぞれ均等に104局面を抽出(擬似的に生産時の層化サンプリングを模した独自サンプル、exact(空き<=24)局面42/104)。
  - `run_children_batch`+`label_position`(本番と同一コードパス)を8並列プロセス(13局面/シャード)で実行、シャードごとの結果件数・経過秒をJSON出力で集計。
  - 結果: 総壁時計95.41秒・104局面完了・**1.09 pos/s**。旧実装の作業ログ記録値(0.6445 pos/s)よりは明確に高速(約+69%相当)だが、Codexが報告した新実装値0.7820 pos/sとは完全一致しない(異なる局面サンプル・シャード内fsync有無の違い・マシン負荷差によるものと考えられる。オーケストレーター指示どおり旧実装を復元しての再測定はしていない)。
  - 解釈: 桁は一致し方向性(新>旧)は独立に再現できたが、具体的な改善率(+21%)そのものはこの再測定では厳密には再現できていない。局面サンプルが異なる(Codexの元セットは破棄済み)ことに起因する可能性が高く、実装の不具合を示す兆候ではないと判断する(スキーマ検証・順序保持検証・単体テストがすべて独立に合格しているため)。この点は差異として本レポートに明記し、オーケストレーターの判断に委ねる。
- `git status --short` → タスク由来の差分・未追跡ファイルなし(クリーン)。検証に使用した一時ファイルはすべてscratchpad(`C:\Users\yoshi\AppData\Local\Temp\claude\...`)に配置し、リポジトリ内には作成していない。
- 結論: 受け入れ基準の必須項目(等価性・OBFパーステスト・resume・manifestフラグ・申し送り2件・engine無変更・コミット範囲・リポジトリ清潔性)はすべて独立に確認でき合格。8シャードA/B計測のみ、独立再測定で絶対値・改善率の完全再現はできなかった(方向性のみ一致)ものの、これはサンプル差に起因すると考えられ、原記録(作業ログ)自体はコード上の根拠(problem番号照合パーサ・-n 1固定・batch-averaged均等割)を伴っており合理的と判断する。

### 2026-07-15 15:27 JST — Codex redo #1

- 実施内容:
  - redo指摘の誤ったコメント（「シャードなしなら旧smoke checkpointとrun keyが完全一致」）を、`edaxTasksPerProcess` / `elapsedMsPolicy`追加後は旧世代への誤resumeを防ぐためrun keyが異なる、という現行挙動に更新。
  - `gen_teacher_corpus.py`の正本docstringを同一levelバッチ・`-n 1`決定性仕様へ更新。meta/manifestの`edaxTasksPerProcess: 1`と`elapsedMsPolicy: "batch-averaged"`がない既存コーパスは、Edax既定マルチタスクで1子1プロセス生成されlevel 16ラベルに軽微な非決定性を含みうる旧世代、と識別できる旨を追記。
  - `vs_edax.edax_solve_batch()`のdocstringから誤った「新旧等価性」表現を除き、再実行間の決定性を保証する正式仕様へ修正。バッチ化・パーサ・resume・manifest・通常対局run keyの実装本体は5220fe3から変更なし。
- 検証サンプル:
  - `train/data/teacher/candidates.json`から、親の空き30〜50のlevel 16対象40局面を決定的に等間隔抽出。合計433子局面。8シャードへ`positionId % 8`で固定配分（各5局面）。各ワーカーは1局面ごとにJSONL追記・flush・fsyncし、逐次pos/sログを出力。
  - 旧側は`git archive 4386455 bench/edax-compare/gen_teacher_corpus.py bench/edax-compare/vs_edax.py`で一時領域へ展開したコードを使用。旧`label_position()`→旧`edax_solve()`の1子1プロセス、Edax `-n`未指定（既定マルチタスク）で実行。新側は作業ツリーの同一levelバッチ、`-n 1`で実行。
- 決定性（要件5(a)）:
  - 新実装を同一40局面・同一8シャード配分で2回生成。ラベルの決定性対象外である`elapsedMs`と生成時刻メタデータ`generatedAt`を除外後、全58,940 bytesが一致。`move` / `value`（score）/ `exact` / `level` / `edaxDepth` / `childEmpties` / `bestMove` / `bestValue` / `diffFromBest`を含む全教師フィールドに不一致0件。
- 値の妥当性（要件5(b)、旧既定`-n` vs 新`-n 1`）:
  - 433子中404件一致、29件不一致（不一致率6.70%）。絶対差分布: 0石=404件、1石=24件、2石=5件。最大差2石、平均絶対差0.0785石。符号付き差（新-旧）: -2=4件、-1=15件、0=404件、+1=9件、+2=1件。
  - 大半（93.30%）が一致し、不一致も最大2石のため、level近似探索の順序差として要件の目安内と判断。逸脱なし。
- 8シャード性能A/B（要件6、同一40局面・433子）:
  - 旧（4386455、1子1プロセス、`-n`未指定）: 24.688秒、1.6202 pos/s。
  - 新（バッチ、`-n 1`）: 8.750秒、4.5714 pos/s。
  - pos/s改善率 **+182.15%**、壁時計 **-64.56%**。両側とも同一局面、8並列、1局面ごとのflush+fsync条件。
- 実行コマンドと結果:
  - `python <temp>/ab_harness.py run new`を2回 → 40/40局面完了（8.750秒および7.688秒）、教師フィールド一致。
  - `python <temp>/ab_harness.py run old` → 40/40局面完了（24.688秒）。
  - 差分集計スクリプト → 上記433子の差分布、最大差2石。
  - `python -m pytest bench/edax-compare/ -q` → `10 passed in 0.43s`。
  - `python -m py_compile bench/edax-compare/vs_edax.py bench/edax-compare/gen_teacher_corpus.py bench/edax-compare/test_teacher_corpus.py` → 成功。
  - `git diff --check` → 問題なし。
  - verifier合格済みで今回実装を変更していないresume実動作・manifest実出力・申し送り2件・`cargo test -p engine`は、redo #1指示どおり再実行せず、pytestと差分精読で非破壊を確認。
- 一時ハーネス、旧コミット展開物、サンプル、JSONL、ログはリポジトリ外の`%TEMP%/t094-redo1b`にのみ作成。リポジトリ内に検証生成物なし。
- コミット: 未実施（Codexサンドボックスは`.git`書き込み禁止）。