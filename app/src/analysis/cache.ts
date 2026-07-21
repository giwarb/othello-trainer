/**
 * 棋譜解析結果のIndexedDBキャッシュ(T029、要件5)。
 *
 * 局面ハッシュ(`joseki/normalize.ts`の`hashBoard`、T017)をキーの一部にして、
 * 同一局面(かつ同一の探索条件)の再解析を避ける。
 *
 * DB名・バージョン番号・ストア作成ロジックは`db/appDb.ts`に一元化されている
 * (T021 reviewer指摘のmust 2対応。過去にモジュールごとに独自のバージョン番号を
 * 定義してIndexedDBが壊れた回帰バグがあったため、本ファイルは独自のバージョン
 * 定数を持たず、`db/appDb.ts`の`openAppDb`だけを使う)。
 *
 * # エンジン・評価アルゴリズムのバージョニング(T060)
 *
 * ユーザー報告: 「一度盤面評価すると、ブラウザでキャッシュする仕組みがあるようで、
 * 新しくデプロイしても結果が変わらなかったりする」。以前の`cacheKey()`は
 * `positionHash + limitTag`のみをキーにしており、エンジン・評価アルゴリズムの
 * バージョンを一切考慮していなかった。そのため評価アルゴリズムを変更して
 * デプロイしても、以前に同じ局面を解析したことがあれば古いキャッシュが
 * ヒットし続け、新しい(修正後の)評価が使われないバグがあった。
 *
 * これを解消するため、`cacheKey()`に`ANALYSIS_ENGINE_VERSION`(手動管理の
 * バージョン定数)を含める。**エンジン(`engine`クレート)・評価アルゴリズム・
 * パターン評価の重みファイル(`pattern_v2.bin`等)に影響する変更を行うたびに、
 * この定数を1つ上げること**。値を上げると`cacheKey()`が返す文字列が変わり、
 * 以前保存されたレコードとキーが一致しなくなるため、古いキャッシュは
 * 自動的に「無視」される(削除はしないが二度とヒットしない。古いレコードは
 * IndexedDB容量を消費し続けるが実害はなく、ユーザーは手動クリアボタン
 * (`AnalysisMode.tsx`の`clearAnalysisCache`呼び出し)でも一括削除できる)。
 *
 * 本バージョニングの仕組み自体の導入(キー形式に`|v${N}`を追加したこと)により、
 * このタスク以前に保存されていた(バージョンサフィックスの無い)キャッシュは
 * 形式が変わったことで自動的に無効化される。
 */

import { ANALYSIS_CACHE_STORE, openAppDb, requestToPromise } from '../db/appDb.ts'
import type { AnalyzeLimit, MoveEvalJson } from '../engine/types.ts'

/** `analysisCache`ストアの1レコード。キーは`cacheKey()`が作る文字列。 */
export interface CachedPositionAnalysis {
  readonly key: string
  readonly moves: MoveEvalJson[]
}

function defaultIndexedDb(): IDBFactory {
  return indexedDB
}

/**
 * エンジン・評価アルゴリズムのバージョン(T060)。`cacheKey()`に含まれる。
 * 評価結果に影響しうる変更(探索アルゴリズム・評価関数・パターン重みファイル
 * 等)をデプロイするたびに、このファイルの本定数を1つ上げること。上げると
 * 以前のキャッシュキーと一致しなくなり、古い解析結果は再解析される。
 *
 * T059: `engine/src/search.rs`の`static_eval`に石差の理論上限(±64、
 * centi-disc換算で±6400)へのクランプを追加した(パターン評価
 * `PatternWeights::score`の出力が学習データの薄い局面で理論上限を大きく
 * 超える異常値になっていた不具合の修正)。エンジンの評価値そのものが変わる
 * 変更のため、ユーザーのブラウザに残っている異常値入りの古いキャッシュを
 * 無効化する必要があり、バージョンを1つ上げる(1 -> 2)。
 *
 * T107ではexactポリシー再校正に合わせて2から3へ上げた。ただし棋譜解析は
 * `allMoves: true`かつ`maxNodes`なしの経路であり、node budgetを分配するquotaは
 * 適用されないため、quota変更を解析キャッシュ無効化の根拠とした説明は正確で
 * なかった(バージョン3という履歴上の値自体はそのまま維持する)。
 *
 * T122: 本番パターン重みをv2からv3へ切り替え、同一局面・同一探索条件でも
 * 評価値が変わるため、古い解析結果を無効化する(3 -> 4)。
 *
 * T139: `search_all_moves_with_eval`(候補手評価=analyzeAllが使う探索経路)
 * が呼び出し元の置換表(TT)を全合法手・全反復深化ステップを通じて使い回して
 * いたため、対称局面(初手d3/c4/f5/e6等)で先に評価した手が残したTTエントリが
 * 後続の手のMPC近似枝刈り判断に混入し、評価値が最大1石ズレることがあった
 * (T138調査で機構を特定)。T139でこの経路を呼び出し元のTTから完全に独立
 * (手ごとに専用のローカルTTを使用)させ、順序に依存しない決定的な値を返す
 * よう修正した。同一局面・同一探索条件でも返る評価値が変わりうるため、
 * 古い解析結果を無効化する(4 -> 5)。
 *
 * T147: 本番パターン重みをv3からv4(ステージ1石刻み61段、T124で導入・
 * T125のseed3をユーザー裁定により採用)へ切り替え、同一局面・同一探索条件
 * でも評価値が変わるため、古い解析結果を無効化する(5 -> 6)。
 *
 * T167: 本番パターン重みをv4からv5(Egaroucid全量25.5M局面×B3特徴×D4
 * canonical化スキーム、T163〜T165、PWV6形式。T166対局ゲートで対v4
 * +17.37石・p<0.0001の有意改善を確認したT165候補C=seed1を採用)へ
 * 切り替え、同一局面・同一探索条件でも評価値が変わるため、古い解析結果を
 * 無効化する(6 -> 7)。**このバージョンを含め、`worker.ts`の
 * `PATTERN_WEIGHTS_URL`を変更する(切り戻し含む)たびに、本定数を必ず
 * 直近の最大値+1へ繰り上げること**(往復させて過去の番号に戻さない。
 * T122申し送り事項——ファイル名を戻すだけでは古いキャッシュが残る事故に
 * つながるため、`worker.ts`側のロールバック手順コメントにも明記した)。
 *
 * T171: 本番パターン重みをv5からv6(V3+corner5x2、D1候補、T168で追加した
 * corner 2x5ブロックパターン込み46インスタンス/11クラス、PWV6形式。T169の
 * 対Edaxゲートで対v5+4.53石・95%CI[1.78,7.33]の有意改善を確認し、サイズ増
 * gzip約5.9MB→10.7MBをユーザーが了承のうえ採用裁定)へ切り替え、同一局面・
 * 同一探索条件でも評価値が変わるため、古い解析結果を無効化する(7 -> 8)。
 */
