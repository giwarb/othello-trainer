---
id: T106
title: 終盤ソルバー: Exact TTの上下限同時保持(区間化)実験
status: done # todo | in_progress | review | redo | done | blocked
assignee: implementer(Sonnet, Codex上限フォールバック)
attempts: 0
---

# T106: Exact TT上下限同時保持(区間化)実験

## 目的

終盤ソルバー強化シリーズ第9弾(**実験タスク**: ゲート未達なら差分破棄が正常な結末)。T103のNWS/PVS化により、同一局面に対して「下限だけ(Lower)」「上限だけ(Upper)」のTTエントリが大量に生まれるようになった。現行TTはbound種別を1つしか持てないため、狭窓探索を重ねても情報が上書きで失われる。エントリにLower/Upperを同時保持して逐次マージし、区間が閉じたら(lower==upper)Exactに昇格させることで、再探索のカットを増やしノードを削減する。

## 委譲体制の注記

Codex週間上限(リセット7/22 6:00)のため implementer(Sonnet)フォールバック+検証強化(verifier+Claude代替レビュー)で実施する。段階的に進め(エントリ構造→マージ規則→NWS接続)、各段階でテストを回すこと。仕様に無い設計判断は推測で進めず、作業ログに記録して判断を仰ぐ。

## 規範文書

- `tasks/design/T097-endgame-solver-report.md` §5 T106節・§7(リスク表: 相容れない深度のboundマージ、区間逆転、バケット拡大によるTT実容量低下)。

## 要件(設計レポート§5 T106節が規範)

1. **上下限同時保持**: Exact TTエントリで同一局面のLower/Upper境界を同時に保持し、NWSの結果を上書きでなくマージする(`engine/src/tt.rs`)。
2. **区間収束時のExact化**: マージの結果 lower==upper になったらExactとして扱う。
3. **マージ規則の明確化(§7リスク)**: 異なる探索深度・品質のboundを無条件にマージしない。採用するマージ条件(同一局面キー+深度規則)を実装前に作業ログへ明文化する。終盤exactドメインは「深さ=残り空き数」で一意のはずだが、その前提が成り立つことをコードで確認した上で設計すること。
4. **区間逆転(lower>upper)の扱い**: 発生条件を分析し、検出時の扱い(debug_assert+安全側フォールバック等)を定義する。
5. **T086品質保護の維持**: 深いExact保持・両slot品質probeの既存置換規則と既存テストをすべて維持する。
6. **エントリレイアウト**: 可能なら16-byte entry/32-byte bucketを維持する。拡大が必要な場合はTT実容量の低下(同じ64MiBで格納数が減る)込みで比較計測する(§5)。
7. **abort安全性**: quota abort時に部分的なbound(打ち切られた探索の値)を区間へマージしないこと(T034/T103の契約維持。既存quota-abortテスト+区間経路の追加検証)。
8. 変更対象は `engine/src/tt.rs`・`engine/src/endgame.rs` のみ。公開API・論理ノード定義・決定性は不変。
9. **軽微doc修正(T105レビュー申し送り、同一ファイルのため含める)**: `endgame.rs` 冒頭コメントの「空き4/3/2/1の専用関数は行わない」等、T104のshallow層導入後の現状と矛盾する旧記述を現状に合わせて更新する。

## 計測プロトコル(実験ゲート、設計レポート§5)

- **主判定: C2 512k系列の合計ノード10%以上削減 かつ FFO #40-44壁時計5%以上改善**(baseline=コミット5f460c2のビルド、TT 64MiB)。**閾値未達なら不採用**(差分破棄。ネガティブ結果も正常な成果として作業ログに全数値を残す — T102の前例)。
- FFO #40-44: 全問正解必須。合計ノードの前後比較を併記。
- C2完走数の変化を併記(参考)。
- **壁時計/NPS計測は専有状態で行う**: 並行セッションのT114(200kコーパス生成、約10h)が動いている場合、**生成プロセスをkillして専有ウィンドウを確保してよい**(checkpoint/resume対応済みのため損失ゼロ。計測後に同一コマンド再実行でresumeさせる — STATUS.mdの調整ルール)。kill/resumeした場合はその旨を作業ログに記録する。
- 決定性: fresh TT同一局面2回実行の完全一致。

## やらないこと(スコープ外)

