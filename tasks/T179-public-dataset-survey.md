---
id: T179
title: 公開教師データの追加調査(Egaroucid他ボリューム・他ソース) — Web調査
status: done # Web調査完了(7系統発見、詳細は作業ログ)。オーケストレーター追試(2026-07-22): 推奨1「zip内の未使用7.4.0序盤ボリューム」は実在せず(zipは0001+READMEのみ=序盤データは0001に統合済み)→推奨1は無効、実質の最有力は推奨2(v0002 5200万局、要ラベル付け)と推奨4(Logistello)。取り込みはT180ボトルネック分析後に判断(ラベル付けコストがエンジン速度に依存するため)
assignee: general-purpose(Web調査)
attempts: 0
---

# T179: 公開教師データ調査

## 目的

ユーザー裁定(2026-07-22未明):「自己対戦で自給する必要はない。Egaroucidのように提供してくれている別データを探す方がよい」。現在使用中のEgaroucidデータ(0001_egaroucid_7_5_1_lv17、25.5M局面)以外に利用可能な公開教師データを調査する。

## 調査対象

1. **Egaroucid自身の他データ**(最有力): 配布ページに複数バージョン・複数ボリュームがないか(より新しい版・より深いレベルのラベル・追加ファイル)。ライセンス・再配布条件も確認
2. 他のオセロAIプロジェクトの公開学習データ(自己対戦棋譜・評価値付き局面)
3. 大規模棋譜アーカイブ(WTHOR以外)

## 成果物

レポート(このタスクファイルの作業ログまたは別mdへの調査結果): 各ソースのURL・規模・ラベル種別・ライセンス・ダウンロード方法・現行パイプライン(simple-corpus形式)への適合性。推奨の取り込み順。

## 受け入れ基準

- 調査結果が上記の観点で整理されている(ダウンロード・取り込みの実行は別タスク)

## 作業ログ

### 2026-07-22 Web調査完了(general-purpose)

調査方法: Egaroucid公式配布ページ(en/ja)・GitHub Releases・skatgame.net(Logistello/GGS)・figshare(Othello is Solved)・Kaggle等をWebFetch/WebSearchで確認。コード変更なし。

#### 1. Egaroucid公式配布データ(最重要の発見あり)

配布ページ: https://www.egaroucid.nyanyan.dev/ja/technology/train-data/ (en版同内容)。配布物は3系統:

| # | データ | URL(GitHub Releases) | 規模 | ラベル | 生成元 | 公開日 |
|---|---|---|---|---|---|---|
| 1a | Egaroucid_Train_Data.zip(盤面64文字+スコア) | Nyanyan/Egaroucid releases tag `training_data` | 25,514,097局面(100万行/ファイル) | 評価値=予想最終石差(手番視点) | 序盤(〜11手)=7.4.0 lv17、12手目以降=7.5.1 lv17自己対戦 | 2025-02-02 |
| 1b | Egaroucid_Train_Data_v0002_0/1.zip(対戦棋譜) | tag `training_data_v0002` | **5200万局**(ランダム序盤8〜59手×各100万局、f5d6形式1万局/ファイル) | **スコアなし**(棋譜のみ。最終石差は棋譜再生で自明) | Egaroucid 7.8.0 lv11 vs Edax 4.5.5 lv11 | **2026-06-02(新規)** |
| 1c | Egaroucid_Transcript.zip(自己対戦棋譜) | tag `transcript` | 200万局(f5d6、1万局/ファイル、ランダム序盤10〜19手) | スコアなし | Egaroucid 6.3.0 lv11 自己対戦 | 2023-07-17 |

- **1a は現行使用データそのもの**(0001_egaroucid_7_5_1_lv17 を含む zip)。ただし zip には序盤担当ボリューム(7.4.0 lv17、4〜15石は全手順列挙+negamax集約)も含まれる。現行パイプラインが 0001 のみ使用なら、**同 zip 内の 7.4.0 lv17 ボリューム(序盤局面)が未使用の追加データとして即利用可能**(要ローカル確認)。
- 1b/1c の注意: レベル11ラベル相当(棋譜のみ)であり、lv17探索値の 1a とはラベル品質が異なる。作者の推奨として「ランダム着手部分の局面は学習データから除外せよ」。
- **ライセンス(3系統共通)**: 自由に利用可(評価関数作成等)/**再配布禁止**/無保証。出典表記は任意(引用例: Yamana, Takuto.: Egaroucid Free Training Data)。→ 現行データと同じ扱い(リポジトリにデータをコミットしない)を踏襲すればよい。
- 7.6系等の追加の盤面+スコア版は配布されていない(盤面+スコア形式は 1a の1本のみ)。

