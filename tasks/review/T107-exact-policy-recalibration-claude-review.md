# T107 exactポリシー再校正 — 最終レビュー(Claude代替、Codex上限中)

- 対象コミット: `7e9b121`(engine,app: exactポリシー再校正でquota40%→60%へ更新(T107))
- 変更ファイル: `engine/src/search.rs`・`engine/src/bin/eval_cli.rs`・`app/src/app.tsx`・`app/src/analysis/cache.ts`(4ファイル、+101/-26)
- 参照資料: `tasks/T107-exact-policy-recalibration.md`(要件・作業ログ・裁定2件)、`tasks/design/T097-endgame-solver-report.md` §5 T107節・§7
- レビュー方法: `git show 7e9b121` の全差分と周辺コード(search.rsのquota機構全経路、`estimated_min_exact_nodes`の全利用箇所、protocol.rs、app.tsx LEVELS、analysis/cache.ts・analyzeGame.ts、bench/edax-compare各ハーネス)を読解。コードの修正は行っていない。

---

## 観点1: EXACT_QUOTA_PERCENT 40→60 の影響範囲

**確認した。作業ログの主張「quotaはmax_nodes指定時のみ発火、appではstrongのみ影響」はコード上正しい。**

- quotaの初期化は `search_with_eval_inner` 内の `if max_nodes.is_some() && depth == 1`(search.rs:742-745)のみ。`max_nodes` 未指定時は `exact_quota_remaining` は0のままだが、葉のexactゲート(search.rs:1451-1454)は `ctx.max_nodes.is_none() || quota >= P75` の短絡ORで `max_nodes.is_none()` 側が真になるため、quota・P75テーブルとも一切参照されない。`search_all_moves_with_eval`(全合法手評価=解析経路)は `max_nodes: None`・`exact_quota = u64::MAX`(search.rs:1180-1195)で、同様に無関係。
- app側: `LEVELS` で `maxNodes` を持つのは `strong.cpuLimit`(160000)のみ。`weak`/`normal` は `cpuLimit` 自体を持たず、解析の `ANALYZE_LIMIT`(analyzeGame.ts:78)も `maxNodes` なし。さらに protocol.rs:214 は `allMoves && maxNodes` を明示的にエラーにするため、全合法手表示にquotaが波及する経路は構造的に存在しない。**「strongのCPU着手のみ影響」は正しい。**
- 設計§7リスク「exactへ予算を寄せすぎて中盤反復深化が浅くなる」への手当: (a) quotaはdepth=1完走後の残予算に対する上限であり、quota切れ(`AbortReason::ExactQuota`)時は中盤探索として継続する既存機構(search.rs:1497-1507)は不変。(b) 校正は本番同条件(depth=12/time1500/160k)でのoracle regretで実施され、regret悪化として間接的に浅化の害を織り込む設計。(c) `leaf_exact_quota_abort_continues_midgame_iteration_without_tt_domain_leak` がquota-abort後の反復継続(`last_completed_depth == 2`)を引き続き検証している。
- **残存リスク(指摘M-3、中)**: 校正局面は root empties 18〜23 の44局面のみ。root empties 14〜17(quota増で「exact試行に最大60%を費やして失敗し、中盤反復に回るノードが減る」影響を最も受けやすい帯。実測P75(14)=118,952 に対し quota上限≈96k なので空き14ルートではabortが相応の頻度で起きる)と、root empties 24〜28(深い葉でexactが発火する帯)は直接測定されていない。1手単位の regret では捉えたが「1局を通した強さ」への影響は未測定であり、正式ゲートはT108(対Edax 60局)に委ねられている。T107の判定を覆すものではないが、**T108の評価設計への申し送りとして明記すべき**(後述)。

## 観点2: P75テーブル更新の妥当性

**確認した。ブロッカーなし。**