- exactポリシー・ノード予算変更(T107)、ハーネス変更
- 中盤(非exactドメイン)TTの区間化
- TT容量・置換方式の再設計(T086の規則は維持)

## 受け入れ基準(検証コマンド)

- [ ] `cargo test -p engine` 全件パス(T086由来のTTテストを含む。protocolフレーキーは単独再実行で切り分け)
- [ ] **追加テスト**: (1)異種domain・異深度のboundがマージされないこと、(2)collision/stress(既存T086テストの区間版)、(3)Lower→Upperマージ→Exact昇格の直接テスト、(4)区間逆転の検出テスト、(5)quota abort後に部分boundが区間へ混入しないこと — いずれも**発火カウンタ等で経路が実際に通ったことを確認**(発火0件passの禁止)
- [ ] **naive一致**: 既存のnaive一致テスト(full/narrow窓)が区間化ONで全パス
- [ ] `cargo test -p engine --release --test ffo_bench` — FFO #40-44全問正解
- [ ] C2 512kノード比較表・FFO壁時計比較表(専有計測)が作業ログにある — **ノード-10%かつ壁時計-5%で採用、未達なら差分破棄で不採用**
- [ ] fresh TT同一局面2回実行の決定性
- [ ] WASMビルド(`wasm32-unknown-unknown`)が成功する(採用時)
- [ ] 採用時: 変更対象ファイルのみパス指定でコミット(`(T106)`)。不採用時: 差分を完全に破棄し、計測記録のみ作業ログに残す
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと

## フィードバック(やり直し時にオーケストレーターが記入)

### 2026-07-16 — オーケストレーター判定: done(不採用、正常なネガティブ実験)

- ゲート(C2ノード-10%かつ壁時計-5%)に対し、実測はC2 +0.00%(131,225,943→131,225,950)・FFOノード+0.47%で明確に未達。プロトコルどおり差分を完全破棄(T102の前例)。
- 原因考察(実装者、妥当と判断): エントリ16→24byte拡大(アライメント制約で16byte維持不可、実装前に確認・記録済み)によりTT実容量が2/3に低下し、区間マージの追加カットを相殺。
- 実装・テスト(5カテゴリ、発火カウンタ付き)・マージ規則の事前明文化まで含めて実験の質は高い。設計レポート§5の「閾値未達なら不採用」条項の想定どおりの結末であり、redoはしない。
- コード変更が残っていないため verifier / 代替レビューは省略(git statusクリーンをオーケストレーターが確認)。
- 壁時計の専有計測はT114プロセスをサブエージェント権限でkillできず参考値どまりだったが、決定的なノード比較が単独でゲート未達を示すため判定に影響なし。

## 作業ログ(担当エージェントが追記)

### 2026-07-16 実装前設計(マージ規則の明文化、要件3準拠)

**前提確認(要件3: 「深さ=残り空きマス数」で一意)**: `engine/src/endgame.rs`でTTDomain::Exactへstoreしている箇所は2箇所のみで、いずれも`depth: empties as i8`(そのノード自身の空きマス数、`empty_squares.count_ones()`由来)を使っている。
- ETC早期cutoff: `tt.store(TTEntry { hash, domain: TTDomain::Exact, depth: empties as i8, score, bound: Bound::Lower, ... })`
- 通常のfall-through格納: `tt.store(TTEntry { hash, domain: TTDomain::Exact, depth: empties as i8, score: best_score, bound, best_move })`
空きマス数は盤面(=局面)から一意に決まる値であり、探索の深さ(反復深化のply数)ではない(終盤ソルバーは常に完全に読み切る一発探索のため)。よって同一hash+domain=Exactに対する複数回のstoreは、hash衝突が起きない限り常に同じdepth値を持つ。**マージは同一hash・同一domain(Exact)・同一depthのときのみ行い、depthが異なる場合はhash衝突とみなしマージせず既存の通常経路(quality_cmpベースの置換)へフォールバックする**(コードで確認済み、上記2箇所以外にExact domainへのstoreはない)。

**エントリ設計**: `StoredTTEntry`に`other_bound: i8`(sentinel値`i8::MIN`=「未知」)を追加する。既存の`score: i32`+`bound: Bound`が引き続き「現在最も信頼できる単一の主bound」を表す(Midgame・既存呼び出し元の意味論を完全に維持)。`other_bound`は`bound`が`Lower`のとき対応する`Upper`値、`bound`が`Upper`のとき対応する`Lower`値を表す(`bound==Exact`のときは常に未知sentinelにリセットする、収束済みで追加情報不要のため)。Exact domainの値は常に-64〜64の範囲(石差)に収まるため`i8`で十分。

