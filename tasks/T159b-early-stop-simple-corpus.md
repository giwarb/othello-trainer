---
id: T159b
title: 早期打ち切りの--simple-corpus(Egaroucid)経路対応 — Egaroucid全量学習シリーズ(1.5/3)
status: todo
assignee: implementer
attempts: 0
---

# T159b: 早期打ち切りのsimple-corpus経路対応

## 目的

T159で本番トレーナー(train_patterns_v3)に導入した早期打ち切りは、WTHOR経路専用で `--simple-corpus`(Egaroucidデータの取り込み経路、T155導入)とは併用エラーになる。**T160=Egaroucid全量25,514,097局面の学習は--simple-corpus経路で行うため、この経路への拡張が必須**(T159仕様の穴、オーケストレーター起因)。

あわせて、T159の代替レビュー(tasks/review/T159-trainer-early-stopping-claude-review.md)の中指摘3件を、25.5M規模で問題になる前にここで対処する。

## 変更対象

- `train/src/bin/train_patterns_v3.rs`(T159実装: 8372aa2)
- `train/src/simple_corpus.rs`(読み込み側の構造確認。必要最小限の変更のみ可)

## 要件

1. **検証splitの単位の調査と決定(最初にやる)**: `train/src/simple_corpus.rs` とEgaroucid実データ(`train/data/egaroucid/` 配下、gitignore領域)の形式を調査し、対局(game)境界が復元できるか確認する。
   - 対局境界が使える場合: WTHOR経路と同じく対局単位のハッシュsplitにする
   - 使えない場合: 局面ハッシュ単位のsplitとし、**類似局面リーク(同一対局由来・transposition)により検証MAEが楽観側に偏るリスクをレポートに明記**する(早期打ち切りの停止タイミングが遅れる方向のバイアスであり、致命的ではないが記録必須)
   - どちらを採用したかと根拠を作業ログ・完了レポートに明記
2. **メモリ効率(レビュー中3)**: 検証splitはT159のclone+flatten方式(ピーク約3倍メモリ)を避け、**インデックスベースの分割**にする(25.5M局面で確実に問題になるため)。WTHOR経路の既存実装は変更しなくてよい(T160はsimple-corpus経路のみ使う)が、共通化できるなら可。
3. **エポック評価コスト(レビュー中2)**: simple-corpus経路の早期打ち切りでは、毎エポックのフルパス評価をval_maeの1回に抑える(train損失は学習パス中の逐次集計で代替し、追加フルパスを行わない)。25.5Mでのエポックあたり追加コストの実測値(180k相当スモークからの外挿でよい)を作業ログに記録。
4. **resume脆弱窓の解消(レビュー中1)**: checkpoint保存後・state.txt書き込み前にクラッシュすると「checkpoint epoch mismatch」で恒久再開不能になる問題を、simple-corpus経路では起こさない(書き込み順序の見直しまたは片側先行を許容する回復ロジック)。WTHOR経路側も同一修正が安全に共有できるなら直してよい(OFF経路の不変は維持)。
5. **identity/決定性**: simple-corpus早期打ち切り用のidentity(corpus識別・フラグ群を含む)。同一入力での再実行・resumeが決定的に同一結果になること。
6. **軽微修正(レビュー指摘のうち安価なもの)**: `append_result_earlystop` の重複判定キーのプレフィックス衝突(seed 1 vs 12)を修正。`--epochs`がON時に黙って無視される点は明示エラーまたは警告にする。
7. **テスト**: (a)simple-corpus経路のOFF時不変(既存T155スモーク方式) (b)split決定性 (c)resume同一性(脆弱窓ケース=checkpointのみ先行した状態からの回復を含む) (d)patience/ベスト復元(小さな合成corpusで)。
8. **動作確認**: Egaroucid実データの小サブセット(例: 180k局面相当)で `--simple-corpus --early-stop` 学習を1回実行し、エポック推移・打ち切り・所要時間を記録(成果物はtrain/data/配下gitignore領域)。**この実測から25.5M全量の1エポック時間と総時間の見積りを算出し作業ログに明記**(T160の仕様に使う)。

## スコープ外

- Egaroucid全量25.5Mでの学習実行(T160)
- B3特徴側の変更・対局ゲート・採否判定
- WTHOR経路のメモリ/コスト最適化(共有修正が自然な場合を除く)

## 受け入れ基準

1. `cargo test -p train` 全パス(新規テスト込み)
2. simple-corpus経路のOFF時不変(重みSHA-256一致)とWTHOR経路(early-stop ON/OFF両方)の挙動不変の実証が作業ログにある(WTHOR ONはT159の180kスモーク再現等の軽い方式でよい)
3. Egaroucid実データのサブセットで早期打ち切りが動作した記録と、25.5M全量の時間見積りがある
4. 変更ファイル一覧と検証結果を完了報告に明記。パス明示でadd・コミット(`git add .`/`-A`禁止)。一時ファイル不残置、完了時 `git status --short` クリーン(`tasks/`とCLAUDE.mdはコミットしない)

## コミット規律

- `tasks/` と `CLAUDE.md` は変更しない(作業ログ追記は行う)。学習スモーク中は他の重い処理と並行しない。detached起動+ツール呼び出しポーリング(Bashバックグラウンド・Monitor通知依存禁止)

## 作業ログ

(ワーカーが節目ごとに追記)
