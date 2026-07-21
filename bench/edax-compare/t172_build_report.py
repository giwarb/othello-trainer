#!/usr/bin/env python3
"""T172: sigma比較(要件1)とGate 2/3(要件2/3)の結果を1本のレポート
(`bench/edax-compare/t172_mpc_report.md` + meta)にまとめる。

個々の生成物(`t172_sigma_compare.py`のsigma比較meta、`compare_mpc.py`の
Gate 2/3 meta)はそれぞれ独立にテスト・再現可能な状態を保ったまま、本
スクリプトはその2つのmetaを読み込んで統合ビュー(結論・σ比較表・
Gate 2/3表・判定・再現手順)を1ファイルに書き出すだけの薄い集約層。
"""
import argparse
import hashlib
import json
from pathlib import Path


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def atomic_json(path, value):
    temp = path.with_name("." + path.name + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                     encoding="utf-8", newline="\n")
    temp.replace(path)


def atomic_text(path, value):
    temp = path.with_name("." + path.name + ".tmp")
    temp.write_text(value, encoding="utf-8", newline="\n")
    temp.replace(path)


def pc(x):
    return f"{100 * x:.2f}%"


def build(sigma_meta, gates_meta):
    g2, g3 = gates_meta["gate2"], gates_meta["gate3"]
    overall_pass = g2["pass"] and g3["pass"]
    return {
        "schemaVersion": 1,
        "task": "T172",
        "analysis": "v6再校正: sigma比較+Gate 2/3",
        "sigmaComparison": {
            "allShrunk": sigma_meta["allShrunk"],
            "shrunkCount": sigma_meta["shrunkCount"],
            "rowCount": sigma_meta["rowCount"],
            "meanSigmaRatioV6OverV4": sigma_meta["meanSigmaRatioV6OverV4"],
        },
        "gate2Pass": g2["pass"],
        "gate3Pass": g3["pass"],
        "overallPass": overall_pass,
        "primaryGate3Criteria": {
            "depthPlusOneRateAtLeast35Percent": g3["bMinusA"]["depthPlusOneRate"] >= 0.35,
            "meanRegretDiffAtMost010": g3["bMinusA"]["meanRegretDifference"] <= 0.10,
            "depthPlusOneRateActual": g3["bMinusA"]["depthPlusOneRate"],
            "meanRegretDifferenceActual": g3["bMinusA"]["meanRegretDifference"],
        },
        "decision": "adopt_proceed_to_t173" if overall_pass else "preregistered_retreat_mpc_stays_off",
        "sources": {
            "sigmaCompareMeta": {"path": None, "sha256": None},
            "gatesMeta": {"path": None, "sha256": None},
        },
    }


def report(meta, sigma_report_text, gates_report_text):
    lines = ["# T172 MPCv6再校正 総合レポート", "", "## 結論", ""]
    decision_text = {
        "adopt_proceed_to_t173": "**両ゲート合格。T173(対局ゲート、v6+MPC on vs v6+MPC off、Edax lv10+lv12)へ進む提案。**",
        "preregistered_retreat_mpc_stays_off": "**Gate 3不合格。事前登録どおり撤退(MPCはdefault OFF維持)。T173へは進まない。**",
    }[meta["decision"]]
    lines.append(decision_text)
    lines.append("")
    sc = meta["sigmaComparison"]
    lines.append(
        f"- σ比較(要件1): {sc['shrunkCount']}/{sc['rowCount']}行でσ縮小"
        f"(平均比v6/v4={sc['meanSigmaRatioV6OverV4']:.4f})→ 見込みありと判定、Gate 2/3へ進んだ。"
    )
    lines.append(f"- Gate 2(固定深さ): {'合格' if meta['gate2Pass'] else '不合格'}")
    pg3 = meta["primaryGate3Criteria"]
    lines.append(
        f"- Gate 3(160k本番相当、主判定線): {'合格' if meta['gate3Pass'] else '不合格'}"
        f"(深さ+1到達率{pg3['depthPlusOneRateActual']:.2%}"
        f"{'≥35% pass' if pg3['depthPlusOneRateAtLeast35Percent'] else '<35% FAIL'}、"
        f"regret差{pg3['meanRegretDifferenceActual']:+.4f}石"
        f"{'≤+0.10 pass' if pg3['meanRegretDiffAtMost010'] else '>+0.10 FAIL'})"
    )
    lines += ["", "## 1. σ比較(v4校正時 vs v6校正時)", "", "候補(d,D)=(3,6),(4,8),(2,10),(4,12)(T156b選定)×4空き帯=16行。", ""]
    # sigma_report_textの本体(見出し行を除いた表部分)をそのまま埋め込む
    sigma_lines = sigma_report_text.splitlines()
    table_start = next(i for i, line in enumerate(sigma_lines) if line.startswith("| 空き帯"))
    lines += sigma_lines[table_start:]
    lines += ["", "## 2. Gate 2 / Gate 3(v6)", ""]
    gates_lines = gates_report_text.splitlines()
    gate2_start = next(i for i, line in enumerate(gates_lines) if line.startswith("## Gate 2"))
    lines += gates_lines[gate2_start:]
    lines += ["", "## 再現方法", "",
              "```powershell", "python bench/edax-compare/t172_sigma_compare.py --v4-stats bench/edax-compare/t156_mpc_pilot_stats.json --v6-stats bench/edax-compare/t172_v6_pilot_stats.json --out bench/edax-compare/t172_sigma_compare.meta.json --report bench/edax-compare/t172_sigma_compare_report.md",
              "python bench/edax-compare/compare_mpc.py --gate2-off ... --gate2-on ... --gate3-a ... (計8 checkpoint) --gate2-positions bench/edax-compare/t156_mpc_positions.json --oracle-positions bench/edax-compare/t157_oracle_positions.json --oracle-labels bench/edax-compare/t157_oracle_labels.json --pattern-weights train/weights/pattern_v6.bin --report bench/edax-compare/t172_mpc_gates_report.md --meta bench/edax-compare/t172_mpc_gates_report.meta.json --weights-label v6",
              "python bench/edax-compare/t172_build_report.py --sigma-meta bench/edax-compare/t172_sigma_compare.meta.json --gates-meta bench/edax-compare/t172_mpc_gates_report.meta.json --sigma-report bench/edax-compare/t172_sigma_compare_report.md --gates-report bench/edax-compare/t172_mpc_gates_report.md --out bench/edax-compare/t172_mpc_report.meta.json --report bench/edax-compare/t172_mpc_report.md",
              "```", ""]
    return "\n".join(lines)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--sigma-meta", type=Path, required=True)
    p.add_argument("--gates-meta", type=Path, required=True)
    p.add_argument("--sigma-report", type=Path, required=True)
    p.add_argument("--gates-report", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--report", type=Path, required=True)
    a = p.parse_args()
    sigma_meta, gates_meta = load(a.sigma_meta), load(a.gates_meta)
    meta = build(sigma_meta, gates_meta)
    meta["sources"]["sigmaCompareMeta"] = {"path": a.sigma_meta.as_posix(), "sha256": digest(a.sigma_meta)}
    meta["sources"]["gatesMeta"] = {"path": a.gates_meta.as_posix(), "sha256": digest(a.gates_meta)}
    atomic_json(a.out, meta)
    atomic_text(a.report, report(meta, a.sigma_report.read_text(encoding="utf-8"),
                                  a.gates_report.read_text(encoding="utf-8")))
    print(json.dumps({"decision": meta["decision"], "gate2Pass": meta["gate2Pass"], "gate3Pass": meta["gate3Pass"]},
                      sort_keys=True))


if __name__ == "__main__":
    main()