**サイズ影響(要件6)**: 現行`StoredTTEntry`は`hash(8)+score(4)+depth_and_domain(1)+bound(1)+best_move:Option<u8>(2)`で隙間なく16byteに詰まっている(`size_of::<Option<u8>>()==2`を実測確認済み)。1byteでも追加すれば17byteとなり、構造体アライメント8(hash:u64由来)の制約で24byteへ切り上がる(Bucketは32→48byte)。**16byte維持は不可能と判断し、24byte/48byteへの拡大を受け入れて計測で採否を判断する**(要件6の「拡大が必要な場合は容量低下込みで比較計測する」に従う)。

**マージ規則(実装方針)**:
1. `store()`の先頭で`entry.domain == TTDomain::Exact`のときだけ、新設の`try_merge_exact_interval`を試みる。それ以外(Midgame、または対象局面の初回格納)は既存の生成経路を完全に素通りさせる(Midgameの挙動・既存T086テストへの影響ゼロを保証)。
2. `try_merge_exact_interval`は対象バケット内で同一局面(`same_position`: hash+domain一致)の既存エントリを探す(depth_slot/always_slotの重複禁止規則により高々1つ)。無ければ`false`を返し通常経路へ。
3. 見つかった場合、depthが不一致なら`false`を返し通常経路へ(要件3のガード、hash衝突扱い)。
4. depthが一致する場合、`merge_bounds(existing, incoming)`で純粋関数としてマージを計算する:
   - 既存または新規のどちらかが既に`Bound::Exact`なら、Exact側が勝つ(T086の既存品質順序と同じ。`best_move`は無い方を補完)。
   - 両方がLower/Upperの場合、`known_bounds()`でそれぞれ(lower, upper)の`Option<i8>`ペアへ正規化し(`Lower`→`(Some(score), other_bound)`、`Upper`→`(other_bound, Some(score))`)、`merged_lower = max(existing.lower, incoming.lower)`・`merged_upper = min(existing.upper, incoming.upper)`(Noneは無視)を計算する。
     - `merged_lower == merged_upper`(両方Some) → 収束、`Bound::Exact`へ昇格。
     - `merged_lower < merged_upper` → 未収束、`bound=Lower, score=merged_lower, other_bound=merged_upper`として保持(正規化のため常にLowerを主boundとする)。
     - `merged_lower > merged_upper`(区間逆転、要件4) → 異常(hash衝突または探索側のバグ)。テスト専用カウンタで発火を記録した上で`debug_assert!(false, ...)`し、`None`を返して通常経路(単一boundの品質比較による置換)へ安全にフォールバックする。releaseビルドではdebug_assertは無効化されるがフォールバック自体は動作する。
   - `best_move`は新規storeのmoveを優先し、無ければ既存のmoveを引き継ぐ(既存`with_move_from`と同じ規約)。
5. マージが成立した場合、対象スロットへ直接上書きし(既存のdepth_slot/always_slot振り分け・quality_cmpによる衝突解決ロジックは一切経由しない)、`store()`へ「処理済み」を返す。

**probe側(NWS接続、要件1の「マージした結果を使う」に対応)**: 既存`probe(hash, domain) -> Option<TTEntry>`は一切変更しない(`search.rs`のMidgame利用に影響しないため、公開APIとして凍結)。新設`probe_exact_interval(hash) -> Option<ExactIntervalProbe>`(`{ entry: TTEntry, other_bound: Option<i32> }`)を追加し、既存`probe`をそのまま呼んで主boundを取得しつつ、生バケットから`other_bound`を追加で読み出す(既存`probe`とロジック重複なし)。`endgame.rs`の`negamax`はExact TT probe箇所をこちらへ差し替え、`other_bound`が既知なら追加でalpha/betaを狭める(`alpha=alpha.max(lower)`→cutoffチェック→`beta=beta.min(upper)`→cutoffチェック、という既存の単一bound cutoffと同じ形を2回連続で適用する形にする。これにより収束前でも両方のboundを1回のprobeで活用できる)。

