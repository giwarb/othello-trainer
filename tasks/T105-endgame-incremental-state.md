---
id: T105
title: 終盤ソルバー: 増分hash・flip再利用・状態の増分更新
status: done # todo | in_progress | review | redo | done | blocked
assignee: implementer(Sonnet, Codex上限フォールバック)
attempts: 0
---

# T105: 増分hash・flip再利用・状態の増分更新

## 目的

終盤ソルバー強化シリーズ第8弾(1ノードあたりコスト削減の第2弾)。現行は着手のたびに Zobrist hash・空き数・パリティ等をゼロから、またはflip maskを複数回計算している箇所が残る。探索中の状態(盤面・hash・empties・パリティ)を増分更新に統一し、flip maskは一度だけ計算して子盤面構築に再利用することで、探索木を一切変えずにNPSを引き上げる。

## 委譲体制の注記

Codex週間上限(リセット7/22 6:00)のため implementer(Sonnet)フォールバック+検証強化(verifier+Claude代替レビュー)で実施する。**本タスクの最大の強みは「探索木が完全不変」という検証条件**: FFO・C2のノード数がbaselineと1ノードでもズレたらどこかにバグがある。段階ごとにこの一致を確認しながら進めること。

## 規範文書

- `tasks/design/T097-endgame-solver-report.md` §5 T105節・§7(リスク表: flip石のhash色切替、パス時のside key、黒白絶対表現とrelative表現の混同)。

## 要件(設計レポート§5 T105節が規範)

1. **flip maskの一回計算**: T099で導入済みの `MoveInfo::flips`/`mv`(現状保存のみで未使用、T099レビュー指摘)を実際に使い、子盤面構築を「保存済みflip maskからXORで構築」に変える(`legal_moves`→`apply_move`での再計算を排除)。
2. **Zobrist hashの増分更新**: 子局面のhashを毎回全盤走査で再計算せず、(着手マス+flipした石の色切替+手番)の差分XORで更新する。パス時のside key切替も正しく扱う。
3. **empties/パリティの増分更新**: 空き数・象限パリティ(T100)の増分管理を統一し、`empty_count()` 等の再計算を排除する。
4. **side-relative表現の整理**(設計レポートの `EndgamePosition` 相当): own/opp の2ビットボードで持ち回し、着手/パスで役割をswapする形に探索内部を整理する(黒白絶対表現との混同に注意、§7リスク)。既存の公開APIの境界で変換する。
5. **debug照合**: debugビルド(またはテスト時)では増分hashとfull再計算hashの一致をassertする(多seedのランダムプレイアウトで着手・パス両方を通す)。
6. **scalar方向処理のinline化比較**: flip計算の方向ループのinline化/展開を試し、効果を計測して採否を決める(効果が無ければ不採用でよい、判断根拠を作業ログに)。
7. 変更対象は `engine/src/endgame.rs`・`engine/src/bitboard.rs`・`engine/src/zobrist.rs` のみ。公開API・abort契約・論理ノード定義は不変。
8. **T104のshallow層との整合**: 空き4以下の専用層はTT/hashを使わない設計のまま維持する(shallow層に入る枝ではhash増分更新自体を省略してよい)。
9. **T099レビュー申し送りの軽微対応(同一ファイルのため含める)**: endgame.rs冒頭コメントの排序説明が旧内容(T100で変更済み)なので現状に合わせて更新。

## 計測プロトコル

- **主判定**: **NPS 1.5倍以上(native)または壁時計30%以上短縮**(設計レポート§5)。FFO #40-44の5問合計で前後比較(前=T104採用コミットのビルド)。専有状態・3回中央値。1.3〜1.5倍はグレーゾーンとして報告し判断を仰ぐ。
- **探索木の完全不変**: FFO #40-44の各問ノード数・C2 512k系列の全jobノード数が**baselineと完全一致**すること(1ノードでもズレたら不合格)。これが正しさの主検証を兼ねる。
- WASMビルド成功。可能ならWASM側の参考NPSも記録。

## やらないこと(スコープ外)

- TT区間化(T106)、exactポリシー・ノード予算変更(T107)
- SIMD・unsafe最適化
- ムーブオーダリング・探索アルゴリズムの変更(ノード数が変わる変更は一切禁止)

## 受け入れ基準(検証コマンド)

