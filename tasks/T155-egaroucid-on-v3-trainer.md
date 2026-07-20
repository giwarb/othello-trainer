---
id: T155
title: Egaroucidデータを本番トレーナー(train_patterns_v3)に取り込んで学習(oracle評価まで)
status: todo # todo | in_progress | review | redo | done | blocked
assignee: implementer(Sonnet)
attempts: 0
---

# T155: Egaroucid×本番トレーナー

## 目的

T154の結論(トレーナー差が支配的+Egaroucidデータは同量でWTHORより良い)を受け、**本番トレーナー train_patterns_v3 に Egaroucid簡易レコード(盤面,スコア)の取り込み機能を追加**し、v4パターンセットで学習して oracle regret を測る。**本番採用の対局ゲートは行わない**(重い処理は後回しのユーザー方針。oracle結果が v4×WTHOR の1.111を明確に下回れば、対局ゲートを後回しリストに積んで承認を仰ぐ)。

## 参照

- T154レポート: bench/edax-compare/t154_mixed_data_probe_report.md(A=WTHOR@t090 1.500 / B=Egaroucid@t090 1.233 / C=混合 1.433。本番v4×WTHOR=1.1111(3seed 0.70/1.67/0.97、T124))
- データ: train/data/egaroucid/extracted/0001_egaroucid_7_5_1_lv17(25,514,097行、64字盤面+スコア)。サブセット化の前例: T153/T154(t090の--simple-max-records+層化)。
- 本番トレーナー: train/src/bin/train_patterns_v3.rs + train/src/(samples_from_game/学習ループ)。v4×WTHOR実績: 74,024局→train 3,988,509サンプル、オンラインSGD lr0.005・L2 1e-5・20エポック・対局単位末尾10%ホールドアウト。

## 要件

1. **取り込み機能**: train_patterns_v3(または共有ライブラリ)に、WTHOR対局サンプルの代わりに/に加えて「簡易レコード(64字盤面+スコア)ファイル群」を学習サンプルとして読み込むモードを追加する(例: `--simple-corpus <dir> [--simple-max-records N]`)。**既定挙動(WTHOR学習)は完全不変**(既存v3/v4重みの再現性を壊さない。ユニットテスト+可能なら小規模での既定経路出力不変確認)。ホールドアウトは簡易レコードでは局面ハッシュ分割でよい(対局概念がないため。方式をレポートに明記)。
2. **学習runと事前登録**:
   - **E1: Egaroucidのみ @443万**(T154 Run Bと同規模・同サブセット方針)× seed 3本(T124と同じseed系。1runの実測時間が30分を超えるならseed1のみに縮小し理由を記録)
   - 参考 **E2: Egaroucidのみ @800万**(時間が許せば1本。1runが45分超なら省略可)
   - 各run T096 oracle 60局面+M2ガード(v2=1.5666666666666667の完全再現を記録)。
   - 解釈の事前登録: E1平均が **1.111を明確に下回る(目安: 3seed平均≤1.0)** → 本番採用候補として対局ゲート(重い、別タスク)を提案。1.1〜1.3なら同等(スケール増E2/フルの価値を検討)。1.3超なら本番トレーナーでもWTHORが優位=データ路線を保留しMPCへ。
3. レポート: bench/edax-compare/t155_egaroucid_v3trainer_report.md(+meta)。学習時間実測・件数・oracle結果・事前登録への当てはめ。コミット・push。
4. 長時間実行ルール: 学習はepoch checkpointがtrain_patterns_v3に無ければ「run単位で完走させる」でよい(1run30分以内目安)が、進捗ログは必須。detached起動+ツール呼び出しでのポーリング(Bashバックグラウンド禁止・Monitor通知への依存禁止=不達実績あり)。

## スコープ外

- 対局ゲート・本番配線・フル25.5M学習(結果を見て別途判断)
- t090側の変更、app/engine変更(Pages確認不要)

## 受け入れ基準

1. 既定挙動不変の担保(テスト+説明)、`cargo test -p train` 全パス
2. E1(3seedまたは縮小理由付きseed1)のoracle結果がM2ガード付きでレポートにあり、事前登録解釈への当てはめが明記されている
3. コード・レポートのみパス明示でコミットしmainへpush、データ非コミット、完了時 `git status --short` クリーン

## コミット規律

- 変更対象のみパス明示add。`tasks/` と `CLAUDE.md` はコミットしない(作業ログ追記は行う)

## 作業ログ

(ワーカーが節目ごとに追記)
