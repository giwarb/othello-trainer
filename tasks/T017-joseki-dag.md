---
id: T017
title: 定石DB構造化(8対称正規化 + DAGビルド)
status: done
assignee: implementer
attempts: 0
---

# T017: 定石DB構造化(8対称正規化 + DAGビルド)

## 目的
T016で収集した定石ライン(`bookgen/joseki-research.json`、35件の名前付き手順)を、実際のアプリで使えるデータ構造(局面ハッシュをキーにしたDAG)に変換する。これにより、手順が違っても同じ局面に合流するケースを正しく扱え、また盤の回転・鏡映による同一局面も正しく同一視できる。

## 背景・コンテキスト
- 前提: T016(`bookgen/joseki-research.json`)完了・コミット済み。全35エントリの`moves`は標準記法(`a1`〜`h8`)の着手列で、いずれも初手`f5`基準(`firstMoveBasis: "f5"`)。
- 設計書 `othello-trainer-design.md` §2.6.1「データ構造」を参照:
  ```javascript
  JosekiDB {
    nodes: Map<normalizedHash64, {
      bookMoves:  [{ move, weight, eval }],
      nonBookEval: number,
      names: [josekiId],
      isLeaf: boolean
    }>,
    lines: [{ id, name, kana, moveSeq, depth, popularity }]
  }
  ```
- **8対称正規化とは**: オセロの盤面は回転(90°/180°/270°)・鏡映(縦/横/斜め2本)により、実質同じ局面が最大8通りの見た目で現れる(二面体群D4、8要素)。標準オセロの初手は `f5`/`d3`/`c4`/`e6` の4通りが対称的に等価。**実際のプレイヤーの対局(初手がf5とは限らない)を、T016で集めた「初手f5基準」の定石データと照合できるようにするため、盤面をf5基準に正規化する変換が必要**。設計書の方針: 「初手をf5に対称正規化(縦取り/横取り/斜め取りはf5系に写像し、表示時に逆変換)」。
- マス番号規約: `engine/src/bitboard.rs` の `index = rank0*8 + file`(a1=0, h8=63)。本タスクはTypeScript側(`/app`)で完結してよく、Rust側の変更は不要(定石DBはビットボード探索の一部ではなく、局面照合のためのルックアップテーブルとして使うため)。
- `app/src/game/othello.ts`(T011)の `Board { black: bigint, white: bigint }` 型・`applyMove`等をそのまま利用できる。

## 変更対象(新規作成)
- `app/src/joseki/symmetry.ts`: 8対称変換(恒等・回転3種・鏡映4種)をマス番号・盤面(bigint)に適用する関数群
- `app/src/joseki/normalize.ts`: 「初手をf5に正規化する変換」を決定し、盤面・着手列に適用するロジック
- `app/src/joseki/buildDb.ts`(または同等): `bookgen/joseki-research.json` を読み込み、DAG構造(`JosekiDb`)を構築する関数
- `app/src/joseki/types.ts`: `JosekiDb`, `JosekiNode`, `JosekiLine` 等の型定義
- `app/public/joseki.json`(または `app/src/joseki/data/` 配下): ビルド済みDAGデータ(アプリが実行時に読み込む成果物。`buildDb.ts`をNodeスクリプトとして実行して生成するか、アプリ起動時に`bookgen/joseki-research.json`相当のデータから動的構築してもよい。実装者の判断で選んでよいが、後続タスク(T018定石練習UI)が扱いやすい形にすること)
- `app/src/joseki/*.test.ts`: 単体テスト

