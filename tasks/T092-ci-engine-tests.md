---
id: T092
title: GitHub Actionsにエンジン/トレインのテストジョブを追加(cargo test + FFO fast)
status: done # todo | in_progress | review | redo | done | blocked
assignee: implementer
attempts: 0
---

# T092: CIにエンジンテストジョブを追加

## 目的

現在のGitHub Actionsは「Deploy to GitHub Pages」(wasm-pack+appビルド)のみで、`cargo test` を一切実行していない(T085a検証時のverifier指摘)。エンジンに回帰が入ってもCIが緑のままになる穴を塞ぐ。

## 背景

- 既存workflow: `.github/workflows/` 配下(デプロイ用)。これは変更しない(別ジョブ/別workflowとして追加)。
- テストの実行時間実績(ローカル): `cargo test -p engine` 約15秒+ビルド、FFO fast(`--release --test ffo_bench`)約8〜9分、`cargo test -p train` 数秒(ただしWTHOR実データ依存のテストが1件ある — CI上ではデータが無いので**スキップされるか失敗するかを確認し、失敗するなら`#[ignore]`等でCI安全にする方法を報告**。データをCIに置くのは禁止)。

## 要件

1. 新しいworkflow(例: `.github/workflows/tests.yml`)を追加: push(main)とpull_requestで実行。
2. ジョブ内容: `cargo test -p engine`(debug)+ `cargo test -p engine --release --test ffo_bench`(fast系のみ、heavyはignoredのまま)+ `cargo test -p train`(WTHOR実データ依存テストの扱いは上記のとおり安全化)。
3. Rustツールチェーンのセットアップとcargoキャッシュ(`actions/cache`または`Swatinem/rust-cache`)を入れてCI時間を抑える。
4. 既存のデプロイworkflowには触らない。
5. **ローカルでのcargoビルド/テスト実行は最小限にする**(現在ローカルで長時間の教師コーパス生成が実行中のため。workflowの検証はpush→Actions実行結果で行う)。

## やらないこと(スコープ外)

- デプロイworkflowの変更
- appのnpmテストのCI追加(将来課題。今回はRustのみ)
- WTHORデータのダウンロードをCIに組み込むこと

## 受け入れ基準

- [ ] 新workflowがpush後に自動実行され、**Actions上で全ジョブ成功**していること(実行リンクを作業ログに記載)
- [ ] FFO fastがCI上で完走し正解値パスしていること(ログで確認)
- [ ] 既存のDeploy to GitHub Pagesが引き続き成功していること
- [ ] 変更は `.github/` 配下(+必要なら train のテスト属性1箇所)のみ
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

### 2026-07-14 実装・検証(implementer)

**実施内容:**

- 既存の `engine/tests/ffo_bench.rs` / `engine/tests/pattern_eval_nps_bench.rs` / `train/tests/real_data.rs` を調査。
  - `ffo_bench.rs` の fast系テスト(`ffo_endgame_fast_positions_solved_correctly_with_timing_and_nps`)はFFO #40-#44(空きマス20-23)のみを対象とし、`#[cfg_attr(debug_assertions, ignore)]` によりdebugビルドでは自動スキップされる設計済み。heavy系(#45-#49)は既存の `#[ignore]` のまま(CIでは実行しない)。
  - `train/tests/real_data.rs`(WTHOR実データ依存の統合テスト)は、`train/data/` が存在しない環境では `panic`/`assert` に到達せず `eprintln!` して早期 `return` する実装に**既になっていた**ため、CI(WTHORデータ非同梱)では失敗せず正常にスキップされることをコード読解で確認。**train側の属性変更・コード変更は不要と判断し、実施しなかった**(要件2の「安全化」は既存実装で満たされていた)。
- 新規workflow `.github/workflows/tests.yml` を追加(既存の `deploy-pages.yml` には一切触れていない)。
  - トリガー: `push`(`main`)・`pull_request`
  - 単一ジョブ `test`(ubuntu-latest)、ステップ:
    1. `actions/checkout@v4`
    2. `dtolnay/rust-toolchain@stable`(wasm targetは不要なので指定なし)
    3. `actions/cache@v4`(`~/.cargo/registry` `~/.cargo/git` `target`、キーは `${{ runner.os }}-cargo-test-${{ hashFiles('**/Cargo.lock') }}` — デプロイworkflowのキーとは名前空間を分離してキャッシュ競合を回避)
    4. `cargo test -p engine`(debug)
    5. `cargo test -p engine --release --test ffo_bench -- --nocapture`(FFO fastのみ)
    6. `cargo test -p train`
- ローカルでのcargoビルド/テスト実行は一切行っていない(教師コーパス生成が並行実行中のため。オーケストレーター指示どおりpush→GitHub Actions結果のみで検証)。

**変更ファイル:** `.github/workflows/tests.yml`(新規追加、45行)。他ファイルは変更なし。

**実行結果(受け入れ基準の検証):**

- コミット `8142db1`(`ci: GitHub ActionsにRustテストジョブを追加(cargo test -p engine/train + FFO fast)(T092)`)をpush。
- **Rust Tests workflow**: run [29368020652](https://github.com/giwarb/othello-trainer/actions/runs/29368020652) — `test`ジョブ **success**(21:02:15〜21:14:07、約12分)。
  - `cargo test -p engine`(debug): success(約28秒)
  - `cargo test -p engine --release --test ffo_bench`(FFO fast): success(約11分、#40〜#44全問正解でassert通過)
  - `cargo test -p train`: success(約1秒、`real_data.rs`はtrain/data不在によりスキップ扱いで正常終了)
- **Deploy to GitHub Pages**: 同じpushに対する run [29368020529](https://github.com/giwarb/othello-trainer/actions/runs/29368020529) も `build`・`deploy`ともに **success**(既存デプロイworkflowは無変更・影響なしを確認)。
- 後続の別タスク(T093)のコミット(`7a882570`)に対する run [29369950388](https://github.com/giwarb/othello-trainer/actions/runs/29369950388) でも「Rust Tests」workflowが継続してsuccessしていることをオーケストレーターが確認済み(継続的な健全性の追加傍証)。
- `git status --short` は本タスク由来の差分・未追跡ファイルなし(`.github/workflows/tests.yml` はコミット済み。他に未追跡の `bench/edax-compare/*.py` 等が存在するが、これは他タスク由来でありT092の変更対象外)。

**仕様どおりにできなかった点・判断に迷った点:** なし。要件2の「train実データ依存テストのCI安全化」は既存コードが既に満たしていたため、コード変更なしで対応した。

**コミット:** `8142db1`(`.github/workflows/tests.yml` のみ)。push・Actions確認まで完了。
