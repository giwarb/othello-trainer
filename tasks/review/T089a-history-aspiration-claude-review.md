# T089a 最終レビュー: history heuristic + aspiration window

**Codex利用上限のためClaude代替レビュー**(レビュアー: Claude / Fable 5、読み取りのみ)

- 対象コミット範囲: `13de7b1..40a773d`
  - `0cf615f` engine: history heuristic + aspiration windowをノード予算探索に追加(T089a)
  - `40a773d` bench: 60局vs Edaxベンチ結果の保全
- 変更ファイル: `engine/src/search.rs`(+592/-39相当)、`engine/src/bin/eval_cli.rs`(+2)、`bench/edax-compare/t089a_primary_{report.md,results.json}`(成果物)
- タスク仕様: `tasks/T089a-history-aspiration.md`(性能ゲートはオーケストレーター裁定でwaive済み)
- 設計書規範: `tasks/design/T085-beat-level10-report.md` §7
- レビュー時の独立確認: `40a773d..HEAD` で engine/ に差分がないことを確認のうえ、キーとなる2テスト
  (`aspiration_and_history_enabled_matches_full_window_disabled`、
  `leaf_exact_quota_abort_continues_midgame_iteration_without_tt_domain_leak`)を実行し **2 passed / 0 failed** を確認。

---

## 総合判定: **合格**(重大指摘なし。中3件・軽微3件は申し送り)

---

## 観点1: aspiration window の再探索ロジックの正しさ(最重要)

### (a) fail-low / fail-high が交互に起きるケース → 問題なし

`aspiration_search`(search.rs)は窓を **center固定の対称拡大**(±200→±400→±800→±1600→full)で管理し、fail方向によらず `window_idx` を単調増加させる。各窓は前の窓の厳密なスーパーセットであり、fail-low と fail-high が交互に起きても `window_idx` は毎回進むため、**最大4回のfailで必ずfull windowに到達**する。無限ループ・窓の縮小はあり得ない。

### (b) full-window fallback の到達保証 → 問題なし

`aspiration_bounds` は `ASPIRATION_WINDOWS_CENTIDISC.get(window_idx)` が `None` になったら無条件に `(-INF, INF)` を返し、`aspiration_search` は `is_full_window`(`alpha <= -INF && beta >= INF`)なら fail 判定をスキップして探索値をそのまま返す。`INF = 1_000_000` に対しスコアは centi-disc で高々 ±6400 なので、clamp(`max(-INF)`/`min(INF)`)による「意図せぬ早期 full-window 化」も起きない。到達保証は堅牢。

### (c) fail時の途中結果が最終結果に混入しないか → 混入しない

- `aspiration_search` が値を返すのは「窓内(`alpha < score < beta` の排他判定)」か「full window」のみ。fail した窓の score は捨てられ、ループ継続にのみ使われる。
- **best_move の取得経路**: `search_with_eval_inner` はイテレーション完了後に `tt.probe(hash, TTDomain::Midgame)` からルートの best_move を取る。最終的に成功した(窓内 or full window の)探索がルートに **Exact bound + 正しい best_move** を格納し、これが probe で返る(下記(d)参照)。fail-low 時にルートへ格納される Upper bound エントリの仮 best_move(fail-soft の argmax で信頼できない値)が読まれる経路はない。
- **timed_out 時**: `aspiration_search` は即 return し、呼び出し元はイテレーション全体を破棄して `last_result`(前 depth の完了時点で probe 済みの best_move を保持)を返す。破棄イテレーション中の TT 書き込みが返却結果に影響しない構造は既存(T034)のまま。

### (d) 半端な bound による TT 汚染(T086品質置換との相互作用) → 健全

- fail した窓の探索がルート/内部ノードに格納する `Bound::Upper`/`Bound::Lower` は、**MPC無効時は fail-soft の証明済み上下界**であり(本ビルドでは MPC は `mpc_enabled` フィーチャ既定OFFで完全無効、`mpc.rs` の `margin_centidisc` が常に `None`)、再探索がこれを probe して `beta = min(beta, U)` 等にクランプしても真値は必ず窓内に残る。「同深度の弱いbound」も汚染源にはならない(証明済みである限り健全)。
- 最終探索がルートに格納する Exact エントリは、T086 の `quality_cmp`(tt.rs)で **同depthなら Exact > Lower/Upper** と定義されており、先行する fail bound エントリを確実に品質置換する。probe も depth スロット/always スロットの高品質側を返すため、古い bound エントリが best_move 取得を汚染しない。
- full window(`alpha == -INF`)ではルートでの TT 即時カットオフ(`alpha >= beta`)が構造的に発生し得ない、というコード内注記は正しい。full-window 探索が TT Upper bound で beta をクランプされて「fail-high」で返るコーナーケースも、fail-soft 下界 ≥ beta = 証明済み上界、により返り値=真値に収束するため正しい。

