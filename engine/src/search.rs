//! 中盤探索エンジン: 反復深化 + PVS(NegaScout) + 置換表(T003) + 終盤完全読み(T006)。
//!
//! # 概要
//! [`search`] / [`search_all_moves`] が既存呼び出し元向けの公開エントリポイント
//! である(常に3項ヒューリスティック評価を使う)。空きマス数が
//! [`SearchLimit::exact_from_empties`] 以下になった局面(探索木の途中で到達した
//! 局面も含む)では、評価関数を一切使わず T006 (`endgame::solve_exact`) による
//! 完全読みに切り替える。それ以外の局面は静的評価([`static_eval`])をリーフ評価
//! に使った NegaScout (PVS) で反復深化探索する。
//!
//! T043で、静的評価をT041のパターン評価(`pattern_eval::PatternWeights`)に
//! 差し替えられる [`search_with_eval`] / [`search_all_moves_with_eval`] を追加した
//! (`weights: Option<&PatternWeights>` が `Some` ならパターン評価、`None` なら
//! 従来の3項ヒューリスティック評価。`search`/`search_all_moves` はこれらの
//! `weights: None` 版の薄いラッパーであり、挙動・シグネチャとも変更していない)。
//! 終盤完全読み(`endgame::solve_exact`系)は静的評価を一切呼ばないため、
//! パターン評価の有無によらず常に同じ結果を返す。
//!
//! # スケールの規約
//! `SearchResult::score` は centi-disc 単位(1石 = 100)・手番視点。
//! `endgame::solve_exact` は素の石差(1石=1)を返すため、本モジュールから
//! 呼び出す際は必ず `* 100` して centi-disc スケールに揃える
//! (`endgame.rs` モジュール冒頭のドキュメントに明記されている変換ルール)。
//!
//! # 置換表の共有について
//! 探索(本モジュール)と終盤ソルバー(T006)は同じ `TranspositionTable` を
//! 共有する。両者は `TTEntry::depth` の意味が異なる
//! (本モジュールでは「残り探索プライ数」、終盤ソルバーでは「残り空きマス数」)
//! が、ある局面がどちらの意味で `depth` を解釈されるかは、その局面自体の
//! 空きマス数だけで一意に決まる(空きマス数 <= `exact_from_empties` の局面は
//! 常に終盤ソルバー経由でのみ探索・格納され、それ以外の局面は常に本モジュールの
//! NegaScoutでのみ探索・格納される)ため、混同は起きない。
//!
//! ただしこれは「同じ `tt` に対しては常に同じ `exact_from_empties` で
//! `search()` を呼ぶ」ことが前提になる。もし将来、同一の `tt` を使い回した
//! まま異なる `exact_from_empties` で `search()` を呼び直すと、過去に
//! 書き込まれたエントリのスケール/depth解釈が食い違い、
//! `entry.depth as u32 >= depth as u32` の判定を通過して誤ったスコアを
//! 黙って返すおそれがある。これを防ぐため、[`search`] は冒頭で
//! `tt` に記録されている前回の `exact_from_empties`
//! (`TranspositionTable::last_exact_from_empties`)と今回の値を比較し、
//! 不一致であれば探索前に `tt.clear()` を行ってからその値を更新する
//! (T007)。この安全策はデバッグ限定ではなく、リリースビルドでも常に
//! 有効な通常ロジックとして実装している。
//!
//! # パスの扱い
//! 手番側に合法手がない場合はパスして相手番で同じ深さ予算のまま再帰する
//! (パスは深さを消費しない)。両者パス(終局)の場合は、終盤ソルバーと同じ
//! 「石数が多い方が残り空きマスを総取りする」慣習で最終石差を計算し、
//! centi-discスケールに変換して返す。

#![allow(dead_code)]

use crate::bitboard::{Board, Side};
use crate::endgame::{final_score, solve_exact, solve_exact_bounded, solve_exact_with_nodes, TimeBudget};
use crate::eval::evaluate_for;
use crate::pattern_eval::PatternWeights;
use crate::tt::{Bound, TTEntry, TranspositionTable};
use crate::zobrist::zobrist_hash;
// `std::time::Instant::now()` は `wasm32-unknown-unknown` ターゲットでは
// 未実装のため実行時に panic する(コンパイルは通ってしまうため、
// ネイティブの `cargo test` だけでは検出できない)。`web-time` はAPI互換の
// ドロップイン実装で、wasm上では `Performance.now()` を、それ以外の
// ターゲットでは `std::time::Instant` をそのまま使う。
use web_time::Instant;

/// 探索を打ち切るための十分に大きな評価値。centi-discスケールでの理論上の
/// 最大絶対値(64石差 = 6400)より大きく、かつ `i32` の演算(符号反転・-1)で
/// オーバーフローしない程度に余裕を持たせた値を選ぶ。
const INF: i32 = 1_000_000;

/// 4隅 (a1, h1, a8, h8) に対応するビットマスク。
const CORNER_MASK: u64 = (1u64 << 0) | (1u64 << 7) | (1u64 << 56) | (1u64 << 63);

/// 静的評価(葉ノード評価)を計算する。`weights`が`Some`ならT043のパターン評価
/// (`PatternWeights::score`、素の石差単位)をcenti-discスケール(×100、
/// 四捨五入)に変換して使い、`None`なら従来の3項ヒューリスティック評価
/// (`eval::evaluate_for`)を使う(グレースフルフォールバック)。
///
/// 終盤完全読み(`endgame::solve_exact`系)はこの関数を一切呼び出さない
/// (完全読みは石差の全数探索でありヒューリスティック評価を使わないため)。
/// パターン評価は本関数経由でのみ中盤ヒューリスティック探索(`negascout`の
/// 葉ノード評価・反復深化が一度も完了しなかった場合のフォールバック)に
/// 使われる。
fn static_eval(board: &Board, side: Side, weights: Option<&PatternWeights>) -> i32 {
    match weights {
        Some(w) => (w.score(board, side) * 100.0).round() as i32,
        None => evaluate_for(board, side),
    }
}

