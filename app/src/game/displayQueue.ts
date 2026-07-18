/**
 * 対局盤面を「実際に見せる」タイミングを直列化するキュー(T134)。
 *
 * 対局の内部状態(`GameState`)はCPUの着手が確定し次第すぐに更新してよい
 * (CPUの探索自体を遅らせると強いCPUの終盤完全読みで体感が悪化するため)。
 * 一方で `<Board>` への反映は「直前に見せた変化のアニメーションが完了し、
 * さらに短い間を置いてから」行いたい(自分の返しアニメーションが終わる前に
 * 次の着手が重なって見えると、どの石がどう返ったか追えなくなるため)。
 *
 * `push`で積んだ値は、直前の値を見せてから `delayMs` 経過するまで反映されない。
 * 直前の値が無い(アイドル状態)場合は即座に反映される(=人間が自分でクリックした
 * 直後の着手は待たされない)。連続して複数回`push`されても、各反映は重ならず
 * 順番に1つずつ処理される(パス絡みでCPUの着手が連続する場合も同様)。
 *
 * タイマー関数を呼び出し側から注入できるようにしてあるのは、vitestの
 * フェイクタイマーで決定的にテストするため(実タイマーに依存すると
 * `FLIP_ANIMATION_MS + DISPLAY_GAP_MS`ぶんの実時間待ちが必要になり、
 * テストが遅く・不安定になる)。
 */
export interface DisplaySequencer<T> {
  /**
   * 新しい表示状態をキューへ積む。キューが空でアイドル中であれば即座に
   * `onApply`が呼ばれる。そうでなければ、直前に反映した値から`delayMs`
   * 経過するまで待ってから反映される。
   */
  push(value: T): void
  /**
   * キュー・保留中のタイマーをすべて破棄し、`value`を待ちなしで即座に反映する
   * (新規対局開始など、これまでの表示状態を引き継ぐ必要がない場合に使う)。
   */
  reset(value: T): void
}

type TimerHandle = ReturnType<typeof setTimeout>

/**
 * `createDisplaySequencer`の依存注入用タイマー関数の型。
 * `window.setTimeout`/`window.clearTimeout`をそのまま渡せる。
 */
export interface SequencerTimers {
  setTimeout: (callback: () => void, ms: number) => TimerHandle
  clearTimeout: (handle: TimerHandle) => void
}

const defaultTimers: SequencerTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
}

/**
 * `DisplaySequencer`を作る。
 *
 * @param onApply 値を実際に表示すべきタイミングで呼ばれるコールバック
 *   (通常はstate setter、例: `setDisplayGame`)。
 * @param delayMs 1回の反映から次の反映が許可されるまでの最小間隔(ms)。
 *   呼び出し側が`FLIP_ANIMATION_MS + 間`をまとめて渡す想定。
 * @param timers タイマー関数の注入(省略時は`setTimeout`/`clearTimeout`をそのまま使う)。
 */
export function createDisplaySequencer<T>(
  onApply: (value: T) => void,
  delayMs: number,
  timers: SequencerTimers = defaultTimers,
): DisplaySequencer<T> {
  const queue: T[] = []
  let cooldownTimer: TimerHandle | null = null

  function popAndApply(): void {
    const next = queue.shift()
    if (next === undefined) return

    onApply(next)
    cooldownTimer = timers.setTimeout(() => {
      cooldownTimer = null
      popAndApply()
    }, delayMs)
  }

  return {
    push(value: T) {
      queue.push(value)
      if (cooldownTimer === null) popAndApply()
    },
    reset(value: T) {
      queue.length = 0
      if (cooldownTimer !== null) {
        timers.clearTimeout(cooldownTimer)
        cooldownTimer = null
      }
      onApply(value)
    },
  }
}