- [ ] `cargo test -p engine` 全件パス(protocolフレーキーは単独再実行で切り分け)
- [ ] **増分hash照合**: 多seedランダムプレイアウト(パス含む)で増分hash==full再計算hashのassertが通るテストがある(発火件数の下限つき)
- [ ] `cargo test -p engine --release --test ffo_bench` — FFO #40-44全問正解 かつ **各問ノード数がT104採用時点と完全一致**
- [ ] C2 512k系列の全jobノード数がbaselineと完全一致(比較表を作業ログに)
- [ ] NPS前後比較表(1.5倍以上または壁時計-30%で採用、1.3〜1.5倍は報告して判断待ち)
- [ ] fresh TT同一局面2回実行の決定性
- [ ] WASMビルド(`wasm32-unknown-unknown`)が成功する
- [ ] 変更対象ファイルのみパス指定でコミット(コミットメッセージに `(T105)`)
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと

## フィードバック(やり直し時にオーケストレーターが記入)

### 2026-07-16 — オーケストレーター裁定: 性能ゲート未達だが採用方向で判定(verifier+レビュー合格を条件)

実装報告(コミット5f460c2): 正しさは完全(FFO・C2全540ジョブでノード数baseline完全一致、194テストパス、WASM成功、増分hash照合テスト合格)。性能はNPS約1.03倍・壁時計約-3%で主判定(1.5倍/-30%)未達、グレーゾーン(1.3倍)にも届かず。

裁定: **選択肢(a)=採用してdone、スコープ拡大redo(b)はしない。**
- 未達の原因分析(実装者の考察を支持): T104のshallow層導入で、本タスクが削る対象だったhash/状態更新コストの大半が既に探索から消えていた(設計レポートの1.5倍見積もりはT104前の前提)。残るノードコストの主因はTT probe・MoveInfoソート・ETCでスコープ外。narrow化拡大の期待値は低い。
- 採用の理由: 探索木ビット単位不変=リスクゼロ / 壁時計-3%の微益 / T099申し送りの負債(MoveInfo::flips未使用)解消 / 増分hash+debug照合は後続施策の基盤。
- ゲート未達採用の前例: T089a(waive裁定)。本件もSTATUS完了表に「ゲート未達・基盤整理として採用」を明記する。

### 2026-07-16 — オーケストレーター判定: done(採用確定)

- verifier: 全項目合格(194テスト、増分hash照合は発火≥200件の実アサート、FFO各問ノードがbaseline完全一致、WASM成功、決定性pass)。
- Claude代替レビュー(`tasks/review/T105-endgame-incremental-state-claude-review.md`): 合格、重大・中指摘なし。§7の3大リスク(FLIP_KEY色切替・パスside key・絶対/relative混同)の回避を確認。軽微3件のうちdoc矛盾(endgame.rs冒頭の「専用関数は行わない」旧記述)はT106へ申し送り。
- 実装コミット: 5f460c2。性能はNPS1.03倍(ゲート未達、基盤整理として採用の裁定どおり)。

## 作業ログ(担当エージェントが追記)

### 2026-07-16 準備フェーズ(読み取り専用): 実装計画

**同期状況の確認**: 着手時点で`tasks/T104-endgame-shallow-solver.md`のfrontmatterは`status: in_progress`。`git log --oneline`で`(T104)`を含む最新コミットは`4bbca88`(初回実装)のみで、それ以降の`636cf25`/`0e8246c`は`tasks/`配下のみの変更(engine/src差分なし)。現在の作業ツリーには`engine/src/endgame.rs`(+253/-?)・`engine/src/search.rs`(+18/-8、テストのコメント・期待値更新のみでロジック変更なし)の未コミット差分があり、これが「T104仕上げ(SHALLOW_MAX_EMPTIES=4採用+公式NPS計測+コミット)」の作業中と判断した。**この時点ではcargo build/testを一切実行していない**(CPU専有を汚染しないため、指示どおり)。5分間隔でポーリングし、baselineコミットの確定を待つ。

**規範文書の要点(§5 T105節・§7)**: 上記システムプロンプトに転記済みの内容を読了。リスク表(flip石のhash色切替、パス時のside key、黒白絶対表現とrelative表現の混同)を踏まえた設計を下記に記す。

**現行コード読了箇所**: `engine/src/endgame.rs`全体(1〜1494行、テスト部含む)、`engine/src/bitboard.rs`冒頭〜240行(`Board`/`flips_for_move`/`apply_move`/`legal_moves`/`empty_count`)、`engine/src/zobrist.rs`全体。

