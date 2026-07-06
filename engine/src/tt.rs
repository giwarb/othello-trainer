//! 置換表(Transposition Table): 探索(T005)・終盤ソルバー(T006)が
//! 局面の探索結果をキャッシュするための構造体。
//!
//! # 設計
//! 通常のメモリ上に確保する `Vec` ベースのシングルスレッド実装。
//! (マルチスレッド共有・SharedArrayBuffer上への配置はフェーズ7で対応する)
//!
//! 2-tier構成: 同じインデックス(バケット)に
//! 「depth優先スロット」(深い探索結果を優先して保持する)と
//! 「always-replaceスロット」(常に最新の結果で上書きする)の2つを持つ。
//! ハッシュの完全一致を確認してから返すため、衝突による誤検出は発生しない
//! (ただし異なる局面が偶然同じ64bitハッシュを持つ場合はこの限りではない)。
//!
//! 探索(T005)・終盤ソルバー(T006)が実装されるまでは `#[cfg(test)]` 以外から
//! 参照されないため、未使用コードの警告 (dead_code) を明示的に抑制する
//! (`bitboard.rs` と同じ扱い)。

#![allow(dead_code)]

/// 評価値の種別(NegaScout/PVSにおける一般的なバウンドの種類)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Bound {
    /// 正確な評価値(window内に収まった)。
    Exact,
    /// 下限値(fail-high, beta cutoffで確定)。真の値はこれ以上。
    Lower,
    /// 上限値(fail-low)。真の値はこれ以下。
    Upper,
}

/// 置換表の1エントリ。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TTEntry {
    /// 局面のZobristハッシュ(衝突検出のため64bit全体を保持する)。
    pub hash: u64,
    /// このエントリを格納した際の探索深さ。
    pub depth: i8,
    /// 評価値。
    pub score: i32,
    /// `score` が exact / lower-bound / upper-bound のいずれであるかを表す。
    pub bound: Bound,
    /// 最善手(マス番号 0..63)。パスや未確定の場合は `None`。
    pub best_move: Option<u8>,
}

/// 1つのインデックスに対応するバケット。depth優先スロットとalways-replaceスロットを持つ。
#[derive(Debug, Clone, Copy)]
struct Bucket {
    depth_slot: Option<TTEntry>,
    always_slot: Option<TTEntry>,
}

impl Bucket {
    const EMPTY: Bucket = Bucket {
        depth_slot: None,
        always_slot: None,
    };
}

/// 置換表本体。
pub struct TranspositionTable {
    buckets: Vec<Bucket>,
    /// `buckets.len()` は常に2の累乗になるようにし、`hash & mask` で
    /// 高速にインデックスを計算できるようにする。
    mask: usize,
    /// このTTに対して最後に探索が実行された際の
    /// `SearchLimit::exact_from_empties` の値(search.rs参照)。
    ///
    /// # なぜ必要か
    /// このTTに格納される `TTEntry::depth` の意味(スケール)は、
    /// エントリの元になった局面の空きマス数が「その時点の
    /// `exact_from_empties` 以下だったか」によって
    /// (終盤ソルバー: 残り空きマス数 / 中盤探索: 残り探索プライ数)と
    /// 一意に決まる。しかし、この前提は「同じTTに対して常に同じ
    /// `exact_from_empties` で探索する」場合にのみ成立する。もし異なる
    /// `exact_from_empties` で同じTTを使い回すと、スケールの異なる古い
    /// エントリが `entry.depth as u32 >= depth as u32` の判定を通過して
    /// 誤ったスコアを返すおそれがある。呼び出し側(`search::search`)は、
    /// この値と今回の `exact_from_empties` を比較し、不一致であれば
    /// 探索前に `clear()` してからこのフィールドを更新することで、
    /// スケール混同を防ぐ。
    last_exact_from_empties: Option<u8>,
}

