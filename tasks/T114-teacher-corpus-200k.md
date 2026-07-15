---
id: T114
title: 拡張教師コーパス200k生成(teacher-only蒸留の本命データ)
status: in_progress # todo | in_progress | review | done | blocked
assignee: implementer(Sonnet, Codex上限フォールバック)
attempts: 0
---

# T114: 拡張教師コーパス200k生成

## 目的

T113でteacher-only蒸留の学習曲線が強い単調改善(R²=0.97)を示し、**200k局面で oracle regret ≈1.92石(現行v2=1.57石に肉薄)** の外挿が得られた(ユーザー裁定 2026-07-16: 「200kを今すぐ生成開始」)。T090a(50k)と同一設計・**T094のバッチ化+決定性(`-n 1`)仕様**で200,000局面の教師コーパスを生成する。生成後のteacher-only学習・v3/ステージ実験は後続タスク。

## 委譲体制の注記

- Codex週間上限(リセット7/22 6:00)のためimplementer(Sonnet)フォールバック。
- **別セッションでT105(終盤ソルバー、NPSゲートあり)が並行実行中**。本タスクの生成はCPU重負荷・長時間のため、以下の調整を厳守:
  - 生成プロセスの並列シャード数はT094の本番構成に従う(生成効率優先。ユーザーが生成開始を承認済み)。
  - **STATUS.mdの調整ルール**: T105側が公式NPS計測を行う際は生成を一時停止できる。生成はシャード/局面単位checkpointからresume可能であること(=いつkillされても損失ゼロ)を起動前に確認する。

## 背景・既存資産(必読)

- `tasks/T090a-teacher-corpus.md` — 50kコーパスの設計(WTHOR 2015-2024層化抽出+engineLoss優先層、全合法手評価値、exact帯(空き24以下)はEdax完全読み・それ以外level 16、D4重複除去、manifest/provenance、verify)。**本タスクは同一設計のスケール版**。
- `tasks/T094-*.md`(tasks/内で検索) — 局面単位バッチ化(壁時計-64.6%)と`-n 1`決定性仕様。**本番生成はこの経路を使う**(旧50kは非決定世代でmanifestフラグ識別可、今回は決定的世代)。
- 生成: `bench/edax-compare/gen_teacher_corpus.py`、検証: `verify_teacher_corpus.py` / `test_teacher_corpus.py`、manifest: `bench/edax-compare/teacher_manifests/`。
- 出力先: `train/data/teacher/`(gitignore領域)。manifest(コミット対象)は既存流儀に従う。

## 要件

1. **規模**: 200,000局面(既存primary 50kとは独立の新規生成。局面選定seedを変えて重複を避けるか、既存50kを包含する設計にするかは既存スクリプトの設計に従い、選択と理由を作業ログに明記)。
2. **オラクル汚染の防止(重要)**: `bench/edax-compare/t096_oracle_positions.json` の60局面(およびそのD4対称形)が**新コーパスに混入しないこと**を選定段階で除外し、生成後にも機械検証する(oracleは独立評価セットとして今後も使うため。混入すると全実験の主指標が自己参照になる)。
3. **決定性**: T094の`-n 1`仕様で生成し、manifestに決定的世代であることを記録する。
4. **長時間実行ルール(CLAUDE.md)厳守**: シャード/局面単位のcheckpoint追記・resume・進捗ログ(何件中何件完了)を起動前に確認。**起動直後に「最初のcheckpointが実際に書かれる」ことを確認してから**長時間実行に入る(T082の教訓)。実行はrun_in_background可(生成スクリプト自体が進捗を外部観測可能なため)。
5. **検証**: 完了後に verify_teacher_corpus.py(全件・否定テスト)+スキーマ契約検査+oracle非混入チェックを実行し、結果を作業ログへ。manifest/provenanceを完備する。
6. **完了時**: manifest等のコミット対象をパス明示でコミット(データ本体はgitignore)。生成の所要時間・シャード構成・中断/再開の有無を作業ログに記録。

## やらないこと(スコープ外)

- 学習の実行(後続タスク: teacher-only 200k学習+v3/ステージ実験)
- コーパス設計の変更・分布多様化(ユーザー裁定で「現行設計のまま」。多様化は将来の増分バッチ候補)
- 採否判定・アプリ配線

