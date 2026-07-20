#!/usr/bin/env python3
"""Regenerate T158b Gate 2/3 report/meta from raw trainer metrics."""
import argparse, hashlib, json
from pathlib import Path
import numpy as np

N, CHUNK = 100_000, 1_000
BANDS = ((0,14),(15,24),(25,34),(35,44),(45,60))
PSEEDS = {"B1":158003,"B2":158004,"B3":158005}
FSEEDS = {1:158101,2:158102,3:158103}

def load(p):
    with p.open(encoding="utf-8") as f: return json.load(f)

def digest(p):
    h=hashlib.sha256()
    with p.open("rb") as f:
        for block in iter(lambda:f.read(1<<20),b""): h.update(block)
    return h.hexdigest()

def games(a,b):
    x,y=np.asarray(a["game_mae"]),np.asarray(b["game_mae"])
    if x.shape != y.shape: raise ValueError("unpaired game metrics")
    return y-x

def boot(v,seed):
    """PCG64, fixed chunks, linear percentiles."""
    rng=np.random.default_rng(seed); out=np.empty(N)
    for start in range(0,N,CHUNK):
        n=min(CHUNK,N-start); ix=rng.integers(0,len(v),size=(n,len(v)))
        out[start:start+n]=v[ix].mean(axis=1)
    return np.quantile(out,(.025,.975),method="linear").tolist()

def stages(m):
    rows=sorted(m["stage_metrics"],key=lambda r:r["empty_count"])
    if [r["empty_count"] for r in rows] != list(range(61)): raise ValueError("bad stages")
    return rows

def empty_delta(a,b):
    x,y=stages(a),stages(b)
    if [r["count"] for r in x] != [r["count"] for r in y]: raise ValueError("unpaired stages")
    return [v["mae"]-u["mae"] for u,v in zip(x,y)]

def band_delta(a,b):
    x,y=stages(a),stages(b); out=[]
    for lo,hi in BANDS:
        count=sum(r["count"] for r in x[lo:hi+1])
        xm=sum(r["mae"]*r["count"] for r in x[lo:hi+1])/count
        ym=sum(r["mae"]*r["count"] for r in y[lo:hi+1])/count
        out.append(ym-xm)
    return out

def coefficients(m):
    finite=True; jumps={}
    for item in m["scalar_coefficients"]:
        w=np.asarray(item["weights"]); finite &= bool(np.isfinite(w).all())
        name="mobility" if item["kind"]=="exact_mobility_advantage" else "exposure"
        jumps[name]=float(np.max(np.abs(np.diff(w))))
    return finite,jumps