impl TranspositionTable {
    /// 指定サイズ(MB)からバケット数を計算して確保する。
    ///
    /// `size_mb` から求めたバケット数を超えない最大の2の累乗に切り詰める
    /// (最低1バケットは確保する)。
    pub fn new(size_mb: usize) -> Self {
        let bucket_bytes = std::mem::size_of::<Bucket>().max(1);
        let total_bytes = size_mb.max(1) * 1024 * 1024;
        let requested_buckets = (total_bytes / bucket_bytes).max(1);

        let mut num_buckets: usize = 1;
        while num_buckets.saturating_mul(2) <= requested_buckets {
            num_buckets *= 2;
        }

        TranspositionTable {
            buckets: vec![Bucket::EMPTY; num_buckets],
            mask: num_buckets - 1,
            last_exact_from_empties: None,
        }
    }

    fn index(&self, hash: u64) -> usize {
        (hash as usize) & self.mask
    }

    /// ハッシュからインデックスを計算し、一致するエントリがあれば返す。
    ///
    /// depth優先スロット・always-replaceスロットの両方を確認し、
    /// ハッシュが完全一致するものだけを返す(衝突誤検出を防ぐ)。
    pub fn probe(&self, hash: u64) -> Option<TTEntry> {
        let bucket = &self.buckets[self.index(hash)];

        if let Some(entry) = bucket.depth_slot {
            if entry.hash == hash {
                return Some(entry);
            }
        }
        if let Some(entry) = bucket.always_slot {
            if entry.hash == hash {
                return Some(entry);
            }
        }
        None
    }

    /// 2-tier方式でエントリを格納する。
    ///
    /// depth優先スロットが空、既存エントリと同じ局面(ハッシュ一致)、
    /// または新しいエントリの深さが既存より深い場合はdepth優先スロットを上書きする。
    /// それ以外の場合はalways-replaceスロットを上書きする。
    pub fn store(&mut self, entry: TTEntry) {
        let idx = self.index(entry.hash);
        let bucket = &mut self.buckets[idx];

        let replace_depth_slot = match bucket.depth_slot {
            None => true,
            Some(existing) => existing.hash == entry.hash || entry.depth >= existing.depth,
        };

        if replace_depth_slot {
            bucket.depth_slot = Some(entry);
        } else {
            bucket.always_slot = Some(entry);
        }
    }

    /// 全エントリを空にする(対局が変わった時などに使用する)。
    pub fn clear(&mut self) {
        for bucket in self.buckets.iter_mut() {
            bucket.depth_slot = None;
            bucket.always_slot = None;
        }
    }

    /// このTTに対して最後に探索が実行された際の `exact_from_empties` を返す
    /// (一度も探索が実行されていなければ `None`)。
    pub fn last_exact_from_empties(&self) -> Option<u8> {
        self.last_exact_from_empties
    }

    /// このTTに対して最後に探索が実行された際の `exact_from_empties` を記録する。
    /// `search::search` がスケール混同防止のクリア処理を行った直後に呼び出す。
    pub fn set_last_exact_from_empties(&mut self, value: u8) {
        self.last_exact_from_empties = Some(value);
    }