/// 探索の制御パラメータ。
///
/// Workerプロトコル(設計書 §2.4)の `limit` パラメータ
/// (`depth`, `timeMs`, `exactFromEmpties`)に対応する。
#[derive(Debug, Clone)]
pub struct SearchLimit {
    /// 反復深化で到達する最大深さ(プライ数)。
    pub max_depth: u8,
    /// 探索の時間制限(ミリ秒)。`None` なら時間制限なし。
    /// 反復深化の各深さが完了するごとにチェックするだけでなく、
    /// `negascout`/`endgame::negamax`の再帰の途中でも`TIME_CHECK_NODE_INTERVAL`
    /// (1024)ノードごとに経過時間をチェックし、超過していれば探索を
    /// (完了を待たずに)打ち切る(T034)。以前は「1つの深さの探索が
    /// 完了するごと」にしかチェックしておらず、探索木の内部で無条件に
    /// 呼ばれる完全読み(`endgame::solve_exact`)が「重い」局面に当たった
    /// 際に時間予算を数十〜数百倍超過してしまう不具合があったため、
    /// より細かい粒度でのチェックに変更した。
    pub time_ms: Option<u64>,
    /// この数値以下の空きマス数になったら終盤完全読み(T006)に切り替える。
    /// 設計書の既定値は24。
    pub exact_from_empties: u8,
}

/// 探索結果。
#[derive(Debug, Clone)]
pub struct SearchResult {
    /// 最善手のマス番号(0..63)。合法手がない(パスすべき)局面の場合は `None`。
    pub best_move: Option<u8>,
    /// 評価値。centi-disc単位(1石=100)、手番視点(正なら手番側有利)。
    pub score: i32,
    /// 到達した探索深さ。終盤完全読みに切り替わった場合は空きマス数そのもの。
    pub depth: u8,
    /// 読み筋(マス番号列)。置換表から再構成した簡易的なものであり、
    /// 途中で置換表にエントリが無くなった時点で打ち切られる。
    pub pv: Vec<u8>,
    /// 探索したノード数。
    pub nodes: u64,
    /// この結果が実際にどちらの方式で得られたか。
    /// `true` なら終盤完全読み(`endgame::solve_exact`/`solve_exact_bounded`
    /// を打ち切りなく完走できた場合)、`false` なら中盤探索(NegaScout、
    /// または`solve_exact_bounded`がタイムアウトした後の静的評価
    /// フォールバック)による評価値であることを示す。
    ///
    /// [`MoveEval::is_exact`] と同じ理由(レビュー指摘、T018)により、
    /// 呼び出し側(`protocol.rs`)が `score.type`(`"exact"`/`"midgame"`)を
    /// 報告する際は、**着手前の局面の空きマス数と`exact_from_empties`の
    /// 比較だけで事前計算した値ではなく**、必ずこのフィールド(=実際に
    /// 使われた評価方式)を根拠にすること。T034で`search()`のルート分岐に
    /// 時間予算付き完全読み(`solve_exact_bounded`)を導入したことで、
    /// 「空きマス数的にはexact_from_empties以下だが、タイムアウトにより
    /// 実際には完全読みを完走できず、通常の反復深化(またはその反復すら
    /// 一度も完了せず単発の静的評価)にフォールバックした」という
    /// ケースが生まれたため、事前計算した空きマス数ベースの判定では
    /// 「exact」と誤表示されてしまう(レビュー指摘、T034フィードバック)。
    pub is_exact: bool,
}

/// [`search_all_moves`] が返す、1つの合法手についての評価値。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MoveEval {
    /// 着手先のマス番号(0..63)。
    pub mv: u8,
    /// 評価値。centi-disc単位(1石=100)、`search_all_moves` に渡した
    /// `side_to_move`(着手前の手番)から見た値。
    pub score: i32,
    /// この評価値が実際にどちらの方式で計算されたか。
    /// `true` なら終盤完全読み(`endgame::solve_exact_with_nodes`)、
    /// `false` なら中盤探索(NegaScout)による評価値であることを示す。
    ///
    /// 呼び出し側(`protocol.rs`)が `score.type`(`"exact"`/`"midgame"`)を
    /// 報告する際、**着手前の局面の空きマス数**ではなく、この
    /// フィールド(=各手について実際に使われた評価方式)を根拠にすること。
    /// 着手により空きマス数は必ず1減るため、着手前の空きマス数だけで
    /// 判定すると `exact_from_empties + 1` の境界で実態と食い違う
    /// (レビュー指摘によりT018で追加)。
    pub is_exact: bool,
}

/// 現在の局面を探索し、最善手と評価値を返す。
///
/// - 空きマス数が `limit.exact_from_empties` 以下であれば、直ちに
///   `endgame::solve_exact` による完全読みの結果を返す。
/// - それ以外は depth=1 から `limit.max_depth` まで反復深化しながら
///   NegaScout(PVS)探索を行う。各反復は `tt` を使い回す。
///
/// 静的評価には常に従来の3項ヒューリスティック評価(`eval::evaluate_for`)を
/// 使う。パターン評価(T043)を使いたい場合は [`search_with_eval`] を使うこと
/// (既存の呼び出し元・シグネチャへの影響を避けるため、本関数はそのまま
/// 変更していない)。
pub fn search(
    board: &Board,
    side_to_move: Side,
    limit: &SearchLimit,
    tt: &mut TranspositionTable,
) -> SearchResult {
    search_with_eval(board, side_to_move, limit, tt, None)
}