- 配列は旧新とも `[u64; 25]`、空き0〜14=1(15要素)+空き15〜24=実測10要素で要素数一致。範囲外(空き25以上)は `unwrap_or(u64::MAX)` で従来どおり安全。最大値 3,300,401,823 はu64に余裕で収まり、quota計算は `saturating_mul(percent)/100`・減算は `saturating_sub` でオーバーフロー経路なし。
- 空き14→15の境界(1 → 238,263)は「0〜14は原則試行」という元設計の意図的な段差であり、旧テーブル(1 → 221,386)と同じ構造。本番予算(quota上限≈96k)では旧15=221k・新15=238kのどちらもゲートを通らないため、**この境界の実効挙動は変更前後で不変**。空き19〜24が `u64::MAX` から実測値になったことで挙動が変わりうるのはquotaが31M超(≈予算52Mノード以上)の場合のみで、現実的な予算では影響しない。
- 空き0〜14を実測値(10=7,919〜14=118,952)に置き換えず「原則試行(=1)」へ戻した判断は妥当。置き換えは「空き14以下は常に試みる」という元設計の変更であり、T107のスコープ(空き15以上の再測定)を超える。sweep(約39,600通り)で回帰テストのシナリオ消失を確認した上で戻した経緯が作業ログに透明に記録されている。
- **軽微(L-3)**: 新テーブルは単調でない(19=31,313,088 > 20=18,547,224)。各空き4局面のnearest-rank p75なのでノイズとして説明はつくが、quotaが18.5M〜31.3M の帯では「空き20は試行するが空き19は試行しない」という論理的に不自然なゲートになる。現行予算では到達しない帯であり実害なしだが、将来予算を大きく引き上げる際は running max 等での単調化を検討する価値がある(コメントにも「将来のために値を正確に保つ」とあるので、その将来時点での注意点)。

## 観点3: テスト期待値更新の正当性

**確認した。「実装に合わせて緩めただけ」の空洞化には当たらない。**

- 新しい期待値は厳密な等値アサーションのまま(`exact_leaf_attempts == 4`・`exact_aborted_by_quota == 1`・`exact_leaf_completed == 3`・`exact_children == 2`)。不等式への弱体化はされていない。
- テストの本来の目的である2点は引き続き実質検証されている:
  1. **quota-abort経路**: `exact_aborted_by_quota == 1` と `fallback_reason == Some(AbortReason::ExactQuota)` により、新quota下でも実際にquota-abortが発生するシナリオであることをピン留めし、abort後に反復が継続する(`last_completed_depth == 2`・`!static_only`・`best_move.is_some()`)ことを検証している。
  2. **TTドメイン非汚染**: ルートがExactドメインに格納されないこと(`probe(root, Exact).is_none()`)、ルート直下の子のExact格納数が実測値2に一致すること(abortした子が漏れてExactに入れば3になり検出される)を等値で検証している。
- 期待値がT103時点(4/1/3)と数値上一致するのは偶然である旨、および `exact_children`(2)が `exact_leaf_completed`(3)と1対1対応しない理由(残り1つはより深いplyでの完走)がコメントで説明されており、経緯の追跡可能性も保たれている。
- 軽微な注(指摘なし扱い): テスト内コメントは「`exact_children < exact_leaf_completed` かつ非0で確認できる」と述べるが、実際のアサーションはより強い等値(==2)。コメントの記述より実装が厳しい方向のズレなので問題なし。
- assertメッセージが "three of the four ... under the T103 PVS solver" → "at least one of the four ..." に変わったのは失敗時メッセージのみの変更で、検証強度には影響しない。

## 観点4: eval_cli の --exact-quota-percent デフォルト 40→60

**確認した。方向性は正しい(本番定数との一致が本来の姿)。比較可能性は既存の防護で概ね守られている。**

- デフォルトを持つのは `cmd_best`(eval_cli.rs:749)と `cmd_budget_regression`(同:888)の2箇所のみで、両方60へ更新済み。`solve`(生ソルバー)・`moves`(全合法手)はquota機構を経由しないため対象外で漏れなし。許可リスト(25|40|50|60|75)に60は元から含まれる。
- デフォルト依存のハーネス:
  - `endgame_bench.py` C3(`eval_cli best --max-nodes 160000 --time-ms 1500 --tt-mb 64`、quota無指定)→ 以後は60%で測定される。過去のC3結果(T098 baseline等)は40%時代の値だが、checkpointは `evalCliSha256` の provenance 不一致で再利用を拒否する設計(T107作業ログでも実際に旧checkpointが拒否され新規作成している)ため、**新旧が同一系列に混入する事故は構造的に防がれている**。
  - `vs_edax.py`(`engine_best` が `--exact-quota-percent` を渡さない)→ 以後の対局は60%。こちらも checkpoint provenance(engine/harness/weights/Edax/eval_cli)検証あり。
  - `policy_calibration.py` は明示指定(--exact-quota-percent)なので影響なし。
  - `run_node_budget_regression`(決定性チェック)は同一セッション内2回比較なのでデフォルト値によらず成立。
  - CI(.github)からeval_cliベンチを呼ぶ箇所はなし。