export const ANALYSIS_ENGINE_VERSION = 8

/** 探索条件をキャッシュキー用の安定したタグへ変換する。 */
export function analysisLimitTag(limit: AnalyzeLimit): string {
  const maxNodes = limit.maxNodes === undefined ? 'none' : String(limit.maxNodes)
  return `d${limit.depth}-e${limit.exactFromEmpties}-n${maxNodes}`
}

/**
 * キャッシュキーを作る。`limitTag`は探索条件(depth/exactFromEmptiesなど)を表す
 * 短い文字列で、異なる探索条件で解析した結果が混同されないようにする
 * (`analyzeGame.ts`の`LIMIT_TAG`参照)。`ANALYSIS_ENGINE_VERSION`(上記)も
 * キーに含め、評価アルゴリズムのバージョンが変わった場合に古いキャッシュが
 * 誤ってヒットしないようにする(T060)。
 */
export function cacheKey(positionHash: string, limitTag: string): string {
  return `${positionHash}|${limitTag}|v${ANALYSIS_ENGINE_VERSION}`
}

/** キャッシュ済みの解析結果(現局面の全合法手評価)を読み込む。無ければ`undefined`。 */
export async function getCachedAnalysis(
  key: string,
  factory: IDBFactory = defaultIndexedDb(),
): Promise<MoveEvalJson[] | undefined> {
  const db = await openAppDb(factory)
  try {
    const tx = db.transaction(ANALYSIS_CACHE_STORE, 'readonly')
    const store = tx.objectStore(ANALYSIS_CACHE_STORE)
    const result = await requestToPromise<CachedPositionAnalysis | undefined>(store.get(key))
    return result?.moves
  } finally {
    db.close()
  }
}

/** 解析結果(現局面の全合法手評価)をキャッシュに保存する(同じキーがあれば上書き)。 */
export async function putCachedAnalysis(
  key: string,
  moves: readonly MoveEvalJson[],
  factory: IDBFactory = defaultIndexedDb(),
): Promise<void> {
  const db = await openAppDb(factory)
  try {
    const tx = db.transaction(ANALYSIS_CACHE_STORE, 'readwrite')
    const store = tx.objectStore(ANALYSIS_CACHE_STORE)
    const record: CachedPositionAnalysis = { key, moves: [...moves] }
    await requestToPromise(store.put(record))
  } finally {
    db.close()
  }
}

/**
 * 解析結果キャッシュ(`analysisCache`ストア)を全件削除する(T060要件2)。
 * `AnalysisMode.tsx`の手動クリアボタンから呼ばれる。バージョニング
 * (`ANALYSIS_ENGINE_VERSION`)は本来デプロイのたびに古いキャッシュを自動的に
 * 無効化する仕組みだが、ユーザーが任意のタイミングで確実にクリアできる手段も
 * 用意しておく(要件2)。
 */
export async function clearAnalysisCache(factory: IDBFactory = defaultIndexedDb()): Promise<void> {
  const db = await openAppDb(factory)
  try {
    const tx = db.transaction(ANALYSIS_CACHE_STORE, 'readwrite')
    const store = tx.objectStore(ANALYSIS_CACHE_STORE)
    await requestToPromise(store.clear())
  } finally {
    db.close()
  }
}
