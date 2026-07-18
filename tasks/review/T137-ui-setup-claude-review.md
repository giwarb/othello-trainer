# T137 最終レビュー(Claude Fable 5、コード品質)

- 対象: `tasks/T137-ui-setup-screens.md`(設定/一覧/ホーム磨き + T136申し送り5点)
- コミット: `0196d7e`(23ファイル、+1251/-78)
- 前提: 見た目はオーケストレーターQA済みのため、集計の正確性・障害分離・a11y・トークン集約・テスト品質に集中。
- レビュー時検証: `npx vitest run` → 95ファイル/754件 全パス(2026-07-18 17:41 再実行で確認)。

## 総合判定: **合格**(重大指摘なし。中3件は申し送り推奨)

---

## 重点観点への回答

### 1. 進捗集計の正確性 — 整合(問題なし)

- **中盤**: ホーム「クリアx/111」(`app.tsx`)・ステージ一覧サマリ(`midgame/PracticeMode.tsx` L1003)・グリッドセルの緑色付けは、すべて同一の `midgame/stageProgress.ts` の `stageStatus`(**全判定モード横断**、★1つ以上=`cleared`)を使っており、3表示の定義が一致している。★表示は従来どおり判定モード別(`stageStarCount`)、復習フィルタは現在モード別(`stageStatusForMode`)のまま変更なしで、一覧の「判定モードごとに★は別々に記録されます」という文言とも齟齬しない。サマリはフィルタ前の全 `stagePool` を分母にしており正しい。
- **詰め**: `Puzzle.id` 単位の `tsume/stageProgress.ts` の `stageStatus` を難易度カード(`difficultyStats.ts`)・一覧サマリ・ホームの3箇所で共通利用。`difficultyStats.ts` の空きマス数帯を「事前対応表ではなくロード済みプールから実測」とした判断は、生成がパーセンタイル分割である事実と合致しており妥当(0件難易度の `null` 処理・levels順序保証もテスト済み)。
- `todaysPuzzle` は空プールで `RangeError` を投げるが、`app.tsx` 側の try/catch 内なので実績行が出ないだけでホームは壊れない。

### 2. ホーム進捗行の障害分離 — 良好(設計どおり)

- `app.tsx` の `useEffect` 内で3モードを**独立の即時実行async関数**に分け、各関数内で全await(IndexedDB `getAllSrsStates`・fetch・`localStorage` 読み)を try/catch。1系統の失敗はその行の非表示+`console.error` のみで、他モード・ホーム描画に波及しない。
- ホームは同期で即描画され、進捗は取得完了後に `setModeProgress` で追記(`progress` 未定義中は行自体を描画しない)。IndexedDB読みでカード描画はブロックされない。`cancelled` ガードでアンマウント後 setState も防止。
- `loadJosekiDb` を2つのasync関数から同時に呼ぶが、両ローダーとも**promise を同期的にキャッシュ**する実装(`lookup.ts`/`loadPuzzles.ts`)のため二重fetchは発生しない。失敗時はキャッシュを破棄し次回再試行できる点も確認。

### 3. チップ化のアクセシビリティ — 概ね維持、フォーカス可視化のみ後退(中1)

- ネイティブ `<input type="radio">` + `name` グループ + `fieldset`/`legend` を維持したままlabelをチップ化する方式のため、radiogroup相当のセマンティクス・checked状態・矢印キーでの選択移動・label クリックはすべてネイティブのまま保たれている(既存の `querySelector('input[name=...]')` 系テストも無改変で通る)。`--active` クラスは checked に同期して再レンダーされるので選択状態の視覚表現も正しい。
- ただし下記【中1】のとおり、**フォーカスリングが不可視**になった。

### 4. トークン集約の完全性 — 完全

- `calc(100dvh - 40px)` → `var(--app-header-height)`: **8箇所すべて置換済み**(AnalysisMode.css×1、app.css×1、joseki/PracticeMode.css×2、midgame/PracticeMode.css×2、tsume/PlayMode.css×2)。`- 40px` の残存はリポジトリ全体で `index.css` のコメント内1件のみ(経緯説明であり問題なし)。
- `--board-label-band` 1.35em→1.35rem: 消費側3箇所(Board.css のgridトラック、MoveEvalOverlay.css / BoardOverlay.css の `inset`)は全て `var()` 参照のため値変更のみで完結。ハードコードの `1.35em` は残存ゼロ。フレームの祖先に font-size 指定が無い現状ではrem化は視覚同値で、T136指摘(別要素で2回解決される罠)は正しく解消されている。