- **軽微(L-4、明記推奨)**: リポジトリにコミット済みの過去ベンチ成果物(`bench/edax-compare/t085_node160_primary_results.json`・`t098` baseline系・過去のvs_edax結果)はすべて quota=40% 時代の測定値であり、今後の測定値と「素の数値比較」はできない(quota変更+P75変更が乗る)。provenanceが混入は防ぐが、**人間が数値を並べて読む際の注意として、T108の計測設計メモ(またはSTATUS.mdの申し送り)に「pre-T107結果はquota40%測定」と1行残すべき**。eval_cli内のコメント・コミットメッセージには記載済みだが、ベンチ結果を読む側の導線(bench側ドキュメント/T108タスク)には未記載。

## 観点5: ANALYSIS_ENGINE_VERSION 2→3

**要否判断の結論(インクリメント実施)は安全側で受け入れ可能だが、判断の根拠がコード事実と食い違っている(指摘M-1、中)。**

- 事実関係: `analysisCache` ストアの唯一の書き込み・読み出し元は `analyzeGame.ts` で、キーは `ANALYZE_LIMIT = { depth: 18, timeMs: 1500, exactFromEmpties: 22 }`(**maxNodesなし**、タグは `d18-e22-nnone`)固定。この経路は `allMoves`(=`search_all_moves_with_eval`)であり、protocol.rs:214 が `allMoves+maxNodes` を拒否することとあわせ、**キャッシュに保存されうる解析結果にquota・P75テーブルが影響する経路は現状存在しない**。したがって厳密には今回のインクリメントは不要だった(40%時代のキャッシュ値は60%でも同一の値になる)。
- cache.ts に追記されたコメント「quota変更は同じ局面・同じlimitでもexact完全読みに回るノード配分が変わり得るため、着手・評価値が変わりうる」は、`maxNodes` 付きlimitに対してのみ真であり、実際にキャッシュされる `nnone` タグのエントリには当てはまらない。**根拠の記述が不正確**。
- ただし影響の方向は安全側(過剰無効化)であり、実害はユーザー端末での一度きりの再解析コストのみ。将来 `maxNodes` 付き解析をキャッシュする変更が入った場合にはこのバージョンが正しく効く、という保険的価値もある。**redoは不要**。次にこのファイルを触るタスクでコメントの根拠を訂正するか、STATUS.md申し送りで「v3は保守的措置(現キャッシュ経路はquota非依存)」と補足することを推奨。
- 他の永続データの漏れ: appDbの全ストアを確認した — `josekiSRS`(SRS状態)・`midgamePool`(ユーザー対局由来の局面、エンジン評価値は保存せず練習時に都度計算=maxNodesなし解析経路)・`tsumeAttempts`/`verbalizeAttempts`(成績記録)はいずれもエンジン出力のキャッシュではなく、quota変更の影響を受けない。定石DB・詰め問題プールは静的コミット資産(完全読みの正解値はquotaと無関係)。**バージョンで守るべき対象の漏れはない。**

## 観点6: その他(決定性・コメント・コミット範囲)