## 要件
1. **8対称変換**: 64マスの盤面に対する8つの変換(恒等/90°回転/180°回転/270°回転/水平反転/垂直反転/主対角線反転/反対角線反転)を、マス番号(0〜63、`index=rank0*8+file`)の並べ替えとして実装する。各変換は「マス番号→マス番号」の関数(またはルックアップテーブル)として実装し、盤面(`{black: bigint, white: bigint}`)全体にビット単位で適用できるようにする。
2. **正規化変換の決定**: ある盤面(初手が打たれた後の局面)に対し、実際に打たれた初手のマスを`f5`に写像する変換を選ぶ。標準オセロの初手は`f5`/`d3`/`c4`/`e6`の4通りしかありえない(初期配置の対称性より)。この4通りそれぞれに対応する変換を用意し、初手のマスに応じて適切な変換を選択する(例: 初手が`d3`なら「時計回り90°回転」のような特定の変換がf5に写像する。実際に4通りそれぞれで検証すること)。
3. **局面ハッシュ**: 正規化後の盤面から一意なハッシュ値(例: `black`と`white`のbigintをそのまま、または文字列化したものをキーにする。Zobristハッシュのような確率的ハッシュではなく、盤面を一意に表現できるものであれば単純な方法でよい。例えば `` `${black.toString(16)}_${white.toString(16)}_${sideToMove}` `` のような文字列キー)。
4. **DAGビルド**: `bookgen/joseki-research.json` の各`lines`エントリについて、初手から順に着手を適用しながら盤面を進め、各局面を正規化してハッシュ化し、DAGのノードとして登録する:
   - 各ノードは「その局面に到達する定石内の次の一手」の候補(`bookMoves`)を持つ。複数の定石ラインが同じ局面を経由する場合、その局面のノードに複数の`bookMoves`候補が集まる(合流)。
   - `weight`(重み)について: **T016のデータには着手頻度の情報が無い**ため、同一局面から分岐する`bookMoves`は暫定的に均等重みとする(例: 2つの選択肢があれば各0.5)。この制約を`buildDb.ts`のコメントとタスクの作業ログに明記すること。
   - `names`: そのノードを経由する定石ライン名の配列(例: ある局面が「虎」からも「猫」からも経由される場合、両方を記録)。
   - `isLeaf`: そのノードがいずれかの定石ラインの最終局面である場合`true`。
   - 各ノードの`nonBookEval`(定石外の評価値)は本タスクではスコープ外(未設定 or nullでよい。T018以降でエンジン評価と統合する)。
5. 単体テストで以下を検証する:
   - 8対称変換の往復一貫性(ある変換を適用してから逆変換を適用すると元に戻ること)
   - 初期局面から4通りの初手(`f5`/`d3`/`c4`/`e6`)それぞれを打った盤面について、正規化変換を適用するとすべて「`f5`を打った場合の盤面」と完全に一致すること(これが最重要のテスト。8対称変換の実装ミスが最も起きやすい箇所)
   - `bookgen/joseki-research.json`から実際にDAGを構築し、既知の定石(例: 「虎」`f5d6c3d3c4`)について、1手目・2手目...と辿っていくと対応するノードが存在し、`bookMoves`に正しい次の一手が含まれることを確認する
   - 2つの定石ラインが同じ局面を経由する場合(データの中に実例があれば)、その局面のノードに両方の`names`が記録されることを確認する

## やらないこと(スコープ外)
- 定石練習モードのUI・ゲームロジック(T018/T019以降)
- SRS(間隔反復)の実装
- 着手頻度(weight)の正確な推定(公開データに情報が無いため均等重みとし、将来WTHOR等の高段者局データが使えるようになったら再計算する、という前提でよい)
- `nonBookEval`(定石外の評価値)の計算(エンジン統合はT018以降)
- ツリービューアUI

## 受け入れ基準(検証コマンド)
- [ ] `cd app && npm run typecheck` がエラー0で通る
- [ ] `cd app && npm test` で本タスクの単体テストが全件パスする(特に4通りの初手正規化テストが通ること)
- [ ] `cd app && npm run build` が成功する
- [ ] 構築したDAGデータ(またはビルドスクリプトの実行結果)に、T016の35ライン分のデータが反映されていることを何らかの形(テストまたはログ出力)で確認できる

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

2026-07-08 implementer: 以下を実装。

- `app/src/joseki/symmetry.ts`: D4群(8対称変換)を `(file, rank0)` 座標変換として実装。
  `transformSquare`(マス番号変換)・`transformBoard`(bigintビットボード全体への適用、
  set bit を1つずつ置換テーブルで移す実装)・`inverseOp`(逆変換)を提供。8変換全ての
  コーナーマス(a1/h1/a8/h8)の巡回を手計算し、`symmetry.test.ts` で回帰テスト化した。
