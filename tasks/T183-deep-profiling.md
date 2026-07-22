---
id: T183
title: 本格プロファイリング — T180の「未解明67%」の解明(優先4位の繰り上げ)
status: todo
assignee: implementer
attempts: 0
---

# T183: 本格プロファイリング

## 目的

T180の内訳モデルで、探索1ノードあたり時間の**約67%が既知コンポーネント(評価・盤面操作・TT・hash)で説明できない**と判明した。ユーザー最優先の「速度ボトルネック分析」の核心はこの67%の解明にある。サンプリングプロファイラで実際の時間分布を関数レベルで取得し、対Edax 57倍差の正体を特定する。T177諮問(7/26)とT180優先2位(ordering簡略化)の判断材料。

## 方法(ワーカーが実行環境に合わせ選択、選択理由を記録)

- Windowsネイティブでのサンプリングプロファイラ候補: Intel VTune(無償版)/AMD uProf/Windows Performance Recorder(ETW)+WPA/`cargo flamegraph`(blondie/ETWバックエンド)/Very Sleepy等。**インストールが必要な場合は事前にツール名・入手元・サイズを報告し承認を得る**(外部ソフトのため)。
- インストール不要の代替: releaseビルド+debug symbols(`[profile.release] debug = true`は計測用の一時変更で、コミットしない)でETW系標準ツールを使う、または関数粒度の計測カウンタを一時挿入(T180方式の細分化: negascoutの区間別、ordered_moves内部、MoveInfo構築、再帰呼び出しオーバーヘッド等)。**プロファイル結果が取れるなら手段は問わない**。
- 対象ワークロード: T180と同じ中盤20局面バッチ(depth12、MPC off/on両方)。専有実行。

## 成果物

1. **関数/区間レベルの時間分布表**(上位20項目、inclusive/exclusive)。T180の内訳モデルとの突合(「67%」がどこに消えていたか)。
2. MPC on特有のコスト(probe再探索等)の分離。
3. **改訂版の最適化優先順位リスト**(実測に基づく。T180のリストを更新し、各候補の「実測上限」を明記)。実装はしない。
4. レポート: bench/edax-compare/t183_profiling_report.md + meta(計測手順の再現可能な記録込み)。

## スコープ外

- 最適化の実装(次タスク)・WASM側・恒久的なコード変更(計測用一時変更はgit checkoutで復元しdiffゼロ実証)

## 受け入れ基準

1. 時間分布表とT180モデルとの突合(67%の帰属先)がレポートにある
2. 改訂優先順位リストがある
3. 一時変更の完全復元(diffゼロ)実証、`cargo test -p engine`全パス
4. 完了時 `git status --short` クリーン(レポートのみパス明示コミット。`tasks/`とCLAUDE.mdはコミットしない)

## コミット規律

- 計測は専有。detached+ツール内ポーリング(ターンを終えて通知を待つの禁止)。作業ログ節目追記

## 作業ログ

### 2026-07-22 実施・完了

- 手段選定: VTune/uProf/WPA/cargo flamegraphはいずれも本機に未導入(`wpr.exe`のみ標準搭載、解析用`wpa.exe`は無し)。インストール承認待ちより先に、インストール不要な代替(`engine/src/search.rs`へのRDTSC一時計装+専用一時バイナリ`engine/src/bin/t183_profile.rs`)で十分な精度が得られるか検証したところ、区間別サイクル数・呼び出し回数まで正確に取れ、外部ツール不要と判断(結果的に一切インストールしていない)。
- T180/T182と同じ中盤20局面(depth12・exact_from_empties0)をMPC off/on両方、専有ウィンドウ(`Get-Process`で競合プロセス無しを確認)で計測。
- **最重要発見**: 未解明67%の正体は`ordered_moves`(ムーブオーダリング)で、MPC off時70.49%・MPC on時74.66%を占めることが判明。さらにその内訳を分解した結果、`ordered_moves`の`sort_by_key`(3箇所)がソートキー計算クロージャ(`apply_move`+`legal_moves`)を要素数の65.5〜78.5倍も再計算していることが主因と特定(Rust標準ライブラリの`sort_by_key`〈比較のたびにキー再計算〉と`sort_by_cached_key`〈要素ごとに1回だけ計算〉の使い分けミス)。独立した最小検証プログラム(降順配列でのsort_by_key vs sort_by_cached_key呼び出し回数比較、n=8で56回vs8回・n=16で240回vs16回)でこの仕様を確認し、実測値と整合することを確認した。
- 残差(未計測)はMPC off 4.68%・MPC on 4.37%まで縮小、探索時間の95%超を関数/区間レベルで説明できるようになった。
- 一時計装は`git checkout -- engine/src/search.rs`+`rm engine/src/bin/t183_profile.rs`で完全復元、`git status --short`空(diffゼロ)を確認。復元後`cargo test -p engine --lib`: 245 passed; 0 failed; 2 ignored(T182までと同一件数)。FFO fastは本タスクで`negascout`のみ計装・`endgame.rs`は無変更のため未再実行(影響なしと判断)。
- 改訂優先順位リスト(実装はしない、次タスクへの提言のみ): 優先1=`sort_by_key`→`sort_by_cached_key`置換(実測上限MPC off最大-56%/MPC on最大-32.6%、リスク低)。優先2=`ordered_moves`をヒープ確保無し固定長配列化(endgame.rsのMoveInfo型と同型)。優先3=`ordered_moves`が計算済みの`next_board`を`negascout`ループへ持ち越し二重apply_moveを回避。優先4(据え置き)=`static_eval`の増分評価化。
- レポート: `bench/edax-compare/t183_profiling_report.md` + `t183_profiling_report.meta.json`(生データ・手法・独立検証込み)。コミット`2ebdfbb`、push済み。
- `git status --short`: 最終的にレポート2ファイルのみコミット、`engine/src/search.rs`・一時バイナリは完全復元済みでクリーン。
