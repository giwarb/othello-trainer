---
id: T026
title: 定石練習クリア画面で「到達した具体的な終端」を明確に表示する
status: done
assignee: implementer
attempts: 0
---

# T026: 定石練習クリア画面で「到達した具体的な終端」を明確に表示する

## 目的
ユーザーが定石練習モード(T020)を実際に遊んだ際のフィードバック(2026-07-08):「定石終端に到達したなら、どの終端に到達したのかもちゃんと表示して成功としてほしい」。現在のクリア画面は、セッション中に通過したすべての`isLeaf`ノードの定石名を並べて表示するだけで、「結局どの定石を完走したのか」が分かりにくい。本タスクでは、**セッションを実際に終わらせた最終ノード(bookMovesが真に空になった終端)の定石名を主役として明確に表示**し、それ以外の途中で通過した短いラインの名前は補足情報として区別して表示する。

## 背景・コンテキスト
- 前提: T020(定石練習モード、`app/src/joseki/practiceSession.ts`・`PracticeMode.tsx`)完了・コミット済み。
- 現状の実装(`app/src/joseki/practiceSession.ts`の`advanceClearState`): セッション中に通過した**すべての**`isLeaf`ノードの`names`を1つの`Set`に蓄積し、重複除去した配列(`clearedLineNames`)として返している。どのノードが「本当にセッションを終わらせた最終ノード」なのか(=`bookMoves`が真に空になった、その1手前で通過したノードの`names`)が、他の途中経過の短いライン名(例: 縦取り・虎・猫…といった、より長いラインが通過点として経由しただけの短いライン)と区別されずに並んでいる。
- 実例(T020やり直し時の実機確認ログより): 25手セッションで33件の定石名が同時にクリア画面に表示された(虎・猫・羊・虎C・虎D・虎E・兎・馬・野兎・縦取り・野ウサギ定石(3種)・ローズ基本形・シャープローズ(2種)・フラットローズ(2種)・手塚システム・Sローズ(3種)等)。この中で「本当に到達した最終地点」がどれなのか、現在のUIでは判別できない。
- T017の`JosekiDb`の`JosekiNode`構造(`app/src/joseki/types.ts`)を確認し、`advanceClearState`が最後に処理したノード(`bookMoves`が空だったノード)の`names`を、他の`names`と区別して保持できるようにする必要がある。

## 変更対象(変更)
- `app/src/joseki/practiceSession.ts`: `advanceClearState`の返り値に、「最終ノード(セッションを終わらせたノード)の`names`」を独立したフィールドとして追加する(例: `finalNodeNames: readonly string[]`)。既存の`clearedLineNames`(通過した全`isLeaf`ノードの`names`の和集合)はそのまま維持してよい(後方互換のため、またはUIの補足表示に使うため)。
- `app/src/joseki/PracticeMode.tsx`: クリア画面のレイアウトを変更し、「到達した定石: {finalNodeNames}」を主役として大きく・明確に表示する。`finalNodeNames`が複数ある場合(1つの終端ノードに複数の定石名が合流している場合)は、その全てを表示する(「あるいは」といった補足で、複数の定石が同じ最終局面を共有していることが伝わる形が望ましい)。それ以外の途中経過で通過したライン名(`clearedLineNames`から`finalNodeNames`を除いたもの)は、「途中で経由した定石」等の見出しで、主役より控えめなスタイル(小さめのフォント・折りたたみ等、実装者判断)で表示する。
- `app/src/joseki/practiceSession.test.ts`: `finalNodeNames`が正しく設定されることを検証するテストケースを追加する。
- `app/src/joseki/PracticeMode.css`: クリア画面のスタイル調整(主役表示・補足表示の区別)。

