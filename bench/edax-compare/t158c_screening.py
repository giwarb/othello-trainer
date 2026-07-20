#!/usr/bin/env python3
"""T158c checkpointed screening and report generation."""
import argparse, hashlib, json, os, statistics, subprocess, sys, time
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]; BENCH=ROOT/"bench/edax-compare"
EVAL=ROOT/"target/release/eval_cli.exe"; POS=BENCH/"t157_oracle_positions.json"; LABELS=BENCH/"t157_oracle_labels.json"
T158B=BENCH/"t158b_training_report.meta.json"; NPS_POS=BENCH/"t158a_engine_cost_positions.json"; OPENINGS=BENCH/"openings.json"
CHECKPOINT=BENCH/"t158c_screening_checkpoint.json"; NPS_OUT=BENCH/"t158c_nps_results.json"
REPORT=BENCH/"t158c_screening_report.md"; META=BENCH/"t158c_screening_report.meta.json"
V2=ROOT/"train/weights/pattern_v2.bin"; PROD=ROOT/"train/weights/pattern_v4.bin"
CAND={s:ROOT/f"train/data/t158/full/t158-b3-seed-{s}.bin" for s in (1,2,3)}
B0={s:ROOT/f"train/data/t158/full/t158-b0-seed-{s}.bin" for s in (1,2,3)}

def load(p): return json.loads(p.read_text(encoding="utf-8"))
def sha(p):
    h=hashlib.sha256()
    with p.open("rb") as f:
        for b in iter(lambda:f.read(1<<20),b""): h.update(b)
    return h.hexdigest()
def atomic(p,v):
    q=p.with_name(p.name+f".{os.getpid()}.tmp"); q.write_text(json.dumps(v,ensure_ascii=False,indent=2)+"\n",encoding="utf-8",newline="\n"); os.replace(q,p)
def run(args,value=None):
    p=subprocess.run(args,input=None if value is None else json.dumps(value),text=True,encoding="utf-8",capture_output=True)
    if p.returncode: raise RuntimeError(f"{args}\n{p.stderr}")
    return json.loads(p.stdout)
def git(*args): return subprocess.run(["git",*args],cwd=ROOT,text=True,encoding="utf-8",capture_output=True,check=True).stdout.strip()
def ident():
    return {"schema":1,"corpusSha256":sha(POS),"labelsSha256":sha(LABELS),"t158bMetaSha256":sha(T158B),
      "openingsSha256":sha(OPENINGS),"npsPositionsSha256":sha(NPS_POS),"evalCliSha256":sha(EVAL),
      "weightsSha256":{"v2":sha(V2),"v4_prod":sha(PROD),**{f"seed{s}":sha(p) for s,p in CAND.items()},**{f"b0_seed{s}":sha(p) for s,p in B0.items()}}}
def state(path):
    now={"identity":ident(),"oracleRows":{},"smoke":None}
    if path.exists():
        now=load(path)
        if now.get("identity")!=ident(): raise RuntimeError("resume identity mismatch")
    return now

def stage_triage():
    out=[]
    for r in load(T158B)["gate3"]["runs"]:
        ds=r["emptyCountDeltas"]; pos=[{"emptyCount":e,"delta":d} for e,d in enumerate(ds) if d>0]
        out.append({"seed":r["seed"],"frozenMaeDelta":r["maeDelta"],"maxRegression":max(pos,key=lambda x:x["delta"]),
          "regressionsOver010":[x for x in pos if x["delta"]>.1],"all61Deltas":ds,"frozenPassForSeedSelection":max(ds)<=.1})
    return out
def score(pos,w):
    return run([str(EVAL),"best","--depth","8","--exact-from-empties","0","--pattern-weights",str(w)],{"board":pos["board"],"side_to_move":pos["side_to_move"]})["move"]
def oracle_run(st,path,stop=None):
    positions=load(POS)["positions"]; labels={r["id"]:r for r in load(LABELS)["rows"]}; n=0
    for name,w in {"v2":V2,"v4_prod":PROD,**{f"seed{s}":p for s,p in CAND.items()}}.items():
        rows=st["oracleRows"].setdefault(name,[]); done={r["id"] for r in rows}
        for p in positions:
            if p["id"] in done: continue
            m=score(p,w); lab=labels[p["id"]]
            if m not in lab["moves"]: raise RuntimeError(f"oracle move missing {p['id']} {m}")
            regret=lab["oracleScore"]-lab["moves"][m]
            rows.append({"id":p["id"],"empties":p["empties"],"move":m,"regret":regret,"agreement":regret==0}); atomic(path,st); n+=1
            print(f"[oracle] {name} {len(rows)}/180 {p['id']} regret={regret}",flush=True)
            if stop and n>=stop: print("intentional checkpoint stop",flush=True); return False
    return True