**結論**: 再探索ロジックは要件7・8を満たす。82組合せ(41局面×2深さ)の on/off 一致テストが実装より先に書かれており、実測でも裏付けられている。

## 観点2: history heuristic の仕様適合と有効範囲の漏れ

- `(side, move)` 表: `HistoryTable { scores: [[u32; 64]; 2] }`、探索コンテキスト(`SearchCtx.history: Option<&mut HistoryTable>`)所有。static/グローバルなし。仕様どおり。
- beta cutoff 時 `depth * depth` の飽和加算(`saturating_add`)、root 反復ごとの `halve_all()`(イテレーションループ冒頭、要件3どおり)。
- TT move 最優先: `ordered_moves` はソート後に TT move を先頭へ移す既存ロジックを維持しており、history はソートキーのタイブレーク(構成A: corner→mobility→history降順)にのみ入る。維持されている。
- exact solver 非適用: `endgame.rs` は無変更(diff stat で確認)。FFO #40-44 合計ノード 1,298,656,784 の完全一致が実測の裏付け。
- **`enable_heuristics` の分岐の網羅性**: `search_with_eval_inner` の本番呼び出し元は2箇所のみ — `search_with_eval`(=`search` 経由含む、`false`)と `search_with_eval_with_node_limit_and_exact_quota`(=`search_with_eval_with_node_limit` 経由、`true`)。`search_all_moves` / `search_all_moves_with_eval`(解析経路)は inner を通らず `history: None` を明示。`SearchCtx` は struct リテラルなのでフィールド設定漏れはコンパイルエラーになる。`protocol.rs`(無変更)は `max_nodes` の有無で node-limit 経路/従来経路を分岐する既存構造のため、「max_nodes経路のみ有効」は**漏れなく実現されている**。fixed-depth 回帰テストは `search()` 経由で完全無変更のままパス。

## 観点3: 既存テスト `leaf_exact_quota_abort_...` の変更(重点)

**T085aの中心保証は維持されている。ブロッカーには当たらない**が、一部の検証が間接化した(下記「中2」)。

- 維持(直接アサーション): quota-abort 発生(`exact_aborted_by_quota == 1`)、abort してもイテレーション継続・完走(`last_completed_depth == 2`、`fallback_reason == ExactQuota`、`!node_limit_hit`、`!static_only`)、ルートが Exact ドメインに漏れない(`tt.probe(root_hash, Exact).is_none()`)、**abort/未試行の子が Exact ドメインへ漏れない**(`exact_children == 1` — 完走した1子だけが格納される。旧版の「全子が格納されない」より情報量の多いアサーションに強化)。
- 失われたもの: 「quota-abort 経路の結果 == 純中盤探索(`exact_from_empties: 0`)の結果」という等価性検証。ただしこれは旧テストが借用していた**偶然の性質**(この局面では常に全 exact 試行が中断していた)であり、ムーブオーダリングを変える施策(history)とは構造的に両立不可能。1子が実際に完全読みを完走するようになった今、等価性が成り立たないのは正当。代替として決定性アサーション(同一入力2回実行の best_move/score/nodes/統計の完全一致)が追加されている。
- テスト内コメントに経緯が詳細に記録されており、変更の透明性は高い。

## 観点4: 決定性

- `HistoryTable` は探索呼び出しごとに `new()`(ゼロ初期化)で生成し、常駐 Engine でも持ち越しなし(要件11どおり)。加えて protocol.rs の node-limit 経路は既存の `tt.clear()`(T085b)で TT の履歴依存も除去済み。
- `sort_by_key`(安定ソート)+ 決定的な u32 演算のみで、非決定性の入り口なし。
- ノードカウントのチェック粒度: `TIME_CHECK_NODE_INTERVAL`(1024)不変、`max_nodes` チェックは毎ノード(従来どおり)。
- 実測: budget-regression 2回一致、vs_edax 内蔵決定性チェック PASSED、repeat テスト追加。問題なし。

## 観点5: ノード予算との相互作用

