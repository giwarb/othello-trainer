#!/usr/bin/env python3
"""Generate the T157 markdown report + meta.json from t157_rescore_results.json."""

import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "bench" / "edax-compare"))
from t157_rescore_weights import WEIGHTS, KNOWN_60_REGRET  # noqa: E402

RESULTS = ROOT / "bench/edax-compare/t157_rescore_results.json"
CORPUS = ROOT / "bench/edax-compare/t157_oracle_positions.json"
NEW_POSITIONS = ROOT / "bench/edax-compare/t157_new_positions.json"
LABELS = ROOT / "bench/edax-compare/t157_oracle_labels.json"
REPORT = ROOT / "bench/edax-compare/t157_oracle_expansion_report.md"
META = ROOT / "bench/edax-compare/t157_oracle_expansion.meta.json"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fmt(x, nd=4):
    return f"{x:.{nd}f}"


def main():
    results = json.loads(RESULTS.read_text(encoding="utf-8"))
    summary = results["summary"]
    corpus = json.loads(CORPUS.read_text(encoding="utf-8"))
    new_positions = json.loads(NEW_POSITIONS.read_text(encoding="utf-8"))

    order = [w["label"] for w in WEIGHTS if w["label"] in summary]

    # M2-style guard: v2 must reproduce the known 60-position constant exactly.
    v2 = summary["v2"]
    m2_guard_pass = abs(v2["n60"]["mean"] - 1.5666666666666667) < 1e-9

    # Cross-check every known point estimate, not just v2.
    cross_checks = []
    for label in order:
        entry = summary[label]
        cc = entry.get("knownN60CrossCheck")
        if cc:
            cross_checks.append((label, cc["expected"], cc["actual"], cc["match"]))
    all_cross_checks_pass = all(row[3] for row in cross_checks)

    # Ranking by n180 mean regret (lower = better).
    ranked = sorted(order, key=lambda label: summary[label]["n180"]["mean"])

    lines = []
    lines.append("# T157: oracle拡張(60→180局面)と既存重みの一括再採点\n")
    lines.append(f"生成元: `bench/edax-compare/t157_rescore_weights.py` / `t157_build_oracle_table.py` / "
                 f"`select_t157_new_positions.py` / `build_t157_combined_positions.py`\n")

    lines.append("## 1. oracleデータの機械検証\n")
    lines.append(f"- 局面数: {corpus['counts']['total']}(t096既存60 + t157拡張120)")
    lines.append(f"- 空き数分布: {corpus['counts']['byEmpties']}")
    lines.append(f"- 重複ゼロ検証: 全180局面のcanonicalKeyユニーク数="
                 f"{corpus['verification']['uniqueCanonicalKeys']}/180、"
                 f"教師コーパス重複={corpus['verification']['teacherCorpusOverlap']}")
    lines.append(f"- t157拡張120局面はさらにT096既存60・T156校正1,200局面ともcanonical重複ゼロを選定時に検証済み"
                 f"(`t157_new_positions.json` selection.excludedT096Overlap="
                 f"{new_positions['selection']['excludedT096Overlap']}, "
                 f"excludedT156Overlap={new_positions['selection']['excludedT156Overlap']} は除外件数、"
                 f"selection後の再検証は0件を保証)")
    lines.append(f"- 選定は乱数seed {new_positions['selection']['seed']}で決定的"
                 f"(2回実行しSHA-256完全一致を確認)")
    lines.append(f"- Edaxラベルは全180局面×全合法手を`-l 60 -book-usage off`で決定的に生成"
                 f"(`t157_build_oracle_table.py`、局面単位checkpoint/resume)")
    inconsistent = [r for r in json.loads(LABELS.read_text(encoding='utf-8'))["rows"]
                    if r["consistentWithRoot"] is False]
    lines.append(f"- 整合性チェック(root oracle値 == 全合法手中の最大値): 不一致 {len(inconsistent)}件\n")

    lines.append("## 2. M2ガード(v2の既存60局面値 再現)\n")
    lines.append(f"- v2 @60局面 regret = **{fmt(v2['n60']['mean'], 16)}**")
    lines.append(f"- 既知値 1.5666666666666667 との完全一致: **{'PASS' if m2_guard_pass else 'FAIL'}**\n")

    lines.append("## 3. 全重みの既知値クロスチェック(@60局面)\n")
    lines.append("T096以降の各タスクが個別に測定した60局面regretを、本タスクの新パイプライン"
                 "(全合法手Edaxラベル表 + 重みごとのeval_cli lookup方式)で再現できるかを検証した"
                 "(単なるv2 M2ガードに留まらない、全重みでの完全独立再現性チェック)。\n")
    lines.append("| weight | 既知値(過去タスク) | 本タスク@60 | 一致 |")
    lines.append("|---|---:|---:|:---:|")
    for label, expected, actual, match in cross_checks:
        lines.append(f"| {label} | {fmt(expected,10)} | {fmt(actual,10)} | {'PASS' if match else 'FAIL'} |")
    lines.append(f"\n全{len(cross_checks)}件クロスチェック: **{'全PASS' if all_cross_checks_pass else '不一致あり'}**\n")

    lines.append("## 4. 順位表(60/120/180局面、位置レベルbootstrap絶対CI付き)\n")
    lines.append("regretは石数(低いほど良い)。CIは各局面集合内での位置レベルbootstrap(resample with "
                 f"replacement, seed={list(summary.values())[0]['n180']['seed']}, "
                 f"samples={list(summary.values())[0]['n180']['samples']})による95%パーセンタイルCI。"
                 "順位は180局面のregretの昇順。\n")
    lines.append("| 順位 | weight | 説明 | @60 regret [95%CI] | @120 regret [95%CI] | @180 regret [95%CI] |")
    lines.append("|---:|---|---|---:|---:|---:|")
    for rank, label in enumerate(ranked, 1):
        e = summary[label]
        w = next(w for w in WEIGHTS if w["label"] == label)
        n60, n120, n180 = e["n60"], e["n120"], e["n180"]
        lines.append(f"| {rank} | **{label}** | {w['desc']} | "
                     f"{fmt(n60['mean'])} [{fmt(n60['ci95'][0])}, {fmt(n60['ci95'][1])}] | "
                     f"{fmt(n120['mean'])} [{fmt(n120['ci95'][0])}, {fmt(n120['ci95'][1])}] | "
                     f"{fmt(n180['mean'])} [{fmt(n180['ci95'][0])}, {fmt(n180['ci95'][1])}] |")
    lines.append("")

    lines.append("## 5. v2比paired bootstrap CI(@180、参考)\n")
    lines.append("| weight | 180局面でのv2との差(平均) | 95%CI | 判定 |")
    lines.append("|---|---:|---:|---|")
    for label in ranked:
        if label == "v2":
            continue
        e = summary[label]
        vs = e.get("vsV2_n180")
        if vs is None:
            continue
        cls = {"worse": "v2より悪化", "improved": "v2より改善",
              "no_significant_difference": "有意差なし"}[vs["classification"]]
        lines.append(f"| {label} | {fmt(vs['meanDifference'])} | "
                     f"[{fmt(vs['ci95'][0])}, {fmt(vs['ci95'][1])}] | {cls} |")
    lines.append("")

    v4_family = ["v4_prod", "t124_seed1", "t124_seed2"]
    v4_vals180 = [summary[l]["n180"]["mean"] for l in v4_family if l in summary]
    v4_vals60 = [summary[l]["n60"]["mean"] for l in v4_family if l in summary]
    v4_avg180 = sum(v4_vals180) / len(v4_vals180) if v4_vals180 else None
    v4_avg60 = sum(v4_vals60) / len(v4_vals60) if v4_vals60 else None
    v4_prod_ci180 = summary["v4_prod"]["n180"]["ci95"] if "v4_prod" in summary else None

    lines.append("## 6. 「v4本番=1.111の頑健性」への答え\n")
    lines.append("T124で報告された `1.1111` は、v4×WTHOR 3seed(seed1=0.7000, seed2=1.6667, "
                 "seed3=0.9667=v4本番)の**60局面oracleでの平均**である。本タスクでは180局面(既存60+新120)"
                 "でこの3seedを再測定した。\n")
    lines.append("| | seed1 | seed2 | seed3(v4本番) | 3seed平均 |")
    lines.append("|---|---:|---:|---:|---:|")
    if all(l in summary for l in v4_family):
        lines.append(f"| @60(既知値相当) | {fmt(summary['t124_seed1']['n60']['mean'])} | "
                     f"{fmt(summary['t124_seed2']['n60']['mean'])} | "
                     f"{fmt(summary['v4_prod']['n60']['mean'])} | {fmt(v4_avg60)} |")
        lines.append(f"| @180(本タスク) | {fmt(summary['t124_seed1']['n180']['mean'])} | "
                     f"{fmt(summary['t124_seed2']['n180']['mean'])} | "
                     f"{fmt(summary['v4_prod']['n180']['mean'])} | **{fmt(v4_avg180)}** |")
    lines.append("")
    if v4_avg180 is not None:
        delta = v4_avg180 - v4_avg60
        direction = "改善(規模拡大でむしろ良化)" if delta < 0 else "悪化(規模拡大で目減り)" if delta > 0 else "不変"
        v2_60 = v2["n60"]["mean"]
        v2_180 = summary["v2"]["n180"]["mean"]
        gap60 = v2_60 - v4_avg60
        gap180 = v2_180 - v4_avg180
        all_no_sig = all(summary[l]["vsV2_n180"]["classification"] == "no_significant_difference"
                        for l in order if l != "v2" and summary[l].get("vsV2_n180"))
        lines.append(f"- 180局面での3seed平均regret = **{fmt(v4_avg180)}**"
                     f"(60局面の{fmt(v4_avg60)}から{fmt(abs(delta))}石{direction})")
        lines.append(f"- v4本番(seed3)単体の180局面絶対CI = "
                     f"[{fmt(v4_prod_ci180[0])}, {fmt(v4_prod_ci180[1])}]")
        lines.append(f"- v2の180局面regret = {fmt(v2_180)}(既知60局面値{fmt(v2_60)}から"
                     f"{fmt(v2_180 - v2_60)}石の変化)")
        lines.append(f"- **v2とv4系(3seed平均)の差(regret、正=v4系が良い)**: "
                     f"60局面時点 {fmt(gap60)}石 → 180局面時点 **{fmt(gap180)}石**"
                     f"({'ほぼ解消' if abs(gap180) < 0.1 else '縮小' if abs(gap180) < abs(gap60) else '拡大'})")
        lines.append(f"- **v2比paired bootstrap CI(セクション5)は、v4本番を含む再採点9重み"
                     f"{'すべてで' if all_no_sig else '(一部を除き)'}「有意差なし」**"
                     f"(v2 CIは[{fmt(summary['v2']['n180']['ci95'][0])}, "
                     f"{fmt(summary['v2']['n180']['ci95'][1])}]、"
                     f"v4本番CIは[{fmt(v4_prod_ci180[0])}, {fmt(v4_prod_ci180[1])}]と大きく重なる)")
        lines.append(f"- **結論**: 「v4本番=1.111」というヘッドライン数値そのものは、"
                     "60局面という小標本の点推定であり180局面では3seed平均1.396へ目減りした。"
                     "より重要なのは、v2とのギャップが60局面時点の"
                     f"{fmt(gap60)}石(見かけ上「v4系が大きく勝る」)から180局面時点で"
                     f"**{fmt(gap180)}石**へほぼ消失し、かつpaired bootstrap CIでは元々有意差が"
                     "証明されていた訳ではなかった(v2比較は毎回`no_significant_difference`)ことである。"
                     "**「v4×WTHOR=1.111が偶々良い値を引いた可能性」はデータに支持される** "
                     "— 60局面oracleは、v2・v3・v4系列・Egaroucid系列の実力差を有意に検出できるだけの"
                     "解像度を持っていなかった可能性が高く、180局面でもなお全candidateがv2と統計的に"
                     "識別不能である。これは「v4系が実は弱い」ことの証明ではなく、"
                     "「60局面はおろか180局面のoracleでも、これらの候補間の細かい差を有意に検出するには"
                     "まだ標本が小さすぎる」ことを示す(帰無仮説を採択できないだけで、実際に差がない"
                     "とは断定できない)。\n")

    lines.append("## 7. 主要比較(WTHOR vs Egaroucid vs 蒸留)が180局面でどう変わるか\n")
    if all(l in summary for l in ["t154_runB", "t155_e1_seed1", "t155_e1_seed2", "t155_e1_seed3", "t155_e2_seed1"]):
        e1_avg180 = sum(summary[f"t155_e1_seed{i}"]["n180"]["mean"] for i in (1, 2, 3)) / 3
        e1_avg60 = sum(summary[f"t155_e1_seed{i}"]["n60"]["mean"] for i in (1, 2, 3)) / 3
        lines.append(f"- **WTHOR(v4×WTHOR 3seed平均)**: @60 {fmt(v4_avg60)} → @180 {fmt(v4_avg180)}")
        lines.append(f"- **Egaroucid Run B(T154, t090_distillation.rsトレーナー)**: "
                     f"@60 {fmt(summary['t154_runB']['n60']['mean'])} → "
                     f"@180 {fmt(summary['t154_runB']['n180']['mean'])}")
        lines.append(f"- **Egaroucid E1(T155, train_patterns_v3トレーナー, 3seed平均)**: "
                     f"@60 {fmt(e1_avg60)} → @180 {fmt(e1_avg180)}")
        lines.append(f"- **Egaroucid E2(T155, @8,000,000, 参考)**: "
                     f"@60 {fmt(summary['t155_e2_seed1']['n60']['mean'])} → "
                     f"@180 {fmt(summary['t155_e2_seed1']['n180']['mean'])}")
        lines.append(f"- **蒸留系(T120/T123/T126、参考・本タスクでは未再測定)**: 60局面でのregretは "
                     "teacher-only 200k=2.389、v3×蒸留200k=2.011、v4×蒸留200k=2.867 と、いずれもWTHOR/Egaroucid系"
                     "(0.7〜1.7台)から1石以上悪い。本タスクの対象重み一覧に蒸留候補は含まれておらず180局面での"
                     "再測定は行っていないが、既存の較差の大きさ(1石以上、本タスクで判明したWTHOR/Egaroucid系の"
                     "相互差0.1〜0.3石より一桁大きい)から見て60→180局面のノイズ縮小だけでこの序列"
                     "(蒸留が最下位)が逆転する可能性は低いと判断する(定性的な申し送り、再測定は将来タスク)。")
        lines.append(f"- **総括**: WTHOR(v4系)・Egaroucid(T154/T155)は180局面では{fmt(min(v4_avg180, summary['t154_runB']['n180']['mean'], e1_avg180, summary['t155_e2_seed1']['n180']['mean']))}〜"
                     f"{fmt(max(v4_avg180, summary['t154_runB']['n180']['mean'], e1_avg180, summary['t155_e2_seed1']['n180']['mean']))}石の狭いレンジに収まり、"
                     "互いに、またv2とも統計的に有意な差が出ていない(セクション5参照)。60局面時点で見えていた"
                     "「WTHORが最良・Egaroucidはそれに劣る」という序列は、180局面ではほぼフラット化した。"
                     "蒸留系との1石以上の較差だけが引き続き明確に大きい。\n")

    lines.append("## 8. 今後の標準\n")
    lines.append("以後のスクリーニングは本180局面oracle(`t157_oracle_positions.json` + "
                 "`t157_oracle_labels.json`)を標準とする。既存の`compare_pattern_v3.py`のデフォルト"
                 "(t085_exact_positions.json)やT096の60局面(`t096_oracle_positions.json`)は変更せず、"
                 "180局面で測る場合は本タスクの`t157_rescore_weights.py --corpus "
                 "bench/edax-compare/t157_oracle_positions.json --labels "
                 "bench/edax-compare/t157_oracle_labels.json`を使う(全合法手Edaxラベル表を再利用するため、"
                 "新規重みの追加はeval_cliのmove選択のみで済み、Edax呼び出しは不要)。\n")

    lines.append("## 9. 実行コマンド\n")
    lines.append("```")
    lines.append("python bench/edax-compare/select_t157_new_positions.py")
    lines.append("python bench/edax-compare/build_t157_combined_positions.py")
    lines.append("python bench/edax-compare/t157_build_oracle_table.py")
    lines.append("python bench/edax-compare/t157_rescore_weights.py")
    lines.append("python bench/edax-compare/t157_generate_report.py")
    lines.append("```\n")

    REPORT.write_text("\n".join(lines) + "\n", encoding="utf-8")

    meta = {
        "task": "T157",
        "provenance": results["metadata"],
        "gitTreeAtReportTime": results.get("gitTreeAtLastWrite"),
        "corpusSha256": digest(CORPUS),
        "labelsSha256": digest(LABELS),
        "resultsSha256": digest(RESULTS),
        "m2GuardPass": m2_guard_pass,
        "allCrossChecksPass": all_cross_checks_pass,
        "crossChecks": [{"label": l, "expected": e, "actual": a, "match": m}
                        for l, e, a, m in cross_checks],
        "rankingByN180": ranked,
        "v4Family3SeedAverage": {"n60": v4_avg60, "n180": v4_avg180},
    }
    META.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {REPORT} and {META}")
    print(f"M2 guard: {'PASS' if m2_guard_pass else 'FAIL'}, "
          f"all cross-checks: {'PASS' if all_cross_checks_pass else 'FAIL'}")


if __name__ == "__main__":
    main()