def oracle_summary(st):
    names=("v2","v4_prod","seed1","seed2","seed3")
    if any(len(st["oracleRows"].get(k,[]))!=180 for k in names): raise RuntimeError("oracle incomplete")
    base={r["id"]:r for r in st["oracleRows"]["v4_prod"]}; out={}
    for name in names:
        rows=st["oracleRows"][name]; bins={}
        for r in rows: bins.setdefault(str(r["empties"]),[]).append(r["regret"])
        e={"meanRegret":statistics.fmean(r["regret"] for r in rows),"agreementCount":sum(r["agreement"] for r in rows),
           "agreementRate":statistics.fmean(r["agreement"] for r in rows),"regretByEmpties":{k:statistics.fmean(v) for k,v in sorted(bins.items(),key=lambda x:int(x[0]))}}
        if name.startswith("seed"):
            ds=[r["regret"]-base[r["id"]]["regret"] for r in rows]
            e.update(meanRegretDeltaVsV4=statistics.fmean(ds),pairedWins=sum(x<0 for x in ds),pairedLosses=sum(x>0 for x in ds),pairedTies=sum(x==0 for x in ds))
            e["agreementDeltaVsV4"]=e["agreementRate"]-out["v4_prod"]["agreementRate"]
            e["regretByEmptiesDeltaVsV4"]={k:v-out["v4_prod"]["regretByEmpties"][k] for k,v in e["regretByEmpties"].items()}
            worst=max(e["regretByEmptiesDeltaVsV4"],key=e["regretByEmptiesDeltaVsV4"].get)
            e["maxEmptiesRegressionVsV4"]={"empties":int(worst),"delta":e["regretByEmptiesDeltaVsV4"][worst]}
            e["gate4Pass"]=e["meanRegretDeltaVsV4"]<.2 and e["agreementDeltaVsV4"]>=-.05
        out[name]=e
    guards={"v2":abs(out["v2"]["meanRegret"]-1.4111111111111112)<1e-12,"v4_prod":abs(out["v4_prod"]["meanRegret"]-1.3777777777777778)<1e-12}
    consistent=all(r["consistentWithRoot"] for r in load(LABELS)["rows"])
    if not all(guards.values()) or not consistent: raise RuntimeError(f"M2/provenance guard failed {guards} {consistent}")
    return {"results":out,"m2Guard":guards,"provenanceGuard":{"labelsConsistent":consistent,"corpusSha256":sha(POS),"labelsSha256":sha(LABELS)}}
def choose_seed(stage,oracle):
    ok=[r for r in stage if r["frozenPassForSeedSelection"] and oracle["results"][f"seed{r['seed']}"]["gate4Pass"]]
    return None if not ok else min(ok,key=lambda r:r["maxRegression"]["delta"])["seed"]

def det(r): return {k:r.get(k) for k in ("move","score","depth","nodes","pv","nodeLimitHit","exactAttempted","exactCompleted","exactAbortedByQuota")}
def nps_input(p):
    black,white=int(p["black"],16),int(p["white"],16)
    board="".join("X" if black&(1<<i) else "O" if white&(1<<i) else "-" for i in range(64))
    return {"board":board,"side_to_move":p["turn"]}
def native_nps(w,reps=3):
    positions=load(NPS_POS); samples={m:[[] for _ in positions] for m in ("on","off")}; refs={}
    for rep in range(reps):
        for mode in (("on","off") if rep%2==0 else ("off","on")):
            extra=[] if mode=="on" else ["--disable-eval-features"]
            for i,p in enumerate(positions):
                start=time.perf_counter(); r=run([str(EVAL),"best","--depth","12","--max-nodes","160000","--exact-from-empties","16","--exact-quota-percent","60","--tt-mb","64","--pattern-weights",str(w),*extra],nps_input(p)); elapsed=(time.perf_counter()-start)*1000
                key=(mode,p["id"]); d=det(r)
                if key in refs and refs[key]!=d: raise RuntimeError(f"native nondeterminism {key}")
                refs[key]=d; samples[mode][i].append({"elapsedMs":elapsed,"deterministic":d})
        print(f"[native nps] repetition {rep+1}/{reps}",flush=True)
    modes={}
    for mode in ("on","off"):
        rows=[]
        for p,x in zip(positions,samples[mode]):
            d=x[0]["deterministic"]; rows.append({"id":p["id"],"bucket":p["bucket"],"elapsedMedianMs":statistics.median(y["elapsedMs"] for y in x),"depth":d["depth"],"nodes":d["nodes"],"move":d["move"]})
        ms=sum(x["elapsedMedianMs"] for x in rows); nodes=sum(x["nodes"] for x in rows); modes[mode]={"positions":rows,"aggregateElapsedMs":ms,"aggregateNodes":nodes,"aggregateNps":nodes/(ms/1000)}
    return {"repetitions":reps,"deterministic":True,"featureOffMethod":"eval_cli --disable-eval-features on the same learned PWV4 model","modes":modes,"onOffNpsRatio":modes["on"]["aggregateNps"]/modes["off"]["aggregateNps"]}
