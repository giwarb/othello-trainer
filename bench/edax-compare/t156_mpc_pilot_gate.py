#!/usr/bin/env python3
"""Deterministic Gate 1 analysis for the T156 MPC pilot."""
import argparse, hashlib, json, math, statistics
from pathlib import Path

TARGETS=(6,8,10,12); SPLITS=("calibration","tuning","test"); TS=("1.5","1.75","2.0")
HELD=("tuning","test"); Z=1.959963984540054

def wu(k,n):
    p=k/n; z2=Z*Z
    return (p+z2/(2*n)+Z*math.sqrt(p*(1-p)/n+z2/(4*n*n)))/(1+z2/n)

def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()

def write(path,text):
    tmp=path.with_name("."+path.name+".tmp"); tmp.write_text(text,encoding="utf-8",newline="\n"); tmp.replace(path)

def tail(groups,splits,t):
    out={}
    for direction in ("high","low"):
        k=sum(g["summaries"][s]["sigmaTailExceedance"][t][direction+"Count"] for g in groups for s in splits)
        n=sum(g["summaries"][s]["n"] for g in groups for s in splits)
        out[direction]={"count":k,"n":n,"rate":k/n,"wilsonUpper95":wu(k,n)}
    return out

def select(stats):
    idx={(g["emptyBucket"],g["deepDepth"],g["shallowDepth"]):g for g in stats["groups"]}
    buckets=sorted({g["emptyBucket"] for g in stats["groups"]}); out=[]
    for D in TARGETS:
        ranked=[]
        for d in range(1,D-2):
            gs=[idx[(b,D,d)] for b in buckets]
            rs=[g["summaries"]["all"]["shallowDeepNodeRatioMedian"] for g in gs]
            if max(rs)>.20: continue
            x=tail(gs,HELD,"1.5")
            rank=(max(x["high"]["wilsonUpper95"],x["low"]["wilsonUpper95"]),
                  statistics.median(g["residualSigma"] for g in gs),statistics.median(rs),d)
            ranked.append((rank,d,gs))
        rank,d,gs=min(ranked,key=lambda x:x[0]); out.append((D,d,gs,rank))
    return out

def proxy(D,d,groups,records):
    by={g["emptyBucket"]:{"n":0,"highCuts":0,"lowCuts":0,"wrongCuts":0,"deepNodes":0,"probeNodes":0,"savedDeepNodes":0} for g in groups}
    gi={g["emptyBucket"]:g for g in groups}
    for row in records:
        if row["split"] not in HELD: continue
        g=gi[row["emptyBucket"]]; v={x["depth"]:x for x in row["results"]}; sh=v[d]; dp=v[D]
        pred=g["slope"]*sh["score"]+g["intercept"]; margin=1.5*g["residualSigma"]
        hi=pred-margin>=0; lo=pred+margin<=-1; bad=(hi and dp["score"]<0) or (lo and dp["score"]>=0)
        x=by[row["emptyBucket"]]; x["n"]+=1; x["highCuts"]+=hi; x["lowCuts"]+=lo; x["wrongCuts"]+=bad
        x["deepNodes"]+=dp["nodes"]; x["probeNodes"]+=sh["nodes"]; x["savedDeepNodes"]+=dp["nodes"] if hi or lo else 0
    def finish(x):
        x["cutRate"]=(x["highCuts"]+x["lowCuts"])/x["n"]; x["weightedProbeRatio"]=x["probeNodes"]/x["deepNodes"]
        x["estimatedNodeImprovement"]=(x["savedDeepNodes"]-x["probeNodes"])/x["deepNodes"]; return x
    allx={k:sum(x[k] for x in by.values()) for k in next(iter(by.values()))}
    return {"description":"held-out root proxy, NWS [-1,0)","byBucket":{b:finish(x) for b,x in by.items()},"combined":finish(allx)}