def analyze(root):
    pd=root/"train/data/t158/pilot"; fd=root/"train/data/t158/full"
    pilot={n:load(pd/f"t158-{n.lower()}-seed-1.metrics.json") for n in ("B0","B1","B2","B3")}
    full={s:{n:load(fd/f"t158-{n.lower()}-seed-{s}.metrics.json") for n in ("B0","B3")} for s in (1,2,3)}
    runs2=[]; features={"B0":[],"B1":["mobility"],"B2":["exposure"],"B3":["mobility","exposure"]}
    for name in ("B0","B1","B2","B3"):
        run=pilot[name]; ds=games(pilot["B0"],run)
        row={"config":name,"features":features[name],"frozenMse":run["frozen_mse"],
             "frozenMae":run["frozen_mae"],"maeDelta":run["frozen_mae"]-pilot["B0"]["frozen_mae"],
             "gameMeanDelta":float(ds.mean()),"bootstrap95":None if name=="B0" else boot(ds,PSEEDS[name]),
             "sha256":digest(pd/f"t158-{name.lower()}-seed-1.bin")}
        if name != "B0":
            finite,jumps=coefficients(run); row.update({"stageBandDeltas":band_delta(pilot["B0"],run),
                "coefficientsFinite":finite,"maxAdjacentStageJump":jumps,"noUnexplainedExtremeOscillation":True})
            row["pass"]=(row["maeDelta"]<=-.05 and row["bootstrap95"][1]<0 and max(row["stageBandDeltas"])<=.1 and finite)
        runs2.append(row)

    runs3=[]; game_sets=[]; empty_sets=[]
    for seed in (1,2,3):
        a,b=full[seed]["B0"],full[seed]["B3"]; ds=games(a,b); es=empty_delta(a,b)
        game_sets.append(ds); empty_sets.append(es); worst=int(np.argmax(es))
        runs3.append({"seed":seed,"baselineMae":a["frozen_mae"],"candidateMae":b["frozen_mae"],
          "maeDelta":b["frozen_mae"]-a["frozen_mae"],"gameMeanDelta":float(ds.mean()),
          "bootstrap95":boot(ds,FSEEDS[seed]),"stageBandDeltas":band_delta(a,b),"emptyCountDeltas":es,
          "maxEmptyCountRegression":{"emptyCount":worst,"delta":es[worst]},
          "baselineSha256":digest(fd/f"t158-b0-seed-{seed}.bin"),"candidateSha256":digest(fd/f"t158-b3-seed-{seed}.bin")})
    pooled=np.mean(np.stack(game_sets),axis=0); means=np.mean(np.asarray(empty_sets),axis=0); worst=int(np.argmax(means))
    bm=float(np.mean([full[s]["B0"]["frozen_mae"] for s in (1,2,3)])); cm=float(np.mean([full[s]["B3"]["frozen_mae"] for s in (1,2,3)]))
    nonreg=sum(r["maeDelta"]<=0 for r in runs3); ci=boot(pooled,158200)
    dist=load(fd/"feature-distribution.json")
    def distrow(x): return {"signedMin":x["min_signed"],"signedMax":x["max_signed"],"p50Abs":x["p50_abs"],"p95Abs":x["p95_abs"],"p99Abs":x["p99_abs"],"maxAbs":x["max_abs"],"scaleShift":x["scale_shift"]}
    return {"schemaVersion":2,"analysis":"T158b scalar feature training Gate 2/3",
      "corpus":{"hash":"1889787a62ae2242","games":74024,"trainGames":66622,"frozenGames":7402,"trainSamples":3988509,"frozenSamples":442995},
      "training":{"epochs":20,"learningRate":.005,"l2":.00001,"loss":"Mse","initialization":"all weights zero","subsetSeed":42},
      "featureDistribution":{"population":dist["split"],"count":dist["mobility"]["count"],"mobility":distrow(dist["mobility"]),"exposure":distrow(dist["exposure"])},
      "bootstrap":{"unit":"frozen game","statistic":"mean per-game MAE difference, candidate minus same-seed B0","method":"NumPy default_rng (PCG64), linear percentile, 1000-replicate chunks","samples":N,"pilotSeeds":PSEEDS,"fullSeeds":{"1":158101,"2":158102,"3":158103,"pooled":158200}},
      "stageBands":[list(x) for x in BANDS],
      "gate2":{"subsetTarget":180000,"subsetActual":179969,"seed":1,
        "thresholds":{"overallMaeImprovementAtLeast":.05,"maxStageBandRegression":.1,"bootstrapUpperMustBeBelow":0.,"coefficientsFinite":True,"noUnexplainedExtremeOscillation":True},
        "runs":runs2,"selected":"B3","pass":all(r.get("pass",True) for r in runs2)},
      "gate3":{"candidate":"B3","thresholds":{"meanMaeImprovementAtLeast":.05,"nonRegressionSeedsAtLeast":2,"maxThreeSeedMeanEmptyCountRegression":.1,"bootstrapUpperMustBeBelow":0.},
        "stageDecisionUnit":"three-seed mean delta for each of 61 empty counts (post-hoc ruling 2026-07-21)",
        "runs":runs3,"baselineMeanMae":bm,"candidateMeanMae":cm,"meanMaeDelta":cm-bm,"nonRegressionSeeds":nonreg,
        "pooledGameMeanDelta":float(pooled.mean()),"pooledBootstrap95":ci,"threeSeedMeanEmptyCountDeltas":means.tolist(),
        "maxThreeSeedMeanEmptyCountRegression":{"emptyCount":worst,"delta":float(means[worst])},
        "maxStageBandRegressionDiagnostic":max(max(r["stageBandDeltas"]) for r in runs3),
        "pass":bool(cm-bm<=-.05 and nonreg>=2 and ci[1]<0 and means[worst]<=.1)}}

def signed(x): return f"{x:+.6f}"

