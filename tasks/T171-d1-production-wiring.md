---
id: T171
title: D1候補の本番配線 — pattern_v6として公開(ユーザー採用裁定済み)
status: todo
assignee: implementer
attempts: 0
---

# T171: D1候補の本番配線

## 目的

T169ゲートで現行v5に+4.53石(CI[+1.78,+7.33]、p=0.043)の有意改善を示したD1候補(V3+corner5x2、PWV6形式)を、**ユーザー採用裁定(2026-07-21、サイズ増gzip 10.7MB了承済み)**に基づき本番配線する。前例: T167(v5配線)。

## 対象重み

- `train/data/t168/d1/t168-d1-canonical-seed-1-earlystop.bin`(SHA-256は `bench/edax-compare/t168_training_report.meta.json` のt169Manifestが正。実測照合)
- 配置名: **pattern_v6.bin**(`train/weights/` と `app/public/` の両方。既存v2〜v5は切り戻し用に残す)

## 要件(T167と同型)

1. 重み配置+SHA一致確認。
2. WASM経由でPWV6+新形状(corner5x2込み46インスタンス)が読めてscalar有効なことのヘッドレス確認。**ゲートスクリプトの更新**: `app/scripts/test-pattern-v5-wasm.mjs` を v6用に更新(またはv6版を新設し旧版を置換)、`test-node-budget-wasm.mjs` も v6参照へ(T170でv5化した直後だが本番追従が正)。goldenの再取得は理由記録の上で行う。
3. `worker.ts` fetch先を pattern_v6.bin へ、`cache.ts` の **ANALYSIS_ENGINE_VERSION を8に繰り上げ**。切り戻しコメント維持(戻す場合は9へ)。
4. サイズ実測(raw/gzip)記録。
5. 全テストパス(app 832+/engine/train)。
6. **本番検証(標準ルール)**: push→Actionsデプロイ成功→Playwright/ブラウザ自動操作で本番URL確認(対局CPU応手・評価バー・解析動作・pattern_v6取得200・コンソールエラーなし)。
7. 強度スモーク: ネイティブとWASMで数局面の評価値一致(取り違え防止)。

## スコープ外

- 探索・プロトコル変更、量子化(バックログ)、レガシー削除

## 受け入れ基準

1. 本番Pages実機確認(要件6)の記録
2. 版数8繰り上げ・ゲートスクリプトv6化・切り戻しコメント
3. WASM経由の読込確認記録
4. 全テストパス、完了時 `git status --short` クリーン(パス明示コミット+push。`tasks/`とCLAUDE.mdはコミットしない)

## 作業ログ

### 2026-07-21 実装(implementer)

**重み配置+SHA一致確認**:
- `train/data/t168/d1/t168-d1-canonical-seed-1-earlystop.bin` を `train/weights/pattern_v6.bin` と `app/public/pattern_v6.bin` にコピー。SHA-256は3ファイルとも `e69f3b1c33432bafd388af82adde64270ec8c51acaab070bbfff4cf4caf20fc9` で一致(`bench/edax-compare/t168_training_report.meta.json` の `t169Manifest.candidate.sha256` と同一)。
- サイズ実測: raw 42,394,905 bytes(v5比+14,408,065)。gzip 10,734,249 bytes(このマシンでの実測、v5は5,865,976 bytes、報告書記載値10,734,273とはgzip実装差でわずかに異なるが同水準)。

**ヘッダー直読みによる形状確認(engine非変更)**:
- PWV6ヘッダーレイアウト(`engine/src/pattern_eval.rs`の`to_bytes_scalar_extended`)をコードリーディングのみで確認(engine/srcは無変更、読むだけ): magic(4)+version(4)+reserved(4)+num_stages(4)+stage_empty_divisor(4)+instances(4)+classes(4)+scalarFeatureCount(4)+schema_hash(32)+...
- `train/weights/pattern_v6.bin` を直接バイトパースし、instances=46/classes=11/scalarFeatureCount=2 を確認(D1=V3+corner5x2の期待どおりの形状)。

**ゲートスクリプトのv6化**:
- `app/scripts/test-pattern-v5-wasm.mjs` を削除し `app/scripts/test-pattern-v6-wasm.mjs` を新設。pattern_v6.binを参照し、マジックバイト確認に加えてヘッダー直読み(instances/classes/scalarFeatureCount = 46/11/2)の検証を追加、scalar特徴有効確認・5局面のWASM評価出力は既存を踏襲。`app/package.json` の `build` スクリプトの参照も更新。
- `app/scripts/test-node-budget-wasm.mjs`: T170でv5化した直後だが、本番追従でv6参照に更新(理由コメント追加)。本スクリプトは固定goldenを持たない自己参照的決定性チェックのため再取得不要(T170と同じ判断)。

