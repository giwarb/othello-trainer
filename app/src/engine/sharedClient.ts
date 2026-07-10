/**
 * アプリ全体で共有する `EngineClient`(Web Worker上のWASMエンジン)の
 * 単一インスタンスを提供する(T054)。
 *
 * 従来は各モードコンポーネント(対局・定石練習・中盤練習・詰めオセロ・棋譜解析・
 * 言語化トレーニング)がそれぞれ独自に`engineRef`を持ち、マウント時に
 * `new EngineClient()`(＝新規Web Worker)を生成し、アンマウント時に
 * `terminate()`で破棄していた。新しいWorkerは`init()`(wasm-bindgen初期化)→
 * `new Engine()`→`pattern_v2.bin`(約2.7MB)のfetch+パースをゼロからやり直す
 * 必要があり、モードタブを切り替えるたびにこのコールドスタート(数百ms〜数秒)が
 * 発生して、ユーザーには「評価値が最初に表示されない」ように見えていた
 * (詳細はtasks/T054-shared-engine-worker.md参照)。
 *
 * `joseki/lookup.ts`の`loadJosekiDb`(モジュール内キャッシュ)と同様のパターンで、
 * 初回呼び出し時にのみ`EngineClient`を生成し、以降は同じインスタンスを返す。
 * 各モードは自前で`new EngineClient()`/`terminate()`を呼ぶのをやめ、
 * `getSharedEngineClient()`を呼ぶだけでよい。
 *
 * Workerの終了(`terminate()`)は、アプリ全体の破棄(タブを閉じる等)まで
 * 不要なため、通常は一度も呼ばれない。ただし将来の用途やテストのために
 * `terminateSharedEngineClient()` も提供する。
 */

import { EngineClient, type WorkerLike } from './client.ts'

let cachedClient: EngineClient | null = null

/**
 * 共有`EngineClient`を取得する。未生成であれば生成し、以降はキャッシュした
 * 同じインスタンスを返す(モードを何度切り替えても新規Workerは生成されない)。
 *
 * `createWorker`はテスト用の差し替え口(本番はグローバルの`Worker`をそのまま
 * 使う`EngineClient`のデフォルト挙動に任せる)。既にインスタンスが生成済みの
 * 場合、2回目以降の呼び出しでは無視される(生成済みのインスタンスをそのまま
 * 返す)。
 */
export function getSharedEngineClient(createWorker?: () => WorkerLike): EngineClient {
  if (!cachedClient) {
    cachedClient = createWorker ? new EngineClient(createWorker) : new EngineClient()
  }
  return cachedClient
}

/**
 * 共有インスタンスを終了し、キャッシュをクリアする。次回`getSharedEngineClient`
 * 呼び出し時に新しいインスタンスが生成される。通常のアプリ動作では呼ぶ必要は
 * ない(要件: アプリ終了時にのみ破棄すればよく、ページ全体のアンマウント以外で
 * 呼ぶ想定はない)。
 */
export function terminateSharedEngineClient(): void {
  cachedClient?.terminate()
  cachedClient = null
}

/** テスト専用: 共有インスタンスのキャッシュをリセットする(`terminate()`は呼ばない)。 */
export function resetSharedEngineClientForTest(): void {
  cachedClient = null
}
