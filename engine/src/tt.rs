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

use std::cmp::Ordering;

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TTDomain {
    Midgame,
    Exact,
}

/// 置換表の1エントリ。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TTEntry {
    /// 局面のZobristハッシュ(衝突検出のため64bit全体を保持する)。
    pub hash: u64,
    pub domain: TTDomain,
    /// このエントリを格納した際の探索深さ。
    pub depth: i8,
    /// 評価値。
    pub score: i32,
    /// `score` が exact / lower-bound / upper-bound のいずれであるかを表す。
    pub bound: Bound,
    /// 最善手(マス番号 0..63)。パスや未確定の場合は `None`。
    pub best_move: Option<u8>,
}

/// TT内部の16-byte表現。探索深さは0..64しか使わないため、`depth_and_domain`
/// の上位1bitにdomainを格納し、T085以前のバケット容量を維持する。
#[derive(Debug, Clone, Copy)]
struct StoredTTEntry {
    hash: u64,
    depth_and_domain: u8,
    score: i32,
    bound: Bound,
    best_move: Option<u8>,
}

impl StoredTTEntry {
    fn from_entry(entry: TTEntry) -> Self {
        debug_assert!((0..=64).contains(&entry.depth));
        let domain_bit = match entry.domain {
            TTDomain::Midgame => 0,
            TTDomain::Exact => 0x80,
        };
        Self {
            hash: entry.hash,
            depth_and_domain: (entry.depth as u8 & 0x7f) | domain_bit,
            score: entry.score,
            bound: entry.bound,
            best_move: entry.best_move,
        }
    }

    fn domain(self) -> TTDomain {
        if self.depth_and_domain & 0x80 == 0 {
            TTDomain::Midgame
        } else {
            TTDomain::Exact
        }
    }

    fn depth(self) -> i8 {
        (self.depth_and_domain & 0x7f) as i8
    }

    fn into_entry(self) -> TTEntry {
        TTEntry {
            hash: self.hash,
            domain: self.domain(),
            depth: self.depth(),
            score: self.score,
            bound: self.bound,
            best_move: self.best_move,
        }
    }

    /// 設計書 T086 §4.2 の品質順序で比較する。
    ///
    /// Lower と Upper の間には強弱を定義せず、同じ種類の bound 同士だけ
    /// score を比較する。品質が完全に同じ場合の「新しい方を優先」は、
    /// 呼び出し側が `Ordering::Equal` のとき新規を選ぶことで実現する。
    fn quality_cmp(self, other: Self) -> Ordering {
        self.depth()
            .cmp(&other.depth())
            .then_with(|| match (self.bound, other.bound) {
                (Bound::Exact, Bound::Exact) => Ordering::Equal,
                (Bound::Exact, _) => Ordering::Greater,
                (_, Bound::Exact) => Ordering::Less,
                (Bound::Lower, Bound::Lower) => self.score.cmp(&other.score),
                (Bound::Upper, Bound::Upper) => other.score.cmp(&self.score),
                _ => Ordering::Equal,
            })
            .then_with(|| self.best_move.is_some().cmp(&other.best_move.is_some()))
    }

    fn same_position(self, other: Self) -> bool {
        self.hash == other.hash && self.domain() == other.domain()
    }

    fn with_move_from(mut self, other: Self) -> Self {
        if self.best_move.is_none() {
            self.best_move = other.best_move;
        }
        self
    }
}

/// 1つのインデックスに対応するバケット。depth優先スロットとalways-replaceスロットを持つ。
#[derive(Debug, Clone, Copy)]
struct Bucket {
    depth_slot: Option<StoredTTEntry>,
    always_slot: Option<StoredTTEntry>,
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
    pub fn probe(&self, hash: u64, domain: TTDomain) -> Option<TTEntry> {
        let bucket = &self.buckets[self.index(hash)];
        let matches = |entry: StoredTTEntry| entry.hash == hash && entry.domain() == domain;

        match (
            bucket.depth_slot.filter(|entry| matches(*entry)),
            bucket.always_slot.filter(|entry| matches(*entry)),
        ) {
            (Some(depth), Some(always)) => Some(
                if !always.quality_cmp(depth).is_lt() {
                    always
                } else {
                    depth
                }
                .into_entry(),
            ),
            (Some(entry), None) | (None, Some(entry)) => Some(entry.into_entry()),
            (None, None) => None,
        }
    }

