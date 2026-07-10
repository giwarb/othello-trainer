---
id: T051
title: エンジン強化(2): ETC(Enhanced Transposition Cutoff)による探索高速化
status: review
assignee: implementer
attempts: 1
---

# T051: エンジン強化(2): ETC(Enhanced Transposition Cutoff)による探索高速化

## 目的

Edax実装調査(T048着手前に実施済み)で、投資対効果が高いとされた技術のうち、MPC(T048、実装したが速度向上は実証できず既定オフで確定)に続き、ETC(Enhanced Transposition Cutoff)に着手する。MPCと異なり、ETCは統計的な誤判定を許容する枝刈りではなく、**置換表(TT)に既に記録されている厳密な情報を使う「安全な」枝刈り**であるため、探索結果(選択する手・評価値)を一切変えずに探索ノード数を削減できる(正しく実装できれば副作用が無い)。

## 背景・コンテキスト(このリポジトリを知らない前提で読めるように)

- ETCとは: あるノードで候補手を1つずつ試す前に、「その手を実際に指した後の局面」のZobristハッシュを計算し、まず置換表(TT)を覗く。もしその子局面のTTエントリに、現在のアルファ・ベータ窓に対してカットオフを確定できるだけの厳密な境界(exact値、またはbeta cutoffを引き起こすlower bound等)が既に記録されていれば、**実際にその手を探索(再帰呼び出し)する前に**、そのTT情報だけでこのノード自体のカットオフを確定できる。ハッシュ計算とTT参照は探索1回分よりずっと安価なため、「無料に近いコストで得られる追加のカットオフ」として知られる。Edaxでは`src/search.c`の`search_ETC_NWS()`関数(1241行目付近)が該当。
- 現状のエンジン: `engine/src/search.rs`にNegaScout(PVS)+Zobrist置換表(TT、`engine/src/tt.rs`または同等)を実装済み。T048でMPC(`engine/src/mpc.rs`)を追加済みだが既定オフ。
- **MPCとの違い(重要)**: MPCは「浅い探索の結果から統計的に見込み薄と判断する」確率的な枝刈りであり、誤判定のリスクがある(実際T048で自己対戦の棋力にわずかな影響が出た)。ETCは「既に置換表に記録されている、過去の探索で確定した厳密な情報」を使うだけなので、**正しく実装されていれば探索結果(最終的な評価値・選ぶ手)を一切変えない**(ノード数だけが減る)。この性質の違いから、本タスクの検証は「探索結果が完全に同一であること」を厳密に確認する必要がある(MPCのように「多少の棋力変化は許容範囲」という判断は不要)。
- 過去の教訓(T034): 探索の時間管理・葉ノード評価まわりの変更は、WASM環境での予期しないハング・タイムアウトに直結した実績がある。既存の時間予算チェック機構(1024ノードごと)には手を入れないこと。

## 変更対象

- `engine/src/search.rs` — NegaScout(PVS)の候補手ループ内、各候補手を実際に探索(再帰呼び出し)する直前に、その手を適用した後の局面のZobristハッシュを計算し、TTを参照する処理を追加する。TTエントリが現在のアルファ・ベータ窓に対して即座にカットオフを確定できる情報を持っていれば、その手の再帰探索を省略してカットオフを返す。
- 既存の置換表参照ロジック(ノード自身のTTルックアップ)と同様の境界判定ロジック(exact/lower/upper boundの扱い)を流用できるはずなので、重複実装を避け、共通化できる部分は共通化すること。

## 要件

1. **正しさ(最重要)**: ETC有効時と無効時で、同一局面・同一深さの探索結果(最終的な最善手・評価値)が完全に一致すること。これを検証するテストを追加する(例: 多数のランダム局面・WTHOR局面等で、ETC有効/無効の両方で`search`を実行し、返り値が全て一致することを確認するユニットテストまたは統合テスト)。
2. ETCの導入により、同一局面・同一深さでの探索ノード数が削減されること(削減率を作業ログに記録)。MPCと異なり「速度向上が実証できなければ既定オフ」という妥協ラインではなく、正しく実装されていれば必ず何らかの削減効果があるはずなので、削減が見られない場合は実装の見直しを行うこと。
3. FFO終盤テスト(`--ignored`除く高速版)が、ETC導入前と完全に同じ結果(正解値・ノード数含め)になること、またはETCがノード数を削減した場合はノード数が減ること(結果自体=正解値は変わらないこと)。
4. `cargo test --workspace`が全件パスすること。
5. 既存の時間予算チェック機構(1024ノードごと)に悪影響を与えないこと。

## やらないこと(スコープ外)

- 終盤パリティベース着手順序付けは別タスク(T052想定)で対応する。
- MPC(T048)の見直し・再調整は行わない(既定オフのまま)。ETCとMPCを組み合わせる場合の相互作用検証は本タスクでは不要(両方とも中盤探索に影響するため、将来両方を有効にする際の検証は別タスクで行う)。
- パターン評価関数自体の変更は行わない。

## 受け入れ基準(検証コマンド)