def wasm_nps(seed):
    source=CAND[seed]; disabled=BENCH/f".t158c-seed{seed}-feature-off.bin"
    data=bytearray(source.read_bytes()); start=len(data)-2*(4+61*4)
    if data[:4]!=b"PWV4" or start<=0: raise RuntimeError("unexpected candidate PWV4 layout")
    for feature in range(2): data[start+feature*248+4:start+feature*248+248]=bytes(244)
    disabled.write_bytes(data)
    try:
        p=subprocess.run(["node",str(BENCH/"t158c_wasm_nps.mjs"),str(source),str(disabled),str(NPS_OUT)],cwd=ROOT,text=True,encoding="utf-8",capture_output=True)
        if p.returncode: raise RuntimeError(p.stderr)
        print(p.stderr,end="",flush=True)
    finally: disabled.unlink(missing_ok=True)

def starts12():
    d=load(OPENINGS); return d["smoke"]["positions"]+d["primary"]["positions"][:2]
def best(position,w):
    empties=position["board"].count("-")
    args=[str(EVAL),"best","--depth",("20" if empties<=20 else "12"),"--exact-from-empties",("20" if empties<=20 else "16"),"--exact-quota-percent","60","--tt-mb","64"]
    if empties>20: args += ["--max-nodes","160000"]
    return run([*args,"--pattern-weights",str(w)],position)
def legal(position): return {r["move"] for r in run([str(EVAL),"moves","--depth","1","--exact-from-empties","0"],position)["moves"]}
def play(start,black,candidate,baseline):
    p={"board":start["board"],"side_to_move":start["side_to_move"]}; passes=0; plies=[]
    for ply in range(120):
        moves=legal(p)
        if not moves:
            passes+=1
            if passes==2: break
            p["side_to_move"]="white" if p["side_to_move"]=="black" else "black"; continue
        passes=0; side=p["side_to_move"]; candidate_turn=(side=="black")==black; w=candidate if candidate_turn else baseline
        a,b=best(p,w),best(p,w)
        if det(a)!=det(b): raise RuntimeError(f"smoke nondeterminism {start['id']} ply={ply}")
        m=a.get("move")
        if m not in moves: raise RuntimeError(f"illegal move {m} {start['id']} ply={ply}")
        plies.append({"ply":ply,"side":side,"move":m,"candidateTurn":candidate_turn,"depth":a["depth"],"nodes":a["nodes"]}); p=run([str(EVAL),"apply","--move",m],p)
    else: raise RuntimeError("game exceeded 120 plies")
    margin=p["board"].count("X")-p["board"].count("O")
    return {"opening":start["id"],"candidateBlack":black,"margin":margin if black else -margin,"plies":plies,"terminalBoard":p["board"]}
def smoke_run(st,path,seed,stop=None):
    starts=starts12(); sid={"candidateSeed":seed,"candidateSha256":sha(CAND[seed]),"baseline":f"T158 B0 seed {seed}","baselineSha256":sha(B0[seed]),"openingIds":[p["id"] for p in starts],"openingsSha256":sha(OPENINGS),"games":24,"depth":12,"maxNodes":160000,"exactQuotaPercent":60,"exactFromEmpties":16,"unlimitedExactEmpties":20,"ttMiB":64}
    if st["smoke"] is None: st["smoke"]={"identity":sid,"rows":[],"anomalies":[]}
    if st["smoke"]["identity"]!=sid: raise RuntimeError("smoke identity mismatch")
    done={(r["opening"],r["candidateBlack"]) for r in st["smoke"]["rows"]}; n=0
    for start in starts:
        for black in (True,False):
            if (start["id"],black) in done: continue
            row=play(start,black,CAND[seed],B0[seed]); st["smoke"]["rows"].append(row); atomic(path,st); n+=1
            print(f"[smoke] {len(st['smoke']['rows'])}/24 {start['id']} candidateBlack={black} margin={row['margin']:+d}",flush=True)
            if stop and n>=stop: print("intentional checkpoint stop",flush=True); return False
    return True
