# T127g 親またぎウォームTT A/B レポート

## 結論

**`warm`（hash指定なし）は、走行中expanded1mへの途中移行をユーザーへ提示する価値がある。`warm+h24`は採用しない。**

coldとの値比較はexact帯・level16帯ともscore / bestMove / diffFromBestが全件一致し、各arm 2回の決定性も全件一致した。関連グループの残件構成加重speedupは`warm`が1.317x（処理量31.7%増、経過時間24.1%減）、`warm+h24`が0.939x（経過時間6.5%増）だった。判定式の「25%以上高速」を通常のspeedup増分で読むと`warm`は条件を満たす。一方、経過時間短縮率で読むと24.1%で0.9ポイント未達なので、境界的な結果であることも明示する。

関連/無関連差は小さく、exact帯では差がなく、level16帯で関連グループが2.3%相対的に上回っただけだった。観測した大半の利得はTT温存ではなく、2親を1プロセスへ束ねた起動・初期化削減である。

## 実験方法

- selection plan SHA-256: `2f26451299ea000c2ee118ab91330d1cdbc283903b0f23474b882210f2698483`
- 固定seed: `t127g-warm-tt-ab-v1`
- サンプル確定時点: expanded1m全体の生成済み271,033件（base reuse 200,000件を含む）、未生成WTHOR局面728,967件。
- 関連グループ: 未生成局面から同一`(year, gameIndex)`かつ同一帯の局面を2件取り、ply昇順に整列。exact 10組、level16 10組。ply差平均はexact 2.7、level16 1.3。
- 無関連グループ: 異なる対局から固定hash順位で2親を選択。exact 10組、level16 10組。関連組と同数・同じ2親/組。
- 合計40組、80親、全子624件（exact 210件、level16 414件）。関連/無関連の内訳はexact 107/103件、level16 227/187件。
- exact帯は親empties <= 21（非終局子をlevel 60）、level16帯は親empties > 21（非終局子をlevel 16）。同一組を同一帯に限定したため、warmは常に全親・全非終局子を単一levelの1 OBF・1 Edaxプロセスで処理した。
- coldは親ごとに別バッチ（2プロセス/組）、warmとwarm+h24は2親を単一バッチ（1プロセス/組）。全armで`-n 1`、warm+h24だけ`-h 24`を追加した。
- 各armを2回実行。組・反復ごとにarm順を回転・反転し、生成8ワーカーとの並走負荷をペア比で相殺した。速度は各反復を独立ペアとした20ペア/区分の`cold elapsed / arm elapsed`幾何平均。
- scratchpad: `train/data/teacher/t127g_scratch/{sample.json,results.jsonl,summary.json}`（gitignore対象）。stage単位でappend + flush + fsyncし、`(groupId, arm, repeat)`単位でresumeした。A/B実測合計2,213.6秒。plan/checkpointは読み取りのみで、生成プロセス・`gen_teacher_corpus.py`には触れていない。

## 値一致と決定性

比較単位は各子のscoreとdiffFromBest、および各親のbestMoveである。表の子数は重複しないサンプル数。不一致判定は両反復を含む。

| 帯 | 親数 | 子数 | cold vs warm | cold vs warm+h24 | 最大score差 | 同一arm 2回 |
|---|---:|---:|---:|---:|---:|---|
| exact | 40 | 210 | 不一致0 | 不一致0 | 0石 | cold / warm / warm+h24 全件一致 |
| level16 | 40 | 414 | 不一致0 | 不一致0 | 0石 | cold / warm / warm+h24 全件一致 |
| 全体 | 80 | 624 | 不一致0 | 不一致0 | 0石 | 全arm・全件一致 |

内部集計ではcold対各warmの各帯比較（2反復込み）がexact 500項目、level16 908項目、同一arm再現比較がarmごとexact 250項目、level16 454項目で、すべて不一致0だった。

## 速度

speedupは1.0超が高速、1.0未満が低速を表す。

| グループ | 帯 | warm speedup | warm時間短縮率 | warm+h24 speedup | warm+h24時間短縮率 |
|---|---|---:|---:|---:|---:|
| 関連 | exact | 1.5568x | 35.76% | 0.9473x | -5.56% |
| 関連 | level16 | 1.0901x | 8.26% | 0.9292x | -7.62% |
| 無関連 | exact | 1.5619x | 35.98% | 0.9869x | -1.33% |
| 無関連 | level16 | 1.0657x | 6.16% | 0.9297x | -7.56% |

時間短縮率は`1 - 1 / speedup`。負値は短縮ではなく増加を示す。

