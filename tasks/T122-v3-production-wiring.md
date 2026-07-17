---
id: T122
title: v3×WTHOR重みの本番配線(評価関数の世代交代)
status: in_progress # todo | in_progress | review | redo | done | blocked
assignee: Codex gpt-5.6-sol(codex-task)
attempts: 0
---

# T122: v3×WTHOR重みの本番配線

## 目的

T121で最終審査に合格した **v3×WTHOR重み**(`train/data/t087/v3-seed-3.bin`、PWV3形式、SHA-256 `d815dd6fbfd3e426ec9f05a3cd0b3d6b5963e518d918bee85301ad83dbc0de92`)を本番アプリの評価関数として配線し、GitHub Pagesに公開する。オーケストレーター採用裁定(2026-07-17、T121の判定材料: oracle regret 1.400 vs v2 1.567、対Edax60局 -21.23 vs -21.85、NPS 93.7%、回帰ゼロ)。

## 背景・前提

- v3特徴・PWV3形式のエンジン側基盤はT087で実装・コミット済み(eval_cli等はpattern-set選択に対応済み=T110)。**WASM経路(app→worker→engine)がPWV3ロードに対応しているかは要確認** — 未対応ならエンジン/プロトコルの必要最小限の拡張を行う。
- 現行の重み配信: v2重み(`pattern_v2.bin`相当)がアプリ資産としてどう配布・ロードされているか(app/public/? Cache Storageのキャッシュ? Service Workerのバージョニング?)を調査し、**同じ機構でv3を配信**する。v3重みは5,964,708 bytes(v2とサイズ比較を作業ログに記録)。
- **ロールバック容易性**: v2重みと切替機構は残す(即時に戻せる形。UIトグルは不要、コード上の定数/設定切替でよい)。

## 要件

1. **配線**: 本番アプリ(対局CPU・解析・詰めオセロ等、評価関数を使う全経路)の重みをv3に切り替える。重みファイルの配置はリポジトリの既存流儀に従う(巨大バイナリの扱い: v2が既にリポジトリ/配信に含まれる流儀をそのまま踏襲。Git LFS等の新機構は導入しない)。
2. **キャッシュ整合**:
   - `ANALYSIS_ENGINE_VERSION` を3→**4**にインクリメント(評価値が変わるため解析キャッシュ無効化が必須)。
   - **ついで対応(T107申し送り)**: `app/src/analysis/cache.ts` のANALYSIS_ENGINE_VERSION=3時に追記されたコメントの根拠が不正確(解析経路はquota非依存)なので、今回の変更にあわせて正しい説明に修正。
   - Service Worker / Cache Storageの重みキャッシュが更新されること(バージョン繰り上げ等、既存機構の流儀)を確認。
3. **検証**:
   - エンジン単体: v3ロード後のeval値がeval_cli(--pattern-weights v3)と一致するサンプル検証。FFO #40-44正解値不変。`cargo test -p engine` 全件パス。
   - app: `npm test -- --run` グリーン、`npx tsc --noEmit` エラーなし。既存テストが重みに依存している箇所の追従。
   - 本番: push→Actions成功→**Pages実機で対局・解析・詰めオセロが正常動作**し、評価値が表示されること(Playwright推奨)。重みの取得(ネットワークタブ相当でv3ファイルの200)を確認。
4. **決定性**: 同一局面での再現一致(サンプル)。
5. 変更対象ファイルのみパス指定でコミット(`(T122)`)。tasks/とCLAUDE.mdはコミットしない。

## やらないこと(スコープ外)

- 評価関数のさらなる学習・調整
- UIでの重み切替機能
- 定石DB・終盤ソルバーの変更

## 受け入れ基準(検証コマンド)

- [ ] 本番Pagesの対局CPU(強)・解析・評価バーがv3重みで動作している(実機確認の証跡)
- [ ] `ANALYSIS_ENGINE_VERSION`=4、cache.tsコメント修正済み
- [ ] eval_cli(v3指定)とWASM経路の評価値一致サンプル、FFO不変、決定性一致の記録
- [ ] `cargo test -p engine`+`npm test -- --run`+`npx tsc --noEmit` 全グリーン
- [ ] v2への切り戻し手順(1〜2行の変更で戻せること)が作業ログに記録されている
- [ ] 変更をmainにpushし、GitHub Actionsのデプロイ成功を確認済み
- [ ] 変更対象ファイルのみパス指定でコミット(`(T122)`)
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと

## フィードバック(やり直し時にオーケストレーターが記入)

## 作業ログ(担当エージェントが追記)
