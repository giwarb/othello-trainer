/**
 * ホーム画面のモードカードに表示する進捗の実績行(T137要件4)の文言を組み立てる
 * 純粋関数群。
 *
 * データの取得(IndexedDB/localStorageの読み込み)自体は`app.tsx`側の
 * `useEffect`が行う(既存の各モードが持つ集計ロジックの再利用のみで、新規の
 * スキーマは追加しない):
 * - 定石: `joseki/dueLines.ts`の`computeDueLines`(T131で導入済み)。
 * - 中盤練習: `midgame/stagePool.ts`の`buildMidgameStagePool` +
 *   `midgame/stageProgress.ts`の`stageStatus`(T119で導入済み)。
 * - 詰めオセロ: `tsume/stageProgress.ts`の`stageStatus`(T117で導入済み) +
 *   `tsume/dailyPuzzle.ts`の`todaysPuzzle`(T028で導入済み)。
 *
 * 本モジュールは「集計済みの数値からどんな文字列を表示するか」だけを担当する
 * ことで、IndexedDB/localStorage/fetchへの依存なしに単体テストできるようにする
 * (`joseki/dueLines.ts`の`dueSummaryHeadline`と同じ設計方針)。
 */

/** 定石の実績行(要件4「今日の復習n本」)。 */
export function formatJosekiProgress(dueCount: number): string {
  return `今日の復習${dueCount}本`
}

/**
 * 中盤練習の実績行(要件4「クリアx/111」)。`total`は`stagePool.length`をそのまま渡す(ハードコードしない)。
 *
 * T137 redo#1軽微1: 「クリア」と数値の間のスペース有無がホーム(旧: 無し)と
 * ステージ一覧サマリ・詰め難易度カード(有り)で不統一だった。スペース有りに
 * 統一する(3箇所中2箇所が既にスペース有りだったため、そちらへ揃えた)。
 */
export function formatMidgameProgress(cleared: number, total: number): string {
  return `クリア ${cleared}/${total}`
}

/**
 * 詰めオセロの実績行(要件4「クリアx/182・今日の1問」)。
 * `todayCleared`は本日の「今日の1問」(`todaysPuzzle`が返す問題)を既にクリア済みかどうか。
 * T137 redo#1軽微1: 「クリア」表記のスペースを他画面と統一(`formatMidgameProgress`参照)。
 */
export function formatTsumeProgress(cleared: number, total: number, todayCleared: boolean): string {
  return `クリア ${cleared}/${total}・今日の1問${todayCleared ? '済み' : '未挑戦'}`
}
