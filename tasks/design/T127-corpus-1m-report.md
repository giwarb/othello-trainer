# T127: 100万局面教師コーパス設計レポート

## 1. 結論

推奨設計は、**WTHOR 2000–2024を維持したまま、1対局×1フェーズbinあたりの抽出数を K=4 まで拡張し、既存expanded200kを先頭200,000件として完全包含する `expanded1m` コーパスを作る方式**である。

1977–1999の追加や全局面抽出への即時転換は行わない。現在の4M構想は、ローカルのWTHOR 2000–2024から得られる約400万学習局面と対応している。ここに別年代を混ぜるより、同じ対局集合の抽出密度を K=1 → K=4 → 全局面と上げる方が、1Mを4Mへの中間観測点として解釈しやすい。

既存200kはEdax再計算せず、そのJSONLレコードをそのまま新セットへ移植する。`positionId=0..199999`を維持し、新規800,000件へ`200000..999999`を割り当てる。8シャードでは既存レコードが各25,000件ずつ均等に入り、新規計算は各シャード約100,000件となる。実測5.4局面/sなら新規800,000件は約41.2時間で、2日以内という制約にも整合する。

ただし、T126の外挿に使った45k/90k/180kは「コーパス総数」ではなく**train split件数**である。現在の分割はcanonicalKeyのFNV hashによる約90/5/5なので、1,000,000レコードのコーパスから得られるtrainは約900,000件である。T126の「N=1,000,000」の予測点と厳密に合わせるなら、コーパス総数は約1.11M必要になる。この点は実装前に確認が必要である。

---

## 2. 調査で確認した現状

### 2.1 expanded200kの分布

コミット済みmanifestでは次の構成である。

- 総数: 200,000
- `engineLoss`: 65
- WTHOR: 199,935
- 年範囲: 2000–2024
- 完全読み閾値: 20
- Edax: level 16、exact時level 60、`-n 1`
- phase bin:
  - bin0: 4,635
  - bin1: 39,061
  - bin2: 39,061
  - bin3: 39,060
  - bin4: 39,059
  - bin5: 39,059
- X/C coverage: 全binで50%以上
- opening cap: 4,000
- t096 oracle混入: 0
- JSONL SHA-256: `412477e2da6bacb0d715c7e5d02447d37b6e981237f64f221013a8eb465690e9`

bin0は候補母集団4,635件で完全に頭打ちし、残余がbin1–5へwaterfall再配分されている。したがって「6bin均等」は既に厳密には成立しておらず、現行設計の本質は「均等を目標にするが、母集団不足時はwaterfallする」ことである。

### 2.2 現行実装の1M化に伴う問題

現在の生成処理には1M化で顕在化する問題がある。

- `teacher_candidates.rs`は1対局×1binにつき1件しか選ばない。
- `perGameCap`はbinあたり件数ではなく、対局全体で処理するbin数の上限である。
- 各シャードワーカーが候補プール全体を読み、全件を再選定する。
- `merge_shards()`は全レコードをPythonのdictへ保持する。
- verifierも全JSONLをPythonのlistへ保持する。
- trainerの`load_corpus()`はJSONL全体を`read_to_string`した後に全レコードを構築する。

expanded200k JSONLは約326MBである。線形換算すると1M版は約1.63GBとなる。候補プールやPython/Rustのオブジェクト展開を含めると、現行方式をそのまま8ワーカーへ拡張するのはメモリ面で危険である。

---

## 3. (a) 推奨する設計と理由

### 3.1 候補プール: 2000–2024のK拡張

`teacher_candidates extract`へ新しい引数、例えば`--per-bin-cap`を追加する。

- 既定値: 1
- `smoke` / `primary` / `expanded200k`: 1のまま
- `expanded1m`: 4
- `expanded1m`の対局全体上限: `perGameCap=24`（6bin×4）

各bin内では決定的な重複なし抽出を行う。K=1時の最初の選択結果は現在の`gen_range`と一致させ、既存setの候補抽出結果を変えない。