## 受け入れ基準(検証コマンド)

- [ ] 200,000局面のコーパスが `train/data/teacher/` に生成され、verify(全件)がパス
- [ ] t096 oracle 60局面(D4含む)の非混入が機械検証されている
- [ ] manifestに決定的世代(`-n 1`)・生成構成・provenanceが記録され、コミットされている
- [ ] 生成がcheckpoint/resume対応で行われた記録(進捗ログ・中断があれば再開記録)が作業ログにある
- [ ] `cargo test -p train` / `python -m pytest bench/edax-compare/test_teacher_corpus.py`(または既存の検証コマンド)がパス
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと(T105由来は除外)

## フィードバック(やり直し時にオーケストレーターが記入)

### 2026-07-16 — オーケストレーター裁定(ブロッカー解消の方針)

ブロッカー報告(候補プール上限≈93k)を受けての裁定。**主方針=年範囲拡張(下記A)、フォールバック=K=2拡張(B)**:

**A(主方針): WTHORの年範囲を拡張して対局数を増やす。** ローカルの2015〜2024はダウンロード済みの範囲にすぎず、WTHOR公式(FFOサイト)は1977年以降を公開している。T040と同じ方法で過去年分(まず2000〜2014、足りなければさらに遡る)を `train/data/` にダウンロードし(gitignore領域・コミット禁止)、`teacher_candidates extract --years` を広げてプールを再probeする。**選定target 200,000に対しdedup後プール25万件以上を目安**に年数を決める。この方式は「1対局×1bin=1候補」の設計哲学を完全に維持し、局面の独立性(=T113外挿の前提)を保つ。Bとの違い(同一対局内のK局面は強く相関し、実効サンプル数を毀損しうる)がAを選ぶ理由。
- 留意: 古い年代の対局は定石流行が異なるため分布が広がるが、これは「実戦局面の範囲内での多様化」であり許容(むしろ分布外汎化には好材料になりうる)。manifestに年範囲を必ず記録し、作業ログに新旧年代の構成比を記載すること。
- ダウンロード検証: ファイルサイズ・パース成功(既存 `train::wthor::parse`)・対局数を年ごとに記録。壊れた年ファイルはスキップして報告。

**B(フォールバック、承認済み)**: Aでプールが不足する場合(サイトに古い年が無い等)のみ、K=2(1対局×1bin=最大2候補)への拡張を併用してよい。その場合は同一対局内相関の懸念を作業ログに明記すること。K=3以上はさらに裁定が必要。

**あわせて以下のコード変更を承認する**(いずれもワーカー調査済みの方針どおり、smoke/primaryの既存挙動・runKey・provenance identityを一切変えないこと):
1. `gen_teacher_corpus.py` の `_write_meta`/`merge_shards` に `schemaVersion: 2` を直接出力(verify必須要件)。
2. t096オラクル除外フィルタ(`excluded_keys`、canonicalKey一致でD4対称込み一括除外)。新set限定のフラグ方式で、既存setの出力形を不変に保つ。
3. `CORPUS_SETS` に新set(例: `expanded200k`、年範囲拡張+除外フラグ有効)を追加。

要件1は「WTHOR年範囲の拡張を含む」と読み替える(規模200,000は不変)。その他の要件(oracle非混入・決定性・長時間実行ルール・検証)はすべて従来どおり。

## 作業ログ(担当エージェントが追記)

### 2026-07-16 準備調査・ブロッカー発見(生成未着手・停止して報告)