/// [`search`]と同じだが、`weights`が`Some`ならT043のパターン評価を中盤探索の
/// 静的評価に使う(`None`なら[`search`]と全く同じ挙動)。
pub fn search_with_eval(
    board: &Board,
    side_to_move: Side,
    limit: &SearchLimit,
    tt: &mut TranspositionTable,
    weights: Option<&PatternWeights>,
) -> SearchResult {
    // TTスケール混同防止(T007): 同じ `tt` に対して過去に異なる
    // `exact_from_empties` で探索していた場合、その古いエントリは
    // 今回とはスケール/depthの意味が食い違っている可能性があるため、
    // 安全のためTTを丸ごとクリアしてから今回の値を記録し直す。
    // (初回呼び出し `None` や、前回と同じ値の場合はクリア不要)
    if let Some(prev) = tt.last_exact_from_empties() {
        if prev != limit.exact_from_empties {
            tt.clear();
        }
    }
    tt.set_last_exact_from_empties(limit.exact_from_empties);

    let empties = board.empty_count();
    let start = Instant::now();

    if empties <= limit.exact_from_empties as u32 {
        // T034: `time_ms`が指定されていれば、`search_all_moves`/`negascout`
        // と同じ理由(完全読み自体が特定局面で時間予算を大幅に超過しうる)
        // により`solve_exact_bounded`を使う。打ち切られた(`None`)場合は
        // ここでは`return`せず、下の通常の反復深化ループにフォールバック
        // する(そちらも同じ`start`を共有しているため、既に予算を
        // 使い切っていれば`negascout`の葉判定内で即座に打ち切られ、
        // 関数末尾の静的評価フォールバックに帰着する。ハングはしない)。
        let exact = match limit.time_ms {
            Some(time_ms) => solve_exact_bounded(board, side_to_move, tt, TimeBudget { start, time_ms }),
            None => Some(solve_exact(board, side_to_move, tt)),
        };

        if let Some(raw) = exact {
            let score = raw * 100;
            let hash = zobrist_hash(board, side_to_move);
            let best_move = tt.probe(hash).and_then(|entry| entry.best_move);
            let pv = best_move.map(|mv| vec![mv]).unwrap_or_default();

            return SearchResult {
                best_move,
                score,
                depth: empties as u8,
                pv,
                nodes: 1,
                is_exact: true,
            };
        }
        // T034: `exact`が`None`(タイムアウト)だった場合はここで`return`せず
        // 下の反復深化ループへフォールバックする。以降で構築される
        // `SearchResult`はすべて`is_exact: false`(完全読みを完走できて
        // いないため)。
    }

    let mut total_nodes: u64 = 0;
    let mut last_result: Option<SearchResult> = None;

    for depth in 1..=limit.max_depth {
        let mut nodes: u64 = 0;
        let mut timed_out = false;
        let score = {
            let mut ctx = SearchCtx {
                limit,
                tt: &mut *tt,
                nodes: &mut nodes,
                start,
                timed_out: &mut timed_out,
                weights,
            };
            negascout(board, side_to_move, depth, -INF, INF, &mut ctx)
        };

        if timed_out {
            // このイテレーション(depth)は再帰の途中で時間切れになり
            // 未完走(T034)。結果は不正確なため使わず、直前に完了した
            // イテレーションの結果(`last_result`、無ければ関数末尾の
            // フォールバック)をそのまま返す。
            break;
        }

        total_nodes += nodes;

        let hash = zobrist_hash(board, side_to_move);
        let best_move = tt.probe(hash).and_then(|entry| entry.best_move);
        let pv = extract_pv(board, side_to_move, tt, depth as usize);

        last_result = Some(SearchResult {
            best_move,
            score,
            depth,
            pv,
            nodes: total_nodes,
            // T034: このループはNegaScout(中盤探索)経由の結果であり、
            // ルート局面自体を完全読みし切ったわけではないため常にfalse
            // (葉の一部が`solve_exact_bounded`で完全読みされていたとしても、
            // ルートから見た最終結果としては「完全読み」を名乗れない)。
            is_exact: false,
        });

        if let Some(time_ms) = limit.time_ms {
            if start.elapsed().as_millis() as u64 >= time_ms {
                break;
            }
        }
    }

    last_result.unwrap_or_else(|| SearchResult {
        // max_depth == 0 のような呼び出しへのフォールバック、または
        // (T034)ルート分岐の完全読みがタイムアウトし、かつ反復深化の
        // depth=1すら一度も完走できなかった場合。反復が一度も行われな
        // かった場合、静的評価をそのまま返す。
        best_move: None,
        score: static_eval(board, side_to_move, weights),
        depth: 0,
        pv: Vec::new(),
        nodes: 0,
        is_exact: false,
    })
}

/// 現在の局面の**全合法手**それぞれについて評価値を返す(T018)。
///
/// 悪手判定(「打った手が最善手からどれだけ悪いか」)・定石外判定など、
/// 全モード共通で必要になる基盤API。[`search`] は最善手1つしか返さないため、
/// こちらは合法手すべてを列挙し、各手について:
///
/// - 着手後の局面の空きマス数が `limit.exact_from_empties` 以下であれば
///   [`solve_exact_with_nodes`] による完全読みの結果(石差)を centi-disc
///   スケールに変換して使う。
/// - それ以外は、着手後の局面に対して `limit.max_depth` までの
///   NegaScout(PVS)探索を行う。
///
/// いずれの経路でも、返す `score` は **`side_to_move`(この関数を呼んだ時点の
/// 手番)から見た** centi-disc スケールの評価値になるよう符号を揃える
/// (着手後は相手番になるため、内部で得られる値は必ず反転してから格納する)。
/// どちらの経路で評価したかは `MoveEval::is_exact` にそのまま記録する
/// (呼び出し側が `score.type` を報告する際の根拠にする。レビュー指摘対応)。
///
/// `tt` は全合法手の評価を通じて使い回される(探索の重複を減らすため)。
/// [`search`] 同様、T007のTTスケール混同防止ロジック
/// (`exact_from_empties` が前回と異なる場合に `tt` をクリアする)が働く。
///
/// `limit.time_ms` が指定されている場合、[`search`] と同様、反復深化の
/// 各深さが完了するごとに経過時間をチェックし、超過していればその時点で
/// 打ち切る。この経過時間計測は**全合法手を通じた累計**であり
/// (合法手ごとに予算を新たに割り当て直すのではない)、予算を使い切った
/// 後に評価される残りの合法手は、それぞれ1回だけ静的評価
/// (`eval::evaluate_for`)相当の浅い値になる。全合法手の評価を打ち切りなく
/// 完走した場合と比べて精度は落ちるが、「0.5〜2秒程度で返る」という
/// 性能目標(タスク背景参照)を守ることを優先する。
///
/// 合法手が0件(パスすべき局面・終局局面)の場合は空の `Vec` を返す
/// (エラーにしない)。返す順序はスコア降順。
///
/// 静的評価には常に従来の3項ヒューリスティック評価を使う。パターン評価
/// (T043)を使いたい場合は [`search_all_moves_with_eval`] を使うこと。
pub fn search_all_moves(
    board: &Board,
    side_to_move: Side,
    limit: &SearchLimit,
    tt: &mut TranspositionTable,
) -> Vec<MoveEval> {
    search_all_moves_with_eval(board, side_to_move, limit, tt, None)
}