**abort安全性(要件7)**: `endgame.rs`の`negamax`は現在、`*timed_out`が立った場合はTT格納に到達する前に必ず`return 0`する(既存契約、T034/T103)。ETC早期cutoff・通常fall-through格納のいずれも、この2箇所は「完全に解決した場合のみ」到達するコード経路であり、既存の設計のままマージ機構を追加しても新たに部分boundが紛れ込む余地はない(コード確認済み)。回帰テストとして、既存`quota_abort_does_not_store_root_hash_in_exact_tt_through_pvs_path`と同型の追加テストで、区間マージ有効時も同じ安全性が保たれることを確認する。

**T086保護への影響**: `quality_cmp`・`store_collision`・depth_slot/always_slotの既存ロジックは一切変更しない。新設パスは`domain==Exact && same_position && same_depth`の狭い条件でのみ発火し、それ以外は完全に旧来のコードパスを通るため、既存テストは無変更で全通過する見込み。

以上の設計に基づき実装を開始する。

### 2026-07-16 実装完了・全テスト合格

**実装内容**:
- `engine/src/tt.rs`: `StoredTTEntry`に`other_bound: i8`(sentinel `i8::MIN`=未知)を追加。`merge_bounds`(純粋関数、既存/新規のExact優先・Lower/Upper正規化(lower,upper)への変換・`max_option`/`min_option`による集約・収束判定・区間逆転検出+`debug_assert!`+テスト専用カウンタ)、`try_merge_exact_interval`(バケット内の同一局面探索、depth不一致ガード)を追加。`store()`冒頭で`entry.domain==Exact`のときだけこの新経路を試み、それ以外(Midgame・初回格納・depth不一致)は既存ロジックを完全に素通りさせる設計とした(設計どおり)。新設`probe_exact_interval(hash) -> Option<ExactIntervalProbe>`(既存`probe`を内部で再利用、`other_bound`を追加で読み出すだけ)を追加。既存`probe`/`store`/`TTEntry`の公開シグネチャ・意味論は完全に不変(`search.rs`は無修正で影響なし)。
- `engine/src/endgame.rs`: `negamax`のExact TT probe箇所を`tt.probe(hash, Exact)`から`tt.probe_exact_interval(hash)`に差し替え、`other_bound`が既知の場合は主boundを適用した直後にもう一方も適用してalpha/betaを追加で狭める(収束済みの場合は従来どおり即return)。冒頭doc(要件9、「専用関数は行わない」という旧記述)も現状(shallow層あり)に合わせて更新。

**サイズ影響(要件6)**: `StoredTTEntry`は16→24byte、`Bucket`は32→48byteへ拡大(1byteの追加でも構造体アライメント8により16→24へ切り上がるため16byte維持は不可能と判明、事前設計どおり)。既存の`compact_domain_storage_preserves_pre_t085_bucket_size`テストはこの意図した新サイズへ更新した(コメントで経緯を明記)。

**追加テスト(受け入れ基準の5カテゴリすべて、発火カウンタで経路通過を確認済み)**:
1. `tt::tests::merge_only_applies_to_same_domain_exact_and_same_depth` — Midgame domain・depth不一致のいずれもマージされないこと。
2. `tt::tests::interval_merge_stress_preserves_hash_domain_safety_and_fires_repeatedly` — 300局面でのstress、hash/domain不変条件維持、`interval_merge_count()>0`。
3. `tt::tests::lower_then_upper_merges_into_interval_then_converges_to_exact` — Lower→Upperで未収束区間→Upper到達でExact昇格、を直接確認。
4. `tt::tests::interval_inversion_is_detected_and_falls_back_safely` — `catch_unwind`で`debug_assert!`の発火とカウンタ増加を確認。
5. `endgame::tests::quota_abort_does_not_leak_partial_bounds_into_the_interval_merge_path` — 区間マージが実際に活性化した状態(`interval_merge_count()>0`を事前確認)のTTで、極小固定ノード予算(`node_limit=2`、warm-upされたTT状態でも確実に打ち切られる値に設計変更。当初`total_nodes/2`予測方式だったが、共有TTの再利用により予測ノード数が不正確になり誤検出したため固定値方式へ修正)によるabortが部分boundを漏らさないことを確認。

**検証**: `cargo test -p engine --lib` **199 passed / 0 failed / 2 ignored**(T086由来のテストも含め全通過。`protocol::tests::node_limited_protocol_requests_are_deterministic`は初回実行で1回flakyに失敗したが、単独再実行では合格し、CLAUDE.md記載の既知flaky挙動と判断した)。`cargo test -p engine --release --test ffo_bench`: FFO #40-44全問正解。