**現状確認した既存資産**:
- `zobrist.rs`に`toggle_square(hash, square, side)`・`toggle_side_to_move(hash)`という増分更新用ヘルパーが**既に実装済み・未使用**(`#[cfg(test)]`のみで参照)。これをそのまま使う、または効率のため後述の`FLIP_KEY`テーブルを追加する。
- `MoveInfo.flips`フィールドは値をセットしているだけで、コード中どこからも読まれていない(`grep`で確認済み、T099レビュー指摘どおり)。
- `quadrant_parity`は既にT100で増分管理済み(`negamax_child`が`quadrant_parity ^ QUADRANT_ID[mv.square]`を子へ渡す)。T105で新規に増分化が必要なのは主に**hash**と**empties**。
- `negamax`の子生成ループは `next_board = board.apply_move(side, mv)` → `flips = board.white/black ^ next_board.white/black`(diffで逆算)という順で、`apply_move`内部で`flips_for_move`を計算した後に**同じflipsをdiffで再度求めている**二重計算がある。
- `child_hash`は現在`etc_eligible`のときだけ`zobrist_hash(&next_board, ...)`で全盤走査再計算し、`etc_eligible`でなければ`0`(未使用)。`negamax_child`も`etc_eligible`のときだけ`Some(child_hash)`を渡し、それ以外は`None`(=子側で全盤走査するhashを再計算)。これが要件2の主対象。
- pass分岐(`negamax`内、自分に合法手なしのケース)は`known_hash`に常に`None`を渡しており、子(手番だけ入れ替えた同一盤面)のhashを毎回全盤走査で再計算している。ここも増分化対象(`toggle_side_to_move(hash)`で置き換え可能)。
- `board.empty_count()`は`64 - (black|white).count_ones()`で、それ自体は軽い(OR+POPCNT)。増分化の主目的は「`solve_shallow`入口の空きマス再列挙をやめ、negamax側で持つ`empties: u64`ビットマスクをそのまま渡す」という設計レポート§3.7の意図に沿うこと(効果は限定的だが要件3として明記されている)。

**段階的実装計画(タスク指示の「flip mask再利用→増分hash→empties/パリティ→side-relative整理→inline化比較」の順に対応)**:

1. **flip mask再利用**: 子生成ループで`flips_for_move(own, opp, mv)`を1回だけ呼び、`bitboard.rs`に新設する`apply_move_with_flips(own: u64, opp: u64, flips: u64, mv_bit: u64) -> (u64, u64)`(新しい own/opp を返す薄いヘルパー)経由で`next_board`を構築する。`Board::apply_move`自体もこのヘルパーを呼ぶようリファクタし(`flips_for_move`→`apply_move_with_flips`)、実装重複を解消する(公開シグネチャ・挙動は不変)。これにより`MoveInfo.flips`が実際に使われるようになる(現状の「diffで逆算」コードを削除)。
2. **Zobrist hashの増分更新**: `zobrist.rs`に`FLIP_KEY: [u64; 64]`(`SQUARE_KEYS[sq][0] ^ SQUARE_KEYS[sq][1]`の事前計算テーブル)を追加する。ある1マスがひっくり返る、または相手→自分に色が変わる操作は、色を問わず`hash ^= FLIP_KEY[sq]`一発で表現できる(以前の色が何であれ、ちょうど黒キーと白キーを入れ替える効果になるため。着手先の新規石だけは元が空きマスなので`toggle_square(hash, square, side)`で個別に加える必要がある)。`negamax`の子生成ループで`child_hash = toggle_side_to_move(flips.into_iter().fold(toggle_square(hash, square, side), |h, sq| h ^ FLIP_KEY[sq]))`のように計算し、`MoveInfo.child_hash`に**常に**(`etc_eligible`の条件を外して)格納する。`negamax_child`も常に`Some(move_info.child_hash)`を子へ渡すよう変更し、`etc_eligible`だけを条件にしていた`if etc_eligible {Some(...)} else {None}`分岐を削除する(ETCで使うhash pre-computeと、探索本体が使うhashは同じ値になるため一本化できる)。pass分岐も`toggle_side_to_move(hash)`を`known_hash`として渡すよう変更する。これにより`known_hash.unwrap_or_else(|| zobrist_hash(board, side))`のフルスキャンパスは実質ルート呼び出し(`solve_exact`系入口、`known_hash: None`)のみに限定される。
3. **empties/パリティの増分更新**: `negamax`/`negamax_child`/`solve_shallow`のシグネチャに`empties: u64`(空きマスのビットマスク)を追加し、ルートで`!(board.black | board.white)`を1回だけ計算、子では`empties & !mv`で更新する。`board.empty_count()`(popcount目的)は`empties.count_ones()`に置き換え、`solve_shallow`冒頭の`!(board.black | board.white)`再計算とビット列挙ループはこの`empties`引数をそのまま使う(`board`から再導出しない)。
4. **side-relative整理**: 設計レポートの`EndgamePosition`(player/opponent + empties + parity + hash)をそのまま`negamax`のシグネチャへ丸ごと導入する(=`Board`+`Side`を`negamax`内部から排除する)のは、既存の`Board`ベースTT格納・`final_score`・大量の既存テストとの整合コストに対してリスクが高いと判断した(設計レポート§7で最大リスクとして名指しされている「黒白絶対表現とrelative表現の混同」を自ら誘発しやすい)。**本タスクでは以下のスコープに narrow 化して実装する**(要件4の趣旨である「own/opp bitboardで持ち回し、negamaxのホットパスからBlack/White match分岐を減らす」は満たしつつ、公開境界・TT格納の型は一切変えない):
   - `bitboard.rs`に`legal_moves_relative(own: u64, opp: u64) -> u64`(既存`legal_moves`の`sides(side)`変換を経由しないrelative版)を追加し、`Board::legal_moves`はこれを呼ぶ薄いラッパーにリファクタする(重複排除、公開シグネチャ不変)。
   - `negamax`の子生成ループ内で`match side { Black => ..., White => ... }`によるflip逆算(現状のdiffコード、要件1で削除予定)を、上記`apply_move_with_flips`(relative)呼び出しに統一し、`Board`型はTT格納・`final_score`・再帰呼び出しの引数としてのみ使う。
   - この narrow化の判断根拠と、フルスコープの`EndgamePosition`構造体化は見送る理由を作業ログに明記する(意図的なスコープ縮小であり、性能への影響は主にstage1-3で刈り取れる想定。設計レポート§3.7も「empties: u64とfixed parityを採用」を実用最小ラインとして推奨しており、この判断と整合する)。
   - もしstage1-3実測で目標(NPS1.5倍/壁時計-30%)に届かない場合、この narrow化を拡大するかどうかを判断材料として作業ログに記録し、必要なら追加着手する。
