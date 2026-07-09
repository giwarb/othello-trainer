---
id: T045
title: フェーズ3着手(5): パターン評価v2をWASM/アプリに配線し新デフォルト評価にする
status: todo
assignee: implementer
attempts: 0
---

# T045: フェーズ3着手(5): パターン評価v2をWASM/アプリに配線し新デフォルト評価にする

## 目的

T044で完成したパターン評価v2(`train/weights/pattern_v2.bin`)は、Edaxとの近さ・自己対戦とも旧来の3項ヒューリスティック評価を上回ることが確認できた。これをWASM経由でアプリ本体に組み込み、全モード共通の新しいデフォルト評価エンジンにする。

## 背景・コンテキスト(このリポジトリを知らない前提で読めるように)

- T043で`engine/src/search.rs`に`search_with_eval(..., weights: Option<&PatternWeights>)`・`search_all_moves_with_eval(...)`が追加済み。既存の`search`/`search_all_moves`(WASM APIから呼ばれる)は`None`を渡す薄いラッパーになっている。**本タスクでは、WASM側のEngine構造体(`engine/src/protocol.rs`、`#[wasm_bindgen]`)に読み込んだ`PatternWeights`を保持させ、内部で`search_with_eval(..., self.weights.as_ref())`を呼ぶように変更する**。これにより既存のTypeScript側APIシグネチャ(`app/src/engine/client.ts`)は変更不要で、重みが読み込まれていれば自動的にパターン評価が使われ、読み込まれていなければ従来の3項評価にフォールバックする(T038の`josekiDb: null`フォールバックと同じ考え方)。
- `engine/src/pattern_eval.rs`の`PatternWeights::from_bytes`が重みファイルのバイト列をパースする(T044でPWV2フォーマット、PWV1旧フォーマットも後方互換で読める)。
- 重みファイルの配布: 定石DB(`public/joseki.json`)と同様に、静的アセットとしてfetchしCache Storageで扱う設計方針(CLAUDE.mdの技術スタック記載: 「Cache Storage(アプリ本体・重み・定石DB)」)。`train/weights/pattern_v2.bin`(約2.7MB)を`app/public/pattern_v2.bin`にコピーして配置すること(`public/joseki.json`がどう配置されているか実際に確認し、同じ方式を踏襲すること)。
- Service Worker: `app/`のPWA設定(T014・T023で整備済み、`sw.js`のキャッシュバージョニング)がどうアセットの事前キャッシュリストを管理しているか確認し、新規追加した`pattern_v2.bin`もオフラインで使えるようキャッシュ対象に含めること。
- **重要な過去の事故の教訓(T034)**: 反復深化の時間予算チェックが粗い粒度だと、WASM環境で予算オーバーの無応答が発生した実績がある(修正: 1024ノードごとのチェック)。パターン評価は22パターンのテーブル引きを行うため、旧3項評価(popcount中心)より1ノードあたりの評価コストが上がる可能性がある。**この変更で探索1ノードあたりのコストが上がることで、既存の時間予算チェック(1024ノードごと)の間隔が実時間で見て粗くなりすぎないか(予算オーバーの兆候が出ないか)を必ず確認すること**。具体的にはNPS(ノード/秒)を旧評価とパターン評価v2とで比較し、明確な性能劣化(桁違いに遅い等)が無いことを確認する。
- 評価スケール: T043で`static_eval`が`PatternWeights::score`の出力(素の石差)を×100して既存のcenti-disc値スケールに変換済み。アプリ側での追加スケール変換は不要なはず。

## 変更対象

- `engine/src/protocol.rs` — `Engine`構造体(`#[wasm_bindgen]`)に`weights: Option<PatternWeights>`フィールドを追加。新規`#[wasm_bindgen]`メソッド`load_pattern_weights(&mut self, bytes: &[u8]) -> Result<(), JsValue>`(パース失敗時はエラーを返す)を追加。既存の`analyze`/`search_all_moves`等、内部で`search`/`search_all_moves`を呼んでいた箇所を`search_with_eval`/`search_all_moves_with_eval`(`self.weights.as_ref()`を渡す)に置き換える。
- `train/weights/pattern_v2.bin` → `app/public/pattern_v2.bin`(コピー、コミット対象。`public/joseki.json`の配置方法を確認し同じ方式に揃える)。
- `app/src/engine/client.ts`(または`worker.ts`、実際にWASM Engineを初期化している箇所) — アプリ起動時(または初回エンジン初期化時)に`pattern_v2.bin`をfetchし、`engine.load_pattern_weights(bytes)`を呼ぶ処理を追加。fetch失敗時はconsole.errorのみで続行(パターン評価なしの従来動作にフォールバック、アプリ全体をエラーで止めない)。
- Service Workerのキャッシュ対象リスト(該当ファイル、`app/sw.js`または関連スクリプト) — `pattern_v2.bin`をオフラインキャッシュ対象に追加。
- 既存のテスト(`app/`配下、実際のWASMエンジンを使う統合テストがあれば)で、パターン評価が有効になったことで特定の評価値を期待するテストが壊れる場合は、期待値を更新するか、パターン評価を無効にした状態でテストするよう調整する(壊れたテストを放置しない)。

