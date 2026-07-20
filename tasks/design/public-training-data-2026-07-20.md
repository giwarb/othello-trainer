# 公開オセロ学習データ調査(2026-07-20、ユーザー指示起点)

調査: general-purpose(Web)エージェント。全URLは実確認済み。

## 結論

**最有力 = Egaroucid公式学習データ**(https://www.egaroucid.nyanyan.dev/ja/technology/train-data/ 、無料・登録不要。利用条件: 自由利用可・**再配布禁止**・出典明記推奨・無保証):

| データ | 規模 | ラベル | 形式 |
|---|---|---|---|
| Egaroucid_Train_Data.zip(2025-02) | **約2,551万局面**(4-63石) | **lv.17探索の予想最終石差** | 64字盤面(X=手番石/O=相手石/-)+スコア |
| Egaroucid_Train_Data_v0002_0/1.zip(2026-06) | **5,200万局**(棋譜) | リプレイで最終石差 | f5d6棋譜(序盤ランダム区間は学習除外推奨と明記) |
| Egaroucid_Transcript.zip(2023) | 200万局(棋譜) | 同上 | f5d6棋譜 |

その他: WTHOR最新版=**137,548局**(1977-2025、手持ち74,024のほぼ倍、ffothello.org)/Logistello book skeleton 3.7万本(終盤24手WLD保証)/GGSアーカイブ/OthelloAI_Textbook self_play 2万局(Egaroucidデータの縮小版、MIT)/othello_world・Kaggle(品質低め)/Othello is solved生データ(分布偏在)。

## 当プロジェクトへの適合

- 「量が支配要因」(T144確定)+「強AIの自己対戦が筋の良い教師」(教科書示唆)にどちらも合致。**8日級の自前Edaxラベル生成が不要になる**。
- Egaroucid Train_Data は(局面, 探索評価値)なので蒸留トレーナーのteacher-onlyと同型。序盤11手は網羅的評価+以降は自己対戦由来で分布も広い。
- 注意: **データをリポジトリにコミットしない**(再配布禁止。gitignore領域 train/data/ 配下に置く)。学習済み重みの公開は問題なし。WTHOR最新版は既存 train/data/*.wtb と混ぜず別ディレクトリへ(train_patterns_v3 が train/data/*.wtb を全部読む仕様のため、混ぜると既存v3/v4の再現性が壊れる)。

## 段階プラン(ユーザー方針: 重い処理は後回し)

1. **T153(軽)**: 取得+SHA記録+変換(トレーナーに単純(盤面,スコア)入力モードを追加)+**同量対照の品質確認**(v4×Egaroucid-subset@90万 vs 既知基準: v4×蒸留1M=1.900 / v2×WTHOR=1.5667 / v4×WTHOR=1.111、oracle60+M2ガード)。
2. (1が良好なら・重い)フル2,551万学習→対局ゲート→採否。さらにv0002リプレイ増強・WTHOR最新版統合の検討。
