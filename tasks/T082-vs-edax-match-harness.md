---
id: T082
title: Edax自動対戦ハーネス構築 + レベル別対戦・弱点分析レポート
status: todo        # todo | in_progress | review | redo | done | blocked
assignee: implementer
attempts: 0
---

# T082: Edax自動対戦ハーネス構築 + レベル別対戦・弱点分析レポート

## 目的

エンジン強化(Edaxに近づける)の前段として、「自作エンジン vs Edax の実対局」を自動で複数局実行できるハーネスを構築し、(1) Edaxのどのレベルと互角か、(2) 序盤/中盤/終盤のどこでどれだけ損しているか、を定量化したレポートを作る。この実測データを次の設計判断(評価関数強化・探索強化などの優先順位付け)の根拠にする。

## 背景・コンテキスト

- 本リポジトリはRust製オセロエンジン(`engine/`クレート)+Preactアプリ。エンジンは反復深化+NegaScout+TT(2-tier)+ETC+終盤完全読み。評価はWTHOR学習のパターン評価v2(`train/weights/pattern_v2.bin`、22パターン/6対称クラス/13ステージ)。
- Edax比較基盤は `bench/edax-compare/` にあり(T022導入)、**静的評価値の比較**(`run-comparison.py`、`compare_pattern_eval.py`)と**自作エンジン同士の自己対戦**(`selfplay.py`、`selfplay_pattern_eval.py`)は実績があるが、**Edaxとの実対局(1手ずつ交互に着手)は未実装**。
- Edax本体: `bench/edax-compare/edax-extract/wEdax-x86-64.exe`(gitignore対象。無ければ `bench/edax-compare/download-edax.ps1` で取得)。評価重み `edax-extract/data/eval.dat` 同梱。
- Edaxの対話モード(`-edax`)はPowerShellのパイプ経由で2行目以降のコマンドが通らない既知の不具合があり不採用(T022作業ログ)。既存スクリプトはすべて**非対話バッチモード**: 局面をOBF形式1行(`<8x8盤面文字列> <X/O>;`)の一時ファイルに書き、`wEdax-x86-64.exe -solve <obfファイル> -l <level> -eval-file data/eval.dat -book-usage off -vv` を1局面ごとに起動し標準出力をパースする。
- `-vv` 出力には `depth|score|...|principal variation` 形式の行があり、PV(例 `d3 E3 f3 E2 f4 G3`)の**先頭手がEdaxの最善手**。既存スクリプトはdepth/scoreしかパースしておらず、**PV先頭手の抽出は本タスクで新規実装**する。PV表記の大文字/小文字がどちらの色を表すかは未検証なので、実装時に既知局面(例: 初期局面は黒番で合法手が d3/c4/f5/e6 のみ)で必ず検証してから使うこと。
- 自作エンジン側CLI: `engine/src/bin/eval_cli.rs`(`cargo build --release -p engine --bin eval_cli`)。
  - `moves`: 単一局面の全合法手を評価値降順で返す(`--depth` / `--exact-from-empties` / `--time-ms` / `--pattern-weights` 対応)。先頭が最善手。
  - `apply`: 局面に `--move a1`〜`h8` を適用し着手後局面(パス処理込み)をJSONで返す。
  - `gen`: ランダム自己対戦で開始局面バリエーションを生成(`--seed` あり、再現可能)。
  - 対局ループの実装パターンは `selfplay_pattern_eval.py` が参考になる(moves→apply→手番交代の繰り返し)。
- Edaxのレベル `-l N` は概ね「中盤探索深さN+終盤は残り空きマスに応じて完全読み」。自作エンジンの `--depth N` + `--exact-from-empties` と概ね対応する土俵になる。
- T022実測でEdax呼び出し1回あたり15〜20秒かかった記録があるが、これは高レベル(FFO `-l 30` 等)込みの平均。低レベル(1〜10)なら大幅に速いはずなので、実装後にまず1局の所要時間を実測してから対局数を確定してよい(下記要件の局数は目安)。

## 変更対象

- `bench/edax-compare/vs_edax.py` — 新規作成(対戦ハーネス本体)
- `bench/edax-compare/vs_edax_report.md` — 新規作成(結果レポート、ハーネスが生成)
- `bench/edax-compare/vs_edax_results.json` — 新規作成(生データ: 棋譜・スコア等)
- (必要なら)`bench/edax-compare/README.md` 等への使い方追記は任意

## 要件