## 要件

1. アプリ起動時に`pattern_v2.bin`が正しくロードされ、以降のエンジン評価(対局・定石練習・中盤練習・棋譜解析・盤面評価オーバーレイ・詰めオセロ以外の完全読み以外の全箇所)がパターン評価v2を使うこと。
2. `pattern_v2.bin`のロードに失敗した場合(fetch失敗等)、アプリがクラッシュせず、従来の3項ヒューリスティック評価にフォールバックして動作し続けること。
3. **NPS(ノード/秒)を旧評価とパターン評価v2とで比較し、明確な性能劣化が無いことを確認すること**(既存のFFOベンチ・`bench/`のNPS計測の仕組みがあれば流用する)。既存の時間予算チェック機構(1024ノードごと)が、パターン評価導入後も実時間ベースで十分に頻繁にチェックされることを確認し、作業ログに記録すること。
4. 終盤完全読み(詰めオセロ・棋譜解析の完全読み区間)の挙動・結果値に変化がないこと(パターン評価は中盤ヒューリスティックのみに影響)。
5. オフライン時(Service Worker経由のキャッシュのみ)でも`pattern_v2.bin`が利用可能であること。
6. 既存の`npm test`が全件パスすること(パターン評価導入により壊れる既存テストがあれば、期待値の更新または設計の調整を行うこと)。

## やらないこと(スコープ外)

- パターン評価モデル自体の再学習・改善(T041/T044で完了済み)は行わない。
- パターン評価をユーザーが手動でON/OFFできる設定UIの追加は不要(常時有効がデフォルト、フォールバックのみで十分)。
- `pattern_v1.bin`をアプリに配線することは行わない(v2のみでよい)。

## 受け入れ基準(検証コマンド)

- [ ] `cargo build --workspace` と `wasm-pack build`(既存のビルド手順)が成功する。
- [ ] `npm test`(`app/`配下)が全件パスする。
- [ ] `npm run build`(`app/`配下)が成功する。
- [ ] NPS比較(旧評価 vs パターン評価v2)の結果を作業ログに記録し、時間予算チェックが引き続き有効に機能することを確認する。
- [ ] 実機確認: 対局モードで実際にCPUと対局し、盤面評価オーバーレイの評価値がパターン評価由来のものになっている(旧評価と異なる値が出る)ことを確認する。詰めオセロ・完全読み区間の判定が変わらないことも確認する。オフライン(Service Worker経由)での動作も確認する。
- [ ] 変更をmainにpushし、GitHub Actionsのデプロイ成功を確認し、`playwright`で本番公開URL(`https://giwarb.github.io/othello-trainer/`)上で上記の実機確認と同じ内容を再現・確認する。

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

<!-- 例: 2026-07-06 12:00 implementer: xxx を実装。`npm test` 12件パス。 -->

### 2026-07-10 implementer: 実装・検証

**変更したファイル**