- [x] `cargo build --workspace` が成功する。
- [x] `cargo test --workspace` が全件パスする(ETC有効/無効での探索結果一致を検証する新規テスト含む)。
- [x] FFO終盤テスト(`--ignored`除く高速版)が引き続き全問正解する。
- [x] ノード数削減率(ETC有効/無効の比較)を作業ログに数値で記録する。
- [x] 探索結果の完全一致(要件1)を検証したテストの実行結果を作業ログに記録する。

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

- 2026-07-10 implementer: ETC(Enhanced Transposition Cutoff)を実装。

  ### 変更内容
  - `engine/src/search.rs`のみ変更(スコープどおりengineクレート限定)。
    - `SearchCtx`に`enable_etc: bool`フィールドを追加(本番コードは常に`true`。
      `false`はETC有効/無効の一致検証テスト専用で、`negascout`の一番深い
      再帰呼び出し3箇所(初手のフルウィンドウ探索、NWSの狭い窓での探索、
      窓を外れた場合のフルウィンドウ再探索)を束ねる新関数
      `negascout_or_etc`経由でのみ参照する)。
    - `search_with_eval`を、`enable_etc`引数を追加した非公開の
      `search_with_eval_inner`への薄いラッパーに分割(公開APIのシグネチャ・
      挙動は変更なし。常に`true`を渡す)。
    - ETC本体`etc_try_cutoff`を追加。候補手を実際に再帰探索する**前**に、
      着手後の局面のZobristハッシュでTTを覗き、`negascout`本体のTT参照
      ブロック(`entry.depth as u32 >= depth as u32`の十分性チェック、
      Exact/Lower/Upperの扱い、`alpha >= beta`カットオフ確定)を前倒しで
      シミュレートする。これが即座に値を確定できると判定した場合のみ
      `Some(score)`を返し、呼び出し元は実際の再帰呼び出しを省略する。
    - 正しさを担保するための2つの必須ガードを実装:
      (1) `child_depth == 0`のときは常に`None`(`negascout`本体は
      `depth == 0`のノードでTTを一切参照せず`static_eval`を直接返すため、
      ここでTTを使うと実際の再帰呼び出しと異なる値を返しうる)。
      (2) 着手後の局面の空きマス数が`ctx.limit.exact_from_empties`以下の
      ときも常に`None`(`negascout`本体はTT参照ブロックに到達する手前で
      終盤完全読み`solve_exact`/`solve_exact_bounded`に処理を委譲して
      `return`するため、この条件を満たす子局面は実際には中盤探索用のTT
      参照ロジックに一度も到達しない)。
    - 既存の時間予算チェック機構(`TIME_CHECK_NODE_INTERVAL`=1024ノードごと、
      T034)・終盤完全読み(`endgame::solve_exact`系)には一切手を入れて
      いない(ETCはO(1)のTT参照のみで、再帰・時間チェックを一切経由しない
      経路のため)。MPC(T048、`mpc.rs`)の見直しも行っていない
      (既定オフのまま)。

  ### 要件1(最重要): ETC有効/無効での探索結果の完全一致
  - 新規テスト`etc_enabled_and_disabled_produce_identical_search_results`
    (`engine/src/search.rs`のテストモジュール、デフォルトの`cargo test`で
    毎回実行される)を追加。初期局面+乱数(自作xorshift64*、seed 0〜5、
    再現可能)で序盤・中盤寄りに進めた局面(空きマス数目標32/18)、
    計13局面 × 深さ[3, 5] = 26通りの組み合わせについて、
    `search_with_eval_inner(..., enable_etc: true)`と
    `search_with_eval_inner(..., enable_etc: false)`を実行し、
    `best_move`・`score`・`depth`が全て一致することを`assert!`で検証。
    実行結果: **26通り全てで完全一致(不一致0件)**。
    ```
    cargo test -p engine --lib search::tests::etc_enabled_and_disabled -- --nocapture
    → T051 ETC node-count comparison across 26 position/depth combinations:
      with_etc=28396 nodes, without_etc=29036 nodes, reduction=2.20%
      test ... ok (1 passed; 0 failed)
    ```
  - さらに`#[ignore]`付きの`etc_node_reduction_at_deeper_depths`
    (より現実的な深さ8〜9、`--release`推奨、FFOの重いテストと同じ理由で
    デフォルトの`cargo test`からは除外)も追加。4局面(初期局面+乱数
    seed 0〜3、空きマス目標40/26)× 深さ[8, 9] = 18通りで同様に検証:
    ```
    cargo test -p engine --lib search::tests::etc_node_reduction_at_deeper_depths --release -- --ignored --nocapture
    → T051 ETC node-count comparison (deeper depths) across 18 position/depth combinations:
      with_etc=2468469 nodes, without_etc=2535498 nodes, reduction=2.64%
      test ... ok (finished in 8.27s)
    ```
    こちらも**不一致0件**。

  ### 要件2: ノード数削減率
  - 上記2つのテストで、削減率はそれぞれ**2.20%**(深さ3・5、26組み合わせ
    合計)・**2.64%**(深さ8・9、18組み合わせ合計、リリースビルド)。
    MPC(T048)と異なり、正しく実装されていればノード数は必ず削減される
    はず、という要件どおり、いずれのテストでもETC有効時のノード数が
    無効時を下回ることを確認済み(`assert!(total_nodes_with_etc <
    total_nodes_without_etc)`)。削減率自体は数%程度と比較的小さいが、
    これは本エンジンの反復深化・TT2-tier構成(depth優先スロット1つ+
    always-replaceスロット1つ)では、ある子局面のTTエントリが「次に
    その子局面を再訪した時点で必要な深さ以上」を満たしたまま残っている
    ケースがそれほど多くない(浅いエントリで上書きされる、異なる局面に
    上書きされる等)ためと考えられる。それでも要件どおり「ゼロではない、
    確実な削減」が得られており、実装自体は正しく機能している。

  ### 要件3: FFO終盤テスト(高速版、#40-44)への影響
  - `cargo test -p engine --test ffo_bench --release -- --nocapture`
    (デフォルトの`--ignored`なし版、#40〜#44)を2回実行し、いずれも
    以下のとおり全問正解・ノード数もT009/T048時点の記録と完全一致
    することを確認(ETCは`search.rs`のみの変更であり
    `endgame::solve_exact_with_nodes`には一切触れていないため、
    影響が無いのは設計上自明だが、念のため実測で確認した):
    ```
    problem  empties   score  expected         nodes     time_ms
    #40           20      38        38      41875164     ~15-18s
    #41           22       0         0     193735021     ~75-86s
    #42           22       6         6     319790944    ~127-131s
    #43           23     -12       -12     450971649    ~216-218s
    #44           23     -14       -14     386081067    ~161-172s
    FAST TOTAL: 5 positions solved correctly, nodes=1392453845
    test result: ok. 1 passed; 0 failed; 1 ignored (heavy #45-49をスキップ)
    ```
    ノード数(41,875,164 / 193,735,021 / 319,790,944 / 450,971,649 /
    386,081,067)は`engine/tests/ffo_bench.rs`冒頭コメントに記録済みの
    T009時点の値と完全一致(=終盤ソルバーの探索経路はETC導入前後で
    ビット単位で同一)。

  ### 要件4: `cargo test --workspace`
  - 全件パス: `test result: ok. 120 passed; 0 failed; 1 ignored`
    (engineクレート。1 ignoredは上記`etc_node_reduction_at_deeper_depths`、
    意図どおり)。他クレート(train)も含め全体で失敗なし。

  ### 要件5: 時間予算チェック機構への影響
  - `TIME_CHECK_NODE_INTERVAL`(1024ノードごとのチェック)・`negascout`
    冒頭の`*ctx.nodes += 1` / `if *ctx.timed_out`ロジックには一切手を
    入れていない。ETCが値を返す(=再帰を省略する)場合、その子ノード分の
    ノードカウント・時間チェックが行われないだけであり、これは通常の
    alpha-beta枝刈りで子ノードを訪問しない場合と全く同じ扱い(既存の
    `search_all_moves_respects_time_ms_budget_and_returns_promptly`等の
    既存テストも変更なしで全てパスしていることから、時間予算機構への
    悪影響が無いことを確認済み)。

  ### 検証コマンド・結果まとめ
  - `cargo build --workspace` → 成功。
  - `cargo test --workspace` → 120 passed; 0 failed; 1 ignored(engine)。
    他クレートも全件パス。
  - `cargo test -p engine --lib search::tests::etc_enabled_and_disabled -- --nocapture`
    → 1 passed(26/26一致、削減率2.20%)。
  - `cargo test -p engine --lib search::tests::etc_node_reduction_at_deeper_depths --release -- --ignored --nocapture`
    → 1 passed(18/18一致、削減率2.64%)。
  - `cargo test -p engine --test ffo_bench --release -- --nocapture`(2回実行)
    → いずれも1 passed(#40-44全問正解、ノード数完全一致)。

  ### 判断に迷った点
  - ETC有効/無効の切り替え口を`SearchCtx`の非公開フィールド
    (`enable_etc`)として実装し、公開API(`search`/`search_with_eval`/
    `search_all_moves`/`search_all_moves_with_eval`)のシグネチャは一切
    変更していない(MPCのようなcargo featureフラグは使わず、常に本番では
    ETC有効固定とした。ETCは正しく実装されていれば探索結果を変えない
    安全な枝刈りであり、MPCと違って本番で無効化する理由が無いため、
    フィーチャフラグで切り替え可能にする必要はないと判断した)。テストは
    同一モジュール内の非公開の`search_with_eval_inner`を直接呼び出す
    ことで`enable_etc: false`を指定している。

  ### スコープ外として対応していないこと(仕様どおり)
  - 終盤パリティベース着手順序付け(T052想定)は未対応。
  - MPC(T048)の見直し・再調整、ETCとMPCの相互作用検証は未対応
    (既定オフのまま)。
  - パターン評価関数自体の変更は無し。
  - WASM/フロントエンドへのデプロイ・Playwright確認はタスク仕様どおり
    受け入れ基準に含めていない(engineクレートのみの変更)。