## 要件
1. `advanceClearState`が、セッションが`ended: true`で終わる際、その最終ノード(`bookMoves`が空だったノード)の`names`を`finalNodeNames`として返す。
2. `PracticeMode.tsx`のクリア画面で、`finalNodeNames`を主役として明確に(例: 見出しレベルで大きく)表示する。「〇〇定石をクリアしました!」のような、ユーザーが「自分が何を完走したか」を一目で理解できる文言にする。
3. 途中経由した他の定石名(`clearedLineNames`から`finalNodeNames`を除いた集合)は、主役より目立たない形で「この過程で経由した定石」等として表示する(情報を消さない。ユーザーは「合流」の存在自体には価値を感じている可能性があるため、完全に消すのではなく階層化する)。
4. 1つの終端ノードに複数の定石名が合流しているケース(実データに存在するか`app/public/joseki.json`で確認すること。無ければ人工データでテストしてよい)でも、`finalNodeNames`配列としてすべて正しく表示されることを確認する。
5. レスポンシブ(375px幅)でも、主役表示・補足表示ともに崩れないこと。
6. 単体テスト: `advanceClearState`が`finalNodeNames`を正しく返すこと(単一の場合・複数合流の場合・複数のisLeafを通過してから真の終端に達する場合、を含む)を検証する。
7. 実機確認: 実際に定石練習モードで複数回クリアまで到達し(短いラインで即終わるケース・長いラインを経由するケース両方)、クリア画面で「到達した定石」が明確に区別されて表示されることを確認する。375px幅でも確認する。

## やらないこと(スコープ外)
- 定石データ自体の拡充(T025で別途対応)
- クリア画面のデザイン全体の作り直し(既存レイアウトに主役/補足の区別を追加する程度のスコープ)
- SRS記録ロジックの変更(既存どおり、通過した全`isLeaf`ノードの`names`について成功記録を行う。本タスクは表示のみの変更)

## 受け入れ基準(検証コマンド)
- [ ] `cd app && npm run typecheck` がエラー0で通る
- [ ] `cd app && npm test` で本タスクの単体テストが全件パスする(既存テストの回帰がないこと)
- [ ] `cd app && npm run build` が成功する
- [ ] 作業ログに、実機確認(短いラインでのクリア・長いラインでのクリア、両方で「到達した定石」が明確に表示されること、375px幅レスポンシブ)の結果が記載されている
- [ ] **(2026-07-08運用ルール)** 変更を`main`にコミット・push・GitHub Actionsデプロイ成功を確認し、`playwright`で本番Pages URL上での動作を確認する

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

2026-07-08 implementer:

### 実装内容
- `app/src/joseki/practiceSession.ts`: `ClearAdvanceResult`に`finalNodeNames: readonly string[]`を追加。`advanceClearState`は、`ended`が`true`(=`bookMoves`が真に空だった)の場合のみ、その終端ノードの`lookup.names`を`finalNodeNames`として返す。`ended`が`false`の場合、および`lookup`が`null`(防御的ケース)の場合は空配列。
- `app/src/joseki/practiceSession.test.ts`: `finalNodeNames`を検証するテストを追加(単一終端/複数合流終端(人工データ)/継続中は常に空/複数isLeaf通過後の真の終端では最後のノードのnamesのみが入ること、の4ケース)。既存テストにも`finalNodeNames`のassertionを追記。
- `app/src/joseki/PracticeMode.tsx`: `ClearResultInfo`に`finalNodeNames`を追加し、`advance()`で`advanceClearState`の返り値からそのまま渡すように変更。クリア画面を、`到達した定石: <strong>{finalNodeNames}</strong> をクリアしました!`という主役表示(`formatFinalNodeNames`で複数合流時は「あるいは」区切り)と、`<details>`で折りたたんだ「この過程で経由した定石(N件)」という補足表示(`clearedLineNames`から`finalNodeNames`を除いた集合、無ければ非表示)に分離した。`finalNodeNames`が空(防御的ケースのみ)の場合は`names`にフォールバックする。
- `app/src/joseki/PracticeMode.css`: `.joseki-result__final`(主役、通常時1.1rem/strongは1.3rem、375px以下では1rem/1.1remに縮小)と`.joseki-result__passed`(補足、0.8rem・折りたたみ)のスタイルを追加。