TT温存効果の分離として関連/無関連speedup比を見ると、exactは0.9967x（関連優位なし）、level16は1.0229x（関連が2.29%相対優位）だった。exactの約1.56xは無関連でも再現しており、Edax起動・eval初期化等を2回から1回へ減らした効果と解釈する。level16では起動削減に加えて小さい親間TT再利用効果があるが、「探索木の大部分を共有するため大幅高速」という仮説は支持されない。

`-h 24`は全4区分で1x未満だった。長寿命化しても拡大hashの初期化・メモリ競合コストを回収できず、T127fの否定結果と整合する。

## 残り生成への外挿

計測完了後のJSONL読み取りスナップショットではincremental 800,000件中84,879件が生成済み、残件715,121件だった。selection plan全体と生成済みIDを帯別に突き合わせた内訳はexact 380,113件、level16 335,008件である。この構成を重みに関連グループの帯別speedupを対数加重した。

| 設定 | 残件加重speedup | 経過時間変化 | 現行ETA | 適用後ETA | 差 |
|---|---:|---:|---:|---:|---:|
| warm | 1.3174x | 24.09%短縮 | 32.55時間 | 24.70時間 | 7.84時間短縮 |
| warm+h24 | 0.9388x | 6.52%増 | 32.55時間 | 34.67時間 | 2.12時間増 |

現行ETAは同時点の8 shard metaの観測レート合計6.1034親/秒で残件を割った単純外挿であり、将来の帯別難度変化は含まない。適用後ETAも2親/プロセスという今回の実測範囲だけを使う。より大きなグループの利得は未計測なので上乗せしない。現在はlevel16が先行して生成され、exact残件380,113件が全て残っているため、起動削減が大きかったexact帯へ移行を間に合わせる価値はある。

無関連グループを使った残件加重speedupも1.3058xで、関連グループ1.3174xとの差は小さい。したがって外挿はTT共有の強さに過度に依存せず、主にプロセス統合効果を見積もっている。

## runKey / resume再設計の必要範囲

途中移行は単なる引数追加ではなく、次の範囲を明示的に設計する必要がある。

1. **決定的batch plan**: 未生成positionIdだけを`(band, year, gameIndex, ply, positionId)`で決定的にグループ化し、batch plan本体とSHA-256を保存する。今回の実測値を守る最小構成は2親/プロセス。異なるlevelを同一Edaxプロセスへ混ぜない。
2. **shard所有権**: 現行はpositionIdの8-way stripeで、同一対局の親が別shardへ分かれうる。既存shardの所有規則をその場で変更せず、残件用の新warm segmentを8 workerへ再割当し、最終mergeで旧レコードとpositionId重複・欠落を検証する。
3. **runKey/provenance**: `batchingPolicy`、batch plan SHA、最大親数、親順、hash指定（今回はnull）、elapsed配賦方針を新runKeyへ含める。旧metaのrunKeyを書き換えて同一生成に見せず、旧cold segmentと新warm segmentをmanifest上で明示する。Edax/eval/harness provenanceは既存値と完全一致を必須にする。
4. **checkpoint粒度**: 1 batch完了後に親レコードをpositionId単位でappend+fsyncし、batch完了集合も保存する。中断時は既存positionIdを除いてbatchを再構成し、完了済み親を再ラベルしない。Edax途中中断で失うのは最大1 batchに制限する。
5. **elapsedスキーマ**: 現行の「1親内batch時間を子へ均等割」から「親またぎbatch時間を全非終局子へ均等割」へ変わるため、`elapsedMsPolicy`を新値にして旧レコードと区別する。教師値自体は混在可能だが、速度テレメトリを同一意味として集計しない。
6. **移行前検証**: scratch出力で少数batch、kill/resume、旧+新segment merge、positionId全件一意、runKey不一致拒否、値一致をテストしてから切り替える。実行中8ワーカーはこの準備中も止めない。

概算ではgeneratorのラベル関数自体より、batch plan永続化・新segment/meta・merge/resume検証が主作業である。既存レコード全保持を安全に満たすには小変更ではなく、中規模のチェックポイント移行実装として扱うべきである。

## 推奨判定

- **提示判定: YES。** 値全一致かつ1.317xで、25%高速の目安をspeedup増分では満たす。期待短縮は現時点で約7.84時間。
- **採用arm: warm（hash指定なし）のみ。** `warm+h24`は遅いため棄却する。
- **切替条件:** 現行生成を止めて先に作り直さない。上記の新warm segment・runKey・kill/resume・merge検証が完了した時点で、残件だけを明示的に移行する。検証未完のまま現行checkpointのrunKeyやshard所有権を変更しない。
- **解釈上の注意:** 経過時間短縮率は24.1%で25%に僅かに届かない。安全な移行実装がexact帯開始までに間に合わない場合は、境界的な7.84時間のために生成整合性を危険にさらさず、現行1Mを完走し、本方式を4Mへ採用する。