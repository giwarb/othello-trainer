# 最終レビューレポート

## (a) 重大（done を止めるブロッカー）

### 1. Gate 2/3 の入力条件が機械検証されておらず、コミット済み成果物から実測条件を確認できない

[compare_mpc.py](C:/Users/yoshi/work/othello-trainer/bench/edax-compare/compare_mpc.py:69) はレコードキーを突き合わせて集計するだけで、checkpoint の `config` を検証していません。

具体的には、以下を確認せずに合否を出せます。

- Gate 2がdepth 8/10/12、test 240局面、exact/history/aspiration OFF、MPCだけON/OFFであること
- Gate 3がv4重み、160k、quota 60%、exact_from_empties=16であること
- A〜Dが規定どおりのpolicyであること
- 全構成が同じ120局面を使っていること
- 空き20以下が除外されていること
- 指定されたoracle positionsとlabelsの対応・fingerprint
- schemaVersionや重複レコードの不存在

特にGate 3ではA/Bのキーしか比較せず、C/Dが同じ対象集合であることも保証されません。[main](C:/Users/yoshi/work/othello-trainer/bench/edax-compare/compare_mpc.py:251) もoracle labelsしか受け取らず、仕様で指定された `t157_oracle_positions.json` を検証していません。

さらに、[meta](C:/Users/yoshi/work/othello-trainer/bench/edax-compare/t156_mpc_gates_report.meta.json:240) に保存されているのは削除済み一時checkpointのパスとSHA-256だけで、各checkpointの `config`、positions/weights fingerprint、レコード集合は残っていません。このため、レポートに書かれた「v4・160k・規定A〜D」という条件をコミット済み成果物から監査・再現できません。

実測値自体は妥当らしい数値ですが、誤った入力でも同じ機械判定を通せるため、受け入れ基準1・2および要件3・4・6を満たしたとは確認できません。入力schema/config、期待される局面ID集合、positions/weights fingerprintを分析時に検証し、検証済みconfigをmetaへ保存する必要があります。

## (b) 中（次タスクで対応すべき）

### 1. `--max-positions` がcheckpoint設定に含まれず、異なる対象集合を黙ってresumeできる

`--max-positions` は [calibrate_mpc.rs](C:/Users/yoshi/work/othello-trainer/engine/src/bin/calibrate_mpc.rs:548) で対象選択に使われますが、[GateConfig](C:/Users/yoshi/work/othello-trainer/engine/src/bin/calibrate_mpc.rs:554) には保存されません。

そのため、同じ出力ファイルを異なる `--max-positions` で再実行しても設定不一致になりません。既存レコードが新しい選択範囲より多い場合には、余分なレコードを残したまま完了し、進捗表示も `completed > total` になり得ます。局面単位checkpoint/resumeの条件同一性が保証されないため、選択上限または選択済みID集合のfingerprintを設定に含めるべきです。

### 2. 重複レコードを検出せず上書きする

[by_key](C:/Users/yoshi/work/othello-trainer/bench/edax-compare/compare_mpc.py:42) は辞書化によって同一 `(id, depthRequested)` を黙って上書きします。また、[oracle_regrets](C:/Users/yoshi/work/othello-trainer/bench/edax-compare/compare_mpc.py:134) も同一IDを上書きします。

今回の既知コーパスが一意なら実測への影響はありませんが、壊れたcheckpointを正常として集計し、局面数・比率・bootstrapを歪める可能性があります。辞書化前にレコード数とキー数の一致を検証すべきです。

### 3. `exactAccountingNormal` の検査が限定的

[exact_summary](C:/Users/yoshi/work/othello-trainer/bench/edax-compare/compare_mpc.py:110) が検査するのは一部の不変条件だけです。少なくとも以下が未検査です。

- root完走数とroot試行数の整合
- bound proof完走数とleaf完走数の整合
- quota abort数と試行数の整合
- `exactNodes`、`midgameNodes`、総ノード会計の整合
- 構成間の異常な偏り

レポートでは「異常な偏りなし」と判定していますが、機械判定の `exactAccountingNormal=true` はその結論全体を裏付けていません。

## (c) 軽微（記録のみ）

- Rust側に約415行、分析スクリプトに273行の追加がありますが、新CLIの設定拒否、resume、merge異常入力、集計境界を対象にした自動テストは追加されていません。作業ログのsmokeと既存テスト通過は確認できますが、今回指摘した入力検証漏れを防ぐ回帰テストが望まれます。
- Gate 3を不合格としてT156eへ進まない判断自体は、報告された数値と事前登録基準に整合しています。Gate 3不合格そのものは問題ではありません。

## (d) 総合判定

**不合格**

Gate 3不合格という実測結果と撤退提言は妥当ですが、Gate判定スクリプトが測定条件・対象集合を検証せず、コミット済みmetaにも検証可能なconfigが残っていません。そのため、タスクの中心である「規定条件でのGate 2/3を機械検証したこと」を成果物から保証できず、doneにはできません。

なお、指定された `git log 81c6207~1..81c6207`、`git diff 81c6207~1..81c6207`、設計書および周辺検索コードをread-onlyで確認し、ファイル変更は行っていません。