### 検証結果
- `cd app && npm run typecheck` → エラー0。
- `cd app && npm test` → 20 test files / 159 tests 全件パス(既存テストの回帰なし)。
- `cd app && npm run build` → 成功。
- 要件4(1終端に複数定石が合流するケース): 現行の`public/joseki.json`を全走査したが、`isLeaf && bookMoves.length===0 && names.length>1`のノードは0件だった(実データには現状存在しない)。タスク仕様の許容どおり、`practiceSession.test.ts`に人工データ(3つの定石名が合流した終端)のテストケースを追加して検証した。

### 実機確認(本番Pages URL、Playwrightで自動操作)
本番`joseki.json`を取得し、`buildDb.ts`/`lookup.ts`/`pickBookMove.ts`の実ロジックをNode上でオフライン再現。ブラウザの`Math.random`を`addInitScript`で常に`0`を返すようモックすることで相手(定石DB側)の着手選択を決定的にし、人間側の着手だけを事前計算してPlaywrightでクリックする方式で、以下2シナリオを実際に本番URL(https://giwarb.github.io/othello-trainer/ )上でクリアまでプレイして確認した(検証用スクリプトは使い捨てのため作業後に削除済み)。

1. **短いラインの即クリア**(黒番、5手(人間3手): f5 c3 c4): クリア画面に`到達した定石: 虎 をクリアしました!`と主役表示され、補足に`この過程で経由した定石(21件)`(折りたたみ、展開すると「虎」を除く21件が表示され重複が無いことを確認)。
2. **長いラインを経由するクリア**(黒番、25手(人間13手): f5 c5 e3 d3 e6 g3 g6 f7 e7 c8 c7 b6 b5): クリア画面に`到達した定石: Sローズ・13-g6ローテーション型 をクリアしました!`と主役表示され、補足に同じく`この過程で経由した定石(21件)`(展開して確認、「Sローズ・13-g6ローテーション型」自身は含まれず、重複除去されていることを確認)。
3. **375px幅レスポンシブ**: シナリオ1をビューポート375x700で再実行し、スクリーンショットで主役表示・補足表示ともに横はみ出しなく収まることを確認。

いずれも旧実装(修正前)で報告されていた「セッション中に通過した全`isLeaf`ノードの定石名(21〜33件)が一律に並ぶだけで、どれが本当の到達点か分からない」という問題が解消され、「本当にセッションを終わらせた最終ノードの定石名」が主役として明確に区別されて表示されることを確認した。

### デプロイ確認
- コミット `20cd855`(app: 定石練習クリア画面で到達した最終ノードを明確に表示(T026))を`main`にpush。
- GitHub Actions「Deploy to GitHub Pages」run `28902807062`が`build`→`deploy`とも成功(`gh run watch`で確認)。
- 上記の実機確認はこのデプロイ後の本番URLに対して実施。

### スコープ順守の確認
- 変更したファイルは`app/src/joseki/practiceSession.ts`・`app/src/joseki/practiceSession.test.ts`・`app/src/joseki/PracticeMode.tsx`・`app/src/joseki/PracticeMode.css`の4件のみ(コミット`20cd855`)。`app/public/joseki.json`・`app/src/joseki/db.ts`等、並行するT025/T021/T024/T023の変更には一切触れていない(`git add`は4ファイルを個別指定、`git add -A`は不使用)。

---

2026-07-08 verifier:

### 実行結果
- `cd app && npm run typecheck` → エラー0、exit code 0(`~/.cargo/bin`をPATHに追加してwasm-packが動く状態で実行)。
- `cd app && npm test` → 21 test files / 163 tests 全件パス(現在のHEAD `4e6c0a5`時点。T026分の`practiceSession.test.ts`の6ケースを含め全件パス。ファイル数・テスト数が実装者報告時の20/159と異なるのは、並行する他タスク(T023等)がその後mainに追加されたため)。
- `cd app && npm run build` → 成功(`dist/`一式生成、`inject-sw-version`まで完走)。

### コード確認
- `app/src/joseki/practiceSession.ts`の`advanceClearState`: `finalNodeNames = ended && lookup ? lookup.names : []`(69行目)。`ended`は`lookup?.bookMoves.length ?? 0 === 0`で判定しており、要件1(bookMovesが真に空だった終端ノードのnamesをfinalNodeNamesとする)と一致。テスト(`practiceSession.test.ts`)は「継続中は空配列」「複数isLeaf通過後の真の終端では最後のノードのnamesのみ」「複数合流時に全件」を個別ケースで検証しており、実装と整合している。
- `app/src/joseki/PracticeMode.tsx`: クリア画面(371〜404行目)で`resultInfo.finalNodeNames`(空ならnamesにフォールバック)を`<p class="joseki-result__final"><strong>...</strong></p>`で主役表示し、「到達した定石: {name} をクリアしました!」の文言。`finalNodeNames`を除いた`names`の差集合を`<details class="joseki-result__passed">`(summary「この過程で経由した定石(N件)」)で折りたたみ表示しており、要件2・3・4と一致。`PracticeMode.css`に`.joseki-result__final`(1.1rem/strongは1.3rem、375px以下では1rem/1.1rem)・`.joseki-result__passed`(0.8rem)のスタイルが追加されていることも確認した。

### 本番環境での実機確認(Playwright、独自に再現)
実装者のログとは独立に、以下の手順で検証した(検証用スクリプトは`app/src/joseki/*.ts`を`tsx`で直接importして本番`joseki.json`をオフラインでシミュレートし、期待される着手列を算出。ブラウザ側は`Math.random = () => 0`をモックして相手の着手選択(`pickBookMove`)を決定的にし、Playwrightで実際にクリックする方式。検証用スクリプトは確認後削除済み)。
- 本番`joseki.json`をfetchし、`buildDb.ts`/`lookup.ts`/`pickBookMove.ts`/`practiceSession.ts`をそのまま用いてオフラインシミュレーションした結果、黒番で`f5 c3 c4`(人間3手)を打つと`finalNodeNames=['虎']`、`clearedLineNames`は虎を含め22件(虎以外21件)になることを事前算出。
- 本番URL(https://giwarb.github.io/othello-trainer/ )で実際に「定石練習」→「黒番で開始」→ canvas上の該当マス(f5→c3→c4、350msの相手着手待ちを挟む)をクリック。
  - デスクトップ幅(1280x900): クリア画面に`到達した定石: 虎 をクリアしました!`が主役表示され、`<details>`の見出しが`この過程で経由した定石(21件)`。展開すると事前算出どおり「虎」を除く21件が表示され、内容も一致することを確認。
  - 375x700(モバイル幅): 同シナリオで同じ主役/補足表示を確認。スクリーンショットを取得し目視で崩れ・はみ出しがないことを確認、`document.documentElement.scrollWidth > clientWidth`で横スクロール発生の有無をプログラム的にも確認(発生なし)。
  - `<details>`は展開前は補足内容(`<p>`)が非表示であることも確認(`isVisible()`で検証)。
- 以上により、実装者の実機確認ログ(短いラインクリアのシナリオ)を第三者として独立に再現・裏付けできた。長いライン(Sローズ・13-g6ローテーション型)シナリオは今回は再現していないが、コードロジック(`advanceClearState`・`PracticeMode.tsx`の表示ロジック)はライン長に依存しない共通処理であり、単体テストで複数isLeaf通過後の真の終端ケースも個別に検証済みのため、短いラインでの実機確認と単体テストの組み合わせで要件7を十分に裏付けられると判断した。

### デプロイ・pushの確認
- `git log`でコミット`20cd855`(app: 定石練習クリア画面で到達した最終ノードを明確に表示(T026))が存在し、`git log origin/main`にも同一コミットが含まれることを確認(push済み)。
- `gh run list`で該当コミットに対応するGitHub Actions「Deploy to GitHub Pages」run `28902807062`が`success`であることを確認。現在のHEAD(`4e6c0a5`)に対応する後続run `28903219941`も`success`。

### 判定
合格。受け入れ基準5項目すべて満たしていることを確認した。既存機能(SRS記録等)への回帰は`npm test`全件パス(163件)で裏付けられる。