/// [`search_all_moves`]と同じだが、`weights`が`Some`ならT043のパターン評価を
/// 静的評価に使う(`None`なら[`search_all_moves`]と全く同じ挙動)。
pub fn search_all_moves_with_eval(
    board: &Board,
    side_to_move: Side,
    limit: &SearchLimit,
    tt: &mut TranspositionTable,
    weights: Option<&PatternWeights>,
) -> Vec<MoveEval> {
    // TTスケール混同防止(T007と同じロジック。search()参照)。
    if let Some(prev) = tt.last_exact_from_empties() {
        if prev != limit.exact_from_empties {
            tt.clear();
        }
    }
    tt.set_last_exact_from_empties(limit.exact_from_empties);

    let legal = board.legal_moves(side_to_move);
    let mut moves: Vec<u8> = Vec::with_capacity(legal.count_ones() as usize);
    let mut remaining = legal;
    while remaining != 0 {
        let lsb = remaining & remaining.wrapping_neg();
        moves.push(lsb.trailing_zeros() as u8);
        remaining &= remaining - 1;
    }

    let opponent = side_to_move.opposite();
    let mut evals: Vec<MoveEval> = Vec::with_capacity(moves.len());

    // 全合法手を通じた累計の経過時間を計測する(`limit.time_ms` があれば
    // 参照する)。`search()` の反復深化ループと同じ「1反復完了ごとに
    // チェック」というポリシーだが、ここでは合法手をまたいで単一の
    // `start` を共有する(合法手ごとに予算を新たに割り当て直さない、
    // 実装者判断でシンプルな「全体の経過時間で判定する」方式を採る)。
    // 予算を使い切った後に評価される合法手は、それぞれの反復深化ループが
    // depth=1(子局面としては depth=0、静的評価1回分)で即座に打ち切られる
    // ため、全合法手が必ず `evals` に含まれることは変わらない
    // (深さが浅くなるだけで、手が欠落することはない)。
    let start = Instant::now();

    for mv in moves {
        let next_board = board.apply_move(side_to_move, 1u64 << mv);
        let next_empties = next_board.empty_count();

        let (score, is_exact) = if next_empties <= limit.exact_from_empties as u32 {
            // T034: `search()`/`negascout`と同じ理由により、`time_ms`が
            // 指定されていれば`solve_exact_bounded`を使う。特定の局面
            // (安定石カット等の高度な枝刈りを持たない完全読みソルバーが
            // 苦手とする「重い」局面)では、この直接呼び出し1回だけでも
            // 時間予算を大幅に超過しうることが実測で確認されている。
            // 打ち切られた場合は、この手についてだけ静的評価に
            // フォールバックし`is_exact=false`として報告する(本当は
            // 完全読みしたかったが時間予算を優先して打ち切った、という
            // 実態を反映する)。
            match limit.time_ms {
                Some(time_ms) => {
                    let budget = TimeBudget { start, time_ms };
                    match solve_exact_bounded(&next_board, opponent, tt, budget) {
                        Some(raw_diff) => (-(raw_diff * 100), true),
                        None => (-static_eval(&next_board, opponent, weights), false),
                    }
                }
                None => {
                    let (raw_diff, _nodes) = solve_exact_with_nodes(&next_board, opponent, tt);
                    (-(raw_diff * 100), true)
                }
            }
        } else {
            // 反復深化: search()のルート呼び出しと同じ深さの意味を保つため、
            // ここで消費した1手分(mvの着手)を差し引いた `depth - 1` を
            // 子局面(next_board, opponent視点)に渡す。こうすることで、
            // 同じ `limit.max_depth` を指定したときに `search()` が返す
            // 評価値と、`search_all_moves()` が返す評価値の最大値が
            // 一致する(整合性は本モジュールのテストで検証する)。
            let mut best_for_move = -static_eval(&next_board, opponent, weights);
            for depth in 1..=limit.max_depth {
                let mut nodes: u64 = 0;
                let mut timed_out = false;
                let candidate = {
                    let mut ctx = SearchCtx {
                        limit,
                        tt: &mut *tt,
                        nodes: &mut nodes,
                        start,
                        timed_out: &mut timed_out,
                        weights,
                    };
                    -negascout(&next_board, opponent, depth - 1, -INF, INF, &mut ctx)
                };

                if timed_out {
                    // このイテレーション(depth)は再帰の途中で時間切れになり
                    // 未完走(T034)。`candidate`は不正確なため使わず、
                    // 直前に完了した深さの評価値(`best_for_move`)を採用して
                    // この手の反復深化を打ち切る。
                    break;
                }
                best_for_move = candidate;

                if let Some(time_ms) = limit.time_ms {
                    if start.elapsed().as_millis() as u64 >= time_ms {
                        break;
                    }
                }
            }
            (best_for_move, false)
        };

        evals.push(MoveEval { mv, score, is_exact });
    }

    evals.sort_by_key(|e| std::cmp::Reverse(e.score));
    evals
}

/// NegaScout探索1回分の実行に必要な文脈をまとめた構造体。
/// (引数を減らしてclippyの`too_many_arguments`を避けるための束ね役でもある)
struct SearchCtx<'a> {
    limit: &'a SearchLimit,
    tt: &'a mut TranspositionTable,
    nodes: &'a mut u64,
    /// この反復深化の1イテレーション(1つの`depth`の探索、または
    /// `search_all_moves`の1つの合法手についての1イテレーション)の
    /// 経過時間計測の起点。`negascout`の再帰の**途中**で`limit.time_ms`の
    /// 超過をチェックするために使う(T034で追加)。
    ///
    /// 背景: 従来は反復深化の「1つの深さの探索が完了するごと」にしか
    /// 経過時間を確認していなかった(このファイル冒頭の
    /// `search`/`search_all_moves`のループ参照)。ほとんどの局面では
    /// 深さが1増えるごとの所要時間の増加はおおむね緩やかなためこれで
    /// 十分だったが、局面によっては特定の深さで(ムーブオーダリングが
    /// 効かない分岐に当たる等の理由で)組合せ的に所要時間が跳ね上がる
    /// ことがあり、そのようなケースでは「1回のイテレーションの完了を
    /// 待つ」だけで時間予算を数百倍超過してしまうことが実測で確認された
    /// (T034調査ログ参照)。再帰の途中でも定期的にチェックすることで、
    /// この種の突発的な超過を打ち切れるようにする。
    start: Instant,
    /// 探索が時間切れで打ち切られたことを示すフラグ。一度立てると、
    /// それ以降の全ての再帰呼び出しは(探索を進めず)即座に展開し、
    /// 呼び出し元まで巻き戻る。このフラグが立った状態で計算される
    /// `best_score`/`best_move`は不完全な探索に基づく不正確な値なので、
    /// 置換表には格納しない(`negascout`本体・呼び出し元の両方で保証する)。
    /// `search`/`search_all_moves`はこのフラグを見て、そのイテレーション
    /// の結果を丸ごと破棄し、直前に完了したイテレーションの結果を使う。
    timed_out: &'a mut bool,
    /// T043: `negascout`の葉ノード評価(`depth == 0`)に使う静的評価。
    /// `Some`ならパターン評価、`None`なら従来の3項ヒューリスティック評価
    /// (`static_eval`参照)。
    weights: Option<&'a PatternWeights>,
}

