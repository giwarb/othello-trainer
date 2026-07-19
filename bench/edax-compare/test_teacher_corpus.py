#!/usr/bin/env python3
"""T090a teacher corpus pipeline regression tests (no Edax calls)."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("gen_teacher_corpus", HERE / "gen_teacher_corpus.py")
assert SPEC and SPEC.loader
gen = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gen)
VERIFY_SPEC = importlib.util.spec_from_file_location("verify_teacher_corpus", HERE / "verify_teacher_corpus.py")
assert VERIFY_SPEC and VERIFY_SPEC.loader
verify = importlib.util.module_from_spec(VERIFY_SPEC)
VERIFY_SPEC.loader.exec_module(verify)
FINALIZE_SPEC = importlib.util.spec_from_file_location("finalize_teacher_corpus", HERE / "finalize_teacher_corpus.py")
assert FINALIZE_SPEC and FINALIZE_SPEC.loader
finalize = importlib.util.module_from_spec(FINALIZE_SPEC)
FINALIZE_SPEC.loader.exec_module(finalize)


# --- T143(要件8): 合成WTHOR(.wtb)入力を組み立てるヘルパー。
# `train/src/wthor.rs`のドキュメントコメント(ヘッダ16バイト、ゲームレコード68バイト)と
# 同ファイルの単体テストが使う既知の合法手順(f5 d6 c3 d3 c4 f4 f6 f3 g4 g3、
# `replay_accepts_known_legal_opening_sequence`で合法性検証済み)をそのまま流用する。
_WTB_RECORD_LEN = 68
_WTB_KNOWN_LEGAL_MOVE_BYTES = [56, 64, 33, 34, 43, 46, 66, 36, 47, 37]  # f5 d6 c3 d3 c4 f4 f6 f3 g4 g3


def _build_wtb_header(year_of_games: int, num_games: int) -> bytes:
    return (
        bytes([20, 26, 2, 23])  # 作成日(任意の固定値、wthor.rsのsample_2024_header_bytesと同じ流儀)
        + num_games.to_bytes(4, "little")
        + (0).to_bytes(2, "little")  # N2=0(通常のゲームアーカイブ)
        + year_of_games.to_bytes(2, "little")
        + bytes([8, 0, 24, 0])  # P1=8(8x8盤)、P2=0(通常)、P3=24(理論スコア深さ、任意)、予約
    )


def _build_wtb_game_record(
    tournament: int, black_player: int, white_player: int, black_disc_count: int, theoretical_score: int, move_bytes: list[int]
) -> bytes:
    assert len(move_bytes) <= 60
    record = bytearray()
    record += tournament.to_bytes(2, "little")
    record += black_player.to_bytes(2, "little")
    record += white_player.to_bytes(2, "little")
    record.append(black_disc_count)
    record.append(theoretical_score)
    record += bytes(move_bytes)
    record += bytes(_WTB_RECORD_LEN - len(record))  # 0パディング(それ以降着手なし)
    return bytes(record)


def _build_wtb_bytes(year_of_games: int, games: list[list[int]]) -> bytes:
    header = _build_wtb_header(year_of_games, len(games))
    body = b"".join(
        _build_wtb_game_record(9, 100 + i, 200 + i, 37, 29, moves) for i, moves in enumerate(games)
    )
    return header + body


class TeacherCorpusTests(unittest.TestCase):
    @staticmethod
    def valid_corpus_record(
        board: str = "---------------------------OX------XO---------------------------", side: str = "black"
    ) -> dict:
        base = {"board": board, "sideToMove": side}
        legal = verify.compute_children([base])[0]["moves"]
        canonical = verify.compute_canonical_keys([base])[0]
        children = []
        for index, move in enumerate(legal):
            value = float(index)
            children.append(
                {
                    "move": move["move"],
                    "value": value,
                    "diffFromBest": float(len(legal) - 1 - index),
                    "exact": False,
                    "level": 16,
                    "edaxDepth": 16,
                    "elapsedMs": 1.0,
                }
            )
        return {
            "positionId": 0,
            "board": board,
            "sideToMove": side,
            "empties": board.count("-"),
            "source": "engineLoss",
            "phaseBin": None,
            "hasXcLegalMove": None,
            "openingKey": None,
            "priorityLoss": 4.0,
            "canonicalKey": canonical,
            "children": children,
            "bestMove": children[-1]["move"],
            "bestValue": children[-1]["value"],
            "generatedAt": "2026-07-15T00:00:00+00:00",
        }

    def assert_verifier_rejects(self, records: list[dict]) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            data_dir = Path(temp_dir)
            (data_dir / "corpus_smoke.jsonl").write_text(
                "".join(json.dumps(record) + "\n" for record in records), encoding="utf-8", newline="\n"
            )
            count = len(records)
            (data_dir / "corpus_smoke.meta.json").write_text(
                json.dumps({"schemaVersion": 2, "progress": {"done": count, "total": count}}) + "\n",
                encoding="utf-8",
                newline="\n",
            )
            with mock.patch.object(verify, "TEACHER_DATA_DIR", data_dir):
                with mock.patch.object(verify.sys, "argv", ["verify_teacher_corpus.py", "smoke"]):
                    with self.assertRaises(SystemExit) as raised:
                        verify.main()
            self.assertEqual(raised.exception.code, 1)

    def test_edax_batch_parser_validates_problem_order_and_count(self) -> None:
        positions = [
            {"board": "board-one", "sideToMove": "black"},
            {"board": "board-two", "sideToMove": "white"},
        ]
        output = """*** problem # 1 ***
 depth|score| time | nodes | N/s | principal variation
    3   +04        0:00.001       10       10 d3
*** problem # 2 ***
 depth|score| time | nodes | N/s | principal variation
    5   -06        0:00.001       20       20 H8