    /// 2-tier方式でエントリを格納する。
    ///
    /// 同一局面は品質順序で保護し、異なる局面の衝突ではdepth優先スロットに
    /// 高品質なエントリ、always-replaceスロットに最新の候補を保持する。
    pub fn store(&mut self, entry: TTEntry) {
        let idx = self.index(entry.hash);
        let bucket = &mut self.buckets[idx];
        let stored = StoredTTEntry::from_entry(entry);

        let depth_match = bucket
            .depth_slot
            .filter(|existing| existing.same_position(stored));
        let always_match = bucket
            .always_slot
            .filter(|existing| existing.same_position(stored));

        match (depth_match, always_match) {
            (Some(depth), Some(always)) => {
                // 旧実装等が残した重複も、このstoreを機に高品質側へ統合する。
                let existing = if !always.quality_cmp(depth).is_lt() {
                    always
                } else {
                    depth
                };
                let selected = if stored.quality_cmp(existing).is_lt() {
                    existing.with_move_from(stored)
                } else {
                    stored.with_move_from(existing)
                };
                bucket.depth_slot = Some(selected);
                bucket.always_slot = None;
            }
            (Some(existing), None) => {
                bucket.depth_slot = Some(if stored.quality_cmp(existing).is_lt() {
                    existing.with_move_from(stored)
                } else {
                    stored.with_move_from(existing)
                });
            }
            (None, Some(existing)) if stored.quality_cmp(existing).is_lt() => {
                bucket.always_slot = Some(existing.with_move_from(stored));
            }
            (None, Some(existing)) => {
                bucket.always_slot = None;
                Self::store_collision(bucket, stored.with_move_from(existing));
            }
            (None, None) => Self::store_collision(bucket, stored),
        }
    }