/// `negascout`の再帰中に時間予算をチェックする頻度(ノード数に1回)。
/// 毎ノードチェックすると、特にWASM上では`web_time::Instant::now()`が
/// `Performance.now()`へのJS境界越え呼び出しになりオーバーヘッドが
/// 無視できないため、探索自体を遅くしてしまう。1024ノードに1回の
/// チェックであれば、オーバーヘッドを無視できる水準に抑えつつ、
/// 時間予算の超過を数msのオーダーで検出できる(T034)。
const TIME_CHECK_NODE_INTERVAL: u64 = 1024;

/// NegaScout(PVS) + 置換表による中盤探索本体。
///
/// `alpha` / `beta` は `side` から見たcenti-discスケールの評価値の窓。
/// 空きマス数が `ctx.limit.exact_from_empties` 以下になった時点で
/// 終盤完全読みに切り替える(この判定はルート呼び出しだけでなく、
/// 探索木の途中の任意の局面でも行う)。
///
/// `ctx.limit.time_ms`が指定されている場合、`ctx.timed_out`がまだ
/// 立っていなければ`TIME_CHECK_NODE_INTERVAL`ノードごとに経過時間を
/// チェックする(T034)。超過していれば`ctx.timed_out`を立てて即座に
/// `0`を返す(呼び出し元は戻り値を使わず`ctx.timed_out`を見て
/// イテレーション全体を破棄するため、`0`という値自体に意味はない)。
/// 一度`ctx.timed_out`が立った後の全呼び出しも同様に即座に`0`を返し、
/// 置換表への格納も行わない(不完全な探索結果でTTを汚染しないため)。
fn negascout(
    board: &Board,
    side: Side,
    depth: u8,
    alpha: i32,
    beta: i32,
    ctx: &mut SearchCtx,
) -> i32 {
    *ctx.nodes += 1;

    if *ctx.timed_out {
        return 0;
    }
    if let Some(time_ms) = ctx.limit.time_ms {
        if *ctx.nodes % TIME_CHECK_NODE_INTERVAL == 0 && ctx.start.elapsed().as_millis() as u64 >= time_ms {
            *ctx.timed_out = true;
            return 0;
        }
    }

    let mut alpha = alpha;
    let mut beta = beta;

    let empties = board.empty_count();
    if empties <= ctx.limit.exact_from_empties as u32 {
        // T034: 空きマス数がしきい値以下になった時点で終盤完全読みに
        // 切り替えるが、この完全読み自体(`endgame::negamax`)は素朴な
        // alpha-beta+TTであり、特定の「重い」局面では1回の呼び出しだけで
        // 時間予算を大幅に超過しうることが実測で確認されている
        // (T034調査ログ参照)。`time_ms`が指定されている場合は
        // `solve_exact_bounded`(同じ`ctx.start`を共有する時間予算付き
        // バージョン)を使い、打ち切られた場合は`ctx.timed_out`を立てて
        // 呼び出し元にイテレーション全体を破棄させる。
        return match ctx.limit.time_ms {
            Some(time_ms) => {
                let budget = TimeBudget { start: ctx.start, time_ms };
                match solve_exact_bounded(board, side, ctx.tt, budget) {
                    Some(score) => score * 100,
                    None => {
                        *ctx.timed_out = true;
                        0
                    }
                }
            }
            None => solve_exact(board, side, ctx.tt) * 100,
        };
    }

    let legal = board.legal_moves(side);
    if legal == 0 {
        if board.legal_moves(side.opposite()) == 0 {
            // 両者パス: 終局。
            return terminal_score_centi(board, side);
        }
        // 自分だけ合法手がない: パス(深さを消費せず相手番で再帰)。
        return -negascout(board, side.opposite(), depth, -beta, -alpha, ctx);
    }

    if depth == 0 {
        return static_eval(board, side, ctx.weights);
    }

    let hash = zobrist_hash(board, side);
    let alpha_orig = alpha;
    let mut tt_move: Option<u8> = None;

    if let Some(entry) = ctx.tt.probe(hash) {
        tt_move = entry.best_move;
        if entry.depth as u32 >= depth as u32 {
            match entry.bound {
                Bound::Exact => return entry.score,
                Bound::Lower => alpha = alpha.max(entry.score),
                Bound::Upper => beta = beta.min(entry.score),
            }
            if alpha >= beta {
                return entry.score;
            }
        }
    }

    let moves = ordered_moves(board, side, tt_move);

    let mut best_score = i32::MIN;
    let mut best_move: Option<u8> = None;
    let mut first = true;

    for mv in moves {
        let next_board = board.apply_move(side, 1u64 << mv);

        let score = if first {
            -negascout(&next_board, side.opposite(), depth - 1, -beta, -alpha, ctx)
        } else {
            // Null Window Search: まず [alpha, alpha+1) の狭い窓で探索する。
            let scout_score = -negascout(
                &next_board,
                side.opposite(),
                depth - 1,
                -alpha - 1,
                -alpha,
                ctx,
            );
            if scout_score > alpha && scout_score < beta {
                // 窓を外れた(=このスコアが実は最善手かもしれない)ので
                // フルウィンドウで再探索する。
                -negascout(&next_board, side.opposite(), depth - 1, -beta, -alpha, ctx)
            } else {
                scout_score
            }
        };

        if *ctx.timed_out {
            // 子の探索(のどこか)が時間切れで打ち切られた: このノードの
            // `score`は不完全な探索に基づく不正確な値なので使わず、
            // 置換表への格納も行わずに即座に展開する(T034)。
            return 0;
        }

        if score > best_score {
            best_score = score;
            best_move = Some(mv);
        }
        if best_score > alpha {
            alpha = best_score;
        }
        if alpha >= beta {
            break;
        }
        first = false;
    }

    let bound = if best_score <= alpha_orig {
        Bound::Upper
    } else if best_score >= beta {
        Bound::Lower
    } else {
        Bound::Exact
    };

    ctx.tt.store(TTEntry {
        hash,
        depth: depth as i8,
        score: best_score,
        bound,
        best_move,
    });

    best_score
}

