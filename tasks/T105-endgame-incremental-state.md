---
id: T105
title: 終盤ソルバー: 増分hash・flip再利用・状態の増分更新
status: todo # todo | in_progress | review | redo | done | blocked
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
