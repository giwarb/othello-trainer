/**
 * T037「任意LLM解説層」(`othello-trainer-design-verbalization.md` §9)の型定義。
 *
 * ここで定義する構造化データが、LLMへの入力の全てである(要件2〜3の核心)。
 * `buildStructuredInput.ts`はT031(評価内訳分解)・T032(モチーフ検出)・
 * T033(反証層)・比較PV(T030)の既存出力からこの型を組み立てるだけの純粋関数であり、
 * LLM自身はこの構造化データに書かれていない事実を作り出してはならない
 * (`prompt.ts`のシステムプロンプトでこの制約を明示する)。
 */

/** 1手ぶんの基本情報(悪手分析パネルの`MoveAnalysis`から必要な部分だけを抜き出したもの)。 */
export interface StructuredMoveFacts {
  readonly ply: number
  readonly side: 'black' | 'white'
  readonly playedMove: string
  readonly bestMove: string
  readonly playedDiscDiff: number
  readonly bestDiscDiff: number
  readonly lossDiscs: number
  readonly classification: string
  readonly reversal: boolean
  readonly isExact: boolean
}

/** 評価内訳分解(T031)の1項目。 */
export interface StructuredAttributionTerm {
  readonly key: string
  readonly label: string
  readonly delta: number
}

/** 評価内訳分解(T031)全体。 */
export interface StructuredAttribution {
  readonly terms: readonly StructuredAttributionTerm[]
  readonly total: number
}

/** モチーフタグ(T032)1件。 */
export interface StructuredMotifTag {
  readonly key: string
  readonly label: string
  readonly kind: 'good' | 'bad' | 'trap'
}

/** 反証層(T033)の回収点1件を文章化したもの。 */
export interface StructuredRefutationPoint {
  readonly stepIndex: number
  readonly move: string
  readonly description: string
}

/** 反証層(T033)全体(実際の進行/最善進行それぞれの回収点)。 */
export interface StructuredRefutation {
  readonly playedCriticalPlies: readonly StructuredRefutationPoint[]
  readonly bestCriticalPlies: readonly StructuredRefutationPoint[]
}

/** 比較PV(T030)の要約。 */
export interface StructuredComparePv {
  readonly playedContinuation: readonly string[]
  readonly bestContinuation: readonly string[]
  readonly firstDivergenceIndex: number | null
}

/**
 * 1手の悪手分析結果をLLMに渡すための構造化入力データ(要件2)。
 * `buildStructuredInput`が組み立てる。この型のインスタンスがそのままJSON化されて
 * プロンプトに埋め込まれる(`prompt.ts`の`buildCommentaryUserMessage`参照)。
 */
export interface StructuredCommentaryInput {
  readonly move: StructuredMoveFacts
  /** T031の評価内訳分解。取得前(ロード中)や取得失敗時は`null`。 */
  readonly attribution: StructuredAttribution | null
  /** T032で検出されたモチーフタグ(実際に打たれた手について)。 */
  readonly motifTags: readonly StructuredMotifTag[]
  /** T033の反証層。取得前や取得失敗時は`null`。 */
  readonly refutation: StructuredRefutation | null
  /** T030の比較PV。取得前や取得失敗時は`null`。 */
  readonly comparePv: StructuredComparePv | null
  /** ヒューリスティック理由表示(`whyBad.ts`)のテキスト一覧。 */
  readonly whyBadReasons: readonly string[]
}

/** 1局まとめの感想戦テキスト生成(要件5、`AnalysisMode.tsx`側)用の入力データ。 */
export interface StructuredGameSummaryInput {
  readonly totalMoves: number
  readonly blunderCount: number
  /** 悪手・疑問手・逆転悪手のみを抜粋した手の一覧(全手ではない、要件8参照)。 */
  readonly notableMoves: readonly StructuredMoveFacts[]
}