/// 終局時の最終石差(`side`から見たcenti-disc値)を計算する。
///
/// `endgame::final_score`(素の石差、1石=1)を呼び出して centi-disc
/// スケール(×100)に変換するだけの薄いラッパー。「石数が多い方が
/// 残り空きマスを総取りする」という終局ロジック自体は `endgame.rs` に
/// 一本化されており、ここでは重複実装しない(T007)。
fn terminal_score_centi(board: &Board, side: Side) -> i32 {
    final_score(board, side) * 100
}

/// 合法手を簡易的なムーブオーダリングで並べ替えて返す。
///
/// 優先順位: TT手(あれば最優先) → 隅 → 相手の着手後合法手数(モビリティ)が
/// 少ない順。
fn ordered_moves(board: &Board, side: Side, tt_move: Option<u8>) -> Vec<u8> {
    let legal = board.legal_moves(side);
    let mut moves: Vec<u8> = Vec::with_capacity(legal.count_ones() as usize);
    let mut remaining = legal;
    while remaining != 0 {
        let lsb = remaining & remaining.wrapping_neg();
        moves.push(lsb.trailing_zeros() as u8);
        remaining &= remaining - 1;
    }

    moves.sort_by_key(|&mv| {
        let bit = 1u64 << mv;
        let is_corner = bit & CORNER_MASK != 0;
        let next_board = board.apply_move(side, bit);
        let opp_mobility = next_board.legal_moves(side.opposite()).count_ones();
        (if is_corner { 0u32 } else { 1u32 }, opp_mobility)
    });

    if let Some(tm) = tt_move {
        if let Some(pos) = moves.iter().position(|&m| m == tm) {
            moves.remove(pos);
            moves.insert(0, tm);
        }
    }

    moves
}

/// 置換表から読み筋(PV)を再構成する。
///
/// ルート局面から`best_move`を辿っていき、置換表にエントリが無くなるか
/// `max_len`手に達したら打ち切る。途中でパスが必要な局面に当たった場合は
/// 手番だけ入れ替えて続行する(パスは読み筋には現れない)。
fn extract_pv(board: &Board, side: Side, tt: &TranspositionTable, max_len: usize) -> Vec<u8> {
    let mut pv = Vec::new();
    let mut current = *board;
    let mut current_side = side;

    for _ in 0..max_len {
        // 手番側に合法手がなければパス(相手番に切り替えて続行)。
        // 両者とも合法手がなければ読み筋はここまで。
        if current.legal_moves(current_side) == 0 {
            if current.legal_moves(current_side.opposite()) == 0 {
                break;
            }
            current_side = current_side.opposite();
        }

        let hash = zobrist_hash(&current, current_side);
        let Some(entry) = tt.probe(hash) else {
            break;
        };
        let Some(mv) = entry.best_move else {
            break;
        };

        let bit = 1u64 << mv;
        if current.legal_moves(current_side) & bit == 0 {
            // 想定外(ハッシュ衝突等): 安全側に倒して打ち切る。
            break;
        }

        pv.push(mv);
        current = current.apply_move(current_side, bit);
        current_side = current_side.opposite();
    }

    pv
}

#[cfg(test)]
mod tests {
    use super::*;

    fn default_limit(max_depth: u8, exact_from_empties: u8) -> SearchLimit {
        SearchLimit {
            max_depth,
            time_ms: None,
            exact_from_empties,
        }
    }

    // --- テスト用ユーティリティ: 初期局面から決定的に手を進めて空きマスを減らす ---
    // (endgame.rsのテストと同様の考え方。モジュールをまたいだ共有はしていない)

    fn play_until_empties(target_empties: u32, choose: impl Fn(&[u64]) -> u64) -> (Board, Side) {
        let mut board = Board::initial();
        let mut side = Side::Black;

        loop {
            if board.empty_count() <= target_empties || board.is_terminal() {
                return (board, side);
            }

            let legal = board.legal_moves(side);
            if legal == 0 {
                side = side.opposite();
                continue;
            }

            let mut moves: Vec<u64> = Vec::new();
            let mut remaining = legal;
            while remaining != 0 {
                let lsb = remaining & remaining.wrapping_neg();
                moves.push(lsb);
                remaining &= remaining - 1;
            }

            let mv = choose(&moves);
            board = board.apply_move(side, mv);
            side = side.opposite();
        }
    }

    fn first_move_strategy(moves: &[u64]) -> u64 {
        moves[0]
    }

    #[test]
    fn search_from_initial_position_returns_a_legal_move() {
        let board = Board::initial();
        let limit = default_limit(6, 24);
        let mut tt = TranspositionTable::new(4);

        let result = search(&board, Side::Black, &limit, &mut tt);

        let best_move = result.best_move.expect("initial position must have a best move");
        let legal = board.legal_moves(Side::Black);
        assert!(
            legal & (1u64 << best_move) != 0,
            "best_move {} is not among the legal moves {:?}",
            best_move,
            legal
        );
        assert_eq!(result.depth, 6);
    }

    #[test]
    fn search_delegates_to_exact_solver_and_matches_its_score() {
        // 空きマス数が閾値以下になるよう手を進めた局面を用意する。
        let (board, side) = play_until_empties(10, first_move_strategy);
        let exact_threshold = board.empty_count() as u8;

        let limit = default_limit(20, exact_threshold);
        let mut tt_search = TranspositionTable::new(4);
        let result = search(&board, side, &limit, &mut tt_search);

        let mut tt_direct = TranspositionTable::new(4);
        let direct_score = solve_exact(&board, side, &mut tt_direct) * 100;

        assert_eq!(
            result.score, direct_score,
            "search() should delegate to solve_exact and report the same centi-disc score"
        );
        assert_eq!(result.depth, board.empty_count() as u8);
    }