    /// このテーブルが持つバケット数(テスト専用: バケットが衝突するハッシュを
    /// 作るために内部のバケット数を知る必要があるため公開する)。
    #[cfg(test)]
    pub(crate) fn bucket_count(&self) -> usize {
        self.buckets.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_entry(hash: u64, depth: i8, score: i32, bound: Bound, best_move: Option<u8>) -> TTEntry {
        TTEntry {
            hash,
            depth,
            score,
            bound,
            best_move,
        }
    }

    #[test]
    fn probe_on_empty_table_returns_none() {
        let tt = TranspositionTable::new(1);
        assert_eq!(tt.probe(0), None);
        assert_eq!(tt.probe(12345), None);
    }

    #[test]
    fn store_then_probe_returns_same_entry() {
        let mut tt = TranspositionTable::new(1);
        let entry = sample_entry(42, 5, -123, Bound::Lower, Some(10));
        tt.store(entry);
        assert_eq!(tt.probe(42), Some(entry));
    }

    #[test]
    fn probe_does_not_match_a_different_hash_in_the_same_bucket() {
        let mut tt = TranspositionTable::new(1);
        let bucket_count = tt.bucket_count() as u64;
        let entry = sample_entry(7, 3, 1, Bound::Exact, None);
        tt.store(entry);

        // 同じバケットにマップされるが異なるハッシュ値。
        let colliding_hash = 7 + bucket_count;
        assert_eq!(tt.probe(colliding_hash), None);
        // 元のハッシュは引き続き取得できる。
        assert_eq!(tt.probe(7), Some(entry));
    }

    #[test]
    fn clear_empties_all_entries() {
        let mut tt = TranspositionTable::new(1);
        tt.store(sample_entry(1, 1, 1, Bound::Exact, None));
        tt.store(sample_entry(2, 1, 1, Bound::Exact, None));
        tt.clear();
        assert_eq!(tt.probe(1), None);
        assert_eq!(tt.probe(2), None);
    }

    #[test]
    fn depth_slot_keeps_deep_entry_while_always_slot_gets_overwritten() {
        let mut tt = TranspositionTable::new(1);
        let bucket_count = tt.bucket_count() as u64;
        let base_hash = 12_345u64;

        // まず深いエントリをdepth優先スロットに格納する。
        let deep_entry = sample_entry(base_hash, 10, 100, Bound::Exact, Some(20));
        tt.store(deep_entry);

        // 同じバケットに衝突する、より浅いエントリを複数回格納する
        // (いずれもdepth優先スロットの深さ10より浅いので、always-replaceスロットに入る)。
        let mut last_shallow = None;
        for i in 1..=4u64 {
            let colliding_hash = base_hash + i * bucket_count;
            let shallow_entry = sample_entry(colliding_hash, 1, i as i32, Bound::Upper, None);
            tt.store(shallow_entry);
            last_shallow = Some((colliding_hash, shallow_entry));
        }

        // depth優先スロットには最初の深いエントリが残っている。
        assert_eq!(
            tt.probe(base_hash),
            Some(deep_entry),
            "depth-preferred slot should keep the deep entry"
        );

        // always-replaceスロットには最後に格納した浅いエントリだけが残っている
        // (途中の衝突ハッシュはすべて上書きされて取得できなくなる)。
        let (last_hash, last_entry) = last_shallow.expect("at least one shallow entry was stored");
        assert_eq!(tt.probe(last_hash), Some(last_entry));

        let earlier_colliding_hash = base_hash + bucket_count; // i = 1 の時に格納したもの
        assert_eq!(
            tt.probe(earlier_colliding_hash),
            None,
            "earlier collisions in the always-replace slot should have been overwritten"
        );
    }

    #[test]
    fn deeper_entry_with_new_hash_replaces_depth_slot() {
        let mut tt = TranspositionTable::new(1);
        let bucket_count = tt.bucket_count() as u64;
        let base_hash = 1u64;

        let shallow = sample_entry(base_hash, 2, 10, Bound::Exact, None);
        tt.store(shallow);

        let deeper_colliding_hash = base_hash + bucket_count;
        let deeper = sample_entry(deeper_colliding_hash, 8, 20, Bound::Exact, None);
        tt.store(deeper);

        // より深いエントリがdepth優先スロットを奪う。
        assert_eq!(tt.probe(deeper_colliding_hash), Some(deeper));
        // 元の浅いエントリはdepth優先スロットから追い出され取得できなくなる
        // (本実装ではdepth優先スロット上書き時に旧エントリの退避は行わない仕様とする)。
        assert_eq!(tt.probe(base_hash), None);
    }
}
