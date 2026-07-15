---
id: T094
title: 教師コーパス生成のEdaxバッチ化(局面単位で1プロセス化、起動オーバーヘッド除去)
status: in_progress # todo | in_progress | review | done | blocked
assignee: codex(gpt-5.6-sol)
attempts: 0
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
5. **等価性検証**: smoke規模(例: 100〜300局面)で新旧実装を実行し、**depth/score/bestValue/diffFromBest が全件一致**することを確認する(elapsedMsのみ差異許容)。
6. **性能検証(並列込み)**: smoke規模を**8シャード並列**で新旧A/B計測し、pos/s の改善率を作業ログに記録する(単発非並列の計測だけでは並列時の実効果を保証できない、explorer指摘)。
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

- [ ] 新旧等価性: smoke規模の新旧出力で depth/score/bestValue/diffFromBest 全件一致(比較スクリプトまたは手順と結果を作業ログに記録)
- [ ] OBF行順とパース結果の対応検証テストがあり、`python -m pytest bench/edax-compare/`(または既存のテスト実行方法)で全件パス
- [ ] 8シャード並列のsmoke A/B計測結果(pos/s 旧→新、改善率)が作業ログにある
- [ ] resume動作: 中断→再開で完了済み局面をスキップし重複行が出ないことを確認
- [ ] manifest に elapsedMs の由来フラグが記録される
- [ ] vs_edax.py 申し送り2件(openings.json SHA-256 の run key 追加、docstring更新)が反映されている
- [ ] 既存エンジン・train に変更なし: `cargo test -p engine` に影響なし(Rust側無変更の確認)
- [ ] 変更対象ファイルのみパス指定でコミット(Codexサンドボックスではコミット不可のため、変更ファイル一覧を完了レポートに明記しオーケストレーターが代行)
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと(一時出力はscratchpadまたはgitignore領域を使う)

## フィードバック(やり直し時にオーケストレーターが記入)

## 作業ログ(担当エージェントが追記)