    #[test]
    fn search_favors_black_when_black_dominates_the_board() {
        // T004(eval.rs)のテストと同じ発想: 黒が4隅を追加で保持する局面。
        // 初期局面をベースに4隅すべてを黒石にすることで、中盤探索の
        // ムーブオーダリング・葉評価が正しく統合されていれば黒有利な
        // スコアになるはず。
        let initial = Board::initial();
        let corners = (1u64 << 0) | (1u64 << 7) | (1u64 << 56) | (1u64 << 63);
        let board = Board {
            black: initial.black | corners,
            white: initial.white,
        };

        let limit = default_limit(4, 10);
        let mut tt = TranspositionTable::new(4);
        let result = search(&board, Side::Black, &limit, &mut tt);

        assert!(
            result.score > 0,
            "black should be clearly favored, got score={}",
            result.score
        );
    }

    #[test]
    fn iterative_deepening_completes_without_error_and_depth_increases() {
        let board = Board::initial();
        let mut tt = TranspositionTable::new(4);

        for max_depth in [1u8, 2, 3] {
            let limit = default_limit(max_depth, 10);
            let result = search(&board, Side::Black, &limit, &mut tt);
            assert_eq!(result.depth, max_depth);
            assert!(result.best_move.is_some());
        }
    }

    #[test]
    fn search_completes_quickly_from_initial_position_up_to_depth_around_ten() {
        // 明らかな無限ループ・指数的爆発がないことの疎通確認。
        // (NPSの厳密な計測はT008のFFOベンチで行う)
        let board = Board::initial();
        let limit = default_limit(9, 12);
        let mut tt = TranspositionTable::new(64);

        let start = std::time::Instant::now();
        let result = search(&board, Side::Black, &limit, &mut tt);
        let elapsed = start.elapsed();

        println!(
            "search up to depth={} finished in {:?}, nodes={}, score={}",
            result.depth, elapsed, result.nodes, result.score
        );

        assert!(result.best_move.is_some());
    }

    #[test]
    fn reusing_tt_across_calls_with_different_exact_from_empties_does_not_crash_and_updates_marker() {
        // T007: TTスケール混同防止の回帰テスト。
        // 同じ `TranspositionTable` を使い回したまま `exact_from_empties` を
        // 変えて2回 `search()` を呼んでもクラッシュせず、かつ2回目の呼び出し
        // 後には `tt.last_exact_from_empties()` が今回の値に更新されている
        // ことを確認する(自動クリア処理が有効であることの間接的な確認)。
        let board = Board::initial();
        let mut tt = TranspositionTable::new(4);

        let limit_x = default_limit(4, 10);
        let _ = search(&board, Side::Black, &limit_x, &mut tt);
        assert_eq!(
            tt.last_exact_from_empties(),
            Some(10),
            "after the first search(), tt should remember exact_from_empties=10"
        );

        // exact_from_empties を変えて同じTTを使い回す。
        let limit_y = default_limit(4, 12);
        let result = search(&board, Side::Black, &limit_y, &mut tt);

        assert!(
            result.best_move.is_some(),
            "search() should still return a valid result after reusing the tt \
             with a different exact_from_empties"
        );
        assert_eq!(
            tt.last_exact_from_empties(),
            Some(12),
            "after the second search(), tt should remember the new exact_from_empties=12"
        );
    }

    #[test]
    fn search_terminal_score_matches_endgame_final_score_directly() {
        // T007: 終局ロジック重複解消の回帰テスト。
        // `search()` が返す終局スコア(両者パスの局面)が、
        // `endgame::final_score` を直接呼んだ結果(×100)と一致することを
        // 確認する。これは `terminal_score_centi` が独自実装ではなく
        // `endgame::final_score` を呼び出す薄いラッパーになったことの確認。
        //
        // 全マスを黒で埋め、1マスだけ空けておくと、その空きマスに隣接する
        // マスは全て黒なので両者とも合法手がなく即終局する
        // (endgame.rsの同種のテストと同じ構成)。
        let mut black = u64::MAX;
        let hole = 1u64 << 27; // d4
        black &= !hole;
        let white = 0u64;
        let board = Board { black, white };

        assert_eq!(board.empty_count(), 1);
        assert_eq!(board.legal_moves(Side::Black), 0);
        assert_eq!(board.legal_moves(Side::White), 0);

        // exact_from_empties=0 にすることで、空き1マスのこの局面は
        // (1 <= 0 が偽なので)終盤ソルバーには渡らず、必ずNegaScout側の
        // `negascout` 関数内で両者パス判定 → `terminal_score_centi` の
        // 経路を通る。
        let limit = default_limit(4, 0);
        let mut tt = TranspositionTable::new(4);
        let result = search(&board, Side::Black, &limit, &mut tt);

        let expected = final_score(&board, Side::Black) * 100;
        assert_eq!(
            result.score, expected,
            "search()'s terminal score should match endgame::final_score(...) * 100 exactly"
        );
    }

    // ------------------------------------------------------------------
    // T018: search_all_moves のテスト
    // ------------------------------------------------------------------

    #[test]
    fn search_all_moves_from_initial_position_returns_all_four_opening_moves() {
        let board = Board::initial();
        let limit = default_limit(4, 10);
        let mut tt = TranspositionTable::new(4);

        let evals = search_all_moves(&board, Side::Black, &limit, &mut tt);

        assert_eq!(
            evals.len(),
            4,
            "initial position should have exactly 4 legal moves (d3, c4, f5, e6)"
        );

        let notations: Vec<String> = evals
            .iter()
            .map(|e| crate::protocol::square_to_notation(e.mv))
            .collect();
        for expected in ["d3", "c4", "f5", "e6"] {
            assert!(
                notations.contains(&expected.to_string()),
                "expected opening move {expected} to be present in {notations:?}"
            );
        }
    }

    #[test]
    fn search_all_moves_max_score_matches_search_best_score() {
        // 整合性チェック: search_all_moves() が返す評価値の最大値は、
        // 同じ局面・同じ limit で search() (単一最善手API) が返す評価値と
        // 一致するはず(どちらも同じ深さでの厳密なmax-of-children)。
        let board = Board::initial();
        let limit = default_limit(4, 10);

        let mut tt_all = TranspositionTable::new(4);
        let evals = search_all_moves(&board, Side::Black, &limit, &mut tt_all);
        let max_score = evals
            .iter()
            .map(|e| e.score)
            .max()
            .expect("initial position should have at least one legal move");

        let mut tt_single = TranspositionTable::new(4);
        let result = search(&board, Side::Black, &limit, &mut tt_single);

        assert_eq!(
            max_score, result.score,
            "the best score among search_all_moves() results should match search()'s score"
        );
    }