- **決定性: 確認した。** quota計算は整数演算のみ(`remaining * percent / 100`)で壁時計非依存。差分に新たな非決定性源はない。ワーカーはT096全60局面×2回で move/score/depth/nodes 完全一致(60/60)を確認済みで、更新後の回帰テスト内でも同一入力2回の一致をアサートしている。
- **コミット範囲: 確認した。** 4ファイルすべてタスクの変更対象(要件6)に含まれ、スコープ外の混入なし。校正スクリプト2本は先行コミット `a1c2118` で保全済み。`tasks/` は含まれていない(規律どおり)。
- **コメントの正確さ(軽微の指摘あり)**:
  - **L-1**: search.rs の `EXACT_QUOTA_PERCENT` コメント末尾「wall保険発動率は…専有ウィンドウでの最終確認を別途行う」は、ユーザー裁定(2026-07-16 16:15、wall保険基準waive)により**実施されないことが確定した手順を「行う」と書いており、コミット時点で既に陳腐化している**。次回search.rsを触るタスクで「ユーザー裁定によりwaive(参考値0/44)」へ直すべき。
  - **L-2**: 同コメントの「empties18〜23の44局面(24〜26の16局面は…未計測)」について、44+16=60はT096コーパスと整合するが、作業ログ(タスクファイル125行目)の空き分布内訳「18:2, 19:11, 20:7, 21:4, 22:10, 23:6」は合計40で44と矛盾する(同ログ98行目の「18〜22で34局面」から逆算すると23は10局面のはずで、「23:6」が誤記の可能性が高い)。regret値(1.2727×44=56、1.3636×44=60がちょうど整数)から分母44自体は正しいとみられる。コード側の問題ではないが、作業ログの記録訂正を推奨。また「未計測」はgrid実行時点の話で、最終的にoracleは57/60まで進んでいる(打ち切り済み)。
  - **M-2**: コメント・コミットメッセージが選定根拠の「生データ」として挙げる `bench/edax-compare/endgame-results/t107-policy-calibration*.json`・`t107-report.md` は、`.gitignore`(`bench/edax-compare/endgame-results/`)配下の**未追跡ローカルファイルであり、リポジトリに保全されていない**。前例のT085では同種の根拠データ(`t085_exact_quota_comparison.json` 等)を gitignore 外に置いてコミットしており、旧 `EXACT_QUOTA_PERCENT` コメントは追跡済みファイルを指していた。本番定数の選定根拠となる集計表は作業ログ(タスクファイル、オーケストレーターがコミット)に転記済みなので最低限の追跡可能性はあるが、**`t107-report.md`(集計レポート)だけでも gitignore 外へ移してコミットする(か、コメントの参照先を「タスクファイル作業ログ」主体に改める)ことを推奨**。ローカル環境が失われると生データは再現不能(oracle再計算に数時間〜)になる。

---

## 指摘まとめ

### 重大(ブロッカー)

なし。

### 中(done可・申し送り/フォローアップ推奨)

- **M-1**: `ANALYSIS_ENGINE_VERSION` 2→3 の判断根拠が不正確(現行のキャッシュ経路は `maxNodes` なし=quota非依存であり、厳密にはインクリメント不要だった)。実施自体は安全側で実害なし。cache.tsコメントの根拠訂正を次回タスクで推奨。
- **M-2**: 選定根拠の生データ(`endgame-results/t107-*.json`・`t107-report.md`)が gitignore 配下の未追跡ファイルのままで、コード内コメントがそれを参照している。T085前例(根拠データをコミット)と乖離。`t107-report.md` の保全を推奨。
- **M-3**: 校正カバレッジの限界(root empties 14〜17・24〜28は未測定、1局通しの強さへの影響は未測定)。quota増による中盤反復浅化の害はregretで間接測定+abort継続テストで防護されているが、最終確認はT108依存。**T108への申し送り: (a) E50をゲートに使わない(既裁定)、(b) pre-T107ベンチ結果はquota40%測定で素の数値比較不可、(c) 60局対Edaxで「平均石差1石以上悪化しない」基準がこの残存リスクの実質的な検収になる。**

### 軽微

- **L-1**: search.rs コメントの「wall保険…専有ウィンドウでの最終確認を別途行う」が裁定(waive)を反映しておらず陳腐化。
- **L-2**: 作業ログの44局面の空き分布内訳(合計40)の誤記。「23:6」は「23:10」の可能性が高い。
- **L-3**: P75テーブルの非単調(19 > 20)。現行予算では実害なし。将来の予算引き上げ時に単調化を検討。
- **L-4**: pre-T107のコミット済みベンチ成果物(t085/t098系)がquota40%測定である旨を、ベンチ結果を読む側の導線(T108タスク/STATUS)に1行明記すべき。

---

## 総合判定: **合格**

quota 60% への変更は、設計レポート§5の辞書式選定手順に忠実に従った校正結果(44局面 regret 1.3636→1.2727)に基づき、実装はコンパイル時定数1箇所+CLIデフォルト2箇所+保守的なキャッシュ無効化という最小限の差分に収まっている。quotaの影響範囲の分析(strong CPUのみ・max_nodes経路のみ)はコードと一致し、P75テーブル更新は境界挙動を変えず将来予算向けの精度改善として妥当、テスト更新は検証強度を保っている。重大指摘はなく、中・軽微の指摘はいずれもdoneをブロックしない(M-3のT108申し送りとM-2のレポート保全をSTATUS.mdメモに残すことを推奨)。