### 5. 既存テスト更新の妥当性 — 問題なし

- `patternStats.test.tsx` は空状態文言の追従のみ(2箇所)。「リセット後に空状態へ戻り、storageが `{}` になる」という元の検証意図は完全に維持されており、むしろ新文言の直接アサートで空状態UIの検証が具体化している。default judgeMode の検証が `settingsUx.test.tsx` に移った点も作業ログどおり。
- 新規テストは実装(実 localStorage・fake-indexeddb・実集計ロジック・実 `buildMidgameStagePool`)をモックせず通す統合寄りの構成で、進捗集計の end-to-end(記録→表示文言)を固定できており品質が高い。`todaysPuzzle` で実際に選ばれるIDを使い日付依存を排除している点も丁寧。

---

## 指摘事項

### 重大(ブロッカー): なし

### 中

1. **チップのキーボードフォーカスが不可視**(`midgame/PracticeMode.css`)
   radioを `.sr-only`(1×1にクリップ)で隠したため、フォーカスリングは不可視のinput側に描かれる。グローバルの `button:focus-visible`(index.css L215)は `<label>` には効かず、`.midgame-settings__option` に `:focus-within` / `:has(input:focus-visible)` のスタイルが無い。旧UI(素のradio)には既定リングがあったので後退。矢印キーは選択も動かすため `--active` が追従して実害は緩和されるが、Tabでグループに入った瞬間の位置が見えない。
   → 修正案: `.midgame-settings__option:has(input:focus-visible) { outline: 2px solid var(--color-accent); outline-offset: 2px; }`(1ルール)。

2. **ホーム実績行がセッション内で更新されない**(`app.tsx`)
   進捗取得effectが deps `[]` でAppマウント時1回のみ。詰め・中盤をクリアしてホームへ戻っても「クリア0/182」等が古いまま(リロードまで)。「進捗の見える化」という機能目的に対して目に見える不整合。
   → 修正案: `mode === null` に戻ったタイミングで再取得(depsに `mode` を入れ null 時のみ実行。ローダーはキャッシュ済みなので再fetchコストはlocalStorage/IndexedDB読みのみ)。

3. **PlayerBadge の aria-label が role=generic の div に付与**(`components/PlayerBadge.tsx`、T136申し送り5対応分)
   ARIA 1.2 では `generic` ロールへの naming(aria-label)は prohibited で、主要スクリーンリーダーでは無視されうる。「SR向けテキスト削除の代替」という追加要件5の意図が実環境で達成されない可能性がある(テストは属性の存在のみ検証しており、この点を検出できない)。可視テキスト(名前・石数)自体は引き続き読めるため実害は限定的。
   → 修正案: `role="group"` を付与するか、`.sr-only` スパン方式(対局モードと同方式)に揃える。

### 軽微

1. 文言の空白不統一: ホーム「クリア0/111」(`modeProgress.ts`、スペース無し)vs 一覧サマリ・難易度カード「クリア 0/2」(スペース有り)。
2. ホーム表示のため起動時に必ず `joseki.json`+`puzzles.json` をfetchする(該当モードを開かなくても)。非同期・キャッシュ共有で二重fetchやUIブロックは無いが、初回表示の帯域コストとして留意。
3. `--app-header-height: 40px` は実測値で、`.app-header` 側に `height: var(--app-header-height)` の宣言が無い(コメントで注意書き済み)。トークンを正とする宣言を足せばズレの再発を構造的に防げる。
4. `computeDifficultyStats`・cleared件数が `PlayMode`/`PracticeMode` の毎レンダーで再計算される(182件×5レベル程度で実害なし。`useMemo` の余地)。

---

## 判定の根拠

進捗集計は3表示すべてで記録スキーマ(tsume=id単位/midgame=2階層+横断 `stageStatus`)と整合し、障害分離・非ブロッキングも要件どおり実装されている。テストは実データ経路を通す構成で754件全パス。中指摘3件はいずれも1〜数行で直せる磨き残しであり、機能の正しさ・データ整合性を損なうものではないため **合格**(done可)。中1〜3は次のUXタスクへの申し送りを推奨する。