    #[test]
    fn search_all_moves_uses_exact_solver_when_next_position_is_within_threshold() {
        // 各手について、着手後の空きマス数がちょうど exact_from_empties に
        // 一致するように limit を組み立てる。この条件下では、全ての手の
        // 評価値が完全読み(solve_exact, 石差×100, 手番反転)に基づいている
        // はず。
        let (board, side) = play_until_empties(7, first_move_strategy);
        let empties_before = board.empty_count();
        // 着手すると必ず空きマスがちょうど1つ減るので、これで
        // 「着手後の空きマス数 <= exact_from_empties」を全ての手について
        // 満たせる。
        let exact_threshold = (empties_before - 1) as u8;
        let limit = default_limit(20, exact_threshold);

        let mut tt = TranspositionTable::new(4);
        let evals = search_all_moves(&board, side, &limit, &mut tt);
        assert!(!evals.is_empty());

        for eval in &evals {
            let next_board = board.apply_move(side, 1u64 << eval.mv);
            assert_eq!(
                next_board.empty_count(),
                exact_threshold as u32,
                "test setup should guarantee next_empties == exact_threshold for every move"
            );

            let mut tt_direct = TranspositionTable::new(4);
            let expected = -(solve_exact(&next_board, side.opposite(), &mut tt_direct) * 100);
            assert_eq!(
                eval.score, expected,
                "move {} should be scored via the exact solver",
                eval.mv
            );
            assert!(
                eval.is_exact,
                "move {} was scored via the exact solver, so is_exact should be true",
                eval.mv
            );
        }
    }

    #[test]
    fn search_all_moves_is_exact_flag_matches_the_evaluation_method_actually_used_at_the_boundary() {
        // レビュー指摘(T018フィードバック1件目)の回帰テスト:
        // 「着手前の局面の空きマス数」と「exact_from_empties」の比較だけで
        // score.type を決めると、exact_from_empties + 1 という境界で実態と
        // 食い違う(着手後は必ず空きマスが1減るため、着手前の空きマス数が
        // ちょうど exact_from_empties + 1 のとき、全ての手は実際には完全
        // 読みで評価されるが、着手前ベースの判定では「探索(midgame)」だと
        // 誤判定してしまう)。
        //
        // `MoveEval::is_exact` が「着手前の空きマス数」ではなく「各手が
        // 実際にどちらの方式で評価されたか」を正しく反映していることを、
        // この境界条件で確認する。
        let (board, side) = play_until_empties(7, first_move_strategy);
        let empties_before = board.empty_count();
        let exact_threshold = (empties_before - 1) as u8; // 境界: empties_before == exact_threshold + 1

        assert_eq!(
            empties_before,
            exact_threshold as u32 + 1,
            "test setup should place empties_before exactly one above exact_threshold"
        );

        let limit = default_limit(20, exact_threshold);
        let mut tt = TranspositionTable::new(4);
        let evals = search_all_moves(&board, side, &limit, &mut tt);

        assert!(!evals.is_empty());
        for eval in &evals {
            assert!(
                eval.is_exact,
                "move {} should be flagged as exact-solved at the exact_from_empties+1 boundary \
                 (this is exactly the case the pre-move-empties-based score.type judgement got wrong)",
                eval.mv
            );
        }
    }

    #[test]
    fn search_all_moves_is_exact_is_false_when_above_the_exact_threshold() {
        // 対照テスト: 十分に空きマスが多い(exact_from_empties を大きく
        // 上回る)局面では、全ての手が探索(NegaScout)経由、つまり
        // `is_exact == false` になることを確認する。
        let board = Board::initial();
        let limit = default_limit(4, 10);
        let mut tt = TranspositionTable::new(4);

        let evals = search_all_moves(&board, Side::Black, &limit, &mut tt);
        assert!(!evals.is_empty());
        for eval in &evals {
            assert!(
                !eval.is_exact,
                "move {} should not be flagged as exact-solved when far from the endgame",
                eval.mv
            );
        }
    }

    #[test]
    fn search_all_moves_respects_time_ms_budget_and_returns_promptly() {
        // レビュー指摘(T018フィードバック2件目)の回帰テスト:
        // time_ms を指定すれば、たとえ max_depth が大きくても
        // (合法手数 × 高深度を律儀に反復深化し続けることなく)
        // 妥当な時間で打ち切られることを確認する。
        //
        // 初期局面から depth=20 まで4手すべてを time_ms 制限なしで
        // 反復深化すると非常に長い時間がかかる(本テストでは実行しない)。
        // ここでは time_ms=50 を指定し、その予算内に近い時間で
        // 関数が返ってくること(かつ全4手が欠落なく返ること)を確認する。
        let board = Board::initial();
        let limit = SearchLimit {
            max_depth: 20,
            time_ms: Some(50),
            exact_from_empties: 10,
        };
        let mut tt = TranspositionTable::new(64);

        let start = std::time::Instant::now();
        let evals = search_all_moves(&board, Side::Black, &limit, &mut tt);
        let elapsed = start.elapsed();

        println!("search_all_moves with time_ms=50 finished in {elapsed:?}");

        assert_eq!(evals.len(), 4, "all 4 legal moves should still be present");
        assert!(
            elapsed < std::time::Duration::from_millis(2000),
            "search_all_moves should honor time_ms and return well within 2s, took {elapsed:?}"
        );
    }

    #[test]
    fn search_all_moves_returns_empty_vec_when_no_legal_moves() {
        // 手番側に合法手が無い局面(パス・終局)では、空の Vec を返す
        // (エラーにしない)。search.rs の他のテストと同様、全マスを黒で
        // 埋め1マスだけ空けた盤面を使う(白は合法手を持たない)。
        let mut black = u64::MAX;
        let hole = 1u64 << 27; // d4
        black &= !hole;
        let white = 0u64;
        let board = Board { black, white };

        assert_eq!(board.legal_moves(Side::White), 0);

        let limit = default_limit(4, 0);
        let mut tt = TranspositionTable::new(4);
        let evals = search_all_moves(&board, Side::White, &limit, &mut tt);

        assert!(evals.is_empty());
    }
}
