import csv, statistics as st, collections, math, json
D=collections.defaultdict(dict); emp={}; exact=set()
for r in csv.DictReader(open('diag_b.csv')):
    D[(r['pos'],r['node'])][r['engine']]=float(r['score'])
    if r['node']=='P': emp[r['pos']]=int(r['empties'])
    if r['engine'] in('edax_d10','edax_d11') and int(r['level'])>int(r['engine'][-2:]): exact.add((r['pos'],r['node'],r['engine']))
pos=[p for p in emp if 'ours_static' in D[(p,'P')]]
src={p['id']:p['src'] for p in json.load(open('positions_b.json'))}
print('n',len(pos),'exact-solved d10 at P:',sum(1 for p in pos if (p,'P','edax_d10') in exact))
def ms(x): 
    return (sum(x)/len(x), st.pstdev(x), sum(abs(v) for v in x)/len(x), len(x))
def fmt(x): m,s,a,n=ms(x); return f'mean {m:+.2f} sd {s:.2f} mae {a:.2f} n={n}'
bands=[('20-29',20,29),('30-39',30,39),('40-50',40,50),('all',0,99)]
for refname,ref in (('edax d10',lambda p:D[(p,'P')]['edax_d10']),('edax (d10+d11)/2',lambda p:(D[(p,'P')]['edax_d10']+D[(p,'P')]['edax_d11'])/2)):
    print('=== reference:',refname)
    for lab,key in (('ours static','ours_static'),('edax l0 static','edax_l0'),('edax l1','edax_l1'),('ours d10','ours_d10'),('edax d11 (vs ref)','edax_d11')):
        for bn,lo,hi in bands:
            x=[D[(p,'P')][key]-ref(p) for p in pos if lo<=emp[p]<=hi]
            print(f'{lab:18s} {bn:6s}',fmt(x))
    for lab,key in (('ours static','ours_static'),('edax l0 static','edax_l0')):
        for par in (0,1):
            x=[D[(p,'P')][key]-ref(p) for p in pos if emp[p]%2==par]
            print(f'{lab:18s} empties parity {"even" if par==0 else "odd"}',fmt(x))
        for sname in ('existing','gen'):
            x=[D[(p,'P')][key]-ref(p) for p in pos if src[p]==sname]
            print(f'{lab:18s} source {sname}',fmt(x))
    # correlation of errors
    xo=[D[(p,'P')]['ours_static']-ref(p) for p in pos]; xe=[D[(p,'P')]['edax_l0']-ref(p) for p in pos]
    mo,me=sum(xo)/len(xo),sum(xe)/len(xe)
    cor=sum((a-mo)*(b-me) for a,b in zip(xo,xe))/len(xo)/(st.pstdev(xo)*st.pstdev(xe)); print('corr(ours err, edax l0 err)=%.2f'%cor)
    print('ours static - edax l0 static:',fmt([D[(p,'P')]['ours_static']-D[(p,'P')]['edax_l0'] for p in pos]))
print('=== tempo test: static(P)+static(C) vs e10(P)+e10(C) ; per-node bias is mean of static - e10 in each node own mover frame')
for tag in ('Cbest','Crand'):
    ps=[p for p in pos if (p,tag) in D and 'edax_d10' in D[(p,tag)]]
    for lab,key in (('ours','ours_static'),('edax_l0','edax_l0')):
        T=[D[(p,'P')][key]+D[(p,tag)][key] for p in ps]
        Tt=[D[(p,'P')]['edax_d10']+D[(p,tag)]['edax_d10'] for p in ps]
        dd=[a-b for a,b in zip(T,Tt)]
        bc=[D[(p,tag)][key]-D[(p,tag)]['edax_d10'] for p in ps]
        bp=[D[(p,'P')][key]-D[(p,'P')]['edax_d10'] for p in ps]
        print(f'{tag} {lab:8s} T_static mean {sum(T)/len(T):+.2f} T_true(e10) {sum(Tt)/len(Tt):+.2f} diff {fmt(dd)} | bias@P {fmt(bp)} bias@C(own frame) {fmt(bc)}')
# static eval of children by parity: P parity and C parity -> bias vs empties parity pooled over nodes (P, Cbest, Crand)
print('=== pooled node bias (static - e10) by empties parity, all nodes')
for lab,key in (('ours','ours_static'),('edax_l0','edax_l0')):
    for par in (0,1):
        x=[v[key]-v['edax_d10'] for (p,n),v in D.items() if key in v and 'edax_d10' in v and (emp[p]-(0 if n=='P' else 1))%2==par]
        print(lab,'empties',('even','odd')[par],fmt(x))
# bias vs empties fine bins (ours vs edax_l0)
print('=== bias by empties (5-wide bins, node P), ref e10')
for lo in range(20,50,5):
    xs=[D[(p,'P')]['ours_static']-D[(p,'P')]['edax_d10'] for p in pos if lo<=emp[p]<lo+5]
    xe=[D[(p,'P')]['edax_l0']-D[(p,'P')]['edax_d10'] for p in pos if lo<=emp[p]<lo+5]
    print(lo,lo+4,'ours',fmt(xs),'| edax l0',fmt(xe))
# by position-evaluation sign: regression slope of static on ref (shrink)
import numpy as np
for key in ('ours_static','edax_l0'):
    x=np.array([ (D[(p,'P')]['edax_d10']+D[(p,'P')]['edax_d11'])/2 for p in pos]); y=np.array([D[(p,'P')][key] for p in pos])
    A=np.vstack([x,np.ones_like(x)]).T; sl,ic=np.linalg.lstsq(A,y,rcond=None)[0]; res=y-(sl*x+ic)
    print(key,'regress static on ref: slope %.2f intercept %+.2f resid sd %.2f'%(sl,ic,res.std()))
