import importlib.util
import shutil
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("compare_mpc.py")
SPEC = importlib.util.spec_from_file_location("compare_mpc", MODULE_PATH)
compare_mpc = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(compare_mpc)


def record(position_id="p1", depth=8):
    return {
        "id": position_id, "gameId": "g1", "empties": 30, "depthRequested": depth,
        "bestMove": "a1", "nodes": 10, "midgameNodes": 8, "exactNodes": 2,
        "exactRootAttempts": 0, "exactRootCompleted": False, "exactLeafAttempts": 1,
        "exactLeafCompleted": 1, "exactBoundProofCompleted": 1, "exactAbortedByQuota": 0,
    }


def checkpoint(records=None):
    ids = ["p1"]
    return {
        "schemaVersion": 1,
        "config": {
            "depths": [8], "mpc": False, "selectedPositionsCount": 1,
            "selectedPositionsFingerprint": compare_mpc.ids_fingerprint(ids),
            "exactFromEmpties": 0,
        },
        "records": records if records is not None else [record()],
    }


class CompareMpcValidationTests(unittest.TestCase):
    def test_each_modified_canonical_input_is_rejected(self):
        repository = MODULE_PATH.parents[2]
        canonical = {
            "gate2_positions_path": (
                repository / "bench/edax-compare/t156_mpc_positions.json",
                "Gate 2 positions canonical SHA-256",
            ),
            "oracle_positions_path": (
                repository / "bench/edax-compare/t157_oracle_positions.json",
                "oracle positions canonical SHA-256",
            ),
            "oracle_labels_path": (
                repository / "bench/edax-compare/t157_oracle_labels.json",
                "oracle labels canonical SHA-256",
            ),
            "weights_path": (
                repository / "train/weights/pattern_v4.bin",
                "v4 weights canonical SHA-256",
            ),
        }
        original_paths = {name: value[0] for name, value in canonical.items()}
        for modified_name, (source, error_name) in canonical.items():
            with self.subTest(input=modified_name), tempfile.TemporaryDirectory() as directory:
                modified = Path(directory) / source.name
                shutil.copyfile(source, modified)
                with modified.open("r+b") as file:
                    first_byte = file.read(1)
                    self.assertTrue(first_byte)
                    file.seek(0)
                    file.write(bytes([first_byte[0] ^ 0x01]))
                paths = {**original_paths, modified_name: modified}
                with self.assertRaisesRegex(ValueError, error_name):
                    compare_mpc.validate_inputs(None, None, None, **paths)

    def test_duplicate_checkpoint_records_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "duplicate"):
            compare_mpc.by_key(checkpoint([record(), record()]))

    def test_configuration_mismatch_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "config.mpc"):
            compare_mpc.validate_checkpoint(checkpoint(), {"mpc": True}, ["p1"], "test")

    def test_selected_position_fingerprint_mismatch_is_rejected(self):
        data = checkpoint()
        data["config"]["selectedPositionsFingerprint"] = "wrong"
        with self.assertRaisesRegex(ValueError, "selected fingerprint"):
            compare_mpc.validate_checkpoint(data, {"mpc": False}, ["p1"], "test")

    def test_record_set_mismatch_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "record keys"):
            compare_mpc.validate_checkpoint(checkpoint(), {"mpc": False}, ["p1", "p2"], "test")

    def test_exact_accounting_checks_full_node_partition(self):
        data = checkpoint()
        data["records"][0]["midgameNodes"] = 9
        summary = compare_mpc.exact_summary(data)
        self.assertEqual(summary["invalidAccountingReasons"]["nodePartitionMismatch"], 1)
        self.assertGreater(summary["invalidAccountingRows"], 0)

    def test_exact_accounting_accepts_consistent_row(self):
        summary = compare_mpc.exact_summary(checkpoint())
        self.assertEqual(summary["invalidAccountingRows"], 0)
        self.assertEqual(summary["exactNodes"] + summary["midgameNodes"], summary["totalNodes"])

    def test_oracle_regret_duplicate_record_is_rejected(self):
        data = checkpoint([record(), {**record(), "depthRequested": 10}])
        labels = {"rows": [{"id": "p1", "oracleScore": 4, "moves": {"a1": 2}}]}
        with self.assertRaisesRegex(ValueError, "duplicate oracle regret"):
            compare_mpc.oracle_regrets(data, labels)

    def test_percentile_interpolates_boundary(self):
        self.assertEqual(compare_mpc.percentile([1, 3], 0.5), 2)

    def test_loss4_increase_limit_scales_to_120_positions(self):
        self.assertEqual(compare_mpc.loss4_increase_limit(120), 4)



if __name__ == "__main__":
    unittest.main()
