---
id: T095
title: 蒸留学習トレーナーの高速化(6run並列化・WTHORキャッシュ・重複計算排除)
status: in_progress # todo | in_progress | review | done | blocked
assignee: codex(gpt-5.6-sol)
attempts: 0
---

# T095: 蒸留学習トレーナーの高速化

## 目的

今後の蒸留実験(oracle再判定後の再学習、v3×蒸留、200kコーパス)の反復を速くする。explorer調査(2026-07-15)で判明したトレーナー(`train/src/t090_distillation.rs` ほか)の非効率3点を潰す。**数値結果(学習される重み・指標)は変えない純粋な高速化**であり、等価性をテストで担保する。

## 背景(explorer調査の要点)

- 6run(mix×seed)は完全直列(`t090_distillation.rs:735-873` の二重forループ)。各runは独立Model・独立checkpoint dirで、共有は読み取り専用スライスのみ。rayon/thread使用は皆無。マシンは物理8コア/論理16スレッド。
- 起動時のWTHOR処理(`experiment.rs:44-57` `canonicalize()` を推定100万〜200万サンプルに適用)が**固定約20秒**。コーパスサイズ非依存で、smoke反復のたびに毎回払っている。
- `train_step`(`t090_distillation.rs:373-434`)の重複計算: 親局面で `features()` と `model.predict()` が同一の `pattern_state_index` を独立に2回計算。pairsループ内で best 側の `child_score`/勾配を毎回再計算(pairs全体で不変なのに最大3回)。実測で baseline(pairsあり)0.49秒/epoch vs teacher-only 0.105秒/epoch(45,055件)。
- クリーン実行の実測: 6run合計の純計算は約100秒。T090bログの「10〜30分」は環境負荷の混入。

## 要件

1. **6runの並列実行**: `std::thread::scope` 等で `run_one` を並列化する(既定の並列度は run 数と論理コアから安全側で決定、CLIで `--jobs` 指定可能に)。各runの決定性・checkpoint/resume・run identity検証は不変。**直列実行時と選択重み(best/final.bin)がバイト一致**すること。進捗ログはrunラベル付きで混在出力してよい。
2. **WTHOR outcomeマップのディスクキャッシュ**: `wthor_hash`(既存のrun identityで使っているハッシュ)+スキーマバージョンをキーに、集計済みoutcomeマップ・wthor_2024テスト集合をシリアライズしてキャッシュする(置き場所は `train/data/` 配下のgitignore領域)。キー不一致時は再構築。キャッシュ有無で結果がバイト一致すること。
3. **train_stepの重複計算排除**: (a) 親局面の `features()`/`predict()` の状態インデックス計算を1回に統合、(b) pairsループ内のbest側スコア/勾配をループ外へ引き上げ。数値結果(全エポックのmetrics、最終重み)が修正前とバイト一致すること。
4. (任意・時間が許せば) `canonicalize`/`transform_bits` のビットトリック化(64セルループ→シフト+マスク)。既存64セル実装との**全数または広範なランダム一致テスト**を付けること。リスクが高いと判断したら見送って作業ログに理由を書く。
5. 高速化の実測(修正前後の wall time)を作業ログに記録する。計測は**他の重い処理が走っていない専有状態**で行う(環境負荷混入の教訓)。

## やらないこと(スコープ外)

- エポック内のデータ並列化・mini-batch化(共有クラス重みとの競合で再現性リスク高、explorer調査の結論により不採用)
- 学習アルゴリズム・ハイパラ・損失・データ分割の変更
- engineクレートの変更(`pattern_eval.rs` 等は読み取り利用のみ)
- 200kコーパス対応・v3特徴対応(既存コードのまま動くはず。動かない場合のみ報告)

## 受け入れ基準(検証コマンド)

- [ ] `cargo test -p train` / `cargo test -p engine` 全件パス(等価性テスト・キャッシュ整合テスト含む)
- [ ] 等価性: smokeコーパスで「修正前(現行main)」と「修正後(直列モード)」「修正後(並列モード)」の3通りを同一引数で実行し、選択重みのSHA-256が3者一致することを作業ログに記録
- [ ] キャッシュ: 初回(構築)と2回目(ヒット)で結果バイト一致、2回目の起動オーバーヘッドが大幅短縮していること
- [ ] 高速化実測: 6run(primaryコーパス、実エポック)で修正前比の合計wall time短縮率を記録
- [ ] `cargo test -p engine --release --test ffo_bench` — FFO #40-44 不変(engine無変更の確認)
- [ ] 変更対象ファイルのみパス指定でコミット(Codexサンドボックスではコミット不可のため、変更ファイル一覧を完了レポートに明記しオーケストレーターが代行)
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと

## フィードバック(やり直し時にオーケストレーターが記入)

## 作業ログ(担当エージェントが追記)