K=3は採用しない。2000–2024のK=1プールが340,574件なので単純3倍は約1.02Mにすぎず、同一対局内・年代間のD4重複、oracle除外、opening cap、X/C quotaを考えると余裕がない。K=4で候補余裕を持たせ、そこから1Mだけ選ぶ。

本番前のselection-only probeで次を必須ゲートとする。

- oracleとbase重複を除いた後でも800,000件を追加できる。
- baseを含むunion候補が1M以上ある。
- final phase配分、X/C quota、opening capをすべて満たせる。
- 可能なら選定目標に対して10%以上の未選択候補を残す。
- K=4で不足した場合は自動的に年代追加へ切り替えず、K=5または設計変更について再確認する。

この方式は、同一対局内相関を増やす。しかし4Mは同じ対局の全局面へ進む構想なので、この相関増加は最終投資の性質そのものである。1Mで相関による実効サンプル数低下を実測できることにも意味がある。

### 3.2 expanded200kの完全包含

新コーパスの先頭200,000レコードを、既存JSONLからそのままコピーする。

- 既存の`positionId=0..199999`を維持
- `canonicalKey`、children、Edax値、`generatedAt`を変更しない
- 新規局面へ`positionId=200000..999999`
- 8シャードでは`positionId % 8`で分配
- 既存分は各シャード25,000件
- 新規分は各シャード約100,000件

これは技術的に現実的である。既存200kは連番であり、8分割にも均等に対応する。

ただし、既存expanded200kのcheckpointを新setへ直接resumeしたり、`--adopt-provenance`で流用してはならない。新setはrunKeyが異なるためである。専用のbase import処理により、次を検証してから新しいcheckpointとして初期化する。

1. base JSONL SHA-256が既知値と一致
2. base manifest SHA-256と設定が一致
3. 200,000件、連番、D4重複なし
4. oracle非混入
5. `exactEmptiesThreshold=20`
6. Edax executable/eval SHAが新規生成環境と一致
7. canonicalKeyが新規候補から除外されている
8. 新シャードmetaへ`reusedRecordCount=25000`を記録

新manifestではprovenanceを単一世代のように見せず、次の2層を明記する。

- `baseCorpus`: パス、200,000件、JSONL SHA-256、manifest SHA-256、元のEdax/eval SHA
- `incrementalGeneration`: 800,000件、候補プール・選定計画・generator・candidate tool・Edax/evalのSHA

### 3.3 選定計画を親プロセスで一度だけ確定する

現行の「各シャードが候補プール全体を再読込し、同じ選定を再実行する」方式は1Mでは避ける。

親プロセスが次を行う。

1. K=4候補を一度だけ抽出
2. base canonicalKeyとoracle 60キーを除外
3. final distributionを一度だけ計算
4. 800,000件のincremental selectionを確定
5. `positionId`を付与
6. ハッシュ付きselection planを保存
7. シャード別planへ分割
8. 各ワーカーは自分の約100,000新規局面だけを読む

selection planとシャード別planはgitignore領域へ置き、SHA-256をrunKeyとmanifestへ含める。これにより、シャードごとの選定差や8重の巨大プール保持を防げる。

### 3.4 phase bin配分

6binの境界とwaterfall方式は変更しない。

- `[50, 40, 30, 20, 10, 1]`
- まずWTHOR最終目標999,935件を6bin均等に配分
- union候補の母集団で不足するbinをcap
- 残りを未cap binへwaterfall
- `engineLoss` 65件はbin外の優先層

既存200kを固定した上で、最終配分との差分だけをincrementalから選ぶ。

K=4にしてもbin0は定石重複により早期に頭打ちする可能性が高い。bin0を無理に1/6へ近づけるために年代追加や重複許容を行うべきではない。実在するcanonical unique母集団を上限とし、不足分をwaterfallする現在の解釈を維持する。

manifestには以下を残す。