#### 2. その他の公開ソース

| ソース | URL | 規模 | ラベル | ライセンス/再配布 | 入手方法 | 64文字+スコア形式への変換難易度 |
|---|---|---|---|---|---|---|
| Logistello book skeleton(Buro) | https://skatgame.net/mburo/log.html | 自己対戦 約3.7万ライン | 最終結果付き・**全ラインが24空きまでWLD検証済み** | GPL(ソース一式と同梱) | logbook.gam.gz / logbook.wtb.gz 直DL | 低(WTHOR形式ありで既存WTHOR経路を流用可) |
| GGS Othello棋譜アーカイブ(Buro) | https://skatgame.net/mburo/ggs/game-archive/Othello/ | 155ファイル(GGF+bz2、2002〜2022、計数百MB。数十万〜百万局規模) | 最終結果のみ(GGF内) | 明示なし(研究利用が慣行) | 直DL | 中(GGFパーサ自作+変則ルール局の除外が必要) |
| Othello is Solved 解析データ(Takizawa) | https://doi.org/10.6084/m9.figshare.24420619 (スクリプト: https://github.com/eukaryo/reversi-scripts) | 50空き2,587局面起点、36空き局面の解析CSV群(展開数百GB規模) | **理論値の上下限バウンド**(正確な一点スコアではない) | **CC BY 4.0(再配布可)** | figshare直DL | 高(バウンドラベルは回帰教師に不適。検証・プロービング用途向き) |
| OthelloGPT データ(Li et al.) | https://github.com/likenneth/othello_world | 選手権系 約14万局+合成2000万局 | なし(着手列のみ。合成分はランダム合法手で品質なし) | MIT(コード)/データは研究公開 | GitHub/Drive | 中(ただし評価学習には不適) |
| Kaggle: Othello Games(andrefpoliveira) | https://www.kaggle.com/datasets/andrefpoliveira/othello-games | 約2.5万局(eOthello人間対局、未検証: ページがJS必須で詳細未取得) | 最終結果 | Kaggle規約依存 | Kaggle CLI | 中(品質低・少量) |
| WTHOR | (現行使用済み・調査対象外) | — | — | — | — | — |

#### 3. 取り込み推奨順と理由

1. **Egaroucid_Train_Data.zip 内の 7.4.0 lv17 序盤ボリューム(未使用なら)** — 追加DL不要の可能性が高く、形式が現行と同一で変換コストゼロ。序盤局面の被覆を補う。
2. **Egaroucid v0002 棋譜 5200万局(2026-06新規)** — 最有力の増量源。同一作者・入手容易・巨大。ただしスコアが無いため、(a)最終石差ラベル(棋譜再生のみ、低コスト・低品質)か、(b)自前エンジン/Edaxでの再探索ラベル付け(高コスト・高品質)の選択が必要。ランダム序盤部分の局面は除外する。lv11品質である点は 1a より劣る。
3. **Egaroucid_Transcript.zip 200万局** — v0002 と同じ処理系で追加できる小口。優先度は v0002 に吸収されるため低。
4. **Logistello 3.7万ライン** — 量は少ないが 24空きWLD検証済みの最高品質ライン。終盤〜中盤の教師/検証セットとして少コストで価値あり。WTHOR形式で変換容易。
5. **GGS アーカイブ** — GGFパーサ実装の手間と品質のばらつき(人間・弱ボット混在、変則ルール)があり中優先。
6. **figshare(Othello is Solved)** — 唯一再配布可(CC BY 4.0)だがラベルがバウンドで回帰学習に不適。評価関数の検証・較正用として将来検討。
7. Kaggle/eOthello・OthelloGPT — 量・品質・ラベルの面で現行用途に合わず見送り。

#### 4. 制約事項の再確認

- Egaroucid系データはすべて**再配布禁止**。取り込みタスクではデータ本体を git 管理外(gitignore)に置く現行運用を維持すること。
- 主要出典: Egaroucid Free Training Data(https://www.egaroucid.nyanyan.dev/en/technology/train-data/)、Nyanyan/Egaroucid GitHub Releases、skatgame.net/mburo、figshare 24420619。