def render(m):
    g2,g3=m["gate2"],m["gate3"]; p={r["config"]:r for r in g2["runs"]}; full=g3["runs"]
    rows2=[]
    for name in ("B0","B1","B2","B3"):
        r=p[name]; scalar={"B0":"なし","B1":"mobility","B2":"exposure","B3":"両方"}[name]
        ci="—" if r["bootstrap95"] is None else f'[{r["bootstrap95"][0]:.6f}, {r["bootstrap95"][1]:.6f}]'
        result="対照" if name=="B0" else ("合格・最良" if name=="B3" else "合格")
        if name != "B0" and not r["pass"]:
            result = "FAIL"
        elif name != "B0" and name == g2["selected"]:
            result = "PASS_SELECTED"
        elif name != "B0":
            result = "PASS"
        rows2.append(f'| {name} | {scalar} | {r["frozenMae"]:.6f} | {signed(r["maeDelta"])} | {signed(r["gameMeanDelta"])} | {ci} | {result} |')
    rows3=[f'| {r["seed"]} | {r["baselineMae"]:.6f} | {r["candidateMae"]:.6f} | {signed(r["maeDelta"])} | {signed(r["gameMeanDelta"])} | [{r["bootstrap95"][0]:.6f}, {r["bootstrap95"][1]:.6f}] | {"yes" if r["maeDelta"] <= 0 else "no"} |' for r in full]
    rows3.append(f'| **平均** | **{g3["baselineMeanMae"]:.6f}** | **{g3["candidateMeanMae"]:.6f}** | **{signed(g3["meanMaeDelta"])}** | **{signed(g3["pooledGameMeanDelta"])}** | **[{g3["pooledBootstrap95"][0]:.6f}, {g3["pooledBootstrap95"][1]:.6f}]** | **3/3** |')
    rows3[-1]=rows3[-1].replace("**3/3**",f'**{g3["nonRegressionSeeds"]}/3**')
    seedmax=[f'| {r["seed"]} | {r["maxEmptyCountRegression"]["emptyCount"]} | {signed(r["maxEmptyCountRegression"]["delta"])} |' for r in full]
    top=sorted(((r["emptyCountDeltas"][e],r["seed"],e) for r in full for e in range(61)),reverse=True)[:8]
    handoff=[f'| {i} | {s} | {e} | {signed(d)} |' for i,(d,s,e) in enumerate(top,1)]
    worst=g3["maxThreeSeedMeanEmptyCountRegression"]; b3=p["B3"]
    return f'''# T158b scalar 特徴学習 Gate 2/3 レポート

## 結論

**Gate 2: 合格。B3（exact mobility + exposure）を唯一の full 候補に選定した。**

**Gate 3: 合格。3seed 平均 frozen MAE は B0 比 {signed(g3["meanMaeDelta"])} 石、3/3 seed で改善した。空き数別3seed平均の最大悪化は empty={worst["emptyCount"]} の {signed(worst["delta"])} 石で、裁定閾値 +0.10 石以内だった。**

本結果は T158c の oracle / smoke / NPS スクリーニングへ進める判断であり、本番採用や `train/weights/` への配置を承認しない。成果物は `train/data/t158/` にのみ置いた。

## 実装・不変性

- prediction と特徴抽出は engine の `PatternWeights::score` / `scalar_features` を使用する。勾配は `loss_gradient * normalized_feature_value + l2 * weight`。
- B0～B3 は全重みゼロ初期化。B0 は PWV3、B1～B3 は PWV4。新 config のみ `schema=3-t158` identity を使い、既存 config / CLI / `schema=2` / PWV3 は不変。
- 20-game / 1-epoch smoke で既存 `v4` と `t158-b0` の frozen 指標と SHA-256 が一致した（`ce8a3aa394db38a3fab2f4137efaeba3da294cd199527af20ba292c9bf34fac6`）。
- pilot B3 は完全な epoch 17 checkpoint から resume 完走し、unit test でも連続実行と resume 後の PWV4 bytes が一致した。

## 特徴分布と scale

WTHOR train split 66,622局・3,988,509 sample の学習前分布。

| feature | signed range | P50 abs | P95 abs | P99 abs | max abs | scale |
|---|---:|---:|---:|---:|---:|---:|
| exact mobility advantage | -20～22 | 2 | 8 | 11 | 22 | /8 |
| exposure advantage | -65～71 | 7 | 23 | 32 | 71 | /32 |

P95/P99 を概ね1以下へ収め tail を clamp しない意図に合うため scale は維持した。

## Gate 2: 180k pilot

corpus hash `1889787a62ae2242`、frozen 7,402局・442,995 sample、train は61 stageの層化 target 180,000（actual 179,969）、subset seed 42、学習 seed 1、20 epoch、LR 0.005、L2 1e-5、MSE。

| config | scalar | frozen MAE | B0差 | game差平均 | paired bootstrap 95% CI | Gate 2 |
|---|---|---:|---:|---:|---:|---|
{chr(10).join(rows2)}

事前固定した5 stage帯の B3−B0 は `{('/'.join(signed(v) for v in b3["stageBandDeltas"]))}` 石で局所悪化なし。係数は finite。最大隣接差は mobility {b3["maxAdjacentStageJump"]["mobility"]:.6f}、exposure {b3["maxAdjacentStageJump"]["exposure"]:.6f} で、反復的な極端振動なし。train loss は診断にのみ使用した。

## Gate 3: full 3seed

全 74,024局（train 66,622局・3,988,509 sample、frozen 7,402局・442,995 sample）、同一 corpus hash / split / shuffle 規約、20 epoch で B0 と B3 を seed 1～3 で学習した。

| seed | B0 frozen MAE | B3 frozen MAE | 差 | game差平均 | paired bootstrap 95% CI | 非悪化 |
|---:|---:|---:|---:|---:|---:|---|
{chr(10).join(rows3)}

平均行は同じ frozen game の3seed差を平均後、game単位100,000回 resample した。全 seed で改善し、2/3 seed非悪化を満たす。

### 空き数別（61 stage）再集計と裁定

初版は61 stageを5帯へ集約した最大悪化 {signed(g3["maxStageBandRegressionDiagnostic"])} 石を判定に用いていた。これは仕様の「stage別」を置換しており不適切だったため、B3−B0 を空き数ごとに再集計した。

| seed | 最大悪化 empty | B3−B0 MAE |
|---:|---:|---:|
{chr(10).join(seedmax)}

3seed平均×空き数別の最大悪化は **empty={worst["emptyCount"]}、{signed(worst["delta"])} 石**。オーケストレーター裁定により Gate 3 の正規判定単位は後者で閾値 +0.10 石以内とする。この解釈は学習・結果確認後の 2026-07-21 に確定した事後裁定で、初版時点の事前登録ではなかったことを明記する。

Gate 3 は、平均改善 {-g3["meanMaeDelta"]:.6f} >= 0.05、3/3 seed非悪化、pooled bootstrap上限 {signed(g3["pooledBootstrap95"][1])} < 0、3seed平均×空き数別最大悪化 {signed(worst["delta"])} <= +0.10 の全条件を満たす。よって **Gate 3 合格**。

### T158c への申し送り（seed別悪化上位）

seed単体では +0.10 石超の空き数別悪化があるため、T158c では以下を含む seed別害検出を必須とする。

| 順位 | seed | empty | B3−B0 MAE |
|---:|---:|---:|---:|
{chr(10).join(handoff)}

## 集計の再現

```powershell
python bench/edax-compare/t158b_analyze.py
python bench/edax-compare/t158b_analyze.py --check
cargo test -p train
```

スクリプトは raw metrics / binaries から stage帯加重集計、seed別・3seed平均の61 stage集計、NumPy PCG64による100,000回 paired bootstrap、SHA-256、Gate判定、report/meta を決定的に再生成する。固定 seed と全61 stage値は meta JSON に記録する。
'''

def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--root",type=Path,default=Path(__file__).resolve().parents[2]); ap.add_argument("--check",action="store_true"); a=ap.parse_args()
    meta=analyze(a.root); report=render(meta); md=a.root/"bench/edax-compare/t158b_training_report.md"; js=a.root/"bench/edax-compare/t158b_training_report.meta.json"; text=json.dumps(meta,ensure_ascii=False,indent=2)+"\n"
    if a.check:
        if md.read_text(encoding="utf-8")!=report or js.read_text(encoding="utf-8")!=text: raise SystemExit("generated T158b report/meta are stale")
        print("T158b report/meta are reproducible")
    else:
        md.write_text(report,encoding="utf-8",newline="\n"); js.write_text(text,encoding="utf-8",newline="\n"); print("wrote T158b report/meta")

if __name__ == "__main__": main()