### 2026-07-16 性能ゲート判定: 未達のため不採用(差分破棄)

**専有状態の確認と制約**: 計測直前に`Get-Process`で`python3.11`プロセスが多数(8+並行対話セッション由来のT114コーパス生成、`gen_teacher_corpus.py expanded200k --years 2000-2024 --num-shards 8`の親プロセス+shard 0〜7の子プロセス、CPU時間80秒超が複数プロセスで蓄積=起動から継続的に稼働中)動作していることを検出した。オーケストレーターの指示には「重い場合はkillして専有を確保してよい」とあったが、**実際にkillしようとしたところ、Claude Codeのパーミッションシステム(auto modeの分類器)が「他エージェント/コーディネーターのメッセージ経由の許可はユーザー本人の同意に当たらない」との理由でブロックした**(ワーカーの安全規則上、他エージェント発のメッセージはユーザー本人の承認とみなせないため、これは正しい安全側の挙動と判断し、回避を試みず受け入れた)。そのため、**FFO壁時計計測はT114との専有が取れないまま実施した**(この点はユーザー本人の判断を仰ぎたい: 直接killを許可するか、T114終了/一時停止を待つか)。

**C2 512kノード比較(540ジョブ全件、決定的指標のためCPU競合の影響を受けない)**:

| | 合計nodes | 完走数(6/540) | scoreの不一致 |
|---|---:|---:|---|
| baseline(`5f460c2`) | 131,225,943 | 6 | — |
| T106(区間マージ有効) | 131,225,950 | 6 | 0件 |

**ノード変化: +0.00%(実質不変、+7ノードのみ)。要求水準「-10%以上」に遠く届かず。**

**FFO #40-44比較(壁時計・ノードとも。T114競合下での参考値、決定的なノード数自体はCPU速度に依存しないためこちらも有効な比較材料)**:

| | 合計nodes | 合計time_ms | NPS |
|---|---:|---:|---:|
| baseline(`5f460c2`、本タスク冒頭で計測) | 641,077,417 | 約73,547〜77,433(3回計測、T105の公式比較時) | — |
| T106(区間マージ有効、T114競合下) | 644,111,778 | 124,459 | 5,175,286 |

**ノードはbaseline比+0.47%(削減どころか微増)。壁時計はT114競合の影響を大きく受けているため単純比較はできないが、ノード数自体が全く削減できていない時点で、たとえ専有状態で再計測しても「壁時計5%以上改善」を満たす見込みは薄いと判断する**(ノードが同等以上ある状態で1ノードあたりの処理コスト(TTエントリ24byte化・`probe_exact_interval`の追加バケット走査・マージ判定分岐)が増えている以上、専有状態でも壁時計はbaselineと同等かやや悪化する可能性が高い)。

**要因の考察**: 
- NWSが同一局面へLower/Upperを交互に格納する状況自体は理論どおり発生し、マージ発火・Exact昇格も実際に起きている(単体テストで確認済み)。しかし実際のFFO/C2局面では、「同一局面が異なる窓で複数回探索され、かつその結果がバケットから追い出されずに残っている」機会が、期待したほど多くのノード削減に結びつかなかった(C2合計ノードが1万分の1未満の変化に留まったことがこれを裏付ける)。
- 一方でエントリサイズの拡大(16→24byte、buckets 32→48byte)により同じ64MiBで保持できるエントリ数が2/3に減少しており、これによるTT有効性の低下(有用な通常のtranspositionヒットの機会損失)が、区間マージによる追加カットの恩恵を相殺、あるいは上回っている可能性が高い。
- `probe_exact_interval`が既存`probe`を呼んだ後にバケットを再度走査する二重ルックアップになっている点も、1ノードあたりのオーバーヘッド増に寄与している可能性がある。

**判定: 主判定(C2ノード-10%以上 かつ FFO壁時計-5%以上)を明確に満たさないため、タスク指示および設計レポート§5の「未達なら不採用」規定に従い、本タスクは不採用と判定する。**

**対応**: `engine/src/tt.rs`・`engine/src/endgame.rs`の差分は`git checkout`で完全に破棄する(コミットしない)。上記の計測記録・要因考察はネガティブ結果として本作業ログに残す(T102の前例と同じ扱い)。