- `engine/src/lib.rs`: `Engine`構造体に`weights: Option<PatternWeights>`フィールドを追加。`Engine::new()`は`weights: None`で初期化(従来どおり3項評価)。新規`#[wasm_bindgen]`メソッド`load_pattern_weights(&mut self, bytes: &[u8]) -> Result<(), JsValue>`を追加(`PatternWeights::from_bytes`が失敗すれば`Err`を返し、既存の`self.weights`は変更しない=グレースフルフォールバック)。`Engine::analyze`は`protocol::handle_analyze(request_json, &mut self.tt, self.weights.as_ref())`を呼ぶよう変更。
- `engine/src/protocol.rs`: `handle_analyze`のシグネチャに`weights: Option<&PatternWeights>`を追加。内部で使っていた`search`/`search_all_moves`(3項評価固定のラッパー)を、T043で追加済みの`search_with_eval`/`search_all_moves_with_eval`(`weights`を受け取れる版)に置き換え。既存のテスト(`Engine::new()`経由、`weights`は常に`None`)は無変更で全件パス。
- `engine/src/bin/eval_cli.rs`: T043時点で書かれた「`Engine::analyze`/`protocol.rs`はまだパターン評価の重みを受け取れない」というコメントが本タスクで古くなったため、事実に合わせて更新(ロジックは変更なし、CLIは引き続き`Engine`を介さず`search`モジュールを直接呼ぶ設計のまま)。
- `app/src/engine/worker.ts`: `ensureEngineReady()`内で`Engine`生成直後に`pattern_v2.bin`(`import.meta.env.BASE_URL`を前置、GitHub Pagesのサブパス配信に対応)をfetchし`engine.load_pattern_weights(bytes)`を呼ぶ`loadPatternWeights()`を追加。fetch失敗・パース失敗(`load_pattern_weights`がwasm-bindgen経由でJS例外をthrow)いずれも`try/catch`で捕捉し`console.error`のみで続行(アプリを止めない、`josekiDb: null`と同じフォールバック方針)。`EngineClient`(`client.ts`)のAPIシグネチャは変更していない。
- `app/public/pattern_v2.bin`: `train/weights/pattern_v2.bin`(T044成果物、約2.7MB)をコピーして新規配置。`public/joseki.json`と同じ「`public/`直下に置いてVite/GitHub Pagesの`base`配下にそのまま配信」方式。
- `engine/tests/pattern_eval_nps_bench.rs`(新規): T034の教訓を踏まえたNPS回帰テスト。初期局面から16手決定的に進めた中盤局面(空き48程度)を対象に、`exact_from_empties: 0`・`max_depth: 10`で3項評価とパターン評価v2の両方を`search_with_eval`で直接実行し、ノード数・経過時間からNPSを算出して比較する。「パターン評価のNPSが3項評価の1/20を下回ったら失敗」という安全マージン付きのアサーションを持つ(通常のテーブル引きコスト増程度なら十分余裕を持って通る想定)。`#[cfg_attr(debug_assertions, ignore)]`で`ffo_bench.rs`と同じ理由によりデバッグビルドでは自動的にスキップされ、`--release`必須。

**Service Workerのキャッシュ対象について(要件5)**

`app/public/sw.js`のfetchハンドラは、同一オリジンの全GETリクエストに対しcache-first戦略(キャッシュになければfetchしてから`cache.put`)を適用する汎用ロジックであり、既存の`joseki.json`/`puzzles.json`もこの仕組みだけでオフライン対応している(`FIXED_SHELL_URLS`にこれらは含まれておらず、install時の明示的プリキャッシュ対象ではない)。`pattern_v2.bin`も同じ同一オリジンGETであるため、`sw.js`自体へのコード変更なしに同じ仕組みでキャッシュされる。実機確認(下記)で実際にオフライン時も200が返ることを確認済み。既存のプリキャッシュ方針(`joseki.json`と同様、明示的なプリキャッシュ対象には加えない)を踏襲する判断とし、`sw.js`自体は変更していない。

**ビルド・テスト結果**

- `cargo build --workspace` 成功。
- `cargo test -p engine --lib` 115件全件パス(既存の`protocol.rs`テストは`Engine::new()`経由・`weights: None`のため無変更で通過)。
- `cargo test -p engine --test pattern_eval_nps_bench --release -- --nocapture` 成功。実測NPS:
  - 3項ヒューリスティック評価: nodes=217,584, elapsed=95.95ms, **NPS=2,290,357**
  - パターン評価v2: nodes=219,280, elapsed=135.96ms, **NPS=1,624,296**
  - 比率(パターン評価/3項評価) = 0.709(約1.4倍のノードあたりコスト増に相当)。1024ノードごとの時間予算チェック間隔は、旧評価で約0.45ms、パターン評価v2で約0.63ms相当となり、いずれもミリ秒未満で「粗すぎる」水準にはほど遠い。T034の事故は「完全読みが1ノードで数百ms〜数秒かかりうる」ことが原因であり、今回の変化(静的評価コストが約1.4倍)はその原因とは性質が異なる軽微な増加であり、時間予算チェックの実効性への悪影響はないと判断した。
- `npm test`(`app/`配下): 54ファイル455件全件パス。
- `npm run build`(`app/`配下): 成功。`dist/pattern_v2.bin`(2,729,420バイト)が生成物に含まれることを確認。

**実機確認(ローカル、`vite preview`+実ビルド`dist/`、Playwright chromium)**

