## 最終レビュー

### (a) 重大（done を止めるブロッカー）

なし。

指定差分内に、採用判定を無効にする不整合、成果物の欠落、探索ロジックのスコープ外変更は確認できませんでした。

### (b) 中（次タスクで対応すべき）

1. 通常対局のresume判定にopeningマニフェストの内容ハッシュが含まれていない

[vs_edax.py](/C:/Users/yoshi/work/othello-trainer/bench/edax-compare/vs_edax.py:1705) の通常対局用run keyには`openings_path`と件数だけが入り、`openings.json`のSHA-256がありません。ファイル内容が同じパス・同じ件数のまま変更された場合、旧チェックポイントを互換と判断し、異なるopeningによる対局結果を混在させる可能性があります。

校正系列では固定局面ファイルの`positionsSha256`をrun keyへ含めており、同じ方式を通常対局にも適用するのが妥当です。今回の成果物ではopening内容の変更は確認されず、60局のキーも重複なく揃っているためブロッカーとはしません。

### (c) 軽微（記録のみ）

1. 冒頭docstringの事前ビルド説明が実装とずれている

docstringは依然として「`cargo build`でビルド済み」を前提として記載していますが、現在の`ensure_engine_built()`は毎回Cargo buildを実行します。実害はありません。

2. 自己テストは現在のread-only環境では再実行できなかった

`--self-test-checkpoint`は一時ディレクトリを作成できず、環境制約により実行不能でした。ただし、コード上は一時ファイルへのflush・fsync後に`os.replace()`を行い、故障注入テストも実装されています。作業ログにも成功結果が記録されているため、受け入れを妨げるものではありません。

### 確認結果

- コミット範囲は`6dd70a5`の1コミット。
- `git diff --check e5f94dd..6dd70a5`はクリーン。
- `t085_exact_quota_comparison.json`はCRLF 0件、LF 1,216件。
- 校正JSONはoracle 48件、5系列×48＝240件、系列・局面キーの重複なし。
- 独立再集計した平均oracle regret:
  - wall1000: 4.104
  - node160k: 1.604
  - node200k: 1.396
  - node240k: 1.396
  - node300k: 1.521
- 全node候補で決定性48/48、wall保険発動0、depth0ゼロ。
- smokeは20局、平均石差−33.65。既存wall基準−35.80に対して+2.15石。
- primaryは60局、重複なし、平均石差−29.067、engine着手1,431件、wall保険発動0、depth0ゼロ。
- 成果物内のharness、engine source、実行`eval_cli.exe`のハッシュは現在の内容と一致。
- usageには`budget-regression`と`--exact-quota-percent`が追加されている。
- エンジン探索ロジックの変更はない。

### (d) 総合判定

**合格**

採用条件をすべて満たす最小候補として160,000 nodes / wall保険1,500msを選んだ判断は、コミットされた生データから再現できます。primary 60局も指定どおり候補を一つに絞った後に実施され、成果物の件数・設定・集計値も判定レポートと整合しています。

resumeのprovenance厳格化、毎回のCargo build、実行バイナリ等のハッシュ保存、アトミック保存も要件を満たしています。opening内容ハッシュの不足は将来のresume堅牢性として次タスクで直すべきですが、今回の採用判定を差し止める問題ではありません。