1. **対戦ループ**: 任意の開始局面から、自作エンジン(`eval_cli moves`で最善手→`apply`)とEdax(`-solve`のPV先頭手)を交互に着手させ、終局まで進めて最終石差を得る。パス処理(`apply`が返すパス込みの手番)を正しく扱うこと。
2. **Edax着手の抽出**: `-vv` 出力からPV先頭手を抽出し `a1`〜`h8` 記法(小文字)に正規化する。**実装検証として、初期局面(黒番、合法手 d3/c4/f5/e6)と、そこから1手進めた白番局面で、抽出した手が合法手集合に含まれることを確認するテスト(またはassert)を入れる**。抽出した手が合法でない場合は即エラーで停止(黙って続行しない)。
3. **一時ファイルの衝突回避**: OBF一時ファイルは呼び出しごと(または対局ごと)に一意な名前を使う(既存スクリプトの固定名 `_t022_tmp.obf` 方式は流用しない)。
4. **対局条件**:
   - 開始局面: `eval_cli gen`(seed固定)等で生成した互角に近い序盤局面(8〜12手目程度)を10局面用意し、各局面につき**黒白持ち替えの2局**(合計20局/レベル)を行う。同一開始局面ペアで色を入れ替えることで先後の偏りを打ち消す。
   - 自作エンジン設定: `--depth 10 --exact-from-empties 18 --pattern-weights train/weights/pattern_v2.bin` を基準とする(アプリ実運用に近く、既存比較(depth10)とも整合)。
   - Edaxレベル: まず `-l 10`(同深度=評価精度の直接比較)で20局。時間が許せば `-l 5` と `-l 1` でも各20局実施し、どのレベルで勝率5割になるかの目安を出す(1局の実測所要時間から判断し、間に合わない分は局数を半分に減らしてよい。**実施した/しなかった条件と理由をレポートに明記**)。
5. **記録**: 各対局について、開始局面・手順(着手リスト)・どちらが黒か・最終石差・各手番での自エンジン評価値(`moves`の返す値)を `vs_edax_results.json` に保存する(後続タスクの分析で再利用するため)。
6. **弱点分析**: 対戦後、**負けた対局**(全敗なら代表5局程度でよい)について、各局面をEdax高レベル(`-l 16` 目安、遅すぎるなら14)で評価し、自作エンジンの各着手のロス(着手前局面のEdax最善評価と、着手後局面のEdax評価の差)を算出する。集計として:
   - フェーズ別(序盤=1〜20手目、中盤=21〜40手目、終盤=41手目〜)の平均ロス・累計ロス
   - ロスの大きい局面トップ10(局面OBF・自エンジンの手・Edaxの推奨手・ロス値)
7. **レポート** `vs_edax_report.md`: (a) 実行条件(両者の設定・局数)、(b) レベル別の勝敗・平均石差、(c) フェーズ別ロス集計、(d) 大ロス局面トップ10、(e) そこから読み取れる弱点の考察(どのフェーズ・どんな種類の局面で崩れているか)、を含める。
8. コミットはハーネス(`vs_edax.py`)・レポート・結果JSONのみをパス指定で行い、mainへpushしてGitHub Actionsの成功を確認する(アプリ本体に変更がないためPages上の機能確認は不要)。

## やらないこと(スコープ外)

- `engine/src/` 配下(エンジン本体)の変更 — 弱点の**修正**は後続タスク
- `app/` 配下の変更
- 既存スクリプト(`run-comparison.py` / `selfplay*.py` / `calibrate.py`)の改修・リファクタリング(edax_solve重複の解消は不要。vs_edax.py内に自前実装してよい)
- Edaxの`book.dat`(定石DB)を使った対局(`-book-usage off` 固定)
- マルチスレッド化・大規模並列対戦基盤(逐次実行で足りる範囲でよい。ただし将来の並列化を妨げない一時ファイル設計にはしておく)

## 受け入れ基準(検証コマンド)

- [ ] `python bench/edax-compare/vs_edax.py --smoke`(等の軽量モード)で、初期局面付近からの1局が終局まで完走し、Edax着手の合法性検証がパスする
- [ ] `bench/edax-compare/vs_edax_report.md` が存在し、要件7の(a)〜(e)をすべて含む
- [ ] `bench/edax-compare/vs_edax_results.json` に少なくとも20局分の棋譜・最終石差が記録されている
- [ ] レポートの勝敗集計と `vs_edax_results.json` の生データが一致する(verifierがサンプル照合)
- [ ] 変更がmainにpushされ、GitHub Actionsが成功している
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと(一時OBFファイル等を残さない。必要なら `.gitignore` 追記)

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)