- `app/src/joseki/normalize.ts`: 「初手をf5に正規化する変換」を決定するロジック。
  初期局面(d4/e5が白、e4/d5が黒)が `identity`/`rot180`/`flipDiag`/`flipAntiDiag` の
  4変換に対して色保存の不動点になることを手計算で確認し、初手ごとの対応を導出:
  `f5→identity`, `d3→flipAntiDiag`, `c4→rot180`, `e6→flipDiag`。
  `hashBoard(board, sideToMove)` は `black`/`white` を16進文字列化して連結する
  非確率的ハッシュ(衝突なし)。
- `app/src/joseki/buildDb.ts`: `bookgen/joseki-research.json` の35ラインから
  `JosekiDb`(局面ハッシュ→ノードのDAG)を構築する `buildJosekiDb`。各ノードに
  `bookMoves`(次の一手候補、合流時は複数)・`names`(経由する定石名、複数所属可)・
  `isLeaf` を記録。**weightは着手頻度データが無いため同一局面からの分岐数で均等割り
  (コード内コメントに明記)**。`serializeJosekiDb`/`deserializeJosekiDb` でMap⇔JSON変換。
- `app/src/joseki/generate.ts`: 上記を使い `app/public/joseki.json` を生成するNode
  スクリプト。`npm run joseki:build`(`node --experimental-strip-types` で直接実行、
  追加の依存パッケージなし)で実行し、実際に生成・コミット済み。
- `app/src/joseki/types.ts`: `JosekiDb`/`JosekiNode`/`JosekiLine`/`JosekiBookMove`/
  `RawJosekiLine` 等の型定義。
- テスト3ファイル(`symmetry.test.ts`/`normalize.test.ts`/`buildDb.test.ts`)、
  計26件。**最重要テスト**(`normalize.test.ts`「初期局面から4通りの初手(f5/d3/c4/e6)
  を打った盤面が正規化後すべて一致する」)を含め全件パス。`buildDb.test.ts` は実際の
  `bookgen/joseki-research.json` を読み込み、「虎」ライン(f5d6c3d3c4)を1手ずつ辿って
  `bookMoves` を検証、および f5,d6 を共有する10ライン(虎/猫/羊/虎C/虎D/虎E/兎/馬/
  野兎/縦取り)が同一ノードに `names` として合流することを確認。

副次的な変更(タスクファイル以外でスコープ外だが実装に必要だったもの):
- `app/tsconfig.app.json`: `types` に `"node"` を追加(`generate.ts`/`buildDb.test.ts`
  が `node:fs` 等を使うため。`tsc --noEmit -p tsconfig.app.json` が
  `Cannot find name 'node:fs'` で失敗するのを解消)。
- `app/package.json`: `joseki:build` スクリプトを追加。

検証結果:
- `cd app && npm run typecheck` → エラー0で通過(要 `wasm-pack` がPATH上にあること。
  このマシンでは `~/.cargo/bin` にインストール済みだがbashのPATHに含まれておらず、
  `export PATH="$USERPROFILE/.cargo/bin:$PATH"` を付けて実行した)。
- `cd app && npm test` → 7ファイル・59件全件パス(うちjosekiディレクトリ26件)。
- `cd app && npm run build` → 成功(`dist/` 出力確認)。
- `cd app && npm run joseki:build` → `35 lines -> 113 nodes -> .../app/public/joseki.json`
  とログ出力され、`app/public/joseki.json` を実際に生成・確認(合流により
  ノード数113は全ライン着手数合計よりずっと少なく、DAG構造になっていることを確認)。

`git add`/`git commit` はこのエージェント自身が実施(`app/src/joseki/`,
`app/public/joseki.json`, `app/package.json`, `app/tsconfig.app.json` を明示指定。
`tasks/`・`CLAUDE.md` 配下の他の未コミット差分には触れていない)。
