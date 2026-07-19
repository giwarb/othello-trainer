---
id: T139
title: エンジン: 候補手評価の対称性・決定性の根本対応(TT共有/MPC由来の±1石ノイズ)
status: in_progress # 生成完走(7/19)によりCPU専有可。Codex上限中(7/23まで)のためSonnet+検証強化で着手(2026-07-20)
assignee: implementer(Sonnet)(Codex usage limit中のフォールバック)
attempts: 0
---

# T139: analyzeAllの対称性・決定性

## 目的

対局モードの候補手評価で、対称局面(初手d3/c4/f5/e6等)の評価値が±1石ズレる(T138調査で確定した機構: `search_all_moves_with_eval`が4手を同一TTで逐次探索+MPC近似枝刈り。engine/src/search.rs:1066-1229)。T138でブックcapにより序盤の実害は消えるが、ブック外の中盤では残る。根本対応として、表示用analyzeAllの「対称局面同値・実行順不変」を可能な範囲で確立する。

## 検討する選択肢(実装時にA/Bして採否判断)

1. `search_all_moves_with_eval`で各手の探索前にTTをクリア(または手ごとに独立TT)— 順序依存を除去。速度影響を計測(オーバーレイ用途なので多少の低速化は許容)。
2. analyzeAll経路のMPC無効化(`suppress_mpc: true`)— 近似性を除去。深さ低下/速度影響を計測。
3. 対称局面のcanonical化(4初手対称のみの特例でなく一般のD4 canonical化で探索し値を共有)— 効果は広いが実装大。
- 併せて `PatternWeights::score` の盤全体D4不変性を直接検証する単体テストを追加(explorer調査で欠落を確認済み)。

## 受け入れ基準(2026-07-20精緻化)

- [ ] 初期局面の4合法手のanalyzeAll値が完全一致する(自動テスト。可能なら初期局面以外の対称局面ペアでも)
- [ ] 同一局面のanalyzeAllを2回呼んで完全一致(TT状態に依存しない。事前にTTを汚す先行探索を挟んだケースを含む)
- [ ] FFO正解・既存エンジンテスト全パス(`cargo test -p engine`。既知フレーキー`node_limited_protocol_requests_are_deterministic`は単独再実行で切り分け)
- [ ] CPU着手経路(cpuLimit)のノード数・選択手が完全不変であることをテストまたはベンチ比較で示す(表示経路のみの変更であること)
- [ ] 速度影響の計測(analyzeAll 1回あたりの壁時計、変更前後)と採否判断の記録。オーバーレイ用途なので多少の低速化は許容だが、体感を損なう場合(目安2倍超)は選択肢を再検討
- [ ] **表示評価値が変わるため `ANALYSIS_ENGINE_VERSION` をインクリメント**(app/src/lib/cache.ts。解析キャッシュ混在防止、T122申し送りのコメント表現修正も同時に)
- [ ] wasm再ビルド→mainへpush→GitHub Actionsデプロイ成功→Pages実機(https://giwarb.github.io/othello-trainer/)で対局モードの候補手評価表示が動作し、初手4手の表示値が一致することをPlaywright等で確認
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと

## フィードバック(やり直し時にオーケストレーターが記入)

## 作業ログ(担当エージェントが追記)
