# T085a 最終レビュー

**総合判定: 不合格**

探索の主要実装に明白な正解値破壊は見つかりませんでした。しかし、規範仕様で必須とされた比較・コーパス範囲が満たされておらず、テレメトリにも不整合があります。現時点では `done` にできません。

## (a) 完了を確認できた部分

- `TTDomain::{Midgame, Exact}` が導入され、hashとdomainの両方でprobeしている。
- TTの16-byte entry / 32-byte bucketを維持している。
- ノード予算経路はdepth 1をexact無効で実行し、完成結果を保持する。
- 無制限exact経路は従来の即時完全読みを維持している。
- exact quota切れ時、木内部で中盤NegaScoutへ戻る処理がある。
- centi-disc窓の`floor_div_100` / `ceil_div_100`は負数を含め正しい。
- `best`に要求されたテレメトリ項目が出力される。
- 壁時計exact失敗後も合法手を返す直接テストが追加されている。
- 差分は指定された5ファイルだけで、`git diff --check`も成功。
- 既存debugテストバイナリの直接実行では、148 passed / 0 failed / 2 ignoredを確認した。

## (b) 指摘事項

### 重大（ブロッカー）

1. 必須のexact quota比較が実施・記録されていない

仕様では25% / 40% / 60% / 75%を目的関数に沿って比較して選定する必要がありますが、実装は残予算の60%を固定採用しています。[search.rs](/C:/Users/yoshi/work/othello-trainer/engine/src/search.rs:586)

作業ログにも4候補の比較結果、対象局面、各候補のregret・exact完走率・完成深さがありません。60%で性能ゲートを満たしたことだけでは、この明示要件を代替できません。

2. 固定局面コーパスが要求された空き13〜30を覆っていない

タスクは空き13〜30の固定コーパスを要求していますが、manifestは空き19〜24の18局面だけです。[t085_exact_positions.json](/C:/Users/yoshi/work/othello-trainer/bench/edax-compare/t085_exact_positions.json:3)

これでは以下を回帰CLIで固定できません。

- 原則exact試行対象となる空き13〜14
- p75表を作った空き15〜18
- exactを抑制する空き25〜30
- 各境界での動的ゲート挙動

要求範囲を追加するか、規範側を19〜24へ変更する明示判断が必要です。

### 中

1. 木内部のExactQuotaフォールバックが`fallbackReason`へ反映されない

木内部exactがquota切れになると`exact_stats.aborted_by_quota`は増えますが、検索全体の`fallback_reason`は更新されません。[search.rs](/C:/Users/yoshi/work/othello-trainer/engine/src/search.rs:1149)

そのまま探索が完了すると、以下の矛盾した結果になり得ます。

```text
exactAbortedByQuota > 0
fallbackReason = null
```

ルートexactのquota切れだけは`ExactQuota`が設定されています。木内部でも実際のイベントを反映する必要があります。

2. quota切れ後の中盤継続を直接固定するテストが不足している

追加テストは合法手、決定性、baseline完走を確認していますが、次の一連の挙動を直接assertしていません。

- 木内部exactが実際に開始される
- ExactQuotaで中断される
- 同じイテレーションが中盤探索として継続する
- 完成した中盤結果を返す
- 不完全なExact値がMidgame TTへ混入しない

T085aの中心機能なので、専用テストが必要です。

3. コミット単体に性能検証結果が含まれていない

oracle regretなどの結果は現在の未コミットなタスク作業ログにだけ存在します。`cf57b56..05b5267`のコミット自体からは、quota候補比較やregret集計を再現できません。

### 軽微

- `AbortReason::GlobalNodeLimit`はendgame側で定義されていますが、`solve_exact_window_limited_with_nodes`自身は`ExactQuota`か`WallClock`しか返しません。Global判定は呼び出し側が制限値の一致から推測しています。現状動作は成立しますが、APIの責務が名前ほど明確ではありません。
- `eval_cli`末尾などに不要な空行が残っています。`git diff --check`上の問題はありません。

## (c) 検証結果

- `git log cf57b56..05b5267`: 対象コミットは`05b5267`の1件。
- `git diff --check cf57b56..05b5267`: 成功。
- `cargo test -p engine`: read-only環境で`.cargo-build-lock`を開けず実行不能。
- 既存のコミット直前debugテストバイナリを直接実行:
  - 148 passed
  - 0 failed
  - 2 ignored
- FFO既存releaseバイナリの直接再実行は長時間化したため中断。作業ログには#40〜44成功と従来ノード数との完全一致が記録されていますが、本レビュー環境では完走を独立確認できていません。
- `git status --short`の残差は`tasks/STATUS.md`と`tasks/T085a-exact-node-budget.md`のみで、対象コミットの実装残差ではありません。

## (d) 必須対応

1. 25% / 40% / 60% / 75%を同一コーパス・同一条件で比較し、目的関数ごとの数値と60%選定理由を記録する。
2. manifestを空き13〜30まで拡張し、各空き数・境界条件を`budget-regression`で検証する。
3. 木内部ExactQuotaを`fallbackReason`へ反映する。
4. 木内部quota切れ後の中盤継続とTTドメイン非混入を直接テストする。
5. 修正後に通常テスト、FFO #40〜44、budget-regressionを再実行する。

上記を満たせば再レビュー可能です。