- base phase counts
- union pool populations
- final bin allocation
- incremental counts
- capped bins
- waterfallされた件数
- 年別構成
- 対局あたり採用局面数の分布

この分布変化により、200k→1Mは純粋な「Nだけ」の実験ではない。しかし同じ年範囲・bin・quota・opening制約を守り、抽出密度だけを増やすため、実現可能な選択肢の中では最も学習曲線の連続性が高い。

### 3.5 X/C quota

現行の各phase最低50%を維持する。ただしincremental部分単独ではなく、**baseを含む最終コーパス全体**で判定する。

各binについて、

`追加で必要なXC数 = max(0, ceil(final_bin_count × 0.5) - base_bin_xc_count)`

としてincrementalを選ぶ。

expanded200kは全binですでに50%以上であり、中盤binでは86–99%なので、K=4で候補不足になる可能性は低い。quota値を増やす理由はなく、学習曲線の比較可能性を優先して0.5を維持する。

### 3.6 opening cap

現行の2%を維持する。

- 1Mでの上限: `ceil(1,000,000 × 0.02) = 20,000`
- baseのopening countを初期値としてincrementalを選ぶ
- baseで最大4,000件のopeningは、incrementalでは最終20,000件まで追加可能

incrementalだけに20,000件のcapを適用すると、baseと合算した最終コーパスで2%を超え得るため不可である。必ず累積値で判定する。

### 3.7 engineLoss優先層

65件をそのまま維持し、件数を5倍へスケールしない。

engineLossは母集団から比例抽出した層ではなく、T084/T085の固定弱点集合である。同じ局面を複製しても情報量は増えず、最新の`vs_edax_results.json`から別の弱点集合を追加すると分布変更要因になる。

新コーパスではbase由来65件だけを保持する。追加のengineLoss候補を採用する場合は、コーパス増量とは別の設計実験として扱う。

### 3.8 checkpoint、merge、verifyの1M対応

生成条件は既存を踏襲する。

- 8シャード
- Edax `-n 1`
- level 16
- exact threshold 20
- exact level 60
- t096 oracle 60キー除外
- 1局面ごとにJSONL append、flush、fsync
- 定期meta更新
- resume時のrunKey/provenance厳格照合
- 最初の新規checkpointを確認してから夜間実行

加えて、1M向けに次を変更する。

- base import後にcheckpointを作成
- children生成は`todo`の新規800kにだけ行う
- mergeは全件dict方式をやめ、positionId順のストリーミングk-way mergeにする
- verifierは全件list方式をやめ、バッチ単位で読み進める
- canonicalKey重複確認用setのみ全体保持
- merged JSONLは一時ファイルへ書き、完了後atomic rename
- merge後もシャードは最終verify完了まで削除しない

ディスク使用量は、merged JSONL約1.6GB、シャード合計約1.6GB、atomic merge一時ファイル約1.6GB、候補・selection plan・ログを含めて少なくとも8–10GBの空きを開始前に確認する。

### 3.9 学習曲線の解釈

新1Mは旧200kを完全包含するため、既存45k/90k/180k点との集合上の入れ子性は保たれる。

ただしK拡張により、1M点では同一対局内の局面密度とphase比率が変わる。したがってT126の1.4–1.63は予測値であり、統計的な信頼区間ではないという扱いを維持する。

解釈を補強するため、1M学習の前にselection planから次のbridge subsetを作ることを推奨する。

- base 200kを全包含
- incrementalから300kを同じ累積quota/waterfall規則で選ぶ
- corpus総数500k、train約450k
- v4 teacher-only、seed 1のみ

これにより、約180k train → 約450k train → 約900k trainという中間点を得られ、K拡張後に曲線が急に鈍化したかを判別できる。4M投資判断は1Mの3seed平均を主指標とし、500kは傾向確認の副指標とする。

### 3.10 trainerのメモリ対策

1M JSONLは約1.6GBになる見込みであり、現行`load_corpus()`の`read_to_string()`はピークメモリを不必要に増やす。