5. **debug照合**: `negamax`内、`known_hash`が`Some`のとき(=増分計算されたhashを受け取ったとき)に限り、`#[cfg(debug_assertions)]`(release NPS計測ではstripされ性能に影響しない。`ffo_bench.rs`が既にdebug_assertions下でheavyテストをignoreする前例と整合)で`zobrist_hash(board, side)`とのフル一致を`debug_assert_eq!`する。加えて既存の`TEST_ETC_CUTOFFS`等と同じ`thread_local`カウンタパターンで発火回数を数える`#[cfg(test)]`テストを新設し、複数seed(例: 5〜10 seed)のランダム自己対戦(パス発生ケースを含む局面を意図的に混ぜる、または既存のC2局面から空き12前後の局面を使う)を完全読みで流し、「発火件数がN件以上」をアサートする(要件5の「発火件数の下限つき」)。
6. **scalar方向処理のinline化比較**: `bitboard.rs`の`DIRECTIONS: [ShiftFn; 8]`(関数ポインタ配列)を、`flips_for_move`/`legal_moves_relative`の中だけ8方向を手展開したバージョンと比較する。関数ポインタ経由だとインライン化されない可能性が高いため、直接の8つの`shift_*`呼び出しに展開したコードをマクロまたは単純な列挙で書き、release NPS(FFO #40-44合計)で比較する。改善が誤差程度なら不採用とし、判断根拠(数値)を作業ログに残す。

**計測・検証の実施順序**: 各stageごとに(a) `cargo test -p engine --lib`でnaive differential/ETC/PVS等の既存テストが全通過すること、(b) `cargo test -p engine --release --test ffo_bench`でFFO #40-44のノード数がT104 baselineと完全一致することを都度確認しながら進める(1つのstageでノードが1つでもズレたらそのstageの実装を疑う)。全stage完了後にC2 512k系列・NPS公式計測・WASMビルドを実施する。

**T104完了待ちの状況**: 上記はすべて設計文書とコードの読み取りのみで作成した(cargo build/test等のCPU操作は未実行)。以後、5分間隔でT104側のコミット状況を確認し、baseline(T104最終コミット)が確定次第、上記stage1から実装に着手する。

**オーケストレーター承認(2026-07-16)**: stage 4(side-relative整理)のnarrow化(`EndgamePosition`構造体への丸ごと移行ではなく、`bitboard.rs`へのown/opp向けrelativeヘルパー追加+`negamax`ホットパスのBlack/White match分岐削減に限定するスコープ)を承認済み。判断理由・NPSゲート未達時の再検討条件とも計画記載どおりでよいとの指示。他の点(stage1・2・3・5・6)も計画どおり進めてよい。T104完了確認まで引き続きcargo等のCPU操作は行わず、5分間隔のポーリングを継続中(バックグラウンドMonitorで監視中)。

### 2026-07-16 T104完了・実装フェーズ開始

オーケストレーターよりT104がdone(採用、NPS 3.065倍)になった旨の連絡。**baselineはコミット`a3a91ef`**(4bbca88 + ce1dacf(redo#1: CornerThenParity) + a3a91ef(redo#2: is_root追加、ルートB1修正)の最終形)。確認: `git log --oneline -- engine/src`の最新は`a3a91ef`、HEAD(`5901c75`)との`engine/src`差分は0(tasksのみのコミット)。作業ツリーの未追跡差分は`train/src/t090_distillation.rs`のみで、これは並行セッション由来のため一切触らない(指示どおり)。

`a3a91ef`で`negamax`に`is_root: bool`引数が追加されていることを確認(公開5関数の最外周呼び出しのみ`true`、`negamax_child`経由の子・パス再帰は常に`false`)。この引数はstage1〜3のシグネチャ変更時にそのまま維持する。

**専有状態確認**: `tasklist`でcargo/rustc/python系プロセス無し、`Get-Process`でCPU上位もclaude/Code等でありビルド系プロセスなし。競合プロセス無しと判断。

**baseline記録(コミット`a3a91ef`、変更前)**:
- `cargo test -p engine --release --test ffo_bench -- --nocapture`: #40=38,176,210 / #41=86,480,440 / #42=125,215,835 / #43=236,602,685 / #44=154,602,247、**合計641,077,417**(T104記録と一致)。この1回の実測NPSは6,355,839(単発参考値、公式比較は全stage完了後に3回中央値で行う)。
- `cargo test -p engine --lib`: 192 passed / 0 failed / 2 ignored。

**Stage 1完了(flip mask再利用)**:
- `engine/src/bitboard.rs`: `legal_moves_relative(own, opp, empty)`(既存`legal_moves`のロジックをrelative化)と`apply_move_with_flips(own, opp, mv_bit, flips)`を追加。`Board::legal_moves`/`Board::apply_move`はこれらの薄いラッパーにリファクタ(公開シグネチャ・挙動は不変)。
- `engine/src/endgame.rs`: `negamax`の子生成ループで、`board.apply_move(side, mv)`→`next_board`との差分でflipsを逆算、という二重計算をやめ、`(own, opp)`を1回導出→`flips_for_move`を1回呼ぶ→`apply_move_with_flips`で`next_board`を組み立てる、に変更。`MoveInfo.flips`が実際に使われるようになった(T099レビュー指摘の解消)。
- 検証: `cargo test -p engine --lib` 192 passed/0 failed/2 ignored(変化なし)。`cargo test -p engine --release --test ffo_bench`: #40〜#44の各問ノード数・合計641,077,417が**baselineと完全一致**。

**Stage 2完了(増分Zobrist hash、debug照合含む)**:
- `engine/src/zobrist.rs`: `FLIP_KEY: [u64; 64]`(`SQUARE_KEYS[sq][0] ^ SQUARE_KEYS[sq][1]`の事前計算)を追加。「flipされた1マスは相手色→自分色に変わるので、色を問わず`FLIP_KEY[sq]`を1回XORするだけで正しい」という性質を利用(設計レポート§7「flip石のhash色切替」対策、色分岐不要)。`incremental_move_hash(hash, mover_square, mover_side, flips)`(着手先1マスの`toggle_square`+flipsの各ビットへの`FLIP_KEY`XOR+`toggle_side_to_move`)を追加。
  - 検証テスト`zobrist::tests::incremental_move_hash_matches_full_recompute_across_random_self_play_including_passes`: seed 1〜30の自己対戦を初期局面から終局まで**毎手**追跡し、`incremental_move_hash`(着手)・`toggle_side_to_move`(パス)による更新値を`zobrist_hash`のフル再計算と毎手assert_eq(1回でもズレたらpanic)。総手数500以上・パス1回以上を確認するアサーション付きで合格。
- `engine/src/endgame.rs`: `MoveInfo.child_hash`を、`etc_eligible`のときだけフル再計算/それ以外0(未使用)、という以前の分岐をやめ、**常に**`incremental_move_hash(hash, square, side, flips)`で計算するよう変更。パス分岐も`None`(子側でのフル再計算)から`Some(toggle_side_to_move(hash))`に変更。`negamax_child`は`etc_eligible`引数自体を削除し(子hashの用途がこれだけだったため)、常に`Some(move_info.child_hash)`を渡すよう単純化(呼び出し3箇所も追随)。
  - **debug照合(要件5)**: `MoveInfo`構築時とパス分岐の両方で`debug_assert_eq!(増分hash, zobrist_hash(フル再計算))`を追加(releaseではstripされNPSに影響しない。`ffo_bench.rs`が既にdebug_assertionsでheavyテストをignoreする前例と整合)。発火回数を数える`TEST_INCREMENTAL_HASH_CHECKS`カウンタ(既存の`TEST_ETC_CUTOFFS`等と同じthread_localパターン)を追加し、新規テスト`incremental_hash_check_fires_across_random_positions_including_passes`でseed 1〜16のランダム小局面(パス含む)を`solve_with_etc::<true, true>(_, _, 8)`で解き、発火回数が200件以上であることをassert。
- 検証: `cargo test -p engine --lib` **194 passed**(192+新規2件: zobrist側1件・endgame側1件)/0 failed/2 ignored。debug_assert_eq!は1件も失敗せず(=増分hashは全ケースで一致)。`cargo test -p engine --release --test ffo_bench`: 各問ノード数・合計641,077,417が**baselineと完全一致**。
- **NPS参考値(単発、専有状態未確認の速報値)**: stage2完了時点でFFO #40-44合計 nodes=641,077,417, time=72.382s, nps=8,856,879(baseline単発値6,355,839から+39%、stage1単発値6,517,677からも大幅改善)。公式な3回中央値比較は全stage完了後に実施する。

**Stage 3完了(empties増分)**:
- `engine/src/endgame.rs`: `initial_empty_squares(board)`(`!(board.black|board.white)`)を追加。`negamax`/`negamax_child`/`solve_shallow`のシグネチャに`empty_squares: u64`(空きマスビットマスク)を追加し、公開5関数のルート呼び出し・テストヘルパー2箇所(`solve_with_etc`/`solve_with_seeded_child_etc`)から`initial_empty_squares(board)`を渡すよう変更。子は`negamax_child`内で`parent_empty_squares & !move_info.mv`で増分更新、パス再帰は同じマスクをそのまま渡す(着手なしのため不変)。
  - `negamax`内は`board.empty_count()`の2回呼び出し(shallow分岐判定用・`let empties`用、いずれも`board.black|board.white`のORを含む)をやめ、`empty_squares.count_ones()`の1回のpopcountに統合。
  - `solve_shallow`は`!(board.black | board.white)`の内部再計算をやめ、渡された`empty_squares_mask`引数をそのまま空きマス列挙に使う。
- 検証: `cargo build -p engine --lib`成功(シグネチャ変更に伴う呼び出し側の不整合なし)。`cargo test -p engine --lib` 194 passed/0 failed/2 ignored(変化なし)。`cargo test -p engine --release --test ffo_bench`: 各問ノード数・合計641,077,417が**baselineと完全一致**。
- **NPS参考値(単発)**: nodes=641,077,417, time=69.857s, nps=9,176,942(stage2の8,856,879からさらに改善)。
- 次: Stage 4(narrow化したside-relative整理、オーケストレーター承認済み)へ進む。

**Stage 4完了(narrow化したside-relative整理)**:
- `engine/src/endgame.rs`: `(own, opp)`の導出を、パス判定直前(`let legal = ...`の直前)に1箇所へ集約。`board.legal_moves(side)`/`board.legal_moves(side.opposite())`(いずれも内部で`sides(side)`のBlack/White match + `!(board.black|board.white)`の毎回導出を行う)を、`legal_moves_relative(own, opp, empty_squares)`/`legal_moves_relative(opp, own, empty_squares)`(stage1で`bitboard.rs`に追加済みのrelative版、増分管理済みの`empty_squares`をそのまま使う)に置き換えた。
- 子生成ループの`opp_mobility`計算も、`next_board.legal_moves(side.opposite())`(同様にBlack/White match+空きマス再導出)から、既に手元にある`new_own`/`new_opp`と`empty_squares & !mv`(flipは空きマスの状態を変えないため`mv`だけ除けばよい)を使う`legal_moves_relative(new_opp, new_own, empty_squares & !mv)`に置き換えた。ループ内で重複していた`(own, opp)`のmatch式は削除し、パス判定直前で導出した値を再利用する形に統合。
- `Board`型・`final_score`・TT格納・公開APIは一切変更していない(narrow化のスコープどおり。`Board`はTT格納・再帰呼び出しの引数としてのみ使用)。
- 検証: `cargo build -p engine --lib`警告0件。`cargo test -p engine --lib` 194 passed/0 failed/2 ignored(変化なし)。`cargo test -p engine --release --test ffo_bench`: 各問ノード数・合計641,077,417が**baselineと完全一致**。
- **NPS参考値(単発)**: nodes=641,077,417, time=76.766s, nps=8,351,043(stage3の9,176,942よりは低いが、これまでの単発計測が6.36M→6.52M→8.86M→9.18M→8.35Mと振れ幅が大きく、単発値だけでは傾向以上の判断はできない。公式判定は全stage完了後の専有状態3回中央値で行う)。
- 次: Stage 5(debug照合)は既にstage2の実装(`debug_assert_eq!`+`TEST_INCREMENTAL_HASH_CHECKS`カウンタ+専用テスト`incremental_hash_check_fires_across_random_positions_including_passes`)で実質完了済みと判断し、追加作業なしでStage 6(scalar方向処理のinline化比較)へ進む。

**Stage 6実施・不採用(scalar方向処理のinline化比較)**:
- `engine/src/bitboard.rs`の`flips_for_move`/`legal_moves_relative`について、`DIRECTIONS`(関数ポインタ配列)を`for`ループで回す現行実装と、8方向を直接呼び出しへ展開したマクロ版(`flip_direction!`/`legal_moves_direction!`)を実装しFFO #40-44合計NPSで比較した。
  - loop版(展開前、stage4完了直後の状態): 8,351,043(stage4検証時)/8,111,911(stage6着手直前の再測定)。
  - 展開版: 8,349,706 / 7,389,373(2回計測)。
  - ノード数はいずれも641,077,417で完全一致(純粋な計算コストの変更であり探索木には影響しない、想定どおり)。
  - 判断: 展開版がloop版を明確に上回る結果にならず(むしろ2回目は下回った)、これまでの単発計測全体で見られたノイズ幅(同一実装内でも6.36M〜9.18Mまで振れている)に埋もれる差でしかないと判断した。設計レポート§3.8・タスク要件6の「効果が無ければ不採用でよい」に従い、**展開版は不採用とし元のloop実装のまま維持する**(コード上も展開版は残さず、比較のための一時実装は削除してloop版に戻した)。
- 検証: 不採用判断後、`cargo test -p engine --lib` 194 passed/0 failed/2 ignored(loop版に戻したのみなので当然変化なし)。
- 以上でStage1〜6(5は2に統合、6は不採用)が完了。次は受け入れ基準の残り(公式NPS比較・C2 512kベンチ・fresh TT決定性・WASMビルド・コミット)を実施する。

### 2026-07-16 最終検証: 公式NPS比較・C2 512k完全一致・WASM・結論

**専有状態**: `Get-Process`でcargo/rustc/python系のCPU大量消費プロセスなしを確認(claude/Code等の通常プロセスのみ)。

**公式NPS比較(3回中央値、baseline=`a3a91ef`とT105最終実装をbash back-to-backで測定)**:

同一セッション内で`git stash push -- engine/src/bitboard.rs engine/src/endgame.rs engine/src/zobrist.rs`によりT105差分だけを一時退避し(`train/src/t090_distillation.rs`は無関係な並行セッション差分のため一切触れず、pathspec指定でstashから除外)、`a3a91ef`相当のビルドで3回測定→`git stash pop`でT105実装へ復元、という手順でbaselineとT105を同一セッション内で直接比較した(セッション冒頭で取った単発計測はマシン状態のばらつきが大きく比較に使えないと判断し、この back-to-back 計測を公式値として採用)。

| | run1 | run2 | run3 | 中央値 |
|---|---:|---:|---:|---:|
| T105最終実装 | 8,716,508 | 8,685,267 | 8,963,226 | **8,716,508** |
| baseline(`a3a91ef`) | 8,444,688 | 8,456,293 | 8,279,161 | **8,444,688** |

倍率: 8,716,508 / 8,444,688 = **約1.032倍**。壁時計(FFO合計time_ms、5問合計)も同様に baseline中央値75.811s → T105中央値73.547s で**約3.0%短縮**。

**判定**: 主判定「NPS 1.5倍以上または壁時計30%以上短縮」を明確に満たさず、**「1.3〜1.5倍はグレーゾーン」の下限(1.3倍)にも届いていない**(約1.03倍)。ノード数完全一致という強い正しさの保証は得られたが、NPS改善効果はごく小さい。

**要因についての考察**: stage1(flip mask再利用)・stage2(増分hash)・stage3(empties増分)・stage4(own/opp化)はいずれも個別には正しく機能しているが、セッション冒頭の単発計測(baseline 6.36M→各stage完了ごとに6.52M→8.86M→9.18M→8.35M)で見えていた大きな伸びは、後半になるほどマシン状態(サーマル/バックグラウンド負荷)が安定した影響が大きく、実際のコード改善分は上記の公式back-to-back比較が示す約3%程度に留まると考えられる。`negamax`1ノードあたりのコストのうち、Zobrist hashの毎ノード全盤走査や`board.empty_count()`の重複呼び出しは、盤面64マスの単純なループ/POPCNTであり元々ハードウェア的に高速だった(命令数はO(64)だが分岐なしSIMD的ループでCPUにとって軽い)ため、削減してもボトルネックの大部分を占めていなかった可能性が高い。TT probe/store・`MoveInfo`配列構築とソート・ETC probe等、本タスクのスコープ外の処理がノードコストの大部分を占めていると推測される。

**C2 512k系列ノード数比較(540ジョブ全件、`bench/edax-compare/endgame_bench.py run --suite c2`)**:

baselineと同じstash手順で`a3a91ef`ビルドのeval_cliを再ビルドし、両方とも独立したcheckpoint(scratchpad配下、リポジトリには置いていない)で540ジョブ(60局面×budget{64000,160000,512000}×window{fail_high,fail_low,full})を完走。

- baseline合計nodes: 131,225,943
- T105合計nodes: **131,225,943**(完全一致)
- 540ジョブ全件で`nodes`・`completed`・`score`が1件残らず一致(不一致0件)
- 実行時間: baseline 38.9s、T105 37.7s(参考値、C2は主にnode_limit到達で決定的に打ち切るジョブが多く工程内訳がFFOほど単純ではないため公式NPS判定には使わない)

**FFO #40-44ノード数**: 全stage・最終状態を通じて`38176210/86480440/125215835/236602685/154602247`(合計641,077,417)が完全に不変であることを確認済み(各stage完了時のログ参照)。

**その他の受け入れ基準**:
- `cargo test -p engine --lib`: **194 passed / 0 failed / 2 ignored**(fresh TT決定性テスト`fresh_tt_runs_are_deterministic_with_etc`含む)。
- 増分hash照合: `zobrist::tests::incremental_move_hash_matches_full_recompute_across_random_self_play_including_passes`(seed1-30、毎手assert)と`endgame::tests::incremental_hash_check_fires_across_random_positions_including_passes`(発火200件以上を要求)の両方が合格。
- `cargo build --release --target wasm32-unknown-unknown`: **成功**(警告0件)。

**結論・オーケストレーターへの報告**:

1. **正しさ**: FFO・C2の全ノード数が完全一致し、増分hash・empties・own/opp化のいずれにも探索木への影響がないことを強く確認できた。既存194テストも全通過。
2. **性能**: 公式3回中央値比較でNPS約1.03倍・壁時計約3%短縮に留まり、要求水準(1.5倍/-30%)はおろか「1.3〜1.5倍のグレーゾーン」にも届かなかった。
3. **判断が必要な点**: 承認済みnarrow化(stage4)の範囲では目標に届かなかった。計画作成時に記録した「NPSゲート未達時はnarrow化拡大を判断材料として記録し、必要なら追加着手する」という条件に該当する。本タスクの時間予算(段階的検証+公式計測+C2 540ジョブ全件確認)を使い切ったため、ここで**一旦停止しオーケストレーターの判断を仰ぐ**: (a) 現状(正しさ確認済み・NPS+3%)を部分的成果としてdone扱いにし、大きな`EndgamePosition`型への本格移行は別タスク(T106以降)に切り出すか、(b) 本タスク内でredoとしてside-relative整理の範囲を拡大するか、(c) NPS目標自体をT107のexactポリシー再校正待ちに一時ペンディングにするか、の3択を提示する。
4. 変更対象ファイル: `engine/src/bitboard.rs`(`apply_move_with_flips`/`legal_moves_relative`追加、既存メソッドのリファクタ)、`engine/src/endgame.rs`(flip再利用・増分hash・empties増分・own/opp化・debug照合テレメトリ)、`engine/src/zobrist.rs`(`FLIP_KEY`/`incremental_move_hash`追加)。stage6(scalar展開)は不採用のため差分に残していない。

**コミット**: `5f460c2`(`engine: 終盤ソルバーにflip再利用・増分Zobrist hash・empties増分・own/opp化を追加(T105)`)。変更対象ファイル(`engine/src/bitboard.rs` `engine/src/endgame.rs` `engine/src/zobrist.rs`)のみパス指定でadd・commit(`git add -A`は使用せず)。push・`tasks/`のコミットは行っていない(オーケストレーター担当)。`git status --short`はこのコミット後`tasks/T105-endgame-incremental-state.md`(本ファイル、作業ログ追記分)のみが差分として残っており、他のタスク由来の差分・未追跡ファイルはない(`train/src/t090_distillation.rs`は並行セッション由来のため未touch、`tasks/T114-...md`は無関係な他タスクの成果物)。

**作業を停止し、オーケストレーターの判断を仰ぐ**: 上記「結論・オーケストレーターへの報告」の3択(a/b/c)について指示を待つ。指示があり次第、redoとして続行するか、STATUS.md反映・後続タスク起票の判断に従う。
