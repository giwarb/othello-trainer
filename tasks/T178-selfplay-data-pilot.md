---
id: T178
title: 自己対戦データ生成パイロット — 自前エンジンによる教師データ自給の成立性検証
status: done # ユーザー裁定(2026-07-22)により縮小クローズ。実測: 62.3局/h=3,737局面/h(180k≈48h・25M≈9.2ヶ月)=自給非効率を数値で確定。生成器(self_play_gen、決定性・resume・テスト付き)は資産としてコミット(9e50fc7)。品質シグナル学習は中止
assignee: implementer
attempts: 0
---

# T178: 自己対戦データ生成パイロット

## 目的

強化提案の次の柱「自己対戦データ生成」の成立性検証。Egaroucid公開データ(25.5M、lv17ラベル)で大幅強化できた前例に対し、**自前エンジン(v6+深さ12+MPC t=1.0)で同種のデータを自給できるか**をスループットと品質シグナルで確認する。成功すればデータ量を外部依存なしに増やせる(Egaroucidと同じ自己改善ループ)。

## 設計方針

1. **生成方式**: 自己対戦(エンジン同士)。序盤の多様化は「最初のNply(例: 8-12ply)を決定的seed付きランダム合法手(または重み付き)で散らす」方式(Egaroucid/一般的な自己対戦生成の標準。決定的に再現可能なこと)。
2. **ラベル**: 各局面で自陣手番視点の**探索値(深さ12+MPC t=1.0のdiscDiff)**。対局を進めながら各局面の探索値を記録すれば、着手決定と同じ探索を流用できて追加コストほぼゼロ。終盤(空き20以下)はexact値。
3. **出力形式**: `--simple-corpus`がそのまま読める形式(`<64文字盤面> <スコア>`、train/src/simple_corpus.rsの仕様)。局面の重複・対称はsimple-corpus側の既存ハッシュ分割/canonicalKeyが処理するため生成側では気にしなくてよい(ただし同一局面の重複書き出しは避ける工夫があれば記録)。
4. **実装場所**: engineの新bin(例: self_play_gen)またはbenchスクリプト+eval_cli。実装が単純な方。決定性(seed→同一出力)必須。
5. **長時間実行ルール厳守**: 1局ごとにファイル追記(atomic)・resume対応・進捗ログ。夜間放置に耐えること。

## パイロットの実行と測定

6. **スループット実測**: まず100局生成して局面数/時間を実測し、**1時間あたりの局面数と、180k局面・1M局面・25M局面の所要見積り**を算出。
7. **180k学習による品質シグナル**: 生成データが180k局面に達したら(見積り上現実的な範囲で。届かなければ生成できた分で)、v6構成(t158-b3相当、canonical、早期打ち切り)で学習し、**Egaroucid 180k学習(T164スモークの条件を揃えた対照run)とfrozen MAEを比較**。分割はいずれも局面ハッシュ。同一frozen母集団になるよう設計に注意(自己対戦データで学習してEgaroucid由来frozenで評価する等、比較設計を明確にレポートで定義すること。「どちらのデータが良い教師か」の粗いシグナルが取れれば十分で、厳密な優劣判定はスコープ外)。
8. レポート: `bench/edax-compare/t178_selfplay_pilot_report.md`(+meta)。スループット・見積り表・品質シグナル・本格生成(1M級)への提案。

## スコープ外

- 本格生成(1M+)・本番採用・対局ゲート(パイロット結果を見てユーザー/オーケストレーターが判断)
- 探索側の変更(t=1.0はT176で配線済みのフラグを使うだけ)

## 受け入れ基準

1. 生成器が決定的(同一seed同一出力のスモーク実証)で、checkpoint/resume対応(中断→再開の実地確認1回)
2. スループット実測と規模別見積り表がレポートにある
3. 品質シグナル(対照条件を揃えた学習比較)の結果と比較設計の定義がレポートにある
4. `cargo test -p engine`(binを足した場合)`cargo test -p train`(触った場合)全パス、既存経路不変
5. 完了時 `git status --short` クリーン(生成データはgitignore領域 train/data/t178/ 等。パス明示コミット。`tasks/`とCLAUDE.mdはコミットしない)

## コミット規律

