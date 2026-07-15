# T103 最終コードレビュー(Claude代替レビュー、Codex週間上限中)

- 対象: コミット `bdb4389`(範囲 `a0e3f9a..bdb4389`)
- 変更ファイル: `engine/src/endgame.rs`(+352/-35相当)、`engine/src/search.rs`(テスト期待値・コメントのみ)
- タスク仕様: `tasks/T103-endgame-nws-pvs.md`
- 設計規範: `tasks/design/T097-endgame-solver-report.md` §3.2・§7
- レビュー方法: 範囲diffの精読 + HEAD時点の `negamax` / `negamax_child` / `etc_cutoff_score` / 外部エントリポイント / テストヘルパーの全文照合 + 追加テスト2本の実行確認(2本ともPASS、2.74s)
- レビュー日: 2026-07-16

## 総合判定: **合格**

重大(ブロッカー)指摘なし。中指摘なし。軽微指摘4件(いずれもdone判定を妨げない。申し送りとしてSTATUS.mdへ)。

---

## 重点確認項目ごとの所見

### 1. PVS再探索条件の正しさ — 問題なし

再探索条件は `null_score > alpha && null_score < beta`(endgame.rs 759行)。境界を全数検討した:

- `null_score == alpha`: null window `(alpha, alpha+1)` に対するfail-low。fail-softの上界としてそのまま採用、再探索しない。正しい。
- `null_score == alpha + 1`(かつ `beta > alpha+1`): 整数窓 `(alpha, alpha+1)` の内部に整数は存在しないため、これはnull windowのfail-high(下界)。条件が真になり全窓で再探索する。正しい(再探索漏れなし)。
- `null_score >= beta`: 再探索せずfail-soft下界として採用 → `alpha >= beta` でβカット。正しい(このとき再探索は不要)。
- 再探索は現在の `(alpha, beta)` 窓で行う(`null_score-1` 起点ではない)。標準的なPVS再探索であり、TT副作用による探索不安定(再探索がfail-lowする等)が起きてもfail-soft値として無害に処理される。無限ループなし。
- ループ中にalphaが上がって実効幅1になった後の兄弟手は、null window=(実効的に)全窓となり再探索条件が恒偽になるため、冗長な再探索は発生しない。

なお `beta` がTT Upper boundで内部的に狭められている場合に `null_score >= beta(狭窄後) かつ < beta_orig` で再探索をスキップする経路があるが、このときTTの保証(`v <= entry.score = beta`)とfail-high下界(`v >= null_score >= beta`)から `v = null_score` が厳密に成立するため、値・bound判定とも健全(下記4と同根の論証)。

### 2. abort安全性 — 問題なし

`score` を best/alpha更新に使う前のtimed_outチェックは3経路すべてで担保されている:

- null window探索直後: `if *timed_out { return 0; }`(755-758行)が `null_score` の窓比較(759行)より**前**にある。打ち切られた値は比較にすら使われない。
- 全窓再探索・1手目/狭窓探索: score式の直後の共通チェック(781-785行)が best/alpha更新(787行以降)より前にあり、早期returnによりループ後のTT格納(810行)もスキップされる。
- 関数入口の quota/時間チェック → `return 0` はTT probe/storeより前(既存T034契約のまま)。

「abortされた第一探索の値の再利用バグ」(設計§7)の防止は構造的に満たされている。

### 3. alpha_orig/beta_orig の経路網羅 — 問題なし

- 確定タイミング: hash計算直後・**TT probeより前**(604-605行)。設計§3.2「TTや安定石で変更する前の呼び出し窓を保存」に正しく準拠。旧実装(probe後に `alpha_orig` を取得)の潜在バグ修正として妥当。
- パス経路(629-648行): 狭窄後の `(-beta, -alpha)` で再帰し、**TT格納を行わずに**そのまま返す(パス局面を格納しない既存契約のまま)。格納しないため alpha_orig/beta_orig は不要で、返り値の健全性は「狭窄がTT boundに由来する場合、fail-soft境界値とTT boundの連立で値が厳密に確定する」ことで保たれる(T103以前からの既存挙動、変更なし)。
- ETC cutoff格納(702-709行): 無条件に `Bound::Lower` で、`etc_cutoff_score` の返す値は子TTのUpper/Exactから導かれる真の下界(`v >= -entry.score`)なので、窓狭窄と無関係に健全。T101から変更なし。
- 再帰(negamax_child経由): 子には現在の(狭窄・更新後の)窓を渡すのが正しく、そうなっている。alpha_orig/beta_origは格納時bound判定専用に閉じている。

### 4. TT格納のbound種別判定 — 問題なし

802-808行: `best_score <= alpha_orig → Upper` / `best_score >= beta_orig → Lower` / それ以外 `Exact`。

内部窓がTTで狭窄された状態で `alpha_orig < best_score < beta_orig` となるケース(旧実装ならUpper/Lowerに分類されえた)をExactと格納することの健全性を確認した: 狭窄はTTのLower/Upper bound由来であり、(i) 狭窄alphaに対するfail-low値 `s` は探索から `v <= s`、TTから `v >= alpha(=entry.score) >= s` で `v = s`、(ii) 狭窄betaに対するfail-highも対称に `v = s` が成立する。つまりTT boundの健全性を前提とすれば、この分類はすべて正確。設計§3.2の規範どおり。

### 5. 狭窓経路(beta-alpha<=1)の旧実装との等価性 — 問題なし(C2ビット単位一致と整合)

