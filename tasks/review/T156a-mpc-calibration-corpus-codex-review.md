# 最終レビューレポート — T156a

対象: `git diff 8c63eba..9749edb` / `git log 8c63eba..9749edb`

## (a) 重大（done を止めるブロッカー）

なし。

現行成果物を無効にする正しさの問題、仕様逸脱、本番探索への回帰は確認できなかった。

## (b) 中（次タスクで対応すべき）

### 1. shard merge時の入力整合性検証が不足している

[calibrate_mpc.rs](C:/Users/yoshi/work/othello-trainer/engine/src/bin/calibrate_mpc.rs:383) の `cmd_merge` は、入力shard間でfingerprint・depths・pilotOnlyを比較しているが、次を検証していない。

- `--positions`で渡された実ファイルのfingerprintとshardの`positionsFingerprint`の一致
- `schemaVersion`の一致
- pilot mergeでは`pilotOnly == true`であること
- 各recordのdepth集合がヘッダーの`depths`と一致すること
- 重複recordの`empties`、`emptyBucket`、`split`、`gameId`の一致

現在は重複時に`results`だけを比較しているため、誤ったpositionsファイルやmetadataが異なるshardを渡しても、IDと探索結果が一致すれば不整合な完成JSONを生成し得る。

コミット済みpilot成果物については、positionsとのID・bucket・split・件数を確認した限り不整合はなく、今回の完了を止める問題ではない。1,200局面の本測定に進む前に、merge境界で上記を検証することを推奨する。

## (c) 軽微（記録のみ）

### 1. CLI usageにmerge・shard引数が掲載されていない

[calibrate_mpc.rs](C:/Users/yoshi/work/othello-trainer/engine/src/bin/calibrate_mpc.rs:195) のusageには`merge`、`--shard-count`、`--shard-index`が記載されていない。機能自体は動作するが、再生成手順の発見性が低い。

### 2. 測定条件fingerprintが非暗号学的FNV-1aである

checkpointのpositions/weights識別にはFNV-1a 64bitとファイル長が使われている。通常の誤操作検出には十分だが、抽出metaで採用しているSHA-256と統一すると、長期的な成果物の由来確認がより明確になる。現要件は測定JSONのSHA-256を要求していないため、仕様違反ではない。

## 確認結果

- 変更は指定範囲で1コミット、7ファイルのみ。
- `engine/src/search.rs`および`engine/src/mpc.rs`に差分なし。
- `search_with_eval`は既存実装上`enable_heuristics=false`であり、history・aspirationともOFF。
- `SearchLimit`は深さ1〜12、`time_ms=None`、`exact_from_empties=0`。
- 各深さで独立したTTを生成し、v4 weightsを明示的に渡している。
- positionsは1,200件、pilotは320件。
- 各空き帯300件／pilot 80件。
- splitは720/240/240、pilotは192/64/64。
- 完全同一盤面＋手番の重複は0件。
- 同一ゲームのsplit跨ぎは0件。
- 同一ゲーム・同一空き帯からの複数抽出は0件。
- meta記載の25個のWTHOR SHA-256は手元の各ファイルと一致。
- positionsの実SHA-256はmetaの`outputSha256`と一致。
- pilot測定は320件すべてに深さ1〜12の12結果があり、欠損・不正depthは0件。
- 統計成果物は320件、4帯×66深さペア＝264グループ。
- `git diff --check`成功。
- `main`は`origin/main`と一致し、指定コミットはpush済み。
- `git status --short`はクリーン。
- 作業ログにはengine/trainテスト、FFO回帰、抽出決定性、resume、merge重複一致、統計self-testの成功記録がある。

## (d) 総合判定

**合格**

コーパス抽出、ゲーム単位split、重複排除、決定的再生成、source/output SHA、pilot/fullの入れ子、v4による深さ1〜12測定、局面単位checkpoint/resume、統計成果物という主要要件を満たしている。本番探索経路にも変更はなく、生成済み成果物の件数・対応関係・ハッシュにも問題はなかった。

merge検証の不足は1,200局面測定前に強化すべきだが、現在のpilot成果物が誤っている証拠はなく、T156aのdoneを止めるブロッカーには該当しない。