**実施した調査(コード変更なし、リポジトリ非汚染)**:
- `tasks/T090a-teacher-corpus.md`(全文、redo #1/#2含む)、`tasks/T094-edax-batch-labeling.md`(全文、`-n 1`決定性仕様・バッチ化の実装詳細)、`tasks/T113-teacher-only-learning-curve.md`(200k外挿の根拠)を読了。
- `bench/edax-compare/gen_teacher_corpus.py`(生成本体)、`verify_teacher_corpus.py`(検証)、`test_teacher_corpus.py`(回帰テスト)、`finalize_teacher_corpus.py`(T090aの後処理専用スクリプト、smoke/primary固定・8シャード固定でハードコードされており本タスクでは再利用不可と判断)、`train/src/bin/teacher_candidates.rs`(候補プール抽出ロジック)を精読。
- `bench/edax-compare/t096_oracle_positions.json`の構造を確認: 60局面各々に既に`canonicalKey`(D4正準化済み、`train::experiment::canonicalize`と同一アルゴリズム、`test_python_rust_d4_agree`で一致確認済み)が付与されており、除外フィルタはこの1キーとの一致チェックだけでD4対称形を含めて一括除外できることを確認(オラクル側の対称形展開は不要)。
- `train/data/teacher/`の既存ファイル一覧・実行中プロセス(`tasklist`)を確認し、本タスクの生成は**まだ未着手**であることを確認(STATUS.mdの「in_progress」表記はタスク起票時点のものであり、実際のプロセス起動はまだ行われていなかった)。

**発見したブロッカー(200,000局面が現行設計の候補プール上限を超過)**:

`teacher_candidates.rs::cmd_extract`の候補抽出は、対局ごとに**フェーズbin(6段階)につき最大1局面**しか採らない設計になっている(`by_bin`の各binから`bucket[game_rng.gen_range(...)]`で1件だけ選ぶループ、`per_game_cap`は「何binまで採るか」の上限であり「1binから何件採るか」には影響しない。6binすべて処理すれば`per_game_cap`を6以上にしても picked_for_game は最大6で頭打ち)。そのため候補プールの理論上限は「対局数 × 6」であり、WTHOR 2015〜2024年の全対局(19,119局)を使っても、D4正準化重複除去後は**約93,000局面が絶対上限**になる。

**実測で確認**(新規seed=90200でextractを実行、出力はscratchpad配置でリポジトリ非汚染):
```
./target/release/teacher_candidates.exe extract --data-dir train/data --years 2015-2024 \
  --seed 90200 --per-game-cap 6 --out <scratchpad>/candidates_probe.json
→ wrote 93055 candidate position(s) (before dedup: 114570, games scanned: 19119)
```
T090aのsmoke(seed 90101)=93,077件、primary(seed 90102)=93,069件、本probe(seed 90200)=93,055件と、**seedを変えてもプールサイズはほぼ不変(93,05x〜93,08x)**であることを確認した(dedup後の一意局面数は本質的に「対局数×6bin」という構造で決まり、乱数seedはどの局面が選ばれるかを変えるだけでプール規模を変えない)。年範囲は`train/data/WTH_2015.wtb`〜`WTH_2024.wtb`の10ファイルが全量で、これ以上拡張できるWTHORデータは存在しない。

既存のprimary(50,000)は既にこの約93,000件プールの約54%を消費済み。**200,000局面は現行の「1対局×1bin=1候補」設計の候補プール上限(約93,000)の2.15倍以上であり、種を変えた独立抽出を1回行うだけでは物理的に到達不可能**(タスク要件1「局面選定seedを変えて重複を避ける」を尽くしても、達成できる規模は最大でも約93,000 − 既存primaryとの重複分、200,000には遠く届かない)。

**現行スクリプトのまま`expanded200k`のような新setを追加して起動しても、`select_positions`のwaterfall配分ロジック(`allocate_bin_targets`)がbin人口上限で頭打ちし、`selected`件数が200,000に届かないままEdaxラベリングに入ってしまう**(target未達のまま数時間〜十時間規模の計算を消費するリスクがあるため、着手前にここで停止する)。

**選択肢(いずれもオーケストレーター/ユーザー判断が必要、推測で選ばず提示)**:

1. **(設計拡張・対称データ量最大)候補抽出ロジックを「1対局×1bin=1候補」から「1対局×1bin=K候補」に拡張する**: `teacher_candidates.rs`の該当ループを、binのbucketから重複なくK件(例: K=3)を決定的にサンプルするよう変更する。同じ6フェーズbin・同じX/C quota・同じopening cap・同じD4正準化重複除去という選定"哲学"は完全に維持したまま、各対局内で複数の局面を深く採るだけの変更であり、多様化(新しい層・新しい重み付け軸の追加)ではない。ただしK=3で理論値約280,000(実測比率0.81の重複除去率を仮定)、K=2で約186,000と見積もり幅があり、200,000を安全に超えるにはK=3程度が必要。本タスクの「やらないこと」に明記された「コーパス設計の変更・分布多様化(現行設計のまま)」に抵触する可能性があるため、実施前に承認が必要。
2. **(規模縮小)目標を現行設計で到達可能な規模(約85,000〜90,000、primaryとの重複を避けた残り)に縮小する**: T113の外挿曲線(200k→1.92石、log-linear R²=0.97)によれば、90k程度では計算上まだ改善余地を残す水準(外挿式 regret≈8.71−1.28×log10(size)に90,000を代入するとregret≈2.35石程度)にとどまり、200k想定ほどの効果は見込めない。目的(v2水準1.57石への接近)に対する費用対効果が変わる可能性がある。
3. **(既存primaryを包含・拡張)既存primary 50,000をベースに、残りプール(約93,000−51,000×重複分≈40,000強)を追加抽出して合計を積み増す**: 得られる最大合計はやはり90,000前後にとどまり、200,000には届かない。オプション1と組み合わせない限り根本解決にならない。
4. **(オプション1限定採用+2の併用)**: K拡張(オプション1)を承認のうえ、実測結果次第でKを調整し200,000を確実に満たす値に決める。

**現状の判断**: 200,000という規模要件と「同一設計のまま」という制約は両立しないことをコードレベルで確認した。生成(Edax呼び出し、数時間〜十数時間級)を開始する前にこの矛盾が見つかったため、CLAUDE.mdの「仕様が曖昧なとき」の方針に従い、**推測でK拡張等の設計変更を行わず、ここで作業を停止して報告する**。生成は一切開始していない(`train/data/teacher/`に新規ファイルなし、`git status --short`はクリーン)。

**このターンでの成果物**: コード変更なし。`bench/edax-compare/gen_teacher_corpus.py`への実装方針(CORPUS_SETS新エントリ`expanded200k`・t096オラクル除外フィルタの設計・schemaVersion付与漏れの発見)は調査済みで、規模問題が解消され次第すぐ実装に移せる状態。

**副次的に発見した実装上の注意点(規模問題とは独立、後続実装時に反映すること)**:
- `TeacherCorpusCheckpoint._write_meta`および`merge_shards`の出力に`schemaVersion: 2`が含まれていない(T090aでは`finalize_teacher_corpus.py`という別スクリプトが事後的に付与していたが、そのスクリプトは`smoke`/`primary`固定・8シャード固定でハードコードされており新setには使えない)。`verify_teacher_corpus.py`は`schemaVersion != 2`でエラーにするため、**このままでは新規生成したコーパスの検証が必ず失敗する**。`gen_teacher_corpus.py`の`_write_meta`/`merge_shards`側で直接`schemaVersion: 2`を書くよう修正が必要(diffFromBest/openingKeyは既にlabel_position/extractが生成時点で正しく付与しているため、finalize相当の後処理は本来不要なはず)。
- t096オラクル除外は`select_positions()`に`excluded_keys`引数を追加し、優先層・WTHOR層それぞれで`canonical_key_of_position(...) in excluded_keys`を除外する形で実装可能(t096の`canonicalKey`フィールドをそのまま集合化するだけでD4対称形も一括除外できる)。既存smoke/primaryのresume可能性を壊さないよう、この除外ロジックはCORPUS_SETS設定に`excludeT096Oracle`のようなフラグを持たせ、フラグがfalse(smoke/primary)のときは`settings`/`selectionStats`の出力形が一切変わらない(=runKeyが変わらない)ように条件分岐すること(`excluded_keys`が空集合なら追加statsフィールド自体を出力しない、等)。`PROVENANCE_IDENTITY_KEYS`やグローバルな`meta`にオラクルSHA256を追加すると、smoke/primaryの`provenance_identity`比較が変わり誤って`start_fresh()`(=既存50,000件JSONLの空文字上書き)を誘発しかねないため、**グローバルなprovenance/meta構造は一切変更しないこと**。