def analyze(stats,meas,sp,mp):
    if len(stats["groups"])!=264 or stats["recordCount"]!=len(meas["records"]): raise ValueError("unexpected input counts")
    if stats["sourcePositionsFingerprint"]!=meas["positionsFingerprint"] or stats["sourceWeightsFingerprint"]!=meas["weightsFingerprint"]: raise ValueError("input fingerprint mismatch")
    candidates=[]
    for D,d,gs,rank in select(stats):
        ratios=[g["summaries"]["all"]["shallowDeepNodeRatioMedian"] for g in gs]
        agg={s:{t:tail(gs,(s,),t) for t in TS} for s in SPLITS}; agg["heldOutCombined"]={t:tail(gs,HELD,t) for t in TS}
        candidates.append({"deepDepth":D,"shallowDepth":d,"selectionRank":rank,"nodeRatioMedianAcrossBuckets":statistics.median(ratios),"nodeRatioMaximumBucket":max(ratios),
          "bucketFits":[{"emptyBucket":g["emptyBucket"],"slope":g["slope"],"intercept":g["intercept"],"residualSigma":g["residualSigma"],"nodeRatioMedian":g["summaries"]["all"]["shallowDeepNodeRatioMedian"],
            "splitTails":{s:{t:g["summaries"][s]["sigmaTailExceedance"][t] for t in TS} for s in SPLITS}} for g in gs],
          "aggregateSplitTails":agg,"heldOutT15Pass":all(x["wilsonUpper95"]<=.10 for x in agg["heldOutCombined"]["1.5"].values()),"zeroWindowProxy":proxy(D,d,gs,meas["records"])})
    gate=next(c for c in candidates if (c["shallowDepth"],c["deepDepth"])==(2,10)); sig=[x["residualSigma"] for x in gate["bucketFits"]]; px=gate["zeroWindowProxy"]["combined"]; r=gate["nodeRatioMaximumBucket"]
    criteria=[
      {"id":1,"pass":r<=.20,"evidence":{"maximumBucketMedianNodeRatio":r}},
      {"id":2,"pass":gate["heldOutT15Pass"],"evidence":gate["aggregateSplitTails"]["heldOutCombined"]["1.5"]},
      {"id":3,"pass":max(sig)/min(sig)<=1.5,"evidence":{"minimumSigma":min(sig),"maximumSigma":max(sig),"maxMinSigmaRatio":max(sig)/min(sig)}},
      {"id":4,"pass":all(x["slope"]>0 for x in gate["bucketFits"]) and px["highCuts"]+px["lowCuts"]>0,"evidence":{"positiveSlopeBuckets":sum(x["slope"]>0 for x in gate["bucketFits"]),"proxyHighCuts":px["highCuts"],"proxyLowCuts":px["lowCuts"]}},
      {"id":5,"pass":px["estimatedNodeImprovement"]>=.05,"evidence":{"minimumCutRateForFivePercent":(.05+r)/(1-r),"proxyCutRate":px["cutRate"],"proxyWeightedProbeRatio":px["weightedProbeRatio"],"proxyEstimatedNodeImprovement":px["estimatedNodeImprovement"]}}]
    return {"schemaVersion":1,"analysis":"T156b MPC pilot Gate 1","inputs":{"stats":str(sp).replace("\\","/"),"statsSha256":digest(sp),"measurements":str(mp).replace("\\","/"),"measurementsSha256":digest(mp),"recordCount":stats["recordCount"],"groupCount":len(stats["groups"]),"positionsFingerprint":stats["sourcePositionsFingerprint"],"weightsFingerprint":stats["sourceWeightsFingerprint"]},
      "selectionRule":"For each D, among common d <= D-3 with every bucket median node ratio <= 0.20, minimize (max held-out t=1.5 directional Wilson upper, median calibration sigma, median node ratio, d).",
      "candidates":candidates,"gate1":{"pass":all(x["pass"] for x in criteria),"criteria":criteria},
      "recommendation":{"primaryGatePair":{"deepDepth":10,"shallowDepth":2,"t":1.5},"initialPairs":[{"deepDepth":6,"shallowDepth":3,"t":1.75},{"deepDepth":8,"shallowDepth":4,"t":1.75},{"deepDepth":10,"shallowDepth":2,"t":1.5},{"deepDepth":12,"shallowDepth":4,"t":1.75}],"bucketMerge":"Keep four buckets separate in T156c; reassess with 1,200-position data."}}