    fn store_collision(bucket: &mut Bucket, stored: StoredTTEntry) {
        let Some(depth) = bucket.depth_slot else {
            bucket.depth_slot = Some(stored);
            return;
        };

        if stored.quality_cmp(depth).is_lt() {
            // depth側を守り、最新エントリをalways側へ入れる。
            bucket.always_slot = Some(stored);
            return;
        }

        // 同品質なら新しい方をdepth側へ置く。追い出したdepth側は、現在の
        // always側より高品質な場合に限り退避する。
        bucket.depth_slot = Some(stored);
        match bucket.always_slot {
            None => bucket.always_slot = Some(depth),
            Some(always) if depth.quality_cmp(always).is_gt() => bucket.always_slot = Some(depth),
            Some(_) => {}
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

    #[test]
    fn compact_domain_storage_preserves_pre_t085_bucket_size() {
        assert_eq!(std::mem::size_of::<StoredTTEntry>(), 16);
        assert_eq!(std::mem::size_of::<Bucket>(), 32);
    }

    fn sample_entry(
        hash: u64,
        depth: i8,
        score: i32,
        bound: Bound,
        best_move: Option<u8>,
    ) -> TTEntry {
        TTEntry {
            hash,
            domain: TTDomain::Midgame,
            depth,
            score,
            bound,
            best_move,
        }
    }

    #[test]
    fn probe_on_empty_table_returns_none() {
        let tt = TranspositionTable::new(1);
        assert_eq!(tt.probe(0, TTDomain::Midgame), None);
        assert_eq!(tt.probe(12345, TTDomain::Midgame), None);
    }

    #[test]
    fn store_then_probe_returns_same_entry() {
        let mut tt = TranspositionTable::new(1);
        let entry = sample_entry(42, 5, -123, Bound::Lower, Some(10));
        tt.store(entry);
        assert_eq!(tt.probe(42, TTDomain::Midgame), Some(entry));
    }

    #[test]
    fn probe_does_not_match_a_different_hash_in_the_same_bucket() {
        let mut tt = TranspositionTable::new(1);
        let bucket_count = tt.bucket_count() as u64;
        let entry = sample_entry(7, 3, 1, Bound::Exact, None);
        tt.store(entry);

        // 同じバケットにマップされるが異なるハッシュ値。
        let colliding_hash = 7 + bucket_count;
        assert_eq!(tt.probe(colliding_hash, TTDomain::Midgame), None);
        // 元のハッシュは引き続き取得できる。
        assert_eq!(tt.probe(7, TTDomain::Midgame), Some(entry));
    }

    #[test]
    fn clear_empties_all_entries() {
        let mut tt = TranspositionTable::new(1);
        tt.store(sample_entry(1, 1, 1, Bound::Exact, None));
        tt.store(sample_entry(2, 1, 1, Bound::Exact, None));
        tt.clear();
        assert_eq!(tt.probe(1, TTDomain::Midgame), None);
        assert_eq!(tt.probe(2, TTDomain::Midgame), None);
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
            tt.probe(base_hash, TTDomain::Midgame),
            Some(deep_entry),
            "depth-preferred slot should keep the deep entry"
        );

        // always-replaceスロットには最後に格納した浅いエントリだけが残っている
        // (途中の衝突ハッシュはすべて上書きされて取得できなくなる)。
        let (last_hash, last_entry) = last_shallow.expect("at least one shallow entry was stored");
        assert_eq!(tt.probe(last_hash, TTDomain::Midgame), Some(last_entry));

        let earlier_colliding_hash = base_hash + bucket_count; // i = 1 の時に格納したもの
        assert_eq!(
            tt.probe(earlier_colliding_hash, TTDomain::Midgame),
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
        assert_eq!(
            tt.probe(deeper_colliding_hash, TTDomain::Midgame),
            Some(deeper)
        );
        // 追い出された元のエントリは空いていたalwaysスロットへ退避される。
        assert_eq!(tt.probe(base_hash, TTDomain::Midgame), Some(shallow));
    }

    #[test]
    fn same_hash_can_hold_midgame_and_exact_domains() {
        let mut tt = TranspositionTable::new(1);
        let midgame = sample_entry(99, 4, 1234, Bound::Exact, Some(10));
        let mut exact = sample_entry(99, 4, -7, Bound::Exact, Some(11));
        exact.domain = TTDomain::Exact;
        tt.store(midgame);
        tt.store(exact);
        assert_eq!(tt.probe(99, TTDomain::Midgame), Some(midgame));
        assert_eq!(tt.probe(99, TTDomain::Exact), Some(exact));
        assert_eq!(tt.probe(99, TTDomain::Midgame).unwrap().score, 1234);
        assert_eq!(tt.probe(99, TTDomain::Exact).unwrap().score, -7);
    }

    #[test]
    fn exact_disc_score_is_not_visible_to_midgame_probe() {
        let mut tt = TranspositionTable::new(1);
        let mut exact = sample_entry(7, 12, -9, Bound::Exact, Some(3));
        exact.domain = TTDomain::Exact;
        tt.store(exact);
        assert_eq!(tt.probe(7, TTDomain::Midgame), None);
    }

    #[test]
    fn midgame_centidisc_score_is_not_visible_to_exact_probe() {
        let mut tt = TranspositionTable::new(1);
        let midgame = sample_entry(8, 6, 1750, Bound::Exact, Some(4));
        tt.store(midgame);
        assert_eq!(tt.probe(8, TTDomain::Exact), None);
    }

    #[test]
    fn deep_exact_survives_shallow_bounds() {
        for bound in [Bound::Lower, Bound::Upper] {
            let mut tt = TranspositionTable::new(1);
            let deep = sample_entry(101, 12, 700, Bound::Exact, Some(8));
            tt.store(deep);
            tt.store(sample_entry(101, 5, -999, bound, Some(9)));
            assert_eq!(tt.probe(101, TTDomain::Midgame), Some(deep));
        }
    }

    #[test]
    fn exact_replaces_bound_at_the_same_depth() {
        let mut tt = TranspositionTable::new(1);
        tt.store(sample_entry(102, 8, 100, Bound::Lower, Some(1)));
        let exact = sample_entry(102, 8, 50, Bound::Exact, Some(2));
        tt.store(exact);
        assert_eq!(tt.probe(102, TTDomain::Midgame), Some(exact));
    }

    #[test]
    fn deeper_bound_beats_shallow_exact() {
        let mut tt = TranspositionTable::new(1);
        let deeper = sample_entry(103, 9, 10, Bound::Upper, None);
        tt.store(deeper);
        tt.store(sample_entry(103, 8, 20, Bound::Exact, Some(3)));
        assert_eq!(
            tt.probe(103, TTDomain::Midgame),
            Some(TTEntry {
                best_move: Some(3),
                ..deeper
            })
        );
    }

    #[test]
    fn stronger_same_kind_bound_is_kept() {
        let mut lower_tt = TranspositionTable::new(1);
        let strong_lower = sample_entry(104, 7, 300, Bound::Lower, Some(4));
        lower_tt.store(strong_lower);
        lower_tt.store(sample_entry(104, 7, 200, Bound::Lower, Some(5)));
        assert_eq!(lower_tt.probe(104, TTDomain::Midgame), Some(strong_lower));

        let mut upper_tt = TranspositionTable::new(1);
        let strong_upper = sample_entry(105, 7, -300, Bound::Upper, Some(6));
        upper_tt.store(strong_upper);
        upper_tt.store(sample_entry(105, 7, -200, Bound::Upper, Some(7)));
        assert_eq!(upper_tt.probe(105, TTDomain::Midgame), Some(strong_upper));
    }

    #[test]
    fn inferior_store_can_only_complete_a_missing_move() {
        let mut tt = TranspositionTable::new(1);
        let deep = sample_entry(106, 10, 400, Bound::Exact, None);
        tt.store(deep);
        tt.store(sample_entry(106, 3, -1, Bound::Upper, Some(17)));
        assert_eq!(
            tt.probe(106, TTDomain::Midgame),
            Some(TTEntry {
                best_move: Some(17),
                ..deep
            })
        );
    }

    #[test]
    fn probe_compares_both_slots_instead_of_using_slot_order() {
        let mut tt = TranspositionTable::new(1);
        let hash = 107;
        let shallow = sample_entry(hash, 3, 1, Bound::Exact, Some(1));
        let deep = sample_entry(hash, 11, 2, Bound::Lower, Some(2));
        let idx = tt.index(hash);
        tt.buckets[idx].depth_slot = Some(StoredTTEntry::from_entry(shallow));
        tt.buckets[idx].always_slot = Some(StoredTTEntry::from_entry(deep));
        assert_eq!(tt.probe(hash, TTDomain::Midgame), Some(deep));

        tt.buckets[idx].depth_slot = Some(StoredTTEntry::from_entry(deep));
        tt.buckets[idx].always_slot = Some(StoredTTEntry::from_entry(shallow));
        assert_eq!(tt.probe(hash, TTDomain::Midgame), Some(deep));
    }

    #[test]
    fn promoted_collision_evacuates_displaced_depth_when_it_is_better() {
        let mut tt = TranspositionTable::new(1);
        let stride = tt.bucket_count() as u64;
        let base = sample_entry(11, 8, 10, Bound::Exact, Some(1));
        let weak = sample_entry(11 + stride, 2, 20, Bound::Upper, Some(2));
        let strongest = sample_entry(11 + 2 * stride, 10, 30, Bound::Lower, Some(3));
        tt.store(base);
        tt.store(weak);
        tt.store(strongest);
        assert_eq!(tt.probe(strongest.hash, TTDomain::Midgame), Some(strongest));
        assert_eq!(tt.probe(base.hash, TTDomain::Midgame), Some(base));
        assert_eq!(tt.probe(weak.hash, TTDomain::Midgame), None);
    }

    #[test]
    fn same_position_is_not_duplicated_across_slots() {
        let mut tt = TranspositionTable::new(1);
        let stride = tt.bucket_count() as u64;
        let blocker = sample_entry(19, 12, 1, Bound::Exact, Some(1));
        let first = sample_entry(19 + stride, 3, 2, Bound::Upper, None);
        let promoted = sample_entry(19 + stride, 11, 3, Bound::Exact, Some(2));
        tt.store(blocker);
        tt.store(first);
        tt.store(promoted);

        let bucket = &tt.buckets[tt.index(promoted.hash)];
        let copies = [bucket.depth_slot, bucket.always_slot]
            .into_iter()
            .flatten()
            .filter(|entry| entry.same_position(StoredTTEntry::from_entry(promoted)))
            .count();
        assert_eq!(copies, 1);
        assert_eq!(tt.probe(promoted.hash, TTDomain::Midgame), Some(promoted));
    }

    #[test]
    fn fully_equal_quality_prefers_the_new_entry() {
        let mut tt = TranspositionTable::new(1);
        tt.store(sample_entry(108, 6, 10, Bound::Exact, Some(4)));
        let newer = sample_entry(108, 6, 20, Bound::Exact, Some(4));
        tt.store(newer);
        assert_eq!(tt.probe(108, TTDomain::Midgame), Some(newer));
    }

    #[test]
    fn collision_stress_never_returns_a_wrong_hash_or_domain() {
        let mut tt = TranspositionTable::new(1);
        let stride = tt.bucket_count() as u64;
        let base = 1234u64;

        for i in 0..10_000u64 {
            let mut entry = sample_entry(
                base + i * stride,
                (i % 65) as i8,
                i as i32 - 5000,
                match i % 3 {
                    0 => Bound::Exact,
                    1 => Bound::Lower,
                    _ => Bound::Upper,
                },
                (i % 2 == 0).then_some((i % 64) as u8),
            );
            entry.domain = if i % 2 == 0 {
                TTDomain::Midgame
            } else {
                TTDomain::Exact
            };
            tt.store(entry);
        }

        for i in 0..10_000u64 {
            let hash = base + i * stride;
            for domain in [TTDomain::Midgame, TTDomain::Exact] {
                if let Some(entry) = tt.probe(hash, domain) {
                    assert_eq!(entry.hash, hash);
                    assert_eq!(entry.domain, domain);
                }
            }
        }
    }
}