def smoke_summary(st):
    rows=st["smoke"]["rows"]
    if len(rows)!=24: raise RuntimeError("smoke incomplete")
    w=sum(r["margin"]>0 for r in rows); l=sum(r["margin"]<0 for r in rows); passed=not(w<=4 and l>=20)
    return {"candidateWins":w,"baselineWins":l,"draws":24-w-l,"meanCandidateMargin":statistics.fmean(r["margin"] for r in rows),"anomalies":st["smoke"]["anomalies"],"extremeLossGatePass":passed,"decision":"harm_smoke_pass" if passed else "stop_extreme_losing_record"}

def deferred(seed,stage,oracle,nps,smoke):
    try:
        sys.path.insert(0,str(BENCH)); import vs_edax
        ex=getattr(vs_edax,"EDAX_EXE"); ev=getattr(vs_edax,"EDAX_EVAL_DATA"); edax={"executablePath":str(ex.relative_to(ROOT)),"executableSha256":sha(ex),"evalPath":str(ev.relative_to(ROOT)),"evalSha256":sha(ev)}
    except Exception as e: edax={"status":"must_pin_at_T158d","reason":str(e)}
    return {"task":"T158d","status":"deferred","candidateSeed":seed,"candidatePath":str(CAND[seed].relative_to(ROOT)),"candidateWeightSha256":sha(CAND[seed]),"baselinePath":str(PROD.relative_to(ROOT)),"baselineWeightSha256":sha(PROD),"evalCliSha256":sha(EVAL),"gitCommit":git("rev-parse","HEAD"),"gitTreeAtScreening":git("rev-parse","HEAD^{tree}"),"openingSet":"primary (30 pairs / 60 games)","openingSetSha256":sha(OPENINGS),"protocol":{"maxNodes":160000,"timeMs":1500,"exactFromEmpties":16,"exactQuotaPercent":60,"unlimitedExactEmpties":20,"engineDepth":12,"ttMiB":64,"nativeBuild":"cargo build --release -p engine --bin eval_cli"},"featureSchema":["exact_mobility_advantage/8","empty_adjacency_exposure_advantage/32"],"screening":{"stage":stage,"oracle":oracle,"nps":nps,"smoke":smoke},"edax":edax,"adoptionRule":"retain production v4 absent significant or practically meaningful T158d improvement"}