**worker.ts / cache.ts**:
- `app/src/engine/worker.ts`: `PATTERN_WEIGHTS_URL` を `pattern_v6.bin` に変更。コメントをT171の採用根拠(T169ゲート+4.53石・95%CI[1.78,7.33]・p=0.043、サイズ増ユーザー了承)に更新。切り戻し手順コメントもv5復帰・版数9への繰り上げに更新。
- `app/src/analysis/cache.ts`: `ANALYSIS_ENGINE_VERSION` を7→8に繰り上げ、T171の切り替え理由をT167コメントの直後に追記(既存のT060〜T167コメント履歴は保持)。

**強度スモーク(要件7、ネイティブ/WASM一致)**:
- `cargo build -p engine --release --bin eval_cli` でビルドし、`eval_cli eval --depth 0 --exact-from-empties 0 --pattern-weights train/weights/pattern_v6.bin` に5局面(initial/midgame-a/midgame-b/real-game-45-52/real-game-37-44、T167と同じフィクスチャ)のOBF形式をstdin投入。
- ネイティブ結果: 0.0, -7.1, -1.29, 11.17, -4.11。WASM結果(`test-pattern-v6-wasm.mjs`実行結果): 0, -7.1, -1.29, 11.17, -4.11。**全5局面で完全一致**、重み取り違えなし。

**全テスト**:
- `npm test -- --run`(app): 832/832 pass(98ファイル)。
- `npm run build`(app): 成功(test-node-budget-wasm.mjs・test-pattern-v6-wasm.mjs両ゲート含む)。
- `cargo test -p engine`: 240 passed / 0 failed / 2 ignored(T170時点から変化なし、engine/src無変更のため当然)。
- `cargo test -p train`: 全パス(105+19+10+5+1、変更なし)。

**push→デプロイ確認**:
- コミット `a1dc56b` を `main` にpush。
- GitHub Actions: `Deploy to GitHub Pages`(run 29806862923)成功(build 1m6s + deploy 9s)。`Rust Tests`(run 29806862829)成功(engine debug + FFO fast + train、3m42s)。両方 `gh run watch --exit-status` で完了確認済み。

**本番Pages実機確認(要件6)**: `https://giwarb.github.io/othello-trainer/` に対しBrowserツール(javascript_tool経由、DOM操作+fetchで確認。computer/screenshotはこの環境で30秒タイムアウトする既知の問題のため、get_page_text/read_network_requests/javascript_toolのDOM操作で代替、T167と同じ回避方法)。
- **pattern_v6取得200**: ページ内から `fetch('.../pattern_v6.bin')` を実行し `status=200, contentLength=10771981(gzip転送量、実測値と近似), byteLength=42394905(SHA一致確認済みファイルと同一サイズ), magic=PWV6` を確認。
- **対局CPU応手・評価バー**: 「対局」→「黒番で開始」→ d3着手 → CPU(白)が応手し石数2-2→3-3に進行、「定石: 虎(他76)(2手目)」の定石認識も動作、候補手評価行(`-10 0 0 0 0`)・現在評価値バー(`+0`)が正常表示。
- **解析動作**: 「棋譜解析」→ テキスト入力 `f5d6c3d3c4f4f6` → 「解析開始」→ 「解析完了: 7手(解析時間: 10.76秒)」、ムーブリスト7手分に評価・ロス・分類(◎等)が表示され、解析パイプラインが本番環境で正常完走することを確認(全手が定石内だったため個々の評価ソースは「定石」表示だが、解析処理自体は最後まで正常動作)。
- **コンソールエラーなし**: 上記一連の操作(対局・棋譜解析)を通じて `read_console_messages(onlyErrors: true)` で確認、エラーなし。

**受け入れ基準の充足状況**: 1(本番Pages実機確認記録)✓、2(版数8繰り上げ・ゲートスクリプトv6化・切り戻しコメント)✓、3(WASM経由読込確認記録、ヘッダー直読み検証込み)✓、4(全テストパス・`git status --short`クリーン、本コミット時点でtasks/配下のみ差分)✓。