"""
        parsed = gen.vs_edax._parse_edax_batch_output(output, positions, 16, 7, "ignored")
        self.assertEqual(
            parsed,
            [
                {"depth": 3, "discDiff": 4.0, "move": "d3"},
                {"depth": 5, "discDiff": -6.0, "move": "h8"},
            ],
        )
        for corrupt in (output.replace("problem # 2", "problem # 3"), output.split("*** problem # 2 ***")[0]):
            with self.assertRaisesRegex(RuntimeError, "ordering/count mismatch"):
                gen.vs_edax._parse_edax_batch_output(corrupt, positions, 16, 0, "")

    def test_label_position_batches_by_level_and_preserves_child_order(self) -> None:
        board = "---------------------------OX------XO---------------------------"
        position = {"board": board, "sideToMove": "black", "source": "engineLoss"}
        children_info = {
            "empties": 25,
            "moves": [
                {
                    "move": "a1",
                    "childBoard": "A" * 64,
                    "childSideToMove": "white",
                    "childEmpties": 25,
                    "childIsTerminal": False,
                },
                {
                    "move": "b2",
                    "childBoard": "B" * 64,
                    "childSideToMove": "black",
                    "childEmpties": 24,
                    "childIsTerminal": False,
                },
                {
                    "move": "c3",
                    "childBoard": "C" * 64,
                    "childSideToMove": "white",
                    "childEmpties": 25,
                    "childIsTerminal": False,
                },
            ],
        }
        calls = []

        def solve_batch(positions: list[dict], level: int) -> list[dict]:
            calls.append((level, [row["board"] for row in positions]))
            if level == gen.DEFAULT_EDAX_LEVEL:
                return [
                    {"depth": 16, "discDiff": -2.0, "move": "a1"},
                    {"depth": 16, "discDiff": 1.0, "move": "c3"},
                ]
            return [{"depth": 24, "discDiff": 5.0, "move": "b2"}]

        with mock.patch.object(gen.vs_edax, "edax_solve_batch", side_effect=solve_batch):
            record = gen.label_position(9, position, children_info)

        self.assertEqual(calls, [(16, ["A" * 64, "C" * 64]), (60, ["B" * 64])])
        self.assertEqual([child["move"] for child in record["children"]], ["a1", "b2", "c3"])
        self.assertEqual([child["value"] for child in record["children"]], [2.0, 5.0, -1.0])
        self.assertEqual(record["bestValue"], 5.0)
        self.assertEqual(record["children"][0]["elapsedMs"], record["children"][2]["elapsedMs"])

    def test_cross_parent_batch_matches_cold_values_and_aggregates_by_level(self) -> None:
        board = "---------------------------OX------XO---------------------------"
        parents = []
        for position_id, prefix in ((10, "A"), (11, "B")):
            position = {"board": board, "sideToMove": "black", "source": "wthor"}
            children = {
                "empties": 22,
                "moves": [
                    {"move": "a1", "childBoard": prefix * 64, "childSideToMove": "white",
                     "childEmpties": 21, "childIsTerminal": False},
                    {"move": "b2", "childBoard": prefix.lower() * 64, "childSideToMove": "white",
                     "childEmpties": 19, "childIsTerminal": False},
                ],
            }
            parents.append((position_id, position, children))

        calls = []

        def solve_batch(positions: list[dict], level: int) -> list[dict]:
            calls.append((level, [row["board"] for row in positions]))
            return [
                {"depth": 19 if level == 60 else 16,
                 "discDiff": float(ord(row["board"][0]) % 7), "move": "a1"}
                for row in positions
            ]

        with mock.patch.object(gen.vs_edax, "edax_solve_batch", side_effect=solve_batch):
            cold = [gen.label_position(*parent, exact_empties_threshold=20) for parent in parents]
            batched = gen.label_positions_across_parents(parents, exact_empties_threshold=20)
        for records in (cold, batched):
            for record in records:
                record.pop("generatedAt")
                for child in record["children"]:
                    child.pop("elapsedMs")
        self.assertEqual(batched, cold)
        self.assertEqual(calls[-2][0], 16)
        self.assertEqual(calls[-1][0], 60)
        self.assertEqual(len(calls[-2][1]), 2)
        self.assertEqual(len(calls[-1][1]), 2)

    def test_expanded1m_bundle_checkpoints_each_parent_in_plan_order(self) -> None:
        parents = [(7, {"positionId": 7}, {}), (15, {"positionId": 15}, {})]
        records = [{"positionId": 7}, {"positionId": 15}]
        checkpoint = mock.Mock()
        with mock.patch.object(gen, "label_positions_across_parents", return_value=records):
            fell_back = gen.checkpoint_expanded1m_parent_bundle(parents, checkpoint)
        self.assertFalse(fell_back)
        self.assertEqual(checkpoint.append.call_args_list, [mock.call(records[0]), mock.call(records[1])])

    def test_expanded1m_bundle_falls_back_to_individual_parents_before_checkpoint(self) -> None:
        parents = [(7, {"positionId": 7}, {}), (15, {"positionId": 15}, {})]
        records = [{"positionId": 7}, {"positionId": 15}]
        checkpoint = mock.Mock()
        with mock.patch.object(gen, "label_positions_across_parents", side_effect=RuntimeError("batch failed")):
            with mock.patch.object(gen, "label_position", side_effect=records) as individual:
                fell_back = gen.checkpoint_expanded1m_parent_bundle(parents, checkpoint)
        self.assertTrue(fell_back)
        self.assertEqual([call.args[0] for call in individual.call_args_list], [7, 15])
        self.assertEqual(checkpoint.append.call_args_list, [mock.call(records[0]), mock.call(records[1])])

    def test_expanded1m_bundle_fallback_checkpoints_each_parent_immediately(self) -> None:
        """T143(要件1・T127h申し送り): フォールバック経路は「束内の全親を
        ラベリングし終えてから一括checkpointする」実装だと、フォールバック中に
        プロセスが落ちたとき最大で束サイズ-1件分の完了済み計算結果が失われる
        (checkpoint未反映のまま消える)。各親をラベリングした直後に即
        `checkpoint.append()`されている(=次の親のラベリングが始まる前に、直前の
        親は既にcheckpoint済み)ことを、共有の呼び出し順序リストで検証する。"""
        parents = [(7, {"positionId": 7}, {}), (15, {"positionId": 15}, {}), (23, {"positionId": 23}, {})]
        records = {7: {"positionId": 7}, 15: {"positionId": 15}, 23: {"positionId": 23}}
        call_order: list[tuple[str, int]] = []

        def fake_label_position(position_id, position, children_info, **kwargs):
            call_order.append(("label", position_id))
            return records[position_id]

        def fake_append(record):
            call_order.append(("checkpoint", record["positionId"]))

        checkpoint = mock.Mock()
        checkpoint.append.side_effect = fake_append
        with mock.patch.object(gen, "label_positions_across_parents", side_effect=RuntimeError("batch failed")):
            with mock.patch.object(gen, "label_position", side_effect=fake_label_position):
                fell_back = gen.checkpoint_expanded1m_parent_bundle(parents, checkpoint)
        self.assertTrue(fell_back)
        # 各親のcheckpointが、次の親のlabel_position呼び出しより前に完了している
        # (束全体のラベリングが終わってからまとめてcheckpointする実装ではこうならない)。
        self.assertEqual(
            call_order,
            [
                ("label", 7), ("checkpoint", 7),
                ("label", 15), ("checkpoint", 15),
                ("label", 23), ("checkpoint", 23),
            ],
        )

    def test_label_position_respects_explicit_exact_empties_threshold(self) -> None:
        """T114移行(exactEmptiesThreshold 24→20 のexpanded200k版): `label_position`に
        既定(24)と異なる`exact_empties_threshold`を明示的に渡すと、その値で
        exact/level判定が行われることを確認する(childEmpties=21は閾値20超なので
        level=16、閾値24以下なので旧既定ではlevel=60になっていたはず)。"""
        board = "---------------------------OX------XO---------------------------"
        position = {"board": board, "sideToMove": "black", "source": "engineLoss"}
        children_info = {
            "empties": 22,
            "moves": [
                {
                    "move": "a1",
                    "childBoard": "A" * 64,
                    "childSideToMove": "white",
                    "childEmpties": 21,
                    "childIsTerminal": False,
                },
            ],
        }

        def solve_batch(positions: list[dict], level: int) -> list[dict]:
            self.assertEqual(level, gen.DEFAULT_EDAX_LEVEL)
            return [{"depth": 16, "discDiff": 3.0, "move": "a1"}]

        with mock.patch.object(gen.vs_edax, "edax_solve_batch", side_effect=solve_batch):
            record = gen.label_position(0, position, children_info, exact_empties_threshold=20)

        self.assertEqual(record["children"][0]["exact"], False)
        self.assertEqual(record["children"][0]["level"], gen.DEFAULT_EDAX_LEVEL)

    def test_corpus_sets_exact_empties_threshold_is_set_specific(self) -> None:
        """T114移行: `CORPUS_SETS`のexactEmptiesThreshold上書きはexpanded200kのみで、
        smoke/primaryは既定(グローバル定数24)のまま=settings/runKeyが不変であることを
        確認する(`generate()`と同じ`cfg.get(..., EXACT_EMPTIES_THRESHOLD)`パターン)。"""
        self.assertNotIn("exactEmptiesThreshold", gen.CORPUS_SETS["smoke"])
        self.assertNotIn("exactEmptiesThreshold", gen.CORPUS_SETS["primary"])
        self.assertEqual(
            gen.CORPUS_SETS["smoke"].get("exactEmptiesThreshold", gen.EXACT_EMPTIES_THRESHOLD), 24
        )
        self.assertEqual(
            gen.CORPUS_SETS["primary"].get("exactEmptiesThreshold", gen.EXACT_EMPTIES_THRESHOLD), 24
        )
        self.assertEqual(gen.CORPUS_SETS["expanded200k"]["exactEmptiesThreshold"], 20)
        self.assertEqual(
            gen.CORPUS_SETS["expanded200k"].get("exactEmptiesThreshold", gen.EXACT_EMPTIES_THRESHOLD), 20
        )

    def test_allocate_bin_targets_matches_fixed_expected_array(self) -> None:
        """T143(要件9・T127a申し送り): waterfall配分の期待配列を固定する回帰テスト。
        populations=[5,10,3,0,20,7], target=30に対する配分は手計算・実行の両方で
        [5,8,3,0,7,7](合計30)であることを確認済み(2026-07-20)。合計が母集団を
        超える/下回るエッジケースも合わせて固定する。"""
        self.assertEqual(gen.allocate_bin_targets([5, 10, 3, 0, 20, 7], 30), [5, 8, 3, 0, 7, 7])
        # 母集団合計(6)が目標(100)に届かない場合は、無限ループせず母集団上限で頭打ちになる。
        self.assertEqual(gen.allocate_bin_targets([1, 1, 1, 1, 1, 1], 100), [1, 1, 1, 1, 1, 1])
        # 母集団が全てゼロなら配分もすべてゼロ(クラッシュしない)。
        self.assertEqual(gen.allocate_bin_targets([0, 0, 0], 5), [0, 0, 0])
        # target=0なら何も配分しない。
        self.assertEqual(gen.allocate_bin_targets([5, 5], 0), [0, 0])

    def test_phase_allocation_and_xc_opening_constraints(self) -> None:
        positions = []
        for phase in range(6):
            for index in range(20):
                board = ["-"] * 64
                board[index] = "X"
                board[63 - index] = "O"
                positions.append(
                    {
                        "board": "".join(board),
                        "sideToMove": "black",
                        "phaseBin": phase,
                        "hasXcLegalMove": index < 12,
                        "openingKey": f"opening-{phase}-{index // 2}",
                        "source": "wthor",
                    }
                )
        selected, stats = gen.select_positions({"positions": positions}, [], 60, 7)
        self.assertEqual(len(selected), 60)
        for phase in range(6):
            rows = [row for row in selected if row["phaseBin"] == phase]
            self.assertGreaterEqual(sum(bool(row["hasXcLegalMove"]) for row in rows), 5)
        self.assertLessEqual(stats["maxOpeningCountSelected"], stats["openingMaxCount"])

    def test_select_positions_excludes_oracle_keys(self) -> None:
        """T114: `excluded_keys`(t096 oracleのcanonicalKey集合)に含まれる候補は
        優先層・WTHOR層のいずれからも除外され、統計に`oracleExclusion`が記録される。"""
        positions = []
        for phase in range(6):
            for index in range(20):
                board = ["-"] * 64
                board[index] = "X"
                board[63 - index] = "O"
                positions.append(
                    {
                        "board": "".join(board),
                        "sideToMove": "black",
                        "phaseBin": phase,
                        "hasXcLegalMove": index < 12,
                        "openingKey": f"opening-{phase}-{index // 2}",
                        "source": "wthor",
                    }
                )
        excluded_pool_row = positions[0]
        excluded_pool_key = gen.canonical_key_of_position(excluded_pool_row["board"], excluded_pool_row["sideToMove"])
        priority_row = {
            "board": positions[1]["board"],
            "sideToMove": positions[1]["sideToMove"],
            "source": "engineLoss",
            "priorityLoss": 5.0,
        }
        priority_key = gen.canonical_key_of_position(priority_row["board"], priority_row["sideToMove"])

        selected, stats = gen.select_positions(
            {"positions": positions},
            [priority_row],
            60,
            7,
            excluded_keys={excluded_pool_key, priority_key},
        )
        selected_keys = {gen.canonical_key_of_position(row["board"], row["sideToMove"]) for row in selected}
        self.assertNotIn(excluded_pool_key, selected_keys)
        self.assertNotIn(priority_key, selected_keys)
        self.assertEqual(stats["oracleExclusion"]["excludedKeyCount"], 2)
        self.assertEqual(stats["oracleExclusion"]["priorityPositionsExcluded"], 1)
        self.assertGreaterEqual(stats["oracleExclusion"]["poolPositionsExcluded"], 1)

    def test_select_positions_without_excluded_keys_is_unchanged(self) -> None:
        """excluded_keysを渡さない(=smoke/primaryの既存呼び出し)場合、statsに
        `oracleExclusion`が一切追加されないことを確認する(settings/runKey不変の保証)。"""
        positions = []
        for phase in range(6):
            for index in range(20):
                board = ["-"] * 64
                board[index] = "X"
                board[63 - index] = "O"
                positions.append(
                    {
                        "board": "".join(board),
                        "sideToMove": "black",
                        "phaseBin": phase,
                        "hasXcLegalMove": index < 12,
                        "openingKey": f"opening-{phase}-{index // 2}",
                        "source": "wthor",
                    }
                )
        _, stats = gen.select_positions({"positions": positions}, [], 60, 7)
        self.assertNotIn("oracleExclusion", stats)

    def test_select_positions_raises_when_pool_insufficient_for_target(self) -> None:
        """T143(要件4・T114申し送り): 候補プール(+優先層)の合計が目標に届かない場合、
        以前は`allocate_bin_targets`が静かに目標未満の配分を返すだけで、
        コーパスが実質空(またはtarget未満)のままEdaxラベリングまで気づかず
        進んでしまう経路があった。ラベリング開始前のこの時点で早期エラーにする。"""
        positions = [
            {
                "board": ("-" * i) + "X" + ("-" * (63 - i)),
                "sideToMove": "black",
                "phaseBin": 0,
                "hasXcLegalMove": False,
                "openingKey": f"opening-{i}",
                "source": "wthor",
            }
            for i in range(10)
        ]
        with self.assertRaisesRegex(RuntimeError, "candidate pool insufficient"):
            gen.select_positions({"positions": positions}, [], target_count=60, seed=7)

    def test_require_year_range_matched_games_raises_when_zero_games_in_range(self) -> None:
        """T143(要件4・T114申し送り): `--years`指定ミス(該当WTHORファイル/対局が
        0件)を、選定・Edaxラベリングより前に早期検出する。"""
        with self.assertRaisesRegex(RuntimeError, "no WTHOR games matched"):
            gen.require_year_range_matched_games(
                {"totalGamesInYearRange": 0}, "1999-1999", Path("candidates.json")
            )
        # 該当が1件でもあれば通過する(何も起きない)。
        gen.require_year_range_matched_games({"totalGamesInYearRange": 1}, "2015-2024", Path("candidates.json"))

    def test_extract_k1_end_to_end_output_sha_is_fixed(self) -> None:
        """T143(要件8・T127a申し送り): K=1(既定`--per-bin-cap`)の`teacher_candidates.exe
        extract`を、小さな合成WTHOR(.wtb)入力を通してend-to-endで実行し、出力の
        SHA-256を固定する回帰テスト(以前は手動のK=1 probeでしか確認されていなかった)。

        出力JSONの`dataDir`/`filesUsed`は一時ディレクトリの絶対パス(実行のたびに
        異なる)を含むため、SHA計算前にこの2フィールドだけ固定のプレースホルダへ
        正規化する(内容的に意味のある残り全フィールドはそのままハッシュ対象)。
        期待SHAは2026-07-20にこのテストを実行して得た値を固定したもの
        (`bench/edax-compare/test_teacher_corpus.py`のこのテスト自体の作業ログ参照)。"""
        with tempfile.TemporaryDirectory() as temp_dir:
            data_dir = Path(temp_dir)
            (data_dir / "WTH_test.wtb").write_bytes(
                _build_wtb_bytes(2001, [_WTB_KNOWN_LEGAL_MOVE_BYTES, _WTB_KNOWN_LEGAL_MOVE_BYTES[:6]])
            )
            out_path = data_dir / "candidates_test.json"
            result = subprocess.run(
                [
                    str(gen.TEACHER_CANDIDATES_TOOL),
                    "extract",
                    "--data-dir",
                    str(data_dir),
                    "--years",
                    "2001",
                    "--seed",
                    "555",
                    "--per-game-cap",
                    "6",
                    "--out",
                    str(out_path),
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            doc = json.loads(out_path.read_text(encoding="utf-8"))

        self.assertEqual(doc["totalGamesInYearRange"], 2)
        self.assertEqual(doc["totalCandidatesAfterDedup"], 2)
        doc["dataDir"] = "<data-dir>"
        doc["filesUsed"] = ["<data-dir>/WTH_test.wtb"]
        normalized = json.dumps(doc, sort_keys=True, separators=(",", ":")).encode("utf-8")
        self.assertEqual(
            hashlib.sha256(normalized).hexdigest(),
            "2646cc53b5b762e5b00b367747d0aae08b3f8211223dd3f6c7d1d6ff8bdbb758",
        )

    def test_python_rust_d4_agree(self) -> None:
        board = "X------O" + "-" * 48 + "O------X"
        proc = subprocess.run(
            [str(gen.TEACHER_CANDIDATES_TOOL), "canonical"],
            input=json.dumps([{"board": board, "sideToMove": "white"}]),
            capture_output=True,
            text=True,
            check=True,
        )
        rust_key = json.loads(proc.stdout)[0]
        self.assertEqual(rust_key, list(gen.canonical_key_of_position(board, "white")))

    def test_resume_truncates_malformed_tail(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            jsonl = root / "checkpoint.jsonl"
            meta = root / "checkpoint.meta.json"
            settings = {"setName": "test"}
            provenance = {key: f"value-{key}" for key in gen.PROVENANCE_IDENTITY_KEYS}
            run_key = json.dumps(settings, sort_keys=True)
            meta.write_text(
                json.dumps({"runKey": run_key, "meta": provenance, "settings": settings}), encoding="utf-8"
            )
            jsonl.write_bytes(b'{"positionId": 0}\n{"positionId":')
            checkpoint = gen.TeacherCorpusCheckpoint(jsonl, meta, run_key, settings, provenance)
            self.assertTrue(checkpoint.try_resume())
            self.assertEqual(jsonl.read_bytes(), b'{"positionId": 0}\n')
            self.assertEqual(checkpoint.done_ids, {0})
            remaining = [position_id for position_id in range(3) if not checkpoint.is_done(position_id)]
            self.assertEqual(remaining, [1, 2])
            for position_id in remaining:
                checkpoint.append({"positionId": position_id})
            checkpoint.close()
            self.assertEqual(
                [json.loads(line)["positionId"] for line in jsonl.read_text(encoding="utf-8").splitlines()],
                [0, 1, 2],
            )

    def test_resume_raises_on_corrupt_meta_without_start_fresh(self) -> None:
        """T143(要件3・T114申し送り): meta.jsonが不正JSON(破損)で、かつjsonlが
        存在する場合、以前は無条件でtry_resume()がFalseを返し、呼び出し元の
        `start_fresh()`がjsonlの内容(完了済み局面)を黙って空へ切り詰めていた。
        既定ではRuntimeErrorで停止し、jsonlの内容は一切変更されないことを確認する。"""
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            jsonl = root / "checkpoint.jsonl"
            meta = root / "checkpoint.meta.json"
            meta.write_text("{not valid json", encoding="utf-8")
            original_bytes = b'{"positionId": 0}\n{"positionId": 1}\n'
            jsonl.write_bytes(original_bytes)
            settings = {"setName": "test"}
            provenance = {key: f"value-{key}" for key in gen.PROVENANCE_IDENTITY_KEYS}
            run_key = json.dumps(settings, sort_keys=True)
            checkpoint = gen.TeacherCorpusCheckpoint(jsonl, meta, run_key, settings, provenance)
            with self.assertRaisesRegex(RuntimeError, "could not be parsed as JSON"):
                checkpoint.try_resume()
            self.assertEqual(jsonl.read_bytes(), original_bytes)

    def test_resume_start_fresh_flag_allows_corrupt_meta_to_be_discarded(self) -> None:
        """T143(要件3): `--start-fresh`(start_fresh_allowed=True)を明示したときだけ、
        meta.json破損時もtry_resume()がFalseを返し(切り詰めが起きる旧来の呼び出し
        パターンが働く)、意図的な再生成として進められる。"""
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            jsonl = root / "checkpoint.jsonl"
            meta = root / "checkpoint.meta.json"
            meta.write_text("{not valid json", encoding="utf-8")
            jsonl.write_bytes(b'{"positionId": 0}\n')
            settings = {"setName": "test"}
            provenance = {key: f"value-{key}" for key in gen.PROVENANCE_IDENTITY_KEYS}
            run_key = json.dumps(settings, sort_keys=True)
            checkpoint = gen.TeacherCorpusCheckpoint(
                jsonl, meta, run_key, settings, provenance, start_fresh_allowed=True
            )
            self.assertFalse(checkpoint.try_resume())
            checkpoint.start_fresh()
            self.assertEqual(jsonl.read_bytes(), b"")

    def test_resume_ignores_gitcommit_change(self) -> None:
        """T114 resume堅牢化: `gitCommit`はPROVENANCE_IDENTITY_KEYSから除外済みのため、
        無関係コミットでHEADが進んだだけ(gitCommitのみ変化)ではresumeを拒否しない
        (2026-07-16のresume失敗事故の再発防止)。"""
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            jsonl = root / "checkpoint.jsonl"
            meta = root / "checkpoint.meta.json"
            settings = {"setName": "test"}
            provenance = {key: f"value-{key}" for key in gen.PROVENANCE_IDENTITY_KEYS}
            provenance["gitCommit"] = "abc123"
            run_key = json.dumps(settings, sort_keys=True)
            meta.write_text(
                json.dumps({"runKey": run_key, "meta": provenance, "settings": settings}), encoding="utf-8"
            )
            jsonl.write_bytes(b'{"positionId": 0}\n')
            changed = dict(provenance)
            changed["gitCommit"] = "different-head"
            checkpoint = gen.TeacherCorpusCheckpoint(jsonl, meta, run_key, settings, changed)
            self.assertTrue(checkpoint.try_resume())
            self.assertEqual(checkpoint.done_ids, {0})
            self.assertEqual(jsonl.read_bytes(), b'{"positionId": 0}\n')

    def test_resume_raises_on_provenance_mismatch_without_flags(self) -> None:
        """T114 resume堅牢化: identity不一致は既定で切り詰めではなくRuntimeErrorで
        停止し、既存jsonlの内容は一切変更されない。"""
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            jsonl = root / "checkpoint.jsonl"
            meta = root / "checkpoint.meta.json"
            settings = {"setName": "test"}
            provenance = {key: f"value-{key}" for key in gen.PROVENANCE_IDENTITY_KEYS}
            run_key = json.dumps(settings, sort_keys=True)
            meta.write_text(
                json.dumps({"runKey": run_key, "meta": provenance, "settings": settings}), encoding="utf-8"
            )
            original_bytes = b'{"positionId": 0}\n{"positionId": 1}\n'
            jsonl.write_bytes(original_bytes)
            changed = dict(provenance)
            changed["edaxSha256"] = "different-edax-sha"
            rejected = gen.TeacherCorpusCheckpoint(jsonl, meta, run_key, settings, changed)
            with self.assertRaisesRegex(RuntimeError, "provenance identity mismatch"):
                rejected.try_resume()
            self.assertEqual(jsonl.read_bytes(), original_bytes)

    def test_provenance_identity_keys_includes_edax_exe_sha256(self) -> None:
        """T143(要件2・T127ij申し送り): `edaxSha256`は既定バイナリのSHAを指し続けるため
        (T127jで固定済みの仕様)、`edaxExe`設定(現状expanded1mのみ)で実際に呼び出す
        バイナリが差し替わってもそれ単体では検知できなかった。`edaxExeSha256`を
        identityへ追加したことを固定する。"""
        self.assertIn("edaxExeSha256", gen.PROVENANCE_IDENTITY_KEYS)

    def test_resume_raises_on_edax_exe_sha256_mismatch(self) -> None:
        """T143(要件2): `edaxExeSha256`(実際に呼び出すバイナリの実SHA、expanded1mの
        `meta`にのみ記録される)が既存checkpointと異なれば、他のSHAと同じく
        fail-closedでresumeを拒否する(v3バイナリ等の差し替えを検知できる)。"""
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            jsonl = root / "checkpoint.jsonl"
            meta = root / "checkpoint.meta.json"
            settings = {"setName": "expanded1m"}
            provenance = {key: f"value-{key}" for key in gen.PROVENANCE_IDENTITY_KEYS}
            provenance["edaxExeSha256"] = "v3-binary-sha-at-plan-time"
            run_key = json.dumps(settings, sort_keys=True)
            meta.write_text(
                json.dumps({"runKey": run_key, "meta": provenance, "settings": settings}), encoding="utf-8"
            )
            original_bytes = b'{"positionId": 0}\n'
            jsonl.write_bytes(original_bytes)
            changed = dict(provenance)
            changed["edaxExeSha256"] = "different-v3-binary-sha-after-swap"
            rejected = gen.TeacherCorpusCheckpoint(jsonl, meta, run_key, settings, changed)
            with self.assertRaisesRegex(RuntimeError, "provenance identity mismatch"):
                rejected.try_resume()
            self.assertEqual(jsonl.read_bytes(), original_bytes)

    def test_resume_unaffected_when_edax_exe_sha256_absent_on_both_sides(self) -> None:
        """T143(要件2): smoke/primary/expanded200k(`edaxExe`設定が無いset)は
        `edaxExeSha256`キー自体を一度も記録しないため、saved/currentとも常にNoneで
        一致し続ける(=既存3setのresume挙動は完全に不変)ことを確認する。"""
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            jsonl = root / "checkpoint.jsonl"
            meta = root / "checkpoint.meta.json"
            settings = {"setName": "smoke"}
            provenance = {
                key: f"value-{key}" for key in gen.PROVENANCE_IDENTITY_KEYS if key != "edaxExeSha256"
            }
            run_key = json.dumps(settings, sort_keys=True)
            meta.write_text(
                json.dumps({"runKey": run_key, "meta": provenance, "settings": settings}), encoding="utf-8"
            )
            jsonl.write_bytes(b'{"positionId": 0}\n')
            checkpoint = gen.TeacherCorpusCheckpoint(jsonl, meta, run_key, settings, dict(provenance))
            self.assertTrue(checkpoint.try_resume())

    def test_resume_raises_on_run_key_mismatch_without_flags(self) -> None:
        """T114 resume堅牢化: runKey不一致も既定でRuntimeErrorで停止する
        (切り詰めは発生しない)。"""
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            jsonl = root / "checkpoint.jsonl"
            meta = root / "checkpoint.meta.json"
            settings = {"setName": "test"}
            provenance = {key: f"value-{key}" for key in gen.PROVENANCE_IDENTITY_KEYS}
            run_key = json.dumps(settings, sort_keys=True)
            meta.write_text(
                json.dumps({"runKey": run_key, "meta": provenance, "settings": settings}), encoding="utf-8"
            )
            original_bytes = b'{"positionId": 0}\n'
            jsonl.write_bytes(original_bytes)
            other_settings = {"setName": "test", "targetCount": 999}
            other_run_key = json.dumps(other_settings, sort_keys=True)
            rejected = gen.TeacherCorpusCheckpoint(jsonl, meta, other_run_key, other_settings, provenance)
            with self.assertRaisesRegex(RuntimeError, "runKey mismatch"):
                rejected.try_resume()
            self.assertEqual(jsonl.read_bytes(), original_bytes)

    def test_resume_start_fresh_flag_allows_truncation_on_mismatch(self) -> None:
        """T114 resume堅牢化: `--start-fresh`(start_fresh_allowed=True)を明示した
        ときだけ、不一致時にtry_resume()がFalseを返し(切り詰めが起きる旧来の
        呼び出しパターン`if not checkpoint.try_resume(): checkpoint.start_fresh()`
        が働く)。"""
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            jsonl = root / "checkpoint.jsonl"
            meta = root / "checkpoint.meta.json"
            settings = {"setName": "test"}
            provenance = {key: f"value-{key}" for key in gen.PROVENANCE_IDENTITY_KEYS}
            run_key = json.dumps(settings, sort_keys=True)
            meta.write_text(
                json.dumps({"runKey": run_key, "meta": provenance, "settings": settings}), encoding="utf-8"
            )
            jsonl.write_bytes(b'{"positionId": 0}\n')
            changed = dict(provenance)
            changed["edaxSha256"] = "different-edax-sha"
            checkpoint = gen.TeacherCorpusCheckpoint(
                jsonl, meta, run_key, settings, changed, start_fresh_allowed=True
            )
            self.assertFalse(checkpoint.try_resume())
            checkpoint.start_fresh()
            self.assertEqual(jsonl.read_bytes(), b"")
            self.assertEqual(checkpoint.done_ids, set())

    def test_resume_adopt_provenance_flag_resumes_despite_mismatch(self) -> None:
        """T114 resume堅牢化: `--adopt-provenance`(adopt_provenance=True)は
        provenance identity不一致でも既存checkpointを正としてresumeし、jsonlを
        切り詰めない(既存の29,008局面消失事故のような損失を防ぐための移行経路)。"""
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            jsonl = root / "checkpoint.jsonl"
            meta = root / "checkpoint.meta.json"
            settings = {"setName": "test"}
            provenance = {key: f"value-{key}" for key in gen.PROVENANCE_IDENTITY_KEYS}
            run_key = json.dumps(settings, sort_keys=True)
            meta.write_text(
                json.dumps({"runKey": run_key, "meta": provenance, "settings": settings}), encoding="utf-8"
            )
            original_bytes = b'{"positionId": 0}\n{"positionId": 1}\n'
            jsonl.write_bytes(original_bytes)
            changed = dict(provenance)
            changed["harnessSha256"] = "different-harness-sha"
            checkpoint = gen.TeacherCorpusCheckpoint(
                jsonl, meta, run_key, settings, changed, adopt_provenance=True
            )
            self.assertTrue(checkpoint.try_resume())
            self.assertEqual(checkpoint.done_ids, {0, 1})
            self.assertEqual(jsonl.read_bytes(), original_bytes)
            # meta引数(=現環境の値)がそのままself.metaとして保持され、以降の
            # write_progress()はこの新しいidentityで書き込む(=identityの更新)。
            self.assertEqual(checkpoint.meta, changed)

    def test_resume_adopt_provenance_does_not_override_run_key_mismatch(self) -> None:
        """T114 resume堅牢化: `--adopt-provenance`はprovenance identityの不一致にしか
        効かず、runKey(生成設定そのもの)の不一致は引き続きRuntimeErrorで停止する。"""
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            jsonl = root / "checkpoint.jsonl"
            meta = root / "checkpoint.meta.json"
            settings = {"setName": "test"}
            provenance = {key: f"value-{key}" for key in gen.PROVENANCE_IDENTITY_KEYS}
            run_key = json.dumps(settings, sort_keys=True)
            meta.write_text(
                json.dumps({"runKey": run_key, "meta": provenance, "settings": settings}), encoding="utf-8"
            )
            original_bytes = b'{"positionId": 0}\n'
            jsonl.write_bytes(original_bytes)
            other_settings = {"setName": "test", "targetCount": 999}
            other_run_key = json.dumps(other_settings, sort_keys=True)
            checkpoint = gen.TeacherCorpusCheckpoint(
                jsonl, meta, other_run_key, other_settings, provenance, adopt_provenance=True
            )
            with self.assertRaisesRegex(RuntimeError, "runKey mismatch"):
                checkpoint.try_resume()
            self.assertEqual(jsonl.read_bytes(), original_bytes)

    def test_merge_rejects_mismatched_shard_provenance(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            data_dir = Path(temp_dir)
            common = {key: f"value-{key}" for key in gen.PROVENANCE_IDENTITY_KEYS}
            for index in range(2):
                settings = {"setName": "test", "targetCount": 2, "numShards": 2, "shardIndex": index}
                meta = {
                    "runKey": json.dumps(settings, sort_keys=True),
                    "meta": dict(common),
                    "settings": settings,
                }
                if index == 1:
                    meta["meta"]["edaxSha256"] = "mismatch"
                (data_dir / f"corpus_test_shard{index}of2.meta.json").write_text(json.dumps(meta), encoding="utf-8")
                (data_dir / f"corpus_test_shard{index}of2.jsonl").write_text(
                    json.dumps({"positionId": index}) + "\n", encoding="utf-8"
                )
            with mock.patch.object(gen, "TEACHER_DATA_DIR", data_dir):
                with self.assertRaisesRegex(RuntimeError, "provenance mismatch"):
                    gen.merge_shards("test", 2, 2)

    def test_verifier_rejects_legal_move_missing_and_extra(self) -> None:
        missing = self.valid_corpus_record()
        missing["children"].pop(0)
        self.assert_verifier_rejects([missing])

        extra = self.valid_corpus_record()
        extra["children"].append(
            {
                "move": "a1",
                "value": -1.0,
                "diffFromBest": extra["bestValue"] + 1.0,
                "exact": False,
                "level": 16,
                "edaxDepth": 16,
            }
        )
        self.assert_verifier_rejects([extra])

    def test_verifier_rejects_diff_and_exact_threshold_corruption(self) -> None:
        bad_diff = self.valid_corpus_record()
        bad_diff["children"][0]["diffFromBest"] += 1
        self.assert_verifier_rejects([bad_diff])

        bad_exact = self.valid_corpus_record()
        bad_exact["children"][0].update({"exact": True, "level": 60, "edaxDepth": 59})
        self.assert_verifier_rejects([bad_exact])

    def test_verifier_rejects_canonical_tamper_and_d4_duplicate(self) -> None:
        tampered = self.valid_corpus_record()
        tampered["canonicalKey"][0] += 1
        self.assert_verifier_rejects([tampered])

        initial = self.valid_corpus_record()
        first_move = verify.compute_children([initial])[0]["moves"][0]
        first = self.valid_corpus_record(first_move["childBoard"], first_move["childSideToMove"])
        second = self.valid_corpus_record(first["board"][::-1], first["sideToMove"])
        second["positionId"] = 1
        self.assert_verifier_rejects([first, second])

    def test_verifier_rejects_missing_required_field(self) -> None:
        record = self.valid_corpus_record()
        del record["openingKey"]
        self.assert_verifier_rejects([record])

    def test_verifier_rejects_oracle_contaminated_position(self) -> None:
        """T114: t096独立oracleのcanonicalKeyと一致する局面は、他のフィールドが
        すべて正しくても`ORACLE_KEYS`との一致だけでexit 1になることを確認する。"""
        record = self.valid_corpus_record()
        oracle_key = tuple(record["canonicalKey"])
        with mock.patch.object(verify, "ORACLE_KEYS", {oracle_key}):
            self.assert_verifier_rejects([record])

    def test_verifier_accepts_clean_position_when_oracle_keys_disjoint(self) -> None:
        """対照テスト: `ORACLE_KEYS`に一致しない局面はオラクル起因では拒否されない
        (上記テストが「常にexit 1になる」偽陽性でないことの確認)。"""
        record = self.valid_corpus_record()
        with tempfile.TemporaryDirectory() as temp_dir:
            data_dir = Path(temp_dir)
            (data_dir / "corpus_smoke.jsonl").write_text(json.dumps(record) + "\n", encoding="utf-8", newline="\n")
            (data_dir / "corpus_smoke.meta.json").write_text(
                json.dumps({"schemaVersion": 2, "progress": {"done": 1, "total": 1}}) + "\n",
                encoding="utf-8",
                newline="\n",
            )
            unrelated_key = (1, 2, 0)
            with mock.patch.object(verify, "ORACLE_KEYS", {unrelated_key}):
                with mock.patch.object(verify, "TEACHER_DATA_DIR", data_dir):
                    with mock.patch.object(verify.sys, "argv", ["verify_teacher_corpus.py", "smoke"]):
                        with self.assertRaises(SystemExit) as raised:
                            verify.main()
            self.assertEqual(raised.exception.code, 0)


    def test_expanded1m_config_is_k4_and_nested(self) -> None:
        cfg = gen.CORPUS_SETS["expanded1m"]
        self.assertEqual(cfg["targetCount"], 1_000_000)
        self.assertEqual(cfg["years"], "2000-2024")
        self.assertEqual(cfg["perBinCap"], 4)
        self.assertEqual(cfg["perGameCap"], 24)
        self.assertEqual(cfg["baseSet"], "expanded200k")
        self.assertNotIn("perBinCap", gen.CORPUS_SETS["smoke"])
        self.assertNotIn("perBinCap", gen.CORPUS_SETS["primary"])
        self.assertNotIn("perBinCap", gen.CORPUS_SETS["expanded200k"])

    def test_expanded1m_run_settings_include_plan_sha_and_two_layer_provenance(self) -> None:
        plan_meta = {
            "selectionStats": {"incrementalSelected": 800_000},
            "selectionPlanSha256": "master-sha",
            "shardPlanSha256": [f"shard-{i}" for i in range(8)],
            "provenance": {
                "baseCorpus": {
                    "jsonlSha256": gen.BASE_CORPUS_SHA256,
                    "manifestSha256": gen.BASE_MANIFEST_SHA256,
                },
                "incrementalGeneration": {
                    "generatorSha256": "current",
                    "teacherCandidatesToolSha256": "current",
                    "edaxSha256": "current",
                    "edaxEvalDataSha256": "current",
                    "candidatePoolSha256": "pool",
                    "selectionPlanSha256": "master-sha",
                },
            },
        }
        with mock.patch.object(gen.vs_edax, "git_commit_hash", return_value="head"):
            with mock.patch.object(gen, "sha256_of_file", return_value="current"):
                settings, meta = gen._expanded1m_settings_and_meta(
                    3, plan_meta, gen.CORPUS_SETS["expanded1m"]["edaxParentsPerProcess"]
                )
        self.assertEqual(settings["selectionPlanSha256"], "master-sha")
        self.assertEqual(settings["shardSelectionPlanSha256"], "shard-3")
        self.assertEqual(settings["perBinCap"], 4)
        self.assertEqual(settings["edaxParentsPerProcess"], 32)
        self.assertEqual(settings["elapsedMsPolicy"], "cross-parent-level-batch-averaged")
        self.assertIn("baseCorpus", meta)
        self.assertIn("incrementalGeneration", meta)
        self.assertEqual(meta["harnessSha256"], "current")

    def test_expanded1m_legacy_run_key_is_unchanged_when_parent_batch_field_is_absent(self) -> None:
        plan_meta = {
            "selectionStats": {},
            "selectionPlanSha256": "master",
            "shardPlanSha256": [f"s{i}" for i in range(8)],
            "provenance": {
                "baseCorpus": {},
                "incrementalGeneration": {
                    "generatorSha256": "current", "teacherCandidatesToolSha256": "current",
                    "edaxSha256": "current", "edaxEvalDataSha256": "current",
                    "candidatePoolSha256": "pool",
                },
            },
        }
        with mock.patch.object(gen.vs_edax, "git_commit_hash", return_value="head"):
            with mock.patch.object(gen, "sha256_of_file", return_value="current"):
                settings, _ = gen._expanded1m_settings_and_meta(0, plan_meta)
        expected_run_key = (
            '{"defaultEdaxLevel": 16, "edaxTasksPerProcess": 1, "elapsedMsPolicy": "batch-averaged", '
            '"exactEdaxLevel": 60, "exactEmptiesThreshold": 20, "numPhaseBins": 6, "numShards": 8, '
            '"openingKeyPlies": 8, "openingMaxFraction": 0.02, "perBinCap": 4, "perGameCap": 24, '
            '"seed": 90104, "selectionPlanSha256": "master", "selectionStats": {}, "setName": '
            '"expanded1m", "shardIndex": 0, "shardSelectionPlanSha256": "s0", "targetCount": '
            '1000000, "xcQuotaFraction": 0.5, "years": "2000-2024"}'
        )
        self.assertNotIn("edaxParentsPerProcess", settings)
        self.assertEqual(json.dumps(settings, sort_keys=True), expected_run_key)

    def test_expanded1m_rejects_execution_sha_changed_since_plan(self) -> None:
        incremental = {
            "generatorSha256": "planned",
            "teacherCandidatesToolSha256": "current",
            "edaxSha256": "current",
            "edaxEvalDataSha256": "current",
            "candidatePoolSha256": "pool",
        }
        plan_meta = {
            "selectionStats": {},
            "selectionPlanSha256": "master",
            "shardPlanSha256": [f"shard-{i}" for i in range(8)],
            "provenance": {"baseCorpus": {}, "incrementalGeneration": incremental},
        }
        with mock.patch.object(gen, "sha256_of_file", return_value="current"):
            with self.assertRaisesRegex(RuntimeError, "execution SHA mismatch.*resume refused"):
                gen._expanded1m_settings_and_meta(0, plan_meta)

    def test_streaming_merge_orders_records_and_uses_atomic_temp(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            data_dir = Path(temp_dir)
            common = {key: f"value-{key}" for key in gen.PROVENANCE_IDENTITY_KEYS}
            for shard_index, ids in enumerate(([0, 2], [1, 3])):
                settings = {"setName": "test", "targetCount": 4, "numShards": 2, "shardIndex": shard_index}
                meta = {
                    "runKey": json.dumps(settings, sort_keys=True),
                    "meta": dict(common),
                    "settings": settings,
                }
                (data_dir / f"corpus_test_shard{shard_index}of2.meta.json").write_text(
                    json.dumps(meta), encoding="utf-8"
                )
                lines = [json.dumps({"positionId": position_id}, separators=(",", ":")) + "\n" for position_id in ids]
                (data_dir / f"corpus_test_shard{shard_index}of2.jsonl").write_text(
                    "".join(lines), encoding="utf-8", newline="\n"
                )
            with mock.patch.object(gen, "TEACHER_DATA_DIR", data_dir):
                gen.merge_shards("test", 2, 4)
            merged = (data_dir / "corpus_test.jsonl").read_text(encoding="utf-8").splitlines()
            self.assertEqual([json.loads(line)["positionId"] for line in merged], [0, 1, 2, 3])
            self.assertFalse((data_dir / "corpus_test.jsonl.merge.tmp").exists())


    def test_expanded1m_target_shortfall_is_immediate_error(self) -> None:
        base = {
            "canonicalKeys": set(),
            "phaseCounts": [0] * 6,
            "phaseXcCounts": [0] * 6,
            "openingCounts": {},
        }
        with mock.patch.object(gen, "EXPANDED1M_BASE_COUNT", 0):
            with mock.patch.object(gen, "EXPANDED1M_INCREMENTAL_COUNT", 4):
                with mock.patch.object(gen, "EXPANDED1M_ENGINE_LOSS_COUNT", 0):
                    with self.assertRaisesRegex(RuntimeError, "target unavailable"):
                        gen.select_expanded1m_incremental({"positions": []}, base, set(), 7)

    def test_expanded1m_synthetic_selection_enforces_final_union_constraints(self) -> None:
        base = {
            "canonicalKeys": {(998, 0, 0)},
            "phaseCounts": [1, 1, 0, 0, 0, 0],
            "phaseXcCounts": [0, 1, 0, 0, 0, 0],
            "openingCounts": {"shared": 2},
        }
        positions = []
        board_id = 100
        for phase in range(6):
            for offset in range(6):
                positions.append(
                    {
                        "board": str(board_id),
                        "sideToMove": "black",
                        "phaseBin": phase,
                        "hasXcLegalMove": offset % 2 == 0,
                        "openingKey": "shared" if offset < 2 else f"opening-{board_id}",
                        "year": 2024,
                        "gameIndex": board_id,
                    }
                )
                board_id += 1
        positions.extend(
            [
                {**positions[0]},
                {**positions[0], "board": "998"},
                {**positions[0], "board": "999"},
            ]
        )

        with mock.patch.object(gen, "EXPANDED1M_BASE_COUNT", 2):
            with mock.patch.object(gen, "EXPANDED1M_INCREMENTAL_COUNT", 12):
                with mock.patch.object(gen, "EXPANDED1M_ENGINE_LOSS_COUNT", 0):
                    with mock.patch.object(gen, "OPENING_MAX_FRACTION", 0.25):
                        with mock.patch.object(
                            gen,
                            "canonical_key_of_position",
                            side_effect=lambda board, _side: (int(board), 0, 0),
                        ):
                            selected, stats = gen.select_expanded1m_incremental(
                                {"positions": positions, "totalCandidatesAfterDedup": len(positions)},
                                base,
                                {(999, 0, 0)},
                                17,
                            )

        self.assertEqual(len(selected), 12)
        self.assertEqual(sum(stats["finalBinAllocation"]), 14)
        self.assertEqual(sum(stats["incrementalBinAllocation"]), 12)
        self.assertEqual(stats["baseExcluded"], 1)
        self.assertEqual(stats["oracleExcluded"], 1)
        self.assertEqual(stats["incrementalDuplicateExcluded"], 1)
        self.assertLessEqual(stats["maxOpeningCountSelected"], stats["openingMaxCount"])
        for phase, final_count in enumerate(stats["finalBinAllocation"]):
            self.assertGreaterEqual(stats["finalPhaseXcCounts"][phase], (final_count + 1) // 2)
        selected_keys = {int(row["board"]) for row in selected}
        self.assertEqual(len(selected_keys), len(selected))
        self.assertNotIn(998, selected_keys)
        self.assertNotIn(999, selected_keys)

    def test_base_shard_copy_preserves_record_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "base.jsonl"
            target = root / "shard.jsonl"
            lines = [
                '{"positionId":0, "payload":"a"}\n',
                '{"positionId":1,"payload":"b"}\n',
                '{"positionId":2, "payload":"c"}\n',
                '{"positionId":3,"payload":"d"}\n',
            ]
            source.write_text("".join(lines), encoding="utf-8", newline="\n")
            copied = gen.copy_base_records_for_shard(source, target, 1, 2)
            self.assertEqual(copied, 2)
            self.assertEqual(target.read_bytes(), (lines[1] + lines[3]).encode("utf-8"))

    def test_expanded1m_verifier_uses_fixed_counts_prefix_and_artifact_shas(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            data_dir = root / "teacher"
            data_dir.mkdir()
            artifacts = {
                "manifest": root / "base.meta.json",
                "candidate": data_dir / "candidates_expanded1m.json",
                "plan": data_dir / "corpus_expanded1m_selection_plan.jsonl",
                "generator": root / "gen.py",
                "tool": root / "teacher_candidates.exe",
                "oracle": root / "oracle.json",
                "edax": root / "edax.exe",
                "eval": root / "eval.dat",
            }
            for name, path in artifacts.items():
                path.write_text(f"{name}\n", encoding="utf-8", newline="\n")
            artifacts["manifest"].write_text(
                json.dumps({"meta": {"edaxSha256": "base-edax", "edaxEvalDataSha256": "base-eval"}}),
                encoding="utf-8",
            )

            def record(position_id: int) -> dict:
                return {
                    "positionId": position_id,
                    "children": [
                        {"move": "a1", "value": 0, "diffFromBest": 0, "exact": False, "level": 16}
                    ],
                    "bestMove": "a1",
                    "bestValue": 0,
                    "canonicalKey": [position_id + 1, 0, 0],
                }

            base_lines = [json.dumps(record(i), separators=(",", ":")) + "\n" for i in range(2)]
            base_path = data_dir / "corpus_expanded200k.jsonl"
            base_path.write_text("".join(base_lines), encoding="utf-8", newline="\n")
            corpus_path = data_dir / "corpus_expanded1m.jsonl"
            corpus_path.write_text(
                "".join(base_lines) + json.dumps(record(2), separators=(",", ":")) + "\n",
                encoding="utf-8",
                newline="\n",
            )
            shard_shas = []
            for shard_index in range(8):
                shard_path = data_dir / f"corpus_expanded1m_shard{shard_index}of8.plan.jsonl"
                shard_path.write_text(f"{shard_index}\n", encoding="utf-8", newline="\n")
                shard_shas.append(verify.sha256_of_file(shard_path))

            base_sha = verify.sha256_of_file(base_path)
            manifest_sha = verify.sha256_of_file(artifacts["manifest"])
            provenance = {
                "baseCorpus": {
                    "path": "train/data/teacher/corpus_expanded200k.jsonl",
                    "recordCount": 2,
                    "jsonlSha256": base_sha,
                    "manifestPath": "bench/edax-compare/teacher_manifests/corpus_expanded200k.meta.json",
                    "manifestSha256": manifest_sha,
                    "edaxSha256": "base-edax",
                    "edaxEvalDataSha256": "base-eval",
                },
                "incrementalGeneration": {
                    "recordCount": 1,
                    "candidatePoolPath": "train/data/teacher/candidates_expanded1m.json",
                    "candidatePoolSha256": verify.sha256_of_file(artifacts["candidate"]),
                    "selectionPlanPath": "train/data/teacher/corpus_expanded1m_selection_plan.jsonl",
                    "selectionPlanSha256": verify.sha256_of_file(artifacts["plan"]),
                    "generatorSha256": verify.sha256_of_file(artifacts["generator"]),
                    "teacherCandidatesToolSha256": verify.sha256_of_file(artifacts["tool"]),
                    "edaxSha256": verify.sha256_of_file(artifacts["edax"]),
                    "edaxEvalDataSha256": verify.sha256_of_file(artifacts["eval"]),
                    "t096OracleSha256": verify.sha256_of_file(artifacts["oracle"]),
                    "shardPlanSha256": shard_shas,
                },
            }
            meta = {
                "schemaVersion": 2,
                "settings": {"exactEmptiesThreshold": 24},
                "progress": {"done": 3, "total": 3},
                "reusedRecordCount": 2,
                "provenance": provenance,
            }
            (data_dir / "corpus_expanded1m.meta.json").write_text(json.dumps(meta), encoding="utf-8")

            patches = {
                "TEACHER_DATA_DIR": data_dir,
                "TOOL": artifacts["tool"],
                "T096_ORACLE_POSITIONS_PATH": artifacts["oracle"],
                "EXPANDED1M_GENERATOR_PATH": artifacts["generator"],
                "EXPANDED1M_BASE_PATH": base_path,
                "EXPANDED1M_BASE_MANIFEST_PATH": artifacts["manifest"],
                "EXPANDED1M_CANDIDATE_POOL_PATH": artifacts["candidate"],
                "EXPANDED1M_SELECTION_PLAN_PATH": artifacts["plan"],
                "EXPANDED1M_BASE_COUNT": 2,
                "EXPANDED1M_TOTAL_COUNT": 3,
                "EXPANDED1M_BASE_SHA256": base_sha,
                "EXPANDED1M_BASE_MANIFEST_SHA256": manifest_sha,
                "ORACLE_KEYS": set(),
            }
            legal = lambda records: [
                {"moves": [{"move": "a1", "childEmpties": 30, "childIsTerminal": False}]} for _ in records
            ]
            canonical = lambda records: [rec["canonicalKey"] for rec in records]
            with mock.patch.multiple(verify, **patches):
                with mock.patch.object(verify.vs_edax, "EDAX_EXE", artifacts["edax"]):
                    with mock.patch.object(verify.vs_edax, "EDAX_EVAL_DATA", artifacts["eval"]):
                        with mock.patch.object(verify, "schema_errors", return_value=[]):
                            with mock.patch.object(verify, "compute_children", side_effect=legal):
                                with mock.patch.object(verify, "compute_canonical_keys", side_effect=canonical):
                                    count, errors = verify.verify_one("expanded1m")
            self.assertEqual((count, errors), (3, 0))

            tampered = json.loads((data_dir / "corpus_expanded1m.meta.json").read_text(encoding="utf-8"))
            tampered["provenance"]["incrementalGeneration"]["selectionPlanSha256"] = "tampered"
            self.assertTrue(verify.expanded1m_provenance_errors(tampered))

            # T127c: 実データのtrain/data/teacher/corpus_expanded1m.meta.jsonは
            # Windows上のPath(os.sep=`\\`)でシリアライズされたためbaseCorpus.path等が
            # 例えば"train\\data\\teacher\\corpus_expanded200k.jsonl"のように記録されて
            # いた。区切り文字の差だけを理由に誤検知しないことを確認する(パス自体が
            # 誤っている場合=別ディレクトリ名等は引き続き検出されること、も併せて確認)。
            with mock.patch.multiple(verify, **patches):
                with mock.patch.object(verify.vs_edax, "EDAX_EXE", artifacts["edax"]):
                    with mock.patch.object(verify.vs_edax, "EDAX_EVAL_DATA", artifacts["eval"]):
                        windows_style = json.loads(json.dumps(provenance))
                        windows_style["baseCorpus"]["path"] = "train\\data\\teacher\\corpus_expanded200k.jsonl"
                        windows_style["baseCorpus"]["manifestPath"] = (
                            "bench\\edax-compare\\teacher_manifests\\corpus_expanded200k.meta.json"
                        )
                        windows_style["incrementalGeneration"]["candidatePoolPath"] = (
                            "train\\data\\teacher\\candidates_expanded1m.json"
                        )
                        windows_style["incrementalGeneration"]["selectionPlanPath"] = (
                            "train\\data\\teacher\\corpus_expanded1m_selection_plan.jsonl"
                        )
                        windows_style_errors = verify.expanded1m_provenance_errors({"provenance": windows_style})
                        self.assertEqual(windows_style_errors, [])

                        wrong_path = json.loads(json.dumps(provenance))
                        wrong_path["baseCorpus"]["path"] = "train\\data\\teacher\\corpus_wrong200k.jsonl"
                        wrong_path_errors = verify.expanded1m_provenance_errors({"provenance": wrong_path})
                        self.assertTrue(any("baseCorpus.path" in message for message in wrong_path_errors))

                        # T143(生成基盤堅牢化の副作用として発見・修正): gen_teacher_corpus.py
                        # 自体を(本タスクのように)後からメンテナンス編集すると、ライブファイルの
                        # SHA-256は生成完了時点の記録値と一致しなくなる。これはコード/ビルド
                        # 成果物の正当な進化であり改ざんではないため、generatorSha256等
                        # 4フィールドは「現在のライブファイルと不一致」でもエラーにならない
                        # (存在してさえいればよい)ことを確認する。一方でデータ成果物
                        # (candidatePoolSha256等、既に上のtamperedケースで確認済み)は
                        # 引き続き厳密一致を要求する。
                        code_artifact_drifted = json.loads(json.dumps(provenance))
                        code_artifact_drifted["incrementalGeneration"]["generatorSha256"] = "code-evolved-since-generation"
                        code_artifact_drifted["incrementalGeneration"]["teacherCandidatesToolSha256"] = "rebuilt-since-generation"
                        code_artifact_drifted["incrementalGeneration"]["edaxSha256"] = "edax-updated-since-generation"
                        code_artifact_drifted["incrementalGeneration"]["edaxEvalDataSha256"] = "eval-updated-since-generation"
                        self.assertEqual(
                            verify.expanded1m_provenance_errors({"provenance": code_artifact_drifted}), []
                        )

                        code_artifact_missing = json.loads(json.dumps(provenance))
                        code_artifact_missing["incrementalGeneration"]["generatorSha256"] = None
                        missing_errors = verify.expanded1m_provenance_errors({"provenance": code_artifact_missing})
                        self.assertTrue(any("generatorSha256" in message for message in missing_errors))

    def test_verify_checkpoint_round_trip_and_set_name_mismatch_is_ignored(self) -> None:
        """T127c: 長時間実行ルール(チャンク進捗+resume)対応で追加した
        save_verify_checkpoint/load_verify_checkpointの基本契約を確認する。
        setNameが異なるcheckpointは取り違え防止のため無視されること、
        原子的置換(.tmp書き→os.replace)で本体ファイルが残ることも確認する。"""
        with tempfile.TemporaryDirectory() as temp_dir:
            checkpoint_path = Path(temp_dir) / "expanded1m.verify-checkpoint.json"
            seen = {(1, 2, 3): 0, (4, 5, 6): 1}
            verify.save_verify_checkpoint(checkpoint_path, "expanded1m", 2, 0, seen)
            self.assertFalse(checkpoint_path.with_suffix(".json.tmp").exists())
            loaded = verify.load_verify_checkpoint(checkpoint_path, "expanded1m")
            self.assertIsNotNone(loaded)
            self.assertEqual(loaded["recordCount"], 2)
            self.assertEqual(loaded["errors"], 0)
            self.assertEqual(
                {(row[0], row[1], row[2]): row[3] for row in loaded["seenCanonical"]}, seen
            )
            self.assertIsNone(verify.load_verify_checkpoint(checkpoint_path, "expanded200k"))

    def test_compute_checkpoint_fingerprint_reflects_jsonl_size_sha_and_tool_sha(self) -> None:
        """T143(要件5): フィンガープリントは対象JSONLのサイズ・SHA-256と
        teacher_candidates.exeのSHA-256から構成され、内容が変わると値も変わる。"""
        with tempfile.TemporaryDirectory() as temp_dir:
            jsonl_path = Path(temp_dir) / "corpus_smoke.jsonl"
            jsonl_path.write_text("abc\n", encoding="utf-8", newline="\n")
            fp1 = verify.compute_checkpoint_fingerprint(jsonl_path)
            self.assertEqual(fp1["jsonlSize"], jsonl_path.stat().st_size)
            self.assertEqual(fp1["jsonlSha256"], verify.sha256_of_file(jsonl_path))
            self.assertEqual(fp1["toolSha256"], verify.sha256_of_file(verify.TOOL))

            jsonl_path.write_text("abcdef\n", encoding="utf-8", newline="\n")
            fp2 = verify.compute_checkpoint_fingerprint(jsonl_path)
            self.assertNotEqual(fp1["jsonlSize"], fp2["jsonlSize"])
            self.assertNotEqual(fp1["jsonlSha256"], fp2["jsonlSha256"])

    def test_load_verify_checkpoint_falls_back_to_full_scan_on_fingerprint_mismatch(self) -> None:
        """T143(要件5): 保存済みcheckpointのフィンガープリントと現在の期待値が
        食い違えば(対象jsonlまたはツールバイナリが変わった)、checkpointを無効化して
        Noneを返す(呼び出し元はフルスキャンへフォールバックする)。"""
        with tempfile.TemporaryDirectory() as temp_dir:
            checkpoint_path = Path(temp_dir) / "smoke.verify-checkpoint.json"
            verify.save_verify_checkpoint(
                checkpoint_path, "smoke", 5, 0, {}, {"jsonlSize": 100, "jsonlSha256": "old-sha", "toolSha256": "old-tool-sha"}
            )
            mismatched = verify.load_verify_checkpoint(
                checkpoint_path, "smoke", {"jsonlSize": 999, "jsonlSha256": "new-sha", "toolSha256": "old-tool-sha"}
            )
            self.assertIsNone(mismatched)
            # フィンガープリント指定なしなら(要件5導入前と同じ)従来どおり無条件で採用する。
            unconditional = verify.load_verify_checkpoint(checkpoint_path, "smoke")
            self.assertIsNotNone(unconditional)
            self.assertEqual(unconditional["recordCount"], 5)
            # フィンガープリントが完全一致すれば採用される。
            matching = verify.load_verify_checkpoint(
                checkpoint_path, "smoke", {"jsonlSize": 100, "jsonlSha256": "old-sha", "toolSha256": "old-tool-sha"}
            )
            self.assertIsNotNone(matching)

    def test_load_verify_checkpoint_falls_back_to_full_scan_on_malformed_json(self) -> None:
        """T143(要件10・レビュー軽微5): checkpoint本体が不正JSON(破損)の場合、
        例外を投げずNoneを返す(呼び出し元はフルスキャンへフォールバックする)。"""
        with tempfile.TemporaryDirectory() as temp_dir:
            checkpoint_path = Path(temp_dir) / "smoke.verify-checkpoint.json"
            checkpoint_path.write_text('{"setName": "smoke", "recordCount": ', encoding="utf-8")
            self.assertIsNone(verify.load_verify_checkpoint(checkpoint_path, "smoke"))

    def test_verify_one_falls_back_to_full_rescan_when_checkpoint_is_corrupt(self) -> None:
        """T143(要件10): verify_one自体を通した回帰テスト。不正JSONのcheckpointを
        与えてもverify_oneはエラーにならず、resumeせず全件を再検証して正しい結果を返す。"""
        record = self.valid_corpus_record()
        with tempfile.TemporaryDirectory() as temp_dir:
            data_dir = Path(temp_dir)
            (data_dir / "corpus_smoke.jsonl").write_text(json.dumps(record) + "\n", encoding="utf-8", newline="\n")
            (data_dir / "corpus_smoke.meta.json").write_text(
                json.dumps({"schemaVersion": 2, "progress": {"done": 1, "total": 1}}),
                encoding="utf-8",
                newline="\n",
            )
            checkpoint_path = data_dir / "smoke.verify-checkpoint.json"
            checkpoint_path.write_text("{not valid json", encoding="utf-8")

            with mock.patch.object(verify, "TEACHER_DATA_DIR", data_dir):
                count, errors = verify.verify_one("smoke", progress_every=1, checkpoint_path=checkpoint_path)
            self.assertEqual((count, errors), (1, 0))
            # 完走後は正常な(パース可能な)checkpointに置き換わっている。
            healed = json.loads(checkpoint_path.read_text(encoding="utf-8"))
            self.assertEqual(healed["recordCount"], 1)

    def test_validated_progress_every_rounds_up_non_multiples_and_passes_through_others(self) -> None:
        """T143(軽微対応11): BATCH_SIZE(500)の倍数でない値は次の倍数へ切り上げる。
        倍数や0(無効化)はそのまま素通しする。"""
        self.assertEqual(verify.validated_progress_every(0), 0)
        self.assertEqual(verify.validated_progress_every(500), 500)
        self.assertEqual(verify.validated_progress_every(1000), 1000)
        self.assertEqual(verify.validated_progress_every(333), 500)
        self.assertEqual(verify.validated_progress_every(501), 1000)

    def test_verify_one_resumes_from_checkpoint_and_skips_recomputation(self) -> None:
        """T127c: checkpointにrecordCountが記録済みの区間はcompute_children/
        compute_canonical_keys(subprocess経由の重い再検証)を呼ばずスキップし、
        seenCanonicalを引き継いだ上で残り区間だけを検証することを確認する。"""
        record = self.valid_corpus_record()
        second_move = verify.compute_children([record])[0]["moves"][0]
        second = self.valid_corpus_record(second_move["childBoard"], second_move["childSideToMove"])
        second["positionId"] = 1
        records = [record, second]
        with tempfile.TemporaryDirectory() as temp_dir:
            data_dir = Path(temp_dir)
            (data_dir / "corpus_smoke.jsonl").write_text(
                "".join(json.dumps(r) + "\n" for r in records), encoding="utf-8", newline="\n"
            )
            (data_dir / "corpus_smoke.meta.json").write_text(
                json.dumps({"schemaVersion": 2, "progress": {"done": 2, "total": 2}}),
                encoding="utf-8",
                newline="\n",
            )
            checkpoint_path = data_dir / "smoke.verify-checkpoint.json"
            first_key = tuple(record["canonicalKey"])
            # T143(要件5): verify_oneはcheckpoint_pathが渡されると内部で対象jsonlの
            # フィンガープリントを計算しload/saveへ渡すため、事前に書くcheckpointにも
            # 同じ内容のjsonlから計算した一致するフィンガープリントを含めておく
            # (含めないとload側が「フィンガープリント欄が無い(=旧形式または破損)」を
            # 不一致とみなしフルスキャンへフォールバックし、本テストが検証したい
            # resumeスキップが働かなくなる)。
            fingerprint = verify.compute_checkpoint_fingerprint(data_dir / "corpus_smoke.jsonl")
            verify.save_verify_checkpoint(checkpoint_path, "smoke", 1, 0, {first_key: 0}, fingerprint)

            call_count = {"children": 0, "canonical": 0}
            real_children = verify.compute_children
            real_canonical = verify.compute_canonical_keys

            def counting_children(recs):
                call_count["children"] += 1
                return real_children(recs)

            def counting_canonical(recs):
                call_count["canonical"] += 1
                return real_canonical(recs)

            with mock.patch.object(verify, "TEACHER_DATA_DIR", data_dir):
                with mock.patch.object(verify, "BATCH_SIZE", 1):
                    with mock.patch.object(verify, "compute_children", side_effect=counting_children):
                        with mock.patch.object(verify, "compute_canonical_keys", side_effect=counting_canonical):
                            count, errors = verify.verify_one(
                                "smoke", progress_every=1, checkpoint_path=checkpoint_path
                            )
            self.assertEqual((count, errors), (2, 0))
            # positionId=0はcheckpointでresume_record_count=1未満なのでbatchへ
            # 積まれず、children/canonicalの再計算は最後の1件分(positionId=1)
            # だけで済む(BATCH_SIZE=1なので1回呼ばれる)。
            self.assertEqual(call_count["children"], 1)
            self.assertEqual(call_count["canonical"], 1)
            final_checkpoint = json.loads(checkpoint_path.read_text(encoding="utf-8"))
            self.assertEqual(final_checkpoint["recordCount"], 2)
            self.assertEqual(len(final_checkpoint["seenCanonical"]), 2)


class T127cFinalizeExpanded1mTests(unittest.TestCase):
    """T127c: `finalize_teacher_corpus.py`に追加したexpanded1m集計・manifest確定の
    回帰テスト。実データ(1M件)は使わず、既知の値を計算できる小さな合成JSONLで
    集計ロジック自体を検証する。"""

    @staticmethod
    def _synthetic_records() -> list[dict]:
        return [
            {
                "positionId": 0,
                "source": "wthor",
                "canonicalKey": [1, 0, 0],
                "phaseBin": 0,
                "hasXcLegalMove": True,
                "openingKey": "op1",
                "year": 2001,
                "gameIndex": 5,
                "children": [
                    {"move": "a1", "exact": True, "level": None, "elapsedMs": 1.0},
                    {"move": "b2", "exact": False, "level": 16, "elapsedMs": 2.0},
                ],
            },
            {
                "positionId": 1,
                "source": "wthor",
                "canonicalKey": [2, 0, 0],
                "phaseBin": 0,
                "hasXcLegalMove": False,
                "openingKey": "op1",
                "year": 2001,
                "gameIndex": 5,
                "children": [{"move": "c3", "exact": True, "level": 60, "elapsedMs": 3.0}],
            },
            {
                "positionId": 2,
                "source": "wthor",
                "canonicalKey": [3, 0, 0],
                "phaseBin": 1,
                "hasXcLegalMove": True,
                "openingKey": "op2",
                "year": 2002,
                "gameIndex": 9,
                "children": [{"move": "d4", "exact": False, "level": 16, "elapsedMs": 4.0}],
            },
            {
                "positionId": 3,
                "source": "engineLoss",
                "canonicalKey": [999, 0, 0],
                "phaseBin": None,
                "hasXcLegalMove": None,
                "openingKey": None,
                "year": None,
                "gameIndex": None,
                "children": [{"move": "e5", "exact": False, "level": 16, "elapsedMs": 5.0}],
            },
        ]

    def test_expanded1m_corpus_stats_aggregates_counts_and_histograms(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            jsonl_path = Path(temp_dir) / "corpus_expanded1m.jsonl"
            jsonl_path.write_text(
                "".join(json.dumps(r) + "\n" for r in self._synthetic_records()), encoding="utf-8", newline="\n"
            )
            oracle_keys = {(999, 0, 0)}
            stats, audit, oracle_report = finalize.expanded1m_corpus_stats(jsonl_path, oracle_keys)
            expected_corpus_sha256 = finalize.sha256(jsonl_path)

        self.assertEqual(stats["records"], 4)
        self.assertEqual(stats["sourceCounts"], {"wthor": 3, "engineLoss": 1})
        self.assertEqual(stats["phaseCountsWthor"], {"0": 2, "1": 1})
        self.assertEqual(stats["yearCountsWthor"], {"2001": 2, "2002": 1})
        self.assertEqual(stats["children"], 5)
        self.assertEqual(stats["exactChildren"], 2)
        self.assertEqual(stats["terminalChildren"], 1)
        self.assertAlmostEqual(stats["averageElapsedMsPerEdaxCall"], 3.0)
        # T143(要件7): corpusStatsにマージ済みJSONL本体自体のSHA-256が含まれる。
        self.assertEqual(stats["corpusSha256"], expected_corpus_sha256)

        self.assertEqual(audit["phaseXcCoverage"]["0"], {"total": 2, "xc": 1, "xcCoverage": 0.5})
        self.assertEqual(audit["phaseXcCoverage"]["1"], {"total": 1, "xc": 1, "xcCoverage": 1.0})
        self.assertEqual(audit["openingMatched"], 3)
        self.assertEqual(audit["openingUnmatched"], 0)
        self.assertEqual(audit["distinctOpeningKeys"], 2)
        self.assertEqual(audit["maxOpeningKey"], "op1")
        self.assertEqual(audit["maxOpeningCount"], 2)
        self.assertAlmostEqual(audit["maxOpeningShareOfWthor"], 2 / 3)
        self.assertEqual(audit["distinctGamesRepresented"], 2)
        self.assertEqual(audit["positionsPerGameHistogram"], {"1": 1, "2": 1})
        self.assertEqual(audit["failedXcPhaseBins"], [])

        self.assertEqual(oracle_report["oracleKeyCount"], 1)
        self.assertEqual(oracle_report["contaminatedRecordsFound"], 1)

    def _write_finalize_fixture(
        self, root: Path, *, oracle_canonical_key: list[int], live_meta_overrides: dict | None = None
    ) -> dict:
        """T143: `finalize_expanded1m`の各テストで共通する合成fixtureの組み立て。
        `oracle_canonical_key`は非混入(4件のどれとも一致しない)ケースと混入ケースの
        両方をテストが選べるように引数化してある。"""
        data_dir = root / "teacher"
        manifest_dir = root / "manifests"
        data_dir.mkdir()
        manifest_dir.mkdir()

        jsonl_path = data_dir / "corpus_expanded1m.jsonl"
        jsonl_path.write_text(
            "".join(json.dumps(r) + "\n" for r in self._synthetic_records()), encoding="utf-8", newline="\n"
        )
        live_meta = {
            "schemaVersion": 2,
            "runKey": None,
            "meta": {"gitCommit": "abc123"},
            "settings": {"setName": "expanded1m", "targetCount": 4},
            "mergedFromShards": 8,
            "progress": {"done": 4, "total": 4},
            "reusedRecordCount": 2,
            "provenance": {"baseCorpus": {"recordCount": 2}, "incrementalGeneration": {"recordCount": 2}},
        }
        if live_meta_overrides:
            live_meta.update(live_meta_overrides)
        (data_dir / "corpus_expanded1m.meta.json").write_text(json.dumps(live_meta), encoding="utf-8")

        boundaries_path = manifest_dir / "corpus_expanded1m_method_boundaries.json"
        boundaries_path.write_text(
            json.dumps({"boundaries": [{"sequence": 1, "change": "test-switch"}], "note": "synthetic note"}),
            encoding="utf-8",
        )

        oracle_path = root / "oracle.json"
        oracle_path.write_text(json.dumps({"positions": [{"canonicalKey": oracle_canonical_key}]}), encoding="utf-8")

        return {
            "jsonl_path": jsonl_path,
            "patches": {
                "DATA_DIR": data_dir,
                "MANIFEST_DIR": manifest_dir,
                "T096_ORACLE_POSITIONS_PATH": oracle_path,
                "EXPANDED1M_METHOD_BOUNDARIES_PATH": boundaries_path,
            },
            "manifest_path": manifest_dir / "corpus_expanded1m.meta.json",
        }

    def test_finalize_expanded1m_writes_manifest_with_method_boundaries(self) -> None:
        """`_synthetic_records()`(4件、openingキー"op1"が3件中2件を占める)は
        `test_expanded1m_corpus_stats_aggregates_counts_and_histograms`が集計値を
        固定するための最小fixtureであり、実データの選定制約(opening集中2%以下等)を
        満たすようには作られていない。本テストの主眼は`finalize_expanded1m`が
        (集計結果を受け取った後に)method boundaries・provenance・manifest書き出しを
        正しく組み立てることの確認なので、集計自体(要件6のゲート判定含む)は
        別テストで検証済みの`expanded1m_corpus_stats`をモックしてゲートを
        確実に通過する値を注入する。"""
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            fixture = self._write_finalize_fixture(root, oracle_canonical_key=[424242, 0, 0])
            fake_stats = {"records": 4, "corpusSha256": "fake-corpus-sha256"}
            fake_audit = {"thresholdTriggered": False, "failedXcPhaseBins": [], "openingShareExceeded": False}
            fake_oracle_report = {"contaminatedRecordsFound": 0, "oracleKeyCount": 1}

            verification = {"verifiedAt": "2026-07-19", "command": "verify_teacher_corpus.py expanded1m", "result": "ok"}
            with mock.patch.multiple(finalize, **fixture["patches"]):
                with mock.patch.object(
                    finalize,
                    "expanded1m_corpus_stats",
                    return_value=(fake_stats, fake_audit, fake_oracle_report),
                ):
                    doc = finalize.finalize_expanded1m(verification)

            self.assertEqual(doc["corpusStats"]["records"], 4)
            self.assertEqual(doc["corpusStats"]["corpusSha256"], "fake-corpus-sha256")
            self.assertEqual(doc["reusedRecordCount"], 2)
            self.assertEqual(doc["provenance"]["methodBoundaries"], [{"sequence": 1, "change": "test-switch"}])
            self.assertEqual(doc["provenance"]["methodBoundariesNote"], "synthetic note")
            self.assertEqual(doc["verification"], verification)
            self.assertEqual(doc["oracleNonContamination"]["contaminatedRecordsFound"], 0)
            self.assertFalse(doc["selectionAudit"]["thresholdTriggered"])

            written = json.loads(fixture["manifest_path"].read_text(encoding="utf-8"))
            self.assertEqual(written, doc)

    def test_finalize_expanded1m_integrity_gate_rejects_record_count_mismatch(self) -> None:
        """T143(要件6): corpusStats.recordsとlive meta progress.totalが食い違えば、
        manifestを書き出さずエラー終了する。"""
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            fixture = self._write_finalize_fixture(
                root, oracle_canonical_key=[424242, 0, 0], live_meta_overrides={"progress": {"done": 4, "total": 5}}
            )
            verification = {"verifiedAt": "2026-07-19", "command": "x", "result": "ok"}
            with mock.patch.multiple(finalize, **fixture["patches"]):
                with self.assertRaisesRegex(RuntimeError, "integrity gate failed.*records"):
                    finalize.finalize_expanded1m(verification)
            self.assertFalse(fixture["manifest_path"].exists())

    def test_finalize_expanded1m_integrity_gate_rejects_oracle_contamination(self) -> None:
        """T143(要件6): oracleNonContamination.contaminatedRecordsFoundが0でなければ
        manifestを書き出さずエラー終了する。"""
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            # 4件目のengineLossレコードのcanonicalKey [999,0,0] と一致させ、混入を発生させる。
            fixture = self._write_finalize_fixture(root, oracle_canonical_key=[999, 0, 0])
            verification = {"verifiedAt": "2026-07-19", "command": "x", "result": "ok"}
            with mock.patch.multiple(finalize, **fixture["patches"]):
                with self.assertRaisesRegex(RuntimeError, "integrity gate failed.*contaminatedRecordsFound"):
                    finalize.finalize_expanded1m(verification)
            self.assertFalse(fixture["manifest_path"].exists())

    def test_finalize_expanded1m_integrity_gate_rejects_threshold_triggered(self) -> None:
        """T143(要件6): selectionAudit.thresholdTriggeredがTrueならmanifestを
        書き出さずエラー終了する(集計自体は`expanded1m_corpus_stats`をモックして
        直接Trueを注入し、集計ロジック自体は再テストしない)。"""
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            fixture = self._write_finalize_fixture(root, oracle_canonical_key=[424242, 0, 0])
            verification = {"verifiedAt": "2026-07-19", "command": "x", "result": "ok"}
            triggered_audit = {"thresholdTriggered": True, "failedXcPhaseBins": ["0"], "openingShareExceeded": False}
            fake_stats = {"records": 4, "corpusSha256": "irrelevant"}
            fake_oracle_report = {"contaminatedRecordsFound": 0}
            with mock.patch.multiple(finalize, **fixture["patches"]):
                with mock.patch.object(
                    finalize, "expanded1m_corpus_stats", return_value=(fake_stats, triggered_audit, fake_oracle_report)
                ):
                    with self.assertRaisesRegex(RuntimeError, "integrity gate failed.*thresholdTriggered"):
                        finalize.finalize_expanded1m(verification)
            self.assertFalse(fixture["manifest_path"].exists())

    def test_append_corpus_sha256_adds_field_without_touching_other_keys(self) -> None:
        """T143(要件7): 既存manifestへcorpusSha256だけを追記し、他フィールドは
        一切変更しないことを確認する。"""
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            jsonl_path = root / "corpus_expanded1m.jsonl"
            jsonl_path.write_text("payload\n", encoding="utf-8", newline="\n")
            manifest_path = root / "corpus_expanded1m.meta.json"
            original = {"schemaVersion": 2, "corpusStats": {"records": 4}, "other": "untouched"}
            manifest_path.write_text(json.dumps(original), encoding="utf-8")

            expected_sha256 = finalize.sha256(jsonl_path)
            returned = finalize.append_corpus_sha256(jsonl_path, manifest_path)
            self.assertEqual(returned, expected_sha256)

            written = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(written["corpusStats"]["corpusSha256"], expected_sha256)
            self.assertEqual(written["corpusStats"]["records"], 4)
            self.assertEqual(written["other"], "untouched")

            # 再実行しても同じ値のまま(冪等)。
            finalize.append_corpus_sha256(jsonl_path, manifest_path)
            rewritten = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(rewritten, written)

    def test_append_corpus_sha256_rejects_mismatched_existing_value(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            jsonl_path = root / "corpus_expanded1m.jsonl"
            jsonl_path.write_text("payload\n", encoding="utf-8", newline="\n")
            manifest_path = root / "corpus_expanded1m.meta.json"
            manifest_path.write_text(
                json.dumps({"corpusStats": {"corpusSha256": "stale-value-from-before-a-data-change"}}),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(RuntimeError, "Refusing to overwrite"):
                finalize.append_corpus_sha256(jsonl_path, manifest_path)


class VsEdaxSolveBatchCommandTests(unittest.TestCase):
    """T127i: `_edax_solve_batch`に追加した`edax_exe`引数の回帰テスト。

    `subprocess.run`をモックしてコマンド列だけを検証する(実際のEdaxは
    起動しない)。OBF一時ファイルの書き込み先も一時ディレクトリへ差し替え、
    走行中の`edax-extract`ディレクトリには一切触れない。
    """

    @staticmethod
    def _fake_completed_process(positions: list[dict]) -> subprocess.CompletedProcess:
        blocks = [
            f"*** problem # {i} ***\n  1  +04         0:00.01          1          100  d3\n"
            for i in range(1, len(positions) + 1)
        ]
        return subprocess.CompletedProcess(args=[], returncode=0, stdout="\n".join(blocks), stderr="")

    def _run_with_captured_command(self, temp_edax_dir: Path, **kwargs) -> list[str]:
        positions = [{"board": "-" * 64, "sideToMove": "black"}]
        captured: dict = {}

        def fake_run(command, **run_kwargs):
            captured["command"] = list(command)
            return self._fake_completed_process(positions)

        with mock.patch.object(gen.vs_edax, "EDAX_DIR", temp_edax_dir):
            with mock.patch.object(gen.vs_edax.subprocess, "run", side_effect=fake_run):
                gen.vs_edax._edax_solve_batch(positions, level=16, n_tasks=1, **kwargs)
        return captured["command"]

    def test_default_command_unchanged_when_edax_exe_unspecified(self) -> None:
        """`edax_exe`未指定時、コマンド列は従来どおり`EDAX_EXE`(ベースライン
        バイナリ)を使い、`-h`も付与されない(既存のedax_hash_bits未指定時と
        同じ「加算引数は挙動を変えない」契約)。"""
        with tempfile.TemporaryDirectory() as temp_dir:
            command = self._run_with_captured_command(Path(temp_dir))
        self.assertEqual(command[0], str(gen.vs_edax.EDAX_EXE))
        self.assertNotIn("-h", command)
        self.assertEqual(command[3], "-l")
        self.assertEqual(command[4], "16")
        self.assertEqual(command[5], "-n")
        self.assertEqual(command[6], "1")
        self.assertEqual(
            command[7:],
            ["-eval-file", str(gen.vs_edax.EDAX_EVAL_DATA), "-book-usage", "off", "-vv"],
        )

    def test_edax_exe_override_replaces_only_the_binary_path(self) -> None:
        """`edax_exe`指定時は実行ファイルパスだけが差し替わり、他の引数列は
        未指定時と同一である(T127i v3バイナリA/B用)。"""
        override = Path("C:/fake/wEdax-x86-64-v3.exe")
        with tempfile.TemporaryDirectory() as temp_dir:
            default_command = self._run_with_captured_command(Path(temp_dir))
            override_command = self._run_with_captured_command(Path(temp_dir), edax_exe=override)
        self.assertEqual(override_command[0], str(override))
        self.assertNotEqual(override_command[0], default_command[0])
        # 実行ファイルパスとOBF一時ファイルパス(呼び出しごとに一意)を除いた
        # 引数列は完全一致する。
        self.assertEqual(override_command[1], default_command[1])
        self.assertEqual(override_command[3:], default_command[3:])


class T127jEdaxExeSwitchTests(unittest.TestCase):
    """T127j: v3バイナリ乗り換え準備で`label_position`系/`_expanded1m_settings_and_meta`
    に追加した`edax_exe`引数の配線を検証する(実際のEdax起動・plan/checkpointの
    読み書きは一切行わない)。低レベルの`_edax_solve_batch`のコマンド列自体は
    T127iの`VsEdaxSolveBatchCommandTests`で既に固定済み。"""

    def test_edax_solve_batch_forwards_edax_exe_to_low_level_call(self) -> None:
        captured: dict = {}

        def fake_low_level(positions, level, n_tasks=None, edax_hash_bits=None, edax_exe=None):
            captured["edax_exe"] = edax_exe
            captured["n_tasks"] = n_tasks
            return [{"depth": 1, "discDiff": 0.0, "move": "a1"}]

        override = Path("C:/fake/wEdax-x86-64-v3.exe")
        with mock.patch.object(gen.vs_edax, "_edax_solve_batch", side_effect=fake_low_level):
            gen.vs_edax.edax_solve_batch(
                [{"board": "-" * 64, "sideToMove": "black"}], 16, edax_exe=override
            )
        self.assertEqual(captured["edax_exe"], override)
        self.assertEqual(captured["n_tasks"], gen.vs_edax.EDAX_BATCH_TASKS)

    def test_edax_solve_batch_unspecified_edax_exe_forwards_none(self) -> None:
        captured: dict = {}

        def fake_low_level(positions, level, n_tasks=None, edax_hash_bits=None, edax_exe=None):
            captured["edax_exe"] = edax_exe
            return [{"depth": 1, "discDiff": 0.0, "move": "a1"}]

        with mock.patch.object(gen.vs_edax, "_edax_solve_batch", side_effect=fake_low_level):
            gen.vs_edax.edax_solve_batch([{"board": "-" * 64, "sideToMove": "black"}], 16)
        self.assertIsNone(captured["edax_exe"])

    @staticmethod
    def _one_parent_bundle() -> tuple[dict, dict]:
        board = "---------------------------OX------XO---------------------------"
        position = {"board": board, "sideToMove": "black", "source": "wthor"}
        children_info = {
            "empties": 22,
            "moves": [
                {
                    "move": "a1",
                    "childBoard": "A" * 64,
                    "childSideToMove": "white",
                    "childEmpties": 21,
                    "childIsTerminal": False,
                },
            ],
        }
        return position, children_info

    def test_label_position_omits_edax_exe_kwarg_when_unspecified(self) -> None:
        """未指定時は`vs_edax.edax_solve_batch`へ`edax_exe`キーワード自体を渡さない。
        渡っていれば下の固定シグネチャ`solve_batch(positions, level)`はTypeErrorで
        失敗するはずなので、完走すること自体が証拠になる(既存コーパス生成経路
        =primary/smoke/expanded200kのコマンド列不変性の裏付け)。"""
        position, children_info = self._one_parent_bundle()

        def solve_batch(positions: list[dict], level: int) -> list[dict]:
            return [{"depth": 21, "discDiff": 1.0, "move": "a1"}]

        with mock.patch.object(gen.vs_edax, "edax_solve_batch", side_effect=solve_batch):
            gen.label_position(0, position, children_info, exact_empties_threshold=20)

    def test_label_position_passes_edax_exe_when_specified(self) -> None:
        position, children_info = self._one_parent_bundle()
        captured: dict = {}
        override = Path("C:/fake/wEdax-x86-64-v3.exe")

        def solve_batch(positions: list[dict], level: int, edax_exe=None) -> list[dict]:
            captured["edax_exe"] = edax_exe
            return [{"depth": 21, "discDiff": 1.0, "move": "a1"}]

        with mock.patch.object(gen.vs_edax, "edax_solve_batch", side_effect=solve_batch):
            gen.label_position(0, position, children_info, exact_empties_threshold=20, edax_exe=override)
        self.assertEqual(captured["edax_exe"], override)

    def test_checkpoint_bundle_forwards_edax_exe_to_batch_path(self) -> None:
        parents = [(7, {"positionId": 7}, {}), (15, {"positionId": 15}, {})]
        records = [{"positionId": 7}, {"positionId": 15}]
        checkpoint = mock.Mock()
        override = Path("C:/fake/wEdax-x86-64-v3.exe")
        with mock.patch.object(gen, "label_positions_across_parents", return_value=records) as batch_call:
            fell_back = gen.checkpoint_expanded1m_parent_bundle(parents, checkpoint, edax_exe=override)
        self.assertFalse(fell_back)
        self.assertEqual(batch_call.call_args.kwargs.get("edax_exe"), override)

    def test_checkpoint_bundle_forwards_edax_exe_to_fallback_path(self) -> None:
        parents = [(7, {"positionId": 7}, {}), (15, {"positionId": 15}, {})]
        records = [{"positionId": 7}, {"positionId": 15}]
        checkpoint = mock.Mock()
        override = Path("C:/fake/wEdax-x86-64-v3.exe")
        with mock.patch.object(gen, "label_positions_across_parents", side_effect=RuntimeError("batch failed")):
            with mock.patch.object(gen, "label_position", side_effect=records) as individual:
                fell_back = gen.checkpoint_expanded1m_parent_bundle(parents, checkpoint, edax_exe=override)
        self.assertTrue(fell_back)
        for call in individual.call_args_list:
            self.assertEqual(call.kwargs.get("edax_exe"), override)

    @staticmethod
    def _legacy_plan_meta() -> dict:
        return {
            "selectionStats": {},
            "selectionPlanSha256": "master",
            "shardPlanSha256": [f"shard-{i}" for i in range(8)],
            "provenance": {
                "baseCorpus": {},
                "incrementalGeneration": {
                    "generatorSha256": "current",
                    "teacherCandidatesToolSha256": "current",
                    "edaxSha256": "current",
                    "edaxEvalDataSha256": "current",
                    "candidatePoolSha256": "pool",
                },
            },
        }

    def test_expanded1m_settings_and_meta_records_edax_exe_when_specified(self) -> None:
        plan_meta = self._legacy_plan_meta()
        with mock.patch.object(gen.vs_edax, "git_commit_hash", return_value="head"):
            with mock.patch.object(gen, "sha256_of_file", return_value="current"):
                settings, meta = gen._expanded1m_settings_and_meta(
                    0, plan_meta, edax_parents_per_process=32, edax_exe_name="wEdax-x86-64-v3.exe"
                )
        self.assertEqual(settings["edaxExe"], "wEdax-x86-64-v3.exe")
        self.assertEqual(meta["edaxExeSha256"], "current")
        # SHAゲート対象の`edaxSha256`はあくまで既定バイナリ(`vs_edax.EDAX_EXE`)を
        # 指し続け、`edaxExe`設定の有無で変わらない。
        self.assertEqual(meta["edaxSha256"], "current")

    def test_expanded1m_settings_and_meta_omits_edax_exe_when_unspecified(self) -> None:
        plan_meta = self._legacy_plan_meta()
        with mock.patch.object(gen.vs_edax, "git_commit_hash", return_value="head"):
            with mock.patch.object(gen, "sha256_of_file", return_value="current"):
                settings, meta = gen._expanded1m_settings_and_meta(0, plan_meta)
        self.assertNotIn("edaxExe", settings)
        self.assertNotIn("edaxExeSha256", meta)

    def test_corpus_sets_expanded1m_edax_exe_points_at_existing_v3_binary(self) -> None:
        """CORPUS_SETSの設定値自体(T127j乗り換え準備の本体)を固定する。バイナリ
        実体の存在確認のみ行い、Edaxは起動しない。"""
        edax_exe_name = gen.CORPUS_SETS["expanded1m"]["edaxExe"]
        self.assertEqual(edax_exe_name, "wEdax-x86-64-v3.exe")
        self.assertTrue((gen.vs_edax.EDAX_DIR / edax_exe_name).exists())


if __name__ == "__main__":
    unittest.main()