def render(m):
    sr="\n".join(f"| {r['seed']} | {r['frozenMaeDelta']:+.6f} | {r['maxRegression']['emptyCount']} | {r['maxRegression']['delta']:+.6f} | {len(r['regressionsOver010'])} | {'PASS' if r['frozenPassForSeedSelection'] else 'EXCLUDE'} |" for r in m["stageHarm"])
    ors="\n".join(f"| {name} | {r['meanRegret']:.6f} | {r['agreementCount']}/180 ({r['agreementRate']:.1%}) | {r.get('meanRegretDeltaVsV4',0):+.6f} | {r.get('pairedWins',0)}/{r.get('pairedLosses',0)}/{r.get('pairedTies',0)} | {('PASS' if r.get('gate4Pass') else 'baseline') if name!='v2' else 'M2'} |" for name,r in m["oracle"]["results"].items())
    oracle_stage="; ".join(f"seed {s}: empties {m['oracle']['results'][f'seed{s}']['maxEmptiesRegressionVsV4']['empties']} {m['oracle']['results'][f'seed{s}']['maxEmptiesRegressionVsV4']['delta']:+.3f}" for s in (1,2,3))
    n=m["nps"]; s=m["smoke"]
    lines=["# T158c screening report","","## Decision","",f"All screening gates passed. Deferred T158d candidate: **B3 seed {m['selectedSeed']}**, SHA-256 `{m['candidateSha256']}`. This is not production adoption.","","## Seed-by-seed 61-stage frozen harm","","Seed 1 (empty 43/53/54) and seed 3 (empty 46) exceed +0.10 and are excluded. Seed 2 is the only frozen-safe seed. Full 61-stage arrays are in meta.","","| seed | overall delta | worst empty | worst delta | stages > +0.10 | decision |","|---:|---:|---:|---:|---:|---|",sr,"","## Gate 4: T157 oracle 180","","Per-position atomic checkpoints and M2/provenance guards passed. Agreement includes value-tied top moves. Stop at regret delta >= +0.2 or agreement delta < -5 percentage points; oracle improvement is not promotion evidence.","","| weight | mean regret | agreement | delta vs v4 | paired W/L/T | decision |","|---|---:|---:|---:|---:|---|",ors,"","Per-empties regret is in meta.","","## Learned-weight NPS and determinism","",f"T158a's stratified 8 positions, actual learned coefficients, fresh TT: native feature on/off NPS ratio {n['native']['onOffNpsRatio']:.4f}; WASM {n['wasm']['onOffNpsRatio']:.4f}. Both modes repeated deterministically. Per-position elapsed/depth/nodes/move are in meta and t158c_nps_results.json. Ratios are diagnostic because feature-on changes the search tree.","","## Gate 5: 24-game paired smoke","",f"Comparator: same-run B0 seed {m['selectedSeed']}. Fixed smoke10 + primary01-02, color-swapped. depth12, 160k nodes, quota60%, exact-from16, TT64MiB; <=20 empties unlimited exact. Every decision was repeated with fresh TT and checked for legality. Atomic checkpoint/resume is per game.","",f"Candidate {s['candidateWins']} wins, {s['draws']} draws, {s['baselineWins']} losses; mean margin {s['meanCandidateMargin']:+.3f}; anomalies={len(s['anomalies'])}; **{s['decision']}**. Wins are not adoption evidence.","","## Deferred T158d registration","","Meta key `deferredT158d` pins candidate/baseline/eval/opening/Edax hashes, git commit/tree, protocol, build, schema and screening results. The 60-game Edax gate was not run.",""]
    marker="Per-empties regret is in meta."
    lines[lines.index(marker)]=f"Oracle worst empties-bin regressions vs v4: {oracle_stage}. All per-empties regret/delta values are in meta. These oracle bins were inspected with the frozen 61-stage arrays; seeds 1 and 3 remain excluded by frozen local harm."
    return "\n".join(lines)
def finalize(st,nps):
    stage=stage_triage(); oracle=oracle_summary(st); seed=choose_seed(stage,oracle)
    if seed is None: raise RuntimeError("no candidate")
    smoke=smoke_summary(st)
    if not nps["native"]["deterministic"] or not nps["wasm"]["deterministic"] or smoke["anomalies"] or not smoke["extremeLossGatePass"]: raise RuntimeError("screening gate failed")
    m={"schemaVersion":1,"task":"T158c","decision":"defer_one_candidate_to_T158d","selectedSeed":seed,"candidateSha256":sha(CAND[seed]),"stageHarm":stage,"oracle":oracle,"nps":nps,"smoke":smoke}; m["deferredT158d"]=deferred(seed,stage,oracle,nps,smoke); atomic(META,m); REPORT.write_text(render(m),encoding="utf-8",newline="\n"); return m
def main():
    a=argparse.ArgumentParser(); a.add_argument("--phase",choices=("oracle","nps-native","nps-wasm","smoke","finalize","all"),default="all"); a.add_argument("--checkpoint",type=Path,default=CHECKPOINT); a.add_argument("--stop-after",type=int); x=a.parse_args(); st=state(x.checkpoint)
    if x.phase in ("oracle","all") and not oracle_run(st,x.checkpoint,x.stop_after): return
    oracle=oracle_summary(st); seed=choose_seed(stage_triage(),oracle)
    if seed is None: raise RuntimeError("no seed passed")
    if x.phase in ("nps-native","all"):
        n=load(NPS_OUT) if NPS_OUT.exists() else {}; n["native"]=native_nps(CAND[seed]); atomic(NPS_OUT,n)
    if x.phase in ("nps-wasm","all"): wasm_nps(seed)
    if x.phase in ("smoke","all") and not smoke_run(st,x.checkpoint,seed,x.stop_after): return
    if x.phase in ("finalize","all"):
        n=load(NPS_OUT)
        if not all(k in n for k in ("native","wasm")): raise RuntimeError("native and WASM NPS required")
        m=finalize(st,n); print(json.dumps({"selectedSeed":m["selectedSeed"],"sha256":m["candidateSha256"],"smoke":m["smoke"]},ensure_ascii=False,indent=2))
if __name__=="__main__": main()
