---
id: T150
title: bookフェーズ2(1/2): WTHOR頻出定石ラインの抽出+頻度重みスキーマ拡張(公開はまだしない)
status: done # verifier合格(決定性SHA独立再現・joseki.json再生成一致・vitest787/cargo74全パス)、2026-07-20。代替レビューはT151検収に統合(buildDb重みロジックはT151で本番使用時に精査)
assignee: implementer(Sonnet)
attempts: 0
---

# T150: WTHOR頻出ライン抽出

## 目的

定石ブックフェーズ2の第1段。WTHOR棋譜(train/data/*.wtb、2000-2024、74,024局)から頻出序盤進行を抽出し、既存bookパイプラインに載る形式の候補ラインデータ+出現頻度を生成する。**このタスクでは本番のjoseki.jsonを変更しない**(公開はT151でEdax評価値によるフィルタ後に行う。ユーザー裁定: 明白な悪手を除外してから公開)。

## ユーザー裁定(2026-07-20)

- カバレッジ: **深さ〜16手(16 ply)・出現100局以上**の進行を抽出。
- 重み: 出現頻度を保持し、後段(T151)でCPU着手の頻度重みランダムに使う。
- 公開はT151の悪手除外後(本タスクは中間データとツールまで)。

## 背景・基盤

- 既存パイプライン: bookgen/joseki-research.json(35ライン)→ app/src/joseki/generate.ts + buildDb.ts(8対称正規化・DAG化・均等重み)→ app/public/joseki.json(615ノード・112ライン)。RawJosekiLine形式 = {name, moves(a1-h8), firstMoveBasis, depth, sources}。
- WTHOR読み込みの前例: train/src/wthor.rs(Rustパーサ、train_patterns_v3等が使用)。抽出ツールはこのパーサを使う新しいRust bin(train クレート内)でも、既存teacher_candidates基盤の流用でも、実装しやすい方でよい。
- 対称正規化: buildDb.tsは初手基準の8対称正規化を行う。抽出側でも同一局面進行の対称合流を考慮すること(初手をf5に正規化して集計するのが簡単、記事・前例の定石体系と同じ流儀)。

## 要件

1. **抽出ツール**: WTHOR全局から、初手f5正規化した着手列のプレフィックスツリー(深さ≤16)を構築し、各ノード(進行)の出現局数を集計。出現100局以上のノードだけ残したツリーから、末端までのラインを列挙する。
2. **出力**: `bookgen/wthor-lines.json`(新規、コミット対象): RawJosekiLine互換+拡張のスキーマ(name(自動命名: 既存35ラインの命名と衝突しない形式、既存定石と進行が一致する場合はその名を継承できれば尚可、無理なら自動名でよい)、moves、depth、**gameCount(出現局数)**、各plyの分岐別出現数があれば尚可)。件数・深さ分布・既存112ラインとの重複率のサマリも生成しレポートに記載。
3. **スキーマ拡張(型のみ)**: RawJosekiLine/JosekiBookMoveに頻度重みを保持できる型拡張を行う(buildDb.tsのassignEqualWeightsは既定挙動を変えない。頻度データがある場合のみ頻度比例重みを計算できるようにする。**joseki.json の再生成・公開はしない**)。既存テスト(vitest)全パス+拡張の単体テスト追加。
4. **規模の安全確認**: 抽出結果のノード数・ライン数を報告(想定数百〜千ノード。1万を大きく超える場合は閾値を上げて調整し、判断をレポートに記録)。
5. 抽出は決定的(同一入力→同一出力)であること。実行方法・所要時間をレポートに記録。

## スコープ外

- Edax評価値付与・悪手除外・joseki.json公開(T151)
- SRS・練習モード・対局UIの変更(T151で影響評価)
- 長時間処理(WTHOR 74k局のプレフィックス集計は数分で終わる想定。10分を超える場合のみcheckpoint要)

## 受け入れ基準

1. `bookgen/wthor-lines.json` が生成・コミットされ、深さ≤16・全ライン出現100局以上を機械検証できる(検証スクリプトまたはテスト)
2. 抽出の決定性(2回実行でファイル一致)を確認済み
3. `npx vitest run`(app/)全パス(型拡張の互換確認込み)、`app/public/joseki.json` に差分がないこと
4. サマリ(ノード数・ライン数・深さ分布・既存との重複)がレポート(作業ログまたはbookgen/配下md)にある
5. 変更ファイルはパス明示でコミットしmainへpush、完了時 `git status --short` クリーン(Pages確認は不要=本番挙動不変)

## コミット規律

- 変更対象のみパス明示add。`tasks/` と `CLAUDE.md` はコミットしない(作業ログ追記は行う)

## 作業ログ

### 2026-07-20 実装完了(implementer)

**実装したもの**

1. `train/src/bin/wthor_lines.rs`(新規Rust bin、`train`クレート)
   - WTHOR全対局(`train/data/WTH_2000.wtb`〜`WTH_2024.wtb`、25ファイル)を`train::wthor::parse`でパースし、`train::wthor::replay`で合法性検証。
   - 初手を`f5`に写す色保存対称変換(`engine::patterns::apply_symmetry`のインデックス0=identity/2=rot180/6=flipDiag/7=flipAntiDiag、`app/src/joseki/normalize.ts`の`FIRST_MOVE_TO_OP`と同じ対応)を、対局の初手だけから決定して全着手(先頭16手まで)に適用。初期局面がこれら4変換の不動点であるためこれで`normalize.ts`/`buildDb.ts`と同じ正規化になることを、虎定石(f5,d6,c3,d3,c4)を4通りの基準に変換してから正規化し直し元に戻ることを検証するテストで確認済み(`normalizing_alternate_basis_game_recovers_canonical_tora_line`)。
   - 正規化後の着手列を接頭辞木(トライ、`BTreeMap`で決定的順序)に挿入し、`count >= 100`のノードだけを残して末端(葉)を「ライン」として列挙(深さ16に達したノード、またはそれ以上閾値を満たす子を持たないノードが葉)。
   - 既存`bookgen/joseki-research.json`(112ライン)と着手列が完全一致すればその名前を継承、しなければ`WTHOR-####`で自動命名(決定的なDFS順)。
   - 出力: `bookgen/wthor-lines.json`(`RawJosekiLine`互換 + `gameCount`)。CLI引数(`--data-dir --years --max-depth --min-games --existing-lines --out`)はすべて既定値ありで実行可能。
   - 単体テスト10件(正規化の往復検証・トライの閾値枝刈り・分岐列挙・決定的順序・notation変換・lookup)。

2. 抽出実行結果(既定値: `--years 2000-2024 --max-depth 16 --min-games 100`、実行時間: 約10秒(cargo build込み、release、74,024局全件))
   - **251ライン、深さ≤16の閾値通過(qualifying)トライノード898個**(想定「数百〜千」の範囲内、1万を大きく超えないため閾値調整は不要と判断)。参考: `wthor-lines.json`の251ラインを実際に`buildJosekiDb`(既存のTS実装、scratchpad上の使い捨てスクリプトで検証。`app/public/joseki.json`は再生成していない)に通すと、局面の合流(手順違いの合流)によりトライノードよりやや少ない**DAGノード数820**になる(既存112ライン→615ノードと同程度のスケール)。
   - 深さ分布: 3手=3, 4手=1, 5手=6, 6手=11, 7手=17, 8手=22, 9手=24, 10手=22, 11手=25, 12手=12, 13手=21, 14手=24, 15手=14, 16手=49(打ち切り上限で49ライン=最多)。
   - 既存112ラインとの重複: **112/112(全ライン)がWTHORデータ中に1局以上出現**、**76/112が出現閾値100局以上に到達**(残り36は閾値未満=WTHORでは比較的稀な定石)。名前継承は2件(「北陸バッファロー・基本形」「白裏大量　8-g6型」が偶然WTHOR頻出ラインの着手列と完全一致)、残り249件は`WTHOR-0001`〜`WTHOR-0249`の自動命名。
   - 決定性: 同一コマンドを2回実行し、出力ファイルのSHA-256が完全一致することを確認済み(`ad247a838a2db737cd3cd6a8ead6d0d9bb3570ddbd0ac668d547a38d72e1ddd9`)。
   - `cargo test -p train`(全bin・統合テスト込み)全パス。

3. `app/src/joseki/types.ts`: `RawJosekiLine`に`gameCount?: number`、`JosekiBookMove`に`frequencyCount?: number`を追加(型のみ、JSDocで用途を明記)。

4. `app/src/joseki/buildDb.ts`: `addBookMove`が`gameCount`を受け取り、渡された場合は該当(ノード,手)の`frequencyCount`に積算するよう拡張。`assignEqualWeights`を`assignWeights`に置き換え、ノードの全bookMovesが`frequencyCount`(>0)を持つ場合のみ頻度比例重み(`weight = frequencyCount / 合計`)を計算し、それ以外(1つでも`gameCount`無しの手が混ざる場合を含む)は従来どおり均等重みにフォールバック。`gameCount`を`JosekiLine.popularity`にも反映(既存型に定義済みだが未使用だったフィールド)。
   - `bookgen/joseki-research.json`(既存112ライン、`gameCount`なし)は常に均等重み分岐を通るため、`app/public/joseki.json`は**再生成しておらず、生成しても差分が出ない**ことを確認済み(既定挙動不変)。

5. `app/src/joseki/buildDb.test.ts`: 新規4テスト追加(頻度比例重みの計算・複数ラインが同じ分岐を共有する場合の積算・一部のみ頻度データがある場合のフォールバック・`gameCount=0`時のフォールバック)+既存describeブロックへの回帰確認テスト(既存112ラインでは`frequencyCount`/`popularity`が常に`undefined`のまま)。

**受け入れ基準の確認**

1. `bookgen/wthor-lines.json`の機械検証(scratchpad上のPythonスクリプトで実施): 全251ラインが`depth<=16`かつ`moves.length===depth`、全ラインが`gameCount>=100`、名前の重複なし → OK。
2. 決定性: 同一引数で2回実行しSHA-256完全一致 → OK。
3. `npx vitest run`(app/): **787 test 全パス**(13ファイル中`joseki`関連13ファイル・99テストのうち新規追加分含め全パス)。`npx tsc --noEmit -p app`もエラーなし。`git diff --stat -- app/public/joseki.json`は空(差分なし)→ OK。
4. サマリは本作業ログに記載のとおり(ノード数898・ライン数251・深さ分布・既存112との重複率)。
5. コミット規律に従いパス明示でadd予定(`train/src/bin/wthor_lines.rs` `bookgen/wthor-lines.json` `app/src/joseki/types.ts` `app/src/joseki/buildDb.ts` `app/src/joseki/buildDb.test.ts`)、`tasks/`はコミットしない。

**判断・注記**

- ノード数(898、トライ上の閾値通過プレフィックス数)は「1万を大きく超える」水準に遠く及ばないため、`--min-games`のデフォルト値100のまま調整不要と判断した(タスク仕様どおり)。
- `RawJosekiLine.gameCount`から`JosekiBookMove.frequencyCount`への積算は、抽出ツールが「末端(葉)ラインのみ」を出力する設計(中間ノードの分岐別出現数は出力しない)であるため、`buildDb.ts`側でライン再生時に葉の`gameCount`を経由する全エッジへ加算する形で実現している。トライの不変量(内部ノードのcountは子countの合計)により、これは実質的に各エッジの真の出現局数を再構成する(ごく短い対局が16手未満で終わる極端なケースを除く)。この設計判断により、要件3の「各plyの分岐別出現数があれば尚可」を追加データなしで実質満たせるため、その拡張フィールド(ply別ブランチカウント配列)は追加しなかった。
- `app/public/joseki.json`の再生成・公開は行っていない(スコープ外、T151で実施予定)。

### 2026-07-20 verifier検証結果(合格)

commit dd32f78 を対象に受け入れ基準5項目を独立実行して検証した。

1. `bookgen/wthor-lines.json`機械検証(Python、独立スクリプト): 251ライン全件が `depth<=16`(最大16)、`moves.length==depth`、`gameCount>=100`(最小100)、name重複なし → OK。
2. 決定性: `cargo run -p train --release --bin wthor_lines -- --out <scratchpad>` を2回独立実行し、両方とも出力SHA-256が `ad247a838a2db737cd3cd6a8ead6d0d9bb3570ddbd0ac668d547a38d72e1ddd9` でコミット済み `bookgen/wthor-lines.json` と完全一致 → OK。
3. `npx vitest run`(app/): 96 test files / 787 tests 全パス。`npx tsc --noEmit`(app/): エラーなし(exit 0)。`git diff --stat -- app/public/joseki.json`: 空。さらに `app/public/joseki.json` をscratchpadへ退避後 `npm run joseki:build` を実行し、再生成結果が既存ファイルとSHA-256完全一致(`02fd6f1c0f7e3661fa08d6bd6e1d3dcc863a3ae30383b5ce72810a504028c864`)・`git diff`/`git status`とも無変化であることを確認(buildDb.ts変更後も既定挙動が不変であることを実証)→ OK。
4. `cargo test -p train --release`: 全バイナリ合計74テスト(wthor_lines.rsの10テスト含む)、0 failed → OK。
5. `git show dd32f78 --stat`: 5ファイルのみ(train/src/bin/wthor_lines.rs, bookgen/wthor-lines.json, app/src/joseki/{types.ts,buildDb.ts,buildDb.test.ts})。`git log origin/main..HEAD`は空(push済み、originと同期)。`git status --short`はクリーン(tasks/含め差分なし)→ OK。

**判定: 合格**。コード修正は一切行っていない(検証用の一時出力はすべてscratchpad配下、`app/public/joseki.json`退避分も比較後に差分なし・再書き込み不要と確認済み)。