学習タスクでは、実験開始前に`BufRead::lines`等のストリーミングパースへ変更する。最終的な`Vec<DistillRecord>`は保持してよいが、入力文字列1.6GBを同時保持しないようにする。

3seedは`--jobs 1`で逐次実行する。epoch単位checkpoint、state、metrics、identity、完走後resume確認は現行方式を使う。

---

## 4. (b) 検討した代替案と却下理由

### 4.1 年範囲だけを1977–1999へ拡張

却下する。

- 1Mに届くか事前に不明
- 2000–2024とは定石・棋風・大会構成が異なる
- 現在の約4M WTHOR学習母集団との対応が弱くなる
- 1Mから4Mへ進む際、同じ母集団を高密度化する曲線ではなくなる
- 古い年代の追加は対局独立性には有利だが、今回のstage gateの比較軸を増やす

将来、K拡張でも候補数が不足した場合の第2選択肢としては有効だが、自動fallbackにはしない。

### 4.2 年範囲拡張とK拡張の併用

現段階では却下する。

候補数には余裕が出るが、「年代分布」と「同一対局密度」の2要因を同時に変えるため、1M点が曲線から外れた原因を判別できなくなる。K=4のprobeが不成立だった場合のみ再検討する。

### 4.3 全局面サンプリングへ即時転換

今回は却下する。

最終4Mとの一貫性は高いが、1M時点で候補設計を全面変更する必要はない。全局面候補を生成すると候補ファイル・選定処理のメモリ負荷も最大になる。

K拡張は「各bin内の決定的順位の先頭K件」と定義でき、Kを十分大きくすれば全局面方式へ自然に接続できる。したがってK=4の方が段階投資に適する。

### 4.4 K=3

却下する。

K=1プール340,574件の単純3倍が約1.02Mであり、重複・oracle除外・quota制約に対する余裕がほぼない。target未達のままEdax生成へ入る事故を防ぐためにもK=4を採る。

### 4.5 既存200kを使わず独立に1Mを再生成

却下する。

- 約10時間分のEdax計算を浪費
- 45k/90k/180kとの集合上の入れ子性を失う
- 既存200kは閾値20・oracle除外・決定性・全件verify済み
- 同一Edax/eval SHAを確認すれば再利用に意味上の問題はない

### 4.6 base 200kと独立800kの単純連結

却下する。

単純連結では最終コーパスのphase、X/C、opening capを保証できない。baseの既存カウントを初期状態として、最終1M全体に対して制約を再計算する必要がある。

### 4.7 既存シャードを`--adopt-provenance`で新setへ流用

却下する。

`--adopt-provenance`は同じrunKeyのcheckpointを別provenanceで継続するための仕組みであり、targetや選定方式が異なる新setの移植には使えない。runKey不一致を弱めると、T114で防いだ全損・誤resume事故を再導入する。

---

## 5. (c) 実装タスクへの分割案

5タスクに分割する。

### T127a: K拡張・入れ子選定・1Mスケール堅牢化

変更対象:

- `train/src/bin/teacher_candidates.rs`
- `bench/edax-compare/gen_teacher_corpus.py`
- `bench/edax-compare/test_teacher_corpus.py`
- `bench/edax-compare/verify_teacher_corpus.py`
- 必要に応じて`train/data/teacher/README.md`
- 必要に応じて`bench/edax-compare/teacher_manifests/README.md`

内容:

- `--per-bin-cap`
- 新set `expanded1m`
- base corpus import
- baseを含む累積phase/XC/opening選定
- oracle/base canonicalKey除外
- 親プロセスでのselection plan確定
- シャード別plan
- streaming merge
- streaming verifier
- target未達の即時エラー
- K=1既存挙動の回帰テスト
- base prefix完全一致テスト
- runKey/provenanceテスト
- K=4 selection-only probe

依存関係: なし

主なリスク:

- K=1の乱数消費順を変えて既存setの出力を変える
- 1M候補のPythonメモリ不足
- base import時の誤ったprovenance表現
- final quotaではなくincremental quotaを検査してしまう
- selection planとシャード実行の不一致

受け入れゲート:

- smoke/primary/expanded200kの既存設定・runKey構成を変更しない
- K=1回帰テスト
- dry-runでちょうど1M選定
- base SHA・200k prefix一致
- incremental canonicalKey重複0
- oracle混入0
- 8シャードの予定件数が各125,000、うちreuse各25,000

このタスクのコードを確定・コミットしてから本番生成へ進む。生成中にgeneratorのSHAが変わらない状態を作るためである。

### T127b: expanded1m本番生成

変更対象:

- コード変更なしを原則とする
- gitignore領域:
  - `train/data/teacher/corpus_expanded1m_*`
  - candidates
  - selection plan
  - logs
- 作業ログのみ

内容:

- ディスク・RAM・Edax/eval SHA確認
- base 200k import
- 8シャード起動
- 各シャード最初の新規checkpoint確認
- 約800k新規局面生成
- 中断時resume
- 進捗・レート・ETA記録
- シャード完走
- streaming merge

依存関係: T127a

主なリスク:

- 電源断
- Edax/evalまたはcandidate binaryの変更によるresume拒否
- CPU温度・スロットリングで2日を超える
- selection planの消失
- 親だけ停止して子シャードが残る運用事故
- ディスク不足

生成中は1局面単位checkpointがあるため、安全に停止・resumeできる。ただし停止時は親プロセスと全シャードを一組として管理する。

### T127c: 独立検証・manifest確定

変更対象:

- `bench/edax-compare/teacher_manifests/corpus_expanded1m.meta.json`
- 必要に応じてmanifest README
- データ本体は変更しない

内容:

- 全1M verifier
- positionId連番
- 先頭200kのレコード同一性
- canonicalKey全件重複0
- oracle混入0
- phase/XC/opening監査
- exact threshold 20
- level 16/60整合
- 全合法手・best/diff整合
- provenanceとSHA
- シャード件数
- reuse/new件数
- 年別・対局別・phase別分布
- merged JSONL SHA-256
- selection plan SHA-256

依存関係: T127b

主なリスク:

- verifier自体のメモリ・所要時間
- mixed provenanceの記載漏れ
- base prefixは一致していてもincrementalとのcross-set重複が残る
- merged後のファイル破損

全件verify合格までシャードファイルを保持する。

### T127d: v4×expanded1m学習・oracle評価

変更対象:

- `train/src/t090_distillation.rs`（ストリーミング読込が必要な場合）
- 対応テスト
- 実験meta/report
- 重み・checkpointはgitignore領域

内容:

1. trainer入力のストリーミング化
2. 500k bridge subset、seed 1（推奨副実験）
3. 1M corpus、v4 teacher-only、seed 1/2/3
4. `--jobs 1`
5. epoch単位checkpoint/resume
6. T096 oracle 60局面を各seed評価
7. v2=1.566666...のM2ガード
8. 3seed平均・sample SD・各seed paired bootstrap CI
9. 45k/90k/180k/bridge/1M曲線の再推定
10. 実train/validation/frozen件数の明記

依存関係: T127c

主なリスク:

- 1M corpusロード時のメモリ不足
- 1 epochが長くなる
- early stopping設定によるseed差
- 60局面oracleの分散
- corpus 1Mとtrain約900kの呼称混同

### T127e: 4M投資判定

変更対象:

- 判定meta/reportのみ

内容:

- 1Mの3seed平均を主指標とする
- 既存v3×WTHOR 1.40
- v4×WTHOR 1.111
- T126外挿
- bridge point
- 1M実測
- 4Mへの更新外挿
- 生成日数・学習日数・ストレージ実績
- 続行／保留／打ち切りの明示

依存関係: T127d

主なリスク:

