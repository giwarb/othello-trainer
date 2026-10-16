import csv, statistics as st, collections
R=collections.defaultdict(dict); MV=collections.defaultdict(dict)
emp={}
for r in csv.DictReader(open('depth_parity.csv')):
    R[(r['engine'],r['pos'])][int(r['depth'])]=float(r['score']); MV[(r['engine'],r['pos'])][int(r['depth'])]=r['move']; emp[r['pos']]=int(r['empties'])
pos=sorted({p for _,p in R}); engs=['ours','edax_nompc','edax_mpc']
def m(x): return sum(x)/len(x)
def metrics(e,rnd=False,sel=None):
    out=collections.defaultdict(list)
    for p in (sel or pos):
        v=R[(e,p)]
        if rnd: v={k:round(x) for k,x in v.items()}
        out['adj'].append(m([abs(v[d]-v[d-1]) for d in range(5,13)]))
        out['same2'].append(m([abs(v[d]-v[d-2]) for d in range(5,13)]))
        out['odd-prev_even'].append(m([v[d]-v[d-1] for d in (5,7,9,11)]))
        out['odd-next_even'].append(m([v[d]-v[d+1] for d in (5,7,9,11)]))
        out['zigzag2'].append(m([abs(v[d]-(v[d-1]+v[d+1])/2) for d in range(6,12)]))
        out['range5_12'].append(max(v[d] for d in range(5,13))-min(v[d] for d in range(5,13)))
    return {k:(m(x),st.median(x)) for k,x in out.items()}
print('n positions',len(pos))
for rnd in (False,True):
    print('--- scores rounded to int' if rnd else '--- raw scores')
    for e in engs:
        mm=metrics(e,rnd)
        print(e.ljust(11),' '.join(f"{k}={a:.2f}/{b:.2f}" for k,(a,b) in mm.items()))
print('--- p86_end_d1 only')
for e in engs:
    print(e, [R[(e,'p86_end_d1')][d] for d in range(1,13)])
# per depth mean |v(d)-v(d-1)|
print('--- per depth mean |v(d)-v(d-1)|')
for e in engs:
    print(e.ljust(11),' '.join(f"d{d}:{m([abs(R[(e,p)][d]-R[(e,p)][d-1]) for p in pos]):.2f}" for d in range(2,13)))
print('--- per depth mean signed v(d)-v(d-1)')
for e in engs:
    print(e.ljust(11),' '.join(f"d{d}:{m([(R[(e,p)][d]-R[(e,p)][d-1]) for p in pos]):+.2f}" for d in range(2,13)))
print('--- per depth mean score (side to move)')
for e in engs:
    print(e.ljust(11),' '.join(f"d{d}:{m([R[(e,p)][d] for p in pos]):+.2f}" for d in range(1,13)))
# per-position ratio of adj
rat=[metrics('ours',sel=[p])['adj'][0]/max(1e-9,metrics('edax_nompc',sel=[p])['adj'][0]) for p in pos]
print('per-position ratio ours/edax_nompc adj: median',st.median(rat),'mean',m(rat),'n(ours>edax)',sum(r>1 for r in rat),'/',len(rat))
# best move agreement
for ref in ('edax_nompc',):
    for e in engs:
        print('agree with',ref,'d12 ->',e,' '.join(f"d{d}:{m([MV[(e,p)][d]==MV[(ref,p)][12] for p in pos])*100:.0f}%" for d in range(4,13)))
print('agree with ours d12 -> ours own',' '.join(f"d{d}:{m([MV[('ours',p)][d]==MV[('ours',p)][12] for p in pos])*100:.0f}%" for d in range(4,13)))
print('agree with edax_mpc d12 -> edax_mpc',' '.join(f"d{d}:{m([MV[('edax_mpc',p)][d]==MV[('edax_mpc',p)][12] for p in pos])*100:.0f}%" for d in range(4,13)))
# bootstrap-ish: ratio of means, and by empties groups
print('mean adj by empties group')
for lo,hi in ((30,37),(38,43),(44,46)):
    s=[p for p in pos if lo<=emp[p]<=hi]
    print(lo,hi,len(s),{e:round(metrics(e,sel=s)['adj'][0],2) for e in engs})
# sign agreement of ours vs edax at d12 / root
print('sign agree ours d12 vs edax_nompc d12',m([(R[('ours',p)][12]>0)==(R[('edax_nompc',p)][12]>0) for p in pos]))
print('MAE d12 ours vs edax nompc',m([abs(R[('ours',p)][12]-R[('edax_nompc',p)][12]) for p in pos]))
print('MAE d8 ours vs edax nompc d8',m([abs(R[('ours',p)][8]-R[('edax_nompc',p)][8]) for p in pos]),'d9',m([abs(R[('ours',p)][9]-R[('edax_nompc',p)][9]) for p in pos]))