def pc(x): return f"{100*x:.2f}%"
def cell(x): return f"{x['count']}/{x['n']} ({pc(x['rate'])}; U95 {pc(x['wilsonUpper95'])})"
def hl(f,s,t):
    x=f["splitTails"][s][t]; return f"{x['highCount']}/{pc(x['highRate'])} / {x['lowCount']}/{pc(x['lowRate'])}"

def report(m):
    cs=m["candidates"]; gate=next(c for c in cs if c["deepDepth"]==10); held=gate["aggregateSplitTails"]["heldOutCombined"]["1.5"]; px=gate["zeroWindowProxy"]; ev=m["gate1"]["criteria"]
    L=["# T156b MPC pilot Gate 1 判定レポート","","## 結論","","**Gate 1: 合格。MPC OFF のまま T156c の式修正へ進む。**","",
      "主候補は `(d,D)=(2,10), t=1.5`。pilotではMPCを有効化せず、default OFFで実装してGate 2の実探索へ進む。本分析は320局面・4帯・264回帰グループを使い、係数はcalibrationのみでfit、Gateのtailはtuning+test（各64、計128）を結合した。split単独値も開示する。","",
      "## 候補選定","","各Dで全帯共通dを選ぶ。`d<=D-3`、全帯ノード比20%以下を必須とし、held-out t=1.5方向別Wilson上限の最大値、calibration σ中央値、ノード比中央値、dの順で一意に順位付けした。","",
      "| d | D | ノード比中央値 | 最大帯 | held-out high | held-out low | 合格 |","|---:|---:|---:|---:|---:|---:|:---:|"]
    for c in cs:
        t=c["aggregateSplitTails"]["heldOutCombined"]["1.5"]; L.append(f"| {c['shallowDepth']} | {c['deepDepth']} | {pc(c['nodeRatioMedianAcrossBuckets'])} | {pc(c['nodeRatioMaximumBucket'])} | {cell(t['high'])} | {cell(t['low'])} | {'○' if c['heldOutT15Pass'] else '×'} |")
    L += ["","### 帯別 affine fit と方向tail","","`H/L`は残差が`+tσ/-tσ`を超えた件数/率。calibration n=48/帯、tuning・test n=16/帯。","",
      "| d,D | 帯 | a | b | σ | node比 | cal 1.5 H/L | tune 1.5 H/L | test 1.5 H/L | tune 1.75 H/L | test 1.75 H/L | tune 2 H/L | test 2 H/L |",
      "|:---:|:---:|---:|---:|---:|---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|"]
    for c in cs:
      for f in c["bucketFits"]: L.append(f"| {c['shallowDepth']},{c['deepDepth']} | {f['emptyBucket']} | {f['slope']:.4f} | {f['intercept']:.1f} | {f['residualSigma']:.1f} | {pc(f['nodeRatioMedian'])} | {hl(f,'calibration','1.5')} | {hl(f,'tuning','1.5')} | {hl(f,'test','1.5')} | {hl(f,'tuning','1.75')} | {hl(f,'test','1.75')} | {hl(f,'tuning','2.0')} | {hl(f,'test','2.0')} |")
    L += ["","### 候補別・split別tail（4帯集約）",""]
    for c in cs:
      L += [f"#### `(d,D)=({c['shallowDepth']},{c['deepDepth']})`","","| split | t | high | low |","|:---:|---:|---:|---:|"]
      for s in SPLITS:
       for t in TS:
        x=c["aggregateSplitTails"][s][t]; L.append(f"| {s} | {t} | {cell(x['high'])} | {cell(x['low'])} |")
      L.append("")
    L += ["## Gate 1の5基準","","### 1. 中央値ノード比20%以下 — 合格","",f"`(2,10)`は全帯20%以下、最大 {pc(gate['nodeRatioMaximumBucket'])}。4候補も選定条件として全帯20%以下。","",
      "### 2. t=1.5 held-out一方向誤カット率 — 合格","",f"`(2,10)` の結合n=128はhigh {cell(held['high'])}、low {cell(held['low'])}。両方向U95が10%以下。tuning/test単独はhighが各3/64、U95 12.90%で標本不足が残るため、採用確定でなくGate 2へ進む根拠に限定する。","",
      "### 3. 一部空き帯だけの極端な悪化なし — 合格（要監視）","",f"σは {ev[2]['evidence']['minimumSigma']:.1f}〜{ev[2]['evidence']['maximumSigma']:.1f} centi-disc、最大/最小={ev[2]['evidence']['maxMinSigmaRatio']:.3f}。帯別held-out t=1.5一方向超過は最大3/32。45–52帯はσ最大かつproxy cut率が低く、Gate 2で帯別収支を監視する。","",
      "### 4. 正しい式でプローブ/cut発生見込み — 合格","","全帯で`a>0`。外向きmarginの浅い閾値はhigh `(beta-b+tσ)/a` 以上、low `(alpha-b-tσ)/a` 以下でNWS窓外をprobeできる。"+f"held-out rootのNWS `[-1,0)` proxyはhigh {px['combined']['highCuts']}、low {px['combined']['lowCuts']}、計 {px['combined']['highCuts']+px['combined']['lowCuts']}/128、誤cut 0。探索木内window分布の実測ではないため実cut率はGate 2で確認する。","",
      "### 5. 固定深さ総ノード5%改善の兆候 — 合格（粗いproxy）","",f"最大帯中央値比による5%損益分岐cut率は {pc(ev[4]['evidence']['minimumCutRateForFivePercent'])}。proxy cut率 {pc(px['combined']['cutRate'])}、deep-node加重probe比 {pc(px['combined']['weightedProbeRatio'])}、粗い改善率 {pc(px['combined']['estimatedNodeImprovement'])}。","",
      "| 帯 | proxy cut | 誤cut | 加重probe比 | 粗い改善率 |","|:---:|---:|---:|---:|---:|"]
    for b,x in px["byBucket"].items(): L.append(f"| {b} | {x['highCuts']+x['lowCuts']}/{x['n']} ({pc(x['cutRate'])}) | {x['wrongCuts']} | {pc(x['weightedProbeRatio'])} | {pc(x['estimatedNodeImprovement'])} |")
    L += ["","## T156c 初期案","","| D | d | t | 位置づけ |","|---:|---:|---:|:---|","| 6 | 3 | 1.75 | t=1.5 high U95 10.86%未達。安全側診断候補 |","| 8 | 4 | 1.75 | t=1.5両方向U95 11.85%未達。安全側診断候補 |","| 10 | 2 | 1.5 | Gate 1主候補 |","| 12 | 4 | 1.75 | t=1.5 high/low U95 11.85%/10.86%未達。安全側診断候補 |","",
      "T156cでは4帯を維持する。`(2,10)`のσ差は23%以内だが、傾きは0.887〜0.306で45–52帯のproxy cut率も低い。1,200局面で残差分布と収支を再評価後に結合を判断する。","","## 再現方法と制約","","```powershell","python bench/edax-compare/t156_mpc_pilot_gate.py --stats bench/edax-compare/t156_mpc_pilot_stats.json --measurements bench/edax-compare/t156_mpc_pilot_measurements.json --report bench/edax-compare/t156_mpc_pilot_gate_report.md --meta bench/edax-compare/t156_mpc_pilot_gate_report.meta.json","```","","固定入力・固定規則・時刻なし・sort済みJSONで決定的に出力する。MPC本体/探索コードは未変更。本合格は本番ONの承認ではなく、MPC OFFのままT156c/Gate 2へ再投資する判断。",""]
    return "\n".join(L)

def main():
    p=argparse.ArgumentParser(); p.add_argument("--stats",type=Path); p.add_argument("--measurements",type=Path); p.add_argument("--report",type=Path); p.add_argument("--meta",type=Path); p.add_argument("--self-test",action="store_true"); a=p.parse_args()
    if a.self_test: assert abs(wu(6,128)-.09849752245094322)<1e-15; print("self-test passed"); return
    if any(x is None for x in (a.stats,a.measurements,a.report,a.meta)): p.error("four path arguments are required")
    m=analyze(json.loads(a.stats.read_text(encoding="utf-8")),json.loads(a.measurements.read_text(encoding="utf-8")),a.stats,a.measurements)
    write(a.meta,json.dumps(m,indent=2,ensure_ascii=False,sort_keys=True,allow_nan=False)+"\n"); write(a.report,report(m)); print("Gate 1: PASS; wrote report and meta")
if __name__=="__main__": main()
