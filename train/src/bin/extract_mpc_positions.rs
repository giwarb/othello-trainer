//! T156a: WTHOR から MPC 校正用の決定的な層化局面集合を抽出する。

use engine::bitboard::{Board, Side};
use serde::Serialize;
use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use train::train_data::samples_from_game;
use train::wthor;

const DEFAULT_SEED: u64 = 156_2026_0720;
const BUCKETS: [(u32, u32); 4] = [(21, 28), (29, 36), (37, 44), (45, 52)];
const SPLITS: [(&str, usize, usize); 3] = [
    ("calibration", 180, 48),
    ("tuning", 60, 16),
    ("test", 60, 16),
];

#[derive(Clone)]
struct Candidate {
    board: Board,
    side: Side,
    empties: u32,
    bucket: usize,
    split: &'static str,
    game_id: String,
    order_key: [u8; 32],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputPosition {
    id: String,
    board: String,
    side_to_move: &'static str,
    empties: u32,
    empty_bucket: String,
    split: &'static str,
    game_id: String,
    pilot: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceFile {
    path: String,
    bytes: usize,
    sha256: String,
    games: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Counts {
    full: usize,
    pilot: usize,
    by_bucket: Vec<BucketCounts>,
    by_split: Vec<SplitCounts>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BucketCounts {
    empty_bucket: String,
    full: usize,
    pilot: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SplitCounts {
    split: &'static str,
    full: usize,
    pilot: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Meta {
    schema_version: u32,
    seed: u64,
    source_files: Vec<SourceFile>,
    counts: Counts,
    output_path: String,
    output_sha256: String,
}

fn get_arg(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

fn bucket_name(index: usize) -> String {
    format!("{}-{}", BUCKETS[index].0, BUCKETS[index].1)
}

fn bucket_index(empties: u32) -> Option<usize> {
    BUCKETS
        .iter()
        .position(|&(lo, hi)| (lo..=hi).contains(&empties))
}

fn board_to_obf(board: &Board) -> String {
    (0..64)
        .map(|i| {
            let bit = 1u64 << i;
            if board.black & bit != 0 {
                'X'
            } else if board.white & bit != 0 {
                'O'
            } else {
                '-'
            }
        })
        .collect()
}

fn side_name(side: Side) -> &'static str {
    match side {
        Side::Black => "black",
        Side::White => "white",
    }
}

fn hash_parts(parts: &[&[u8]]) -> [u8; 32] {
    let mut bytes = Vec::new();
    for part in parts {
        bytes.extend_from_slice(&(part.len() as u64).to_le_bytes());
        bytes.extend_from_slice(part);
    }
    sha256(&bytes)
}

fn split_for_game(seed: u64, game_id: &str) -> &'static str {
    let key = hash_parts(&[&seed.to_le_bytes(), b"split", game_id.as_bytes()]);
    match u64::from_le_bytes(key[..8].try_into().unwrap()) % 100 {
        0..=59 => "calibration",
        60..=79 => "tuning",
        _ => "test",
    }
}

// ?
fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    fs::write(path, &bytes).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(bytes)
}
fn run(args: &[String]) -> Result<(), String> {
    let data_dir =
        PathBuf::from(get_arg(args, "--data-dir").unwrap_or_else(|| "train/data".into()));
    let out = PathBuf::from(
        get_arg(args, "--out")
            .unwrap_or_else(|| "bench/edax-compare/t156_mpc_positions.json".into()),
    );
    let meta = PathBuf::from(
        get_arg(args, "--meta")
            .unwrap_or_else(|| "bench/edax-compare/t156_mpc_positions.meta.json".into()),
    );
    let seed: u64 = get_arg(args, "--seed")
        .map(|s| s.parse().expect("invalid --seed"))
        .unwrap_or(DEFAULT_SEED);
    let mut paths: Vec<PathBuf> = fs::read_dir(&data_dir)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("wtb")))
        .collect();
    paths.sort();
    if paths.is_empty() {
        return Err("no WTHOR files".into());
    }
    let mut sources = Vec::new();
    let mut candidates = Vec::new();
    for path in paths {
        let bytes = fs::read(&path).map_err(|e| e.to_string())?;
        let parsed = wthor::parse(&bytes).map_err(|e| e.to_string())?;
        let file_name = path.file_name().unwrap().to_string_lossy();
        sources.push(SourceFile {
            path: path.to_string_lossy().replace('\\', "/"),
            bytes: bytes.len(),
            sha256: hex(&sha256(&bytes)),
            games: parsed.games.len(),
        });
        for (game_index, game) in parsed.games.iter().enumerate() {
            let game_id = format!("{}#{game_index}", file_name);
            let split = split_for_game(seed, &game_id);
            let samples = match samples_from_game(&game.moves) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let mut per_bucket: [Vec<_>; 4] = std::array::from_fn(|_| Vec::new());
            for sample in samples {
                if sample.board.has_legal_move(sample.mover) {
                    if let Some(bucket) = bucket_index(sample.board.empty_count()) {
                        per_bucket[bucket].push(sample)
                    }
                }
            }
            for (bucket, choices) in per_bucket.into_iter().enumerate() {
                if choices.is_empty() {
                    continue;
                }
                let choice_key = hash_parts(&[
                    &seed.to_le_bytes(),
                    b"within-game",
                    game_id.as_bytes(),
                    &(bucket as u64).to_le_bytes(),
                ]);
                let pick = choices[u64::from_le_bytes(choice_key[..8].try_into().unwrap())
                    as usize
                    % choices.len()];
                let obf = board_to_obf(&pick.board);
                let order_key = hash_parts(&[
                    &seed.to_le_bytes(),
                    b"order",
                    game_id.as_bytes(),
                    &(bucket as u64).to_le_bytes(),
                    obf.as_bytes(),
                    side_name(pick.mover).as_bytes(),
                ]);
                candidates.push(Candidate {
                    board: pick.board,
                    side: pick.mover,
                    empties: pick.board.empty_count(),
                    bucket,
                    split,
                    game_id: game_id.clone(),
                    order_key,
                });
            }
        }
    }
    let mut selected = Vec::with_capacity(1200);
    let mut seen = HashSet::new();
    for bucket in 0..BUCKETS.len() {
        for &(split, wanted, pilot_wanted) in &SPLITS {
            let mut pool: Vec<_> = candidates
                .iter()
                .filter(|c| c.bucket == bucket && c.split == split)
                .cloned()
                .collect();
            pool.sort_by_key(|c| c.order_key);
            let mut accepted = Vec::with_capacity(wanted);
            for candidate in pool {
                let key = (
                    candidate.board.black,
                    candidate.board.white,
                    side_name(candidate.side),
                );
                if seen.insert(key) {
                    accepted.push(candidate)
                }
                if accepted.len() == wanted {
                    break;
                }
            }
            if accepted.len() != wanted {
                return Err(format!(
                    "bucket {} split {split}: wanted {wanted}, got {}",
                    bucket_name(bucket),
                    accepted.len()
                ));
            }
            for (index, c) in accepted.into_iter().enumerate() {
                selected.push(OutputPosition {
                    id: format!("mpc-{}-{split}-{:03}", bucket_name(bucket), index + 1),
                    board: board_to_obf(&c.board),
                    side_to_move: side_name(c.side),
                    empties: c.empties,
                    empty_bucket: bucket_name(bucket),
                    split,
                    game_id: c.game_id,
                    pilot: index < pilot_wanted,
                })
            }
        }
    }
    let output_bytes = write_json(&out, &selected)?;
    let counts = Counts {
        full: selected.len(),
        pilot: selected.iter().filter(|p| p.pilot).count(),
        by_bucket: (0..4)
            .map(|b| {
                let name = bucket_name(b);
                BucketCounts {
                    full: selected.iter().filter(|p| p.empty_bucket == name).count(),
                    pilot: selected
                        .iter()
                        .filter(|p| p.empty_bucket == name && p.pilot)
                        .count(),
                    empty_bucket: name,
                }
            })
            .collect(),
        by_split: SPLITS
            .iter()
            .map(|&(s, _, _)| SplitCounts {
                split: s,
                full: selected.iter().filter(|p| p.split == s).count(),
                pilot: selected.iter().filter(|p| p.split == s && p.pilot).count(),
            })
            .collect(),
    };
    let manifest = Meta {
        schema_version: 1,
        seed,
        source_files: sources,
        counts,
        output_path: out.to_string_lossy().replace('\\', "/"),
        output_sha256: hex(&sha256(&output_bytes)),
    };
    write_json(&meta, &manifest)?;
    eprintln!(
        "wrote {} positions ({} pilot)",
        selected.len(),
        selected.iter().filter(|p| p.pilot).count()
    );
    Ok(())
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("extract_mpc_positions: {e}");
            ExitCode::FAILURE
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn sha256(input: &[u8]) -> [u8; 32] {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut h = [
        0x6a09e667u32,
        0xbb67ae85,
        0x3c6ef372,
        0xa54ff53a,
        0x510e527f,
        0x9b05688c,
        0x1f83d9ab,
        0x5be0cd19,
    ];
    let mut data = input.to_vec();
    let bit_len = (data.len() as u64) * 8;
    data.push(0x80);
    while data.len() % 64 != 56 {
        data.push(0)
    }
    data.extend_from_slice(&bit_len.to_be_bytes());
    for chunk in data.chunks_exact(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes(chunk[i * 4..i * 4 + 4].try_into().unwrap())
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1)
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut z] = h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ (!e & g);
            let t1 = z
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            z = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(s0.wrapping_add(maj))
        }
        for (x, v) in h.iter_mut().zip([a, b, c, d, e, f, g, z]) {
            *x = x.wrapping_add(v)
        }
    }
    let mut out = [0u8; 32];
    for (i, v) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&v.to_be_bytes())
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sha_vector() {
        assert_eq!(
            hex(&sha256(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        )
    }
    #[test]
    fn bucket_edges() {
        assert_eq!(bucket_index(20), None);
        assert_eq!(bucket_index(21), Some(0));
        assert_eq!(bucket_index(52), Some(3));
        assert_eq!(bucket_index(53), None)
    }
    #[test]
    fn split_deterministic() {
        assert_eq!(split_for_game(7, "x#1"), split_for_game(7, "x#1"))
    }
}