- 生成・学習は専有。detached+ツール呼び出しポーリング(Monitor依存禁止)。作業ログ節目追記

## 作業ログ

### 2026-07-21〜22 実装・パイロット実行・ユーザー裁定による縮小クローズ(implementer)

**生成器の実装**: `engine/src/bin/self_play_gen.rs`(新規bin、`--features mpc_enabled`必須)。v6+深さ12+MPC t=1.0(`search_with_eval_with_policy_and_margin_t`、T176)で自己対戦し、各局面のmover視点discDiffラベルを`--simple-corpus`形式(`train/src/simple_corpus.rs`)で出力。序盤8-12手(既定)は一様ランダム合法手で散らし、それ以外は探索のbest_moveを採用。決定性のため`time_ms`は常に`None`(壁時計に基づく打ち切りを一切使わない)。checkpoint(完了局数+設定fingerprint)をatomic保存し、起動時に既存checkpointとの設定一致を検証(不一致なら拒否)。出力ファイルは1局完了ごとに全行まとめて追記。

**ノード上限の追加(設計変更)**: 当初`time_ms: None`のみで探索の時間上限を一切設けない設計だったところ、smokeテスト中に1局が13分超でも完走しないケースを実測で発見(depth=12+MPC t=1.0の探索が稀な局面で極端に長引く)。決定性を保ったまま(壁時計ではなくノード数で)上限を設ける`--max-nodes-midgame`(既定1億)・`--max-nodes-exact`(既定5億)を追加し、1局あたり約50-60秒まで安定化した。

**決定性・resumeの実地確認**: (a) 本番設定(depth=12等)でseed=1・3局を独立に2回実行し、出力ファイルが完全一致(diff空)することを確認。(b) seed=42・8局の実行を1局完了直後にSIGKILLで強制終了(checkpoint gamesCompleted=1、出力60行、破損なし)、再起動して正しく続きから再開(gamesCompleted=1→2、出力120行、重複・欠落なし)することを確認。(c) 単体テスト5件(`rng_is_deterministic_for_same_seed`・`rng_differs_for_different_seeds`・`encode_mover_relative_matches_simple_corpus_convention`・`play_one_game_is_deterministic_for_the_same_seed_and_config`・`play_one_game_differs_for_different_seeds`)を追加(決定性テストは実行時間を抑えるためdepth=4の軽量設定を使用)。

**スループット実測**: seed=178001・`train/weights/pattern_v6.bin`・本番相当設定でPowerShell detached+Bashポーリング(Monitor非依存)で実行。30局完了時点で1734.06秒(28.9分)、1局あたり60局面(全観測局で一貫)。レート: 62.28局/時 ≈ 3,736.9局面/時。規模別見積り: 180k≈48.2時間(約2日)・1M≈267.6時間(約11.15日)・25M≈6,690時間(約9.2ヶ月)。

**ユーザー裁定による縮小クローズ**: 33局・1,980局面まで生成した時点(2026-07-22未明)で、コーディネーター経由のユーザー裁定「自給する必要はない、公開データを探す方が良い」を受け、以下を実施。(1) 実行中の生成プロセスを停止(PowerShell `Stop-Process`、checkpointは保全、出力ファイル破損なしを確認)。(2) 実測データからスループット見積り表を確定し、縮小レポート`bench/edax-compare/t178_selfplay_pilot_report.md`+`.meta.json`を作成(中止の経緯・見積り表・生成器を資産として保全する旨を明記)。(3) 180k学習による品質シグナル比較は中止判断により実施せず。(4) 生成器はテスト付きでコミット、生成済みデータ(`train/data/t178/selfplay_pilot.txt`・checkpoint)はgitignore領域にローカル保全。

**検証**: `cargo test -p engine`(全バイナリ)243 passed(lib、既存不変)+ 5 passed(`self_play_gen`新規)+ 他バイナリ全パス。`git status --short`は`engine/src/bin/self_play_gen.rs`のみ(コミット後クリーン)。生成データ・checkpointはgitignore領域のため対象外。

**変更・追加ファイル**: `engine/src/bin/self_play_gen.rs`(新規、テスト込み)、`bench/edax-compare/t178_selfplay_pilot_report.md`・`.meta.json`(新規、縮小クローズ報告)。
