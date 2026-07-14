---
id: T092
title: GitHub Actionsにエンジン/トレインのテストジョブを追加(cargo test + FFO fast)
status: todo # todo | in_progress | review | redo | done | blocked
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