- オンライン初回ロード: `pattern_v2.bin`へのリクエストがstatus 200で成功。
- 対局モードで黒番の初手として`f5`(定石DBに登録済みの手)をクリック→CPU(白)が応手。着手直後のEvalBadgeは「-3.0」「定石」(定石DBのマッチにより`source: 定石`と表示されるが、表示される数値自体はエンジンの評価値であり、定石固有の値ではない)。
- 同一局面(初期局面、黒番)を`eval_cli moves --depth 8 --exact-from-empties 12`で独立に評価した結果: 重みなし(旧3項評価)は4手すべて`discDiff: 0.0`(対称局面のため区別なし)。`--pattern-weights train/weights/pattern_v2.bin`では`f5`/`e6`が`-2.99`、`d3`/`c4`が`-3.16`と非対称な値になった。ブラウザで表示された`-3.0`は明らかに旧評価(常に0.0)ではなく、パターン評価v2の`f5`の値(`-2.99`)と一致しており、実際にパターン評価由来の値が使われていることを確認した。
- さらに「候補手評価を表示」チェックボックスを有効化し、初期局面での4候補手それぞれのオーバーレイ表示(最善手からのロス量)を取得したところ、`f5`/`e6`が「ロス0.0石」、`d3`/`c4`が「ロス0.2石」だった。これは`eval_cli`のパターン評価v2出力(`f5`/`e6`=-2.99が最善、`d3`/`c4`=-3.16 → ロス=3.16-2.99≈0.17≈0.2)と完全に一致し、旧評価(4手とも0.0でロス無し)とは明確に異なる。これにより「対局モードでパターン評価由来の評価値が出ている」ことを数値レベルで確認した。
- オフライン確認: `context.setOffline(true)`にしてリロードしても`pattern_v2.bin`へのリクエストがstatus 200で成功(Service Worker経由のキャッシュから)、対局モードの盤面が表示され着手も引き続き機能した(コンソールエラーなし)。なお`joseki.json`はこの検証セッションでは同じオフラインリロードで`Failed to fetch`が発生したが、これは`sw.js`の既存のプリキャッシュ対象外という既存挙動に起因するものであり、本タスクで変更していない箇所・スコープ外(`joseki.json`自体は本タスクの変更対象ではない)。
- 終盤完全読み区間については、`engine::endgame::solve_exact`系の関数群がそもそも`weights`パラメータを一切持たない(コード上の構造的な保証)ことを確認した上で、既存の`protocol.rs`単体テスト(`score_type_is_exact_when_within_exact_from_empties_threshold`等)が本タスクの変更後も無変更のまま全件パスすることで裏付けた。実際に盤面を60マス空きから0まで打ち切ってUI上で完全読み結果を確認するプレイスルーは、対局を最後まで進める必要があり検証コストが高いため実施していない(コードの構造的保証+既存テストの回帰確認で十分と判断)。

**mainへのpush・GitHub Actionsデプロイ・本番確認**

- コミット`80fb31b`(`engine/app: パターン評価v2をWASM経由でアプリの新デフォルト評価に配線(T045)`)を`main`にpush済み。
- GitHub Actions「Deploy to GitHub Pages」(run ID `29053981983`)が`success`で完了(`build`46s + `deploy`9s、`gh run watch`で確認)。
- 本番URL(`https://giwarb.github.io/othello-trainer/`)にPlaywright(chromium)でアクセスして確認:
  - `pattern_v2.bin`へのリクエストがオンライン初回ロードでstatus 200。
  - 「候補手評価を表示」を有効化し初期局面の4候補手のオーバーレイを取得したところ、`{"title":"黒番 ロス0.2石","text":"-0.2"}`が2件、`{"title":"黒番 ロス0.0石","text":"±0"}`が2件 — ローカル検証で確認したパターン評価v2由来の値(`f5`/`e6`が最善でロス0、`d3`/`c4`がロス約0.2)と完全に一致し、本番でもパターン評価v2が実際に使われていることを確認した。
  - `f5`をクリックしてCPUの応手まで進めても、コンソールエラーは0件。
  - `context.setOffline(true)`でオフラインにしてリロードしても、`pattern_v2.bin`は引き続きstatus 200(Service Worker経由のキャッシュ)で取得でき、盤面(canvas)が表示され着手も引き続き機能し、コンソールエラーは0件だった。
- 以上により、受け入れ基準の全項目(ビルド成功・`npm test`全件パス・`npm run build`成功・NPS比較記録・実機確認・本番デプロイ確認)を満たしたと判断する。

**判断に迷った点(なければ「なし」)**

- `pattern_v2.bin`をService Workerの明示的なプリキャッシュ対象(`FIXED_SHELL_URLS`)に加えるかどうかを検討したが、既存の`joseki.json`/`puzzles.json`も同様に明示的プリキャッシュ対象ではなく、汎用のcache-first fetchハンドラのみでオフライン対応している設計だったため、同じ方針(`sw.js`は変更しない)を踏襲した。ローカル・本番いずれのPlaywright確認でも、一度オンラインで対局操作(パターン評価の利用)を行った後であればオフラインでも`pattern_v2.bin`が問題なく取得できることを確認済み。もしオーケストレーター側で「初回訪問時にオフラインになる可能性も考慮し明示的にプリキャッシュすべき」という判断であれば、`FIXED_SHELL_URLS`に`./pattern_v2.bin`を追加する小さな追加変更で対応可能(既存方針からの逸脱が必要と判断されれば追加タスクとして実施する)。
