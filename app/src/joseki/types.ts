/**
 * 定石DB(JosekiDb)関連の型定義。
 *
 * 設計書 `othello-trainer-design.md` §3(定石練習モード)のデータ構造を
 * TypeScriptで実装したもの。局面(盤面 + 手番)を8対称正規化したハッシュを
 * キーとするDAGとして定石データを保持する(手順が異なっても同じ局面に
 * 合流するケースを正しく扱うため、木ではなくDAGにしている)。
 *
 * 座標(`square`)は `app/src/game/othello.ts` と同じ規約
 * (`square = rank0 * 8 + file`, a1=0, h8=63)。`JosekiLine.moveSeq` /
 * `JosekiBookMove.move` はいずれも「初手をf5に正規化した後」の座標で
 * 格納する(`app/src/joseki/normalize.ts` 参照)。
 */

/** 定石DB内の1つの分岐候補手。 */
export interface JosekiBookMove {
  /** 正規化後の着手マス(0〜63)。 */
  readonly move: number
  /**
   * この局面から分岐する候補手の中でのこの手の重み(合計1になるよう正規化)。
   * T016のデータ(`bookgen/joseki-research.json`)には着手頻度の情報が無いため、
   * 本タスク(T017)では同一局面から分岐するbookMovesは暫定的に均等重みとする
   * (`buildDb.ts` の `buildJosekiDb` 参照)。T150でWTHOR由来の`gameCount`
   * (`RawJosekiLine.gameCount`)を持つラインが混ざる場合は、`frequencyCount`
   * を使って頻度比例の重みを計算できるようにした(`buildDb.ts` の
   * `assignWeights` 参照。`gameCount`の無い既存データでは従来どおり均等重み)。
   */
  weight: number
  /**
   * この手を打った後の評価値。T017では未計算(エンジン統合はT018以降)のため
   * 常に `null`。
   */
  eval: number | null
  /**
   * この分岐(局面からこの手へ)に対応する出現局数の合計。複数の
   * `RawJosekiLine`(いずれも`gameCount`を持つもの)がこの局面からこの手へ
   * 分岐する場合、それらの`gameCount`を合算した値になる(`buildDb.ts` の
   * `addBookMove` 参照)。`gameCount`を持たないライン(T016由来の手作業
   * データ)しかこの手を経由しない場合は`undefined`のまま
   * (頻度データが無いことを表す)。T150で追加。
   */
  frequencyCount?: number
}

/** 定石DB内の1局面(ノード)。 */
export interface JosekiNode {
  /** この局面から定石として指されうる次の一手の候補(合流時は複数)。 */
  readonly bookMoves: JosekiBookMove[]
  /**
   * 定石を外れた場合の評価値。T017ではスコープ外のため常に `null`
   * (T018以降でエンジン評価と統合する)。
   */
  nonBookEval: number | null
  /** この局面を経由する定石ライン名の配列(複数の定石が合流する場合は複数)。 */
  readonly names: string[]
  /** この局面がいずれかの定石ラインの最終局面であれば `true`。 */
  isLeaf: boolean
}

/** 定石DB内の1本の定石ライン(名前付き手順)のメタデータ。 */
export interface JosekiLine {
  /** ライン識別子。現状は `name` をそのまま用いる(全35件で一意)。 */
  readonly id: string
  readonly name: string
  readonly aliases: readonly string[]
  /** 正規化後(初手をf5に写像した後)の着手マス列。 */
  readonly moveSeq: readonly number[]
  readonly depth: number
  /** 出現頻度・人気度。T017では未設定(情報源に無いため)。 */
  readonly popularity: number | undefined
}

/**
 * 定石DB本体。
 *
 * `nodes` のキーは `normalize.ts` の `hashBoard()` が返す局面ハッシュ文字列
 * (正規化後の盤面 + 手番から一意に定まる)。
 */
export interface JosekiDb {
  readonly nodes: Map<string, JosekiNode>
  readonly lines: JosekiLine[]
}

/** `nodes` をMapの代わりにプレーンオブジェクトで表現した、JSONにそのまま保存できる形。 */
export interface SerializedJosekiDb {
  readonly nodes: Record<string, JosekiNode>
  readonly lines: JosekiLine[]
}

/** `bookgen/joseki-research.json` の `lines[]` 要素(T016の生データ)の型。 */
export interface RawJosekiLine {
  readonly name: string
  readonly aliases?: readonly string[]
  /** "a1"〜"h8" 記法の着手列。 */
  readonly moves: readonly string[]
  readonly firstMoveBasis: string
  readonly depth: number
  readonly sources?: readonly string[]
  readonly notes?: string
  /**
   * このライン(着手列)がWTHOR等の実戦棋譜データ中に出現した局数。
   * T016由来の手作業データ(`bookgen/joseki-research.json`)には出現頻度の
   * 情報が無いため常に`undefined`。T150で追加した`bookgen/wthor-lines.json`
   * (WTHOR頻出ライン抽出、公開はT151以降)ではこの値が設定される。
   * `buildDb.ts` はこの値がある場合のみ`JosekiBookMove.frequencyCount`に
   * 積算し、頻度比例の重み付けに使う(`assignWeights`参照)。
   */
  readonly gameCount?: number
}

/** `bookgen/joseki-research.json` 全体の型(本タスクで使うフィールドのみ)。 */
export interface RawJosekiFile {
  readonly lines: readonly RawJosekiLine[]
}
