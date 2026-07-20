# 最終レビューレポート

対象コミット: `60c2b27`  
総合判定: **不合格**

## (a) 重大（done を止めるブロッカー）

### Gate 3 の stage 判定が仕様より粗く、重大退行を隠している

タスク仕様は Gate 3 で「stage別重大退行なし」を要求しています。しかしレポートと meta は、61個の empty-count stage を5つの広い帯へ集約した `maxStageBandRegression` だけで判定しています。

- `t158b_training_report.md:60-62`
- `t158b_training_report.meta.json:34,51,63`

レポートは最大悪化を `+0.014026` としていますが、生成済みの空き数別 raw metrics を B3−B0 で再計算すると、次の局所退行があります。

- seed 1、empty=43: **+0.228951**
- seed 1、empty=53: **+0.197828**
- seed 1、empty=54: **+0.137782**
- seed 3、empty=46: **+0.140260**

各 stage は7,402サンプルあり、少数サンプルだけによる値ではありません。Gate 2 の仕様は明示的に「stage帯別」ですが、Gate 3 は「stage別」であり、この差を事後的に帯集約へ置き換える根拠は示されていません。

なお、3seed平均を空き数別に評価すると最大悪化は empty=54 の `+0.059454` です。したがって「3seed平均の各stageを判定対象とする」という事前定義なら合格する可能性はあります。しかし現在のレポートにはその定義も数値もなく、「最大悪化 +0.014026」という記述は stage 別評価としては正しくありません。

Gate 3 の合否が本タスクの中心であり、受け入れ基準「全判定基準の数値と合否」に未達です。判定単位を仕様に沿って確定し、空き数別の数値を再集計したうえで Gate 3 の合否を更新する必要があります。

## (b) 中（次タスクで対応すべき）

### Gate 集計・bootstrap の再現手段がコミットされていない

trainer は per-game MAE と空き数別 MAE を JSON に出力しますが、次の処理を再現するスクリプトまたはコマンドがありません。

- stage帯の加重集計
- 100,000回 paired bootstrap
- 3seed pooled bootstrap
- Gate 2/3 の機械的な合否判定
- report/meta の生成

meta には乱数 seed はありますが、PRNGや抽出アルゴリズムまでは定義されていません。レポートの「再現コマンド」も学習コマンドだけで、報告値の生成までは再現できません。

今回の stage 判定問題も手集計部分で発生しています。次タスクでは、判定基準をコード化した解析スクリプトとテストを追加し、raw metrics から report/meta を決定的に再生成できるようにすべきです。

## (c) 軽微（記録のみ）

該当なし。

## 正しく実装されている点

- scalar 勾配は `loss_gradient * normalized_feature_value + L2` になっている。
- prediction と特徴抽出は engine の `PatternWeights::score`／`scalar_features` を使用し、train側に合法手・exposure計算を褧製していない。
- B0～B3はゼロ初期化で、warm-startしていない。
- T158 configだけ `schema=3-t158` identityを使用し、既存configは従来の `schema=2` 組み立てを維持している。
- PWV4 round-trip、resume同一性、特徴なしPWV3同一性、scalar勾配のテストが追加されている。
- epoch単位の原子的checkpoint、identity検証、進捗flushが実装されている。
- 学習成果物は `train/data/t158/` にあり、`train/weights/` への誤配置はない。
- pilot/full の overall MAE、seed別非悪化、報告された成果物SHA-256は確認した範囲で raw artifacts と一致している。
- `git diff --check 60c2b27~1..60c2b27` は成功した。

## (d) 総合判定

**不合格。**

trainer拡張自体にはブロッカー級の実装不良は見つかりませんでした。しかし、Gate 3 の stage 別退行判定を仕様より粗い帯集約へ変更し、実際に存在する `+0.10` 超の空き数別退行をレポートしていません。Gate 3 合格という本タスクの主要結論を現状のレポートから確定できないため、done には進められません。