- 1.4–1.7帯の裁定規則が未確定
- 3seed平均と最良seedの取り違え
- oracleの繰り返し利用による判断の楽観化
- 「現本番v3」と「未採用v4 WTHOR」のどちらを最終目標にするかの混同

---

## 6. 生成中の並行作業ルール

生成中に新規UI要望が来た場合、次の運用を推奨する。

並行可能:

- 要件整理
- 設計
- `app/`限定の軽量な編集
- 短時間のtypecheck/unit test
- ドキュメント調査
- CPUを継続占有しない作業

並行禁止または生成を停止してから実施:

- エンジンNPS測定
- FFOベンチ
- 対戦実験
- WTHOR学習
- 蒸留学習
- 別のEdax大量呼び出し
- `teacher_candidates.exe`を上書きし得るrelease build
- Edax本体・eval data・candidate pool・selection plan・generatorの変更

優先度の高いUI作業で重いビルドが必要な場合は、まず全シャードの最新done数を記録し、親と8ワーカーを停止し、JSONL末尾が妥当であることを確認してから作業する。再開後は全シャードでresume件数と最初の新規checkpointを確認する。

Git HEADの更新自体は現在provenance identityから除外されているが、生成関連ファイルや実行バイナリのSHA変更はresumeへ影響する。生成期間中は生成コードを凍結する。

---

## 7. 判定ルール案

主指標はT096 oracle regretの3seed平均とする。

- 平均 `<= 1.40`: 4M設計へ進む
- 平均 `> 1.70`: 打ち切り
- `1.40 < 平均 <= 1.70`: デフォルトは停止または保留
  - bridge→1Mの傾き
  - seed SD
  - 4M更新外挿
  - v4 WTHOR 1.111を下回る見込み
  - 追加8日投資の価値
  を明示してユーザー再裁定

最良seedだけで続行判定してはならない。各seed値、平均、SD、位置単位bootstrap CIを併記する。

---

## 8. (d) 未確定事項・オーケストレーターへの確認事項

1. **「1M」の定義**
   - コーパス総数1,000,000件でよいか。
   - それともT126外挿の横軸と厳密に合わせ、train split約1,000,000件となる総数約1.11Mにするか。
   - 前者なら新規800kで約41.2時間、後者なら新規約910kで約46.8時間となり、検証時間を含めると2日制約が厳しくなる。

2. **K=4の承認**
   - 本報告ではK=4固定を推奨する。
   - probeで余裕不足だった場合、K=5へ上げてよいか、それとも再裁定するか。安全上は自動変更せず再確認を推奨する。

3. **4Mの母集団**
   - 4MはWTHOR 2000–2024の全canonical unique局面を意味する、という理解でよいか。
   - 1977–1999も4M段階で含めるなら、今回の年代方針を再検討する必要がある。

4. **1.4–1.7帯の扱い**
   - T126レポートはこの帯を「デフォルト停止」としている。
   - ユーザー指示では`<=約1.4`と`>1.7`だけが明示されている。
   - 本報告の「1.40超1.70以下は保留／デフォルト停止」でよいか。

5. **判定対象**
   - 3seed平均を正式なgate値としてよいか。
   - seedごとのばらつきが大きい場合、追加seedを行う条件を設けるか。

6. **比較目標**
   - 4M続行判断の最低条件を現本番v3×WTHORの1.40突破とするか。
   - 未採用候補を含むv4×WTHORの1.111を最終的に下回る見込みまで要求するか。
   - T126では後者へのcredible pathも条件に含めている。

7. **500k bridge学習**
   - 学習曲線の解釈補強として、500k corpus相当をseed 1で追加する案を採用するか。
   - ラベル追加費用はなく、学習計算だけで実施できるため推奨する。

8. **ハードウェア事前ゲート**
   - 1M生成・merge・verify・学習に必要なディスクとRAMをT127aで実測し、基準不足なら生成前に停止する運用でよいか。
   - 特にtrainerは1.6GB級JSONLを扱うため、ストリーミング化後も全`DistillRecord`保持量の実測が必要である。