- `narrow_window` 分岐のループ本体は旧実装の単一窓ループと同一呼び出し(negamax_childは引数構築の共通化のみで、子盤面・子パリティ・子hash・窓の組み立ては旧inline コードと一致)。
- 幅1の窓ではTT probeによる窓狭窄は必ず `alpha >= beta` に到達して早期return(旧実装と同一のコード)になるか、何も変えないかのいずれか。したがって幅1窓のツリー内では alpha_orig/beta_orig が常に呼び出し時窓と一致し、**bound判定の変更(probe前取得への変更・beta→beta_origへの変更)は狭窓経路の挙動を一切変えない**。窓は幅1のまま子へ伝播する(alpha更新は即βカット)。
- よって狭窓系列(fail_high/fail_low)のノード数がC2の512k・4M両系列でbaselineとビット単位一致したという計測結果は、コード構造から導かれる帰結と完全に整合する。

### 6. ETC(T101)・ムーブオーダリング(T099/T100)・パリティとの統合 — 問題なし

- MoveInfo生成・sort_key(TT move→隅→相手mobility→square class→象限パリティ→マス番号)・ETC probe/cutoffのコードはこの範囲で無変更。
- negamax_childの子象限パリティ計算(`quadrant_parity ^ QUADRANT_ID[square]`)は旧inlineコードと同一。ETC対象時のchild_hash受け渡しも同一。
- ETC・ソートはPVS分岐の**前**(候補列挙時)に完結しており、null window/再探索のどちらの子呼び出しでも同じMoveInfoを共有する。副作用なし。
- 論理ノード定義(negamax呼び出し回数)は不変。null window+再探索で同一子を2回訪問すればその分カウントされるのは意図どおり。

### 7. 追加テスト2本の実質性 — 問題なし(空洞化なし)

- `pvs_full_and_narrow_windows_match_naive_reference_with_research_firing`: 照合先の `naive_solve` は枝刈り・TT・PVSを一切持たない独立全探索(パス処理込み)で自己参照なし。空き6以下129局面でfull/fail-high/fail-low 3窓のscore一致に加え、**ルートTTエントリのbound種別**(full=Exact/fail-high=Lower/fail-low=Upper、score=真値)まで検証しており、これは項目4のbound判定の直接回帰テストになっている(fail-soft値が真値に一致することも窓構成 `(truth-1,truth)`/`(truth,truth+1)` から数学的に必然で、アサーションは緩くない)。閾値アサーション(full>=100、narrow>=40、pass>0)と再探索カウンタ>0(thread_localでテスト間干渉なし)により、発火0件passは構造的に不可能。実行して2.74sでPASSを確認。
- `quota_abort_does_not_store_root_hash_in_exact_tt_through_pvs_path`: 複数合法手(=PVS分岐が確実に選択される)・空き6以上の局面で、全解決ノード数の半分をnode_limitに設定(決定的なので打ち切り保証)し、`ExactQuota` abortとルートhashのExact TT未格納を検証。checked>=8の下限付き。汚染の間接検証(同一TT再解決 vs fresh TT)も含む。実質的。

### 8. search.rsの期待値更新 — 機械的追従の範囲内

`leaf_exact_attempts 2→4`、`exact_leaf_completed 1→3`、`exact_children 1→2` と対応コメントの更新のみで、探索ロジック・テスト構造への変更はゼロ。T085a/T089a/T100(コミット23a5e6d)と同一性質の前例踏襲であり、変化の因果(PVSでソルバー1回あたりのノード消費が減り共有quota内の試行数が増えた)は作業ログにデバッグ実測値付きで記録されている。テストの主眼(aborted/unattemptedな局面がExactドメインへ漏れない)は維持されている(仮にabortされた子がply1に漏れれば `exact_children==2` が3になって検出される)。

---

## 指摘一覧

### 重大(ブロッカー)

なし。

### 中

なし。

### 軽微

1. **[endgame.rs 119-122] `TEST_RESEARCH_COUNT` が非testビルドにも存在する。** thread_local宣言が `#[cfg(test)]` の外にあるため、本番ビルドにも未使用のthread_local staticが1つ残る(触られることはなく実害なし)。既存の `TEST_ETC_CUTOFFS` と同じ前例踏襲だが、いずれ `#[cfg(test)]` 化してもよい。
2. **[endgame.rs テスト1] 再探索カウンタはテスト全体のグローバル合算。** naive照合済み局面(空き6以下)の探索**内で**再探索が発火したことまでは保証せず、発火は空き7-12の非照合局面由来でもpassする。再探索経路自体の正しさはFFO全問正解と窓別bound検証で間接的に担保されているため実用上十分だが、「naive照合とre-search発火の同時成立」を厳密に主張するものではない点は認識しておく。
3. **[search.rs 3475-3480] `exact_children == 2` は実装依存の観測値の固定化。** 旧アサーションの「完走数と1:1」という不変条件が「完走3のうちply1格納は2」という観測事実に置き換わっており、コメントで正直に説明されているものの、将来のソルバー変更で(安全性と無関係に)割れやすいテレメトリテストである(この脆さはT103以前からの性質)。
4. **[endgame.rs テスト1] pass局面カウントは全サンプル局面に対する集計。** naive照合対象(空き6以下)にpass局面が含まれることを個別には強制しない(実際には40seed×全局面でほぼ確実に含まれる)。

---

## 結論

設計レポート§3.2の規範(NWS/PVS分岐・abort契約・alpha_orig/beta_orig基準のTT格納規約・2刻み窓最適化の不採用)と§7のリスク3点(再探索漏れ・alpha_orig管理・abort値再利用)をすべて満たしている。狭窓経路の数学的等価性はC2ビット単位一致の計測結果とコード構造の双方から裏付けられ、full window経路の-50.17%(FFO)・完走+4(C2 4M)は健全な改善。外部契約(公開シグネチャ・abort契約・論理ノード定義)は不変。

**総合判定: 合格**(軽微4件はSTATUS.mdへの申し送りで足りる)。