- aspiration の全窓再探索は**同一の `SearchCtx`**(イテレーションごとに1つ)を共有し、`nodes` が累積・`nodes_before + *ctx.nodes >= max_nodes` の判定に含まれるため、再探索分も正しく予算消費として扱われる。
- 予算超過/時間切れは従来どおり `*ctx.timed_out = true` → `aspiration_search` 即 return → 呼び出し元がイテレーション破棄・`last_result`(last_completed)返却。`GlobalNodeLimit` / `WallClock` の判別ロジック(`total_nodes + nodes >= max_nodes`)にも変更なし。**既存動作は壊れていない**。
- 破棄イテレーションを含む累計を `aspiration_fail_low/high` に載せる仕様は `exact_stats` 系と同じ慣習で、コメントに明記済み。テレメトリのみで結果に影響しない。

## 観点6: スコープ遵守

- `endgame.rs` 無変更、`tt.rs`(置換規則)無変更、`protocol.rs` 無変更。`eval_cli.rs` はテレメトリ2フィールド追加のみ(要件10の「SearchResultとeval_cli best」の字義どおり)。bench 成果物2ファイルは保全コミット。**スコープ逸脱なし**。

---

## 指摘一覧

### 重大(ブロッカー)

なし。

### 中(done可・申し送り推奨)

1. **要件8「full-window完全一致」の保証範囲は純中盤に限定される。** 一致テストは `exact_from_empties: 0` 固定で、exact quota 併用時(実運用の `--exact-from-empties 18` 等)は history によるムーブオーダリング変化が exact 試行の訪問順・quota 消費を変え、完走する子の集合が変わりうる(`leaf_exact_...` テストの `exact_leaf_attempts` 1→3 がその実例)。これは quota 設計(T085a)に内在する性質で回避不能であり、作業ログにも明記・オーケストレーター裁定でも織り込み済みだが、「exact併用時は on/off でビット単位の一致保証はない」ことを STATUS.md 等に申し送っておくべき。
2. **旧テストの「quota-abort結果 == 純中盤探索」等価性検証の喪失。** 「中断した exact 試行が中盤探索の*値*を汚染しない」ことの検証が、値の等価性からドメイン占有チェック+決定性チェックへと間接化した。構造的には TTDomain 分離(probe/store のドメイン引数)が汚染を防いでおり、代替アサーションは妥当だが、値レベルの直接検証が1つ減ったことは事実。将来 exact/TT まわりを触るタスク(T089b等)では意識すること。
3. **一致テストの best_move 同点許容ロジック。** 要件8の字義(best move 完全一致)より緩いが、「`search_all_moves`(history/aspiration不使用の ground truth)で両方の手が同一スコアを達成すると独立検証できた場合のみ許容、できなければ不一致扱い」という設計は健全で、ムーブオーダリング変更技法に一般的に伴う性質として妥当な解釈。仕様の読み替えとして作業ログに記録済みであり容認できる。

### 軽微

1. **`mpc_enabled` フィーチャ有効ビルドでは aspiration の一致保証が崩れる。** MPC カット(`mpc_try_cutoff` が `beta`/`alpha` を返す確率的枝刈り)は窓依存のため、aspiration の狭い窓では full window と異なるカットが発生し、要件8 の保証も一致テストも成立しなくなる。既定ビルドでは MPC は完全無効(`margin_centidisc` が常に `None`)なので実害はないが、将来 MPC を再有効化する場合(T089b 圏)は aspiration との併用可否を再設計する必要がある。
2. `leaf_exact_...` テストの新コメント内の attempt 内訳の推測列挙(「1回完走・1回quota-abort・1回は…のいずれか」)は網羅的に正確とは言えない(aspiration 再探索で同一子を再 attempt して TT ヒットで即完走する経路等もあり得る)。アサーション自体(`exact_children == 1` 等)は正しく、挙動への影響はない。コメントの精度の問題のみ。
3. `budget-regression` の JSON 出力には aspiration テレメトリが載らない(`cmd_best` のみ)。要件10 の字義どおりではあるが、今後 aspiration 再探索率をコーパス単位で追跡したくなった場合は追加が必要。

---

## 結論

aspiration window の再探索ロジック((a)交互fail・(b)full-window到達・(c)途中結果の非混入・(d)TT bound の健全性)はいずれも正しく実装されており、history heuristic の有効範囲制御(`enable_heuristics` = max_nodes経路のみ)にも漏れがない。既存テストの書き換えは T085a の中心保証を直接アサーションで維持しており弱体化には当たらない。決定性・ノード予算・スコープもすべて要件どおり。

**総合判定: 合格**(性能ゲート未達はオーケストレーター裁定で waive 済みのため判定対象外。中3件・軽微3件を STATUS.md への申し送り推奨)。
