import csv, random, statistics as st, collections
exec(open('stats.py').read().split("print('n positions'")[0])
random.seed(1)
def per(e,f): return {p:f(R[(e,p)]) for p in pos}
adj=lambda v:m([abs(v[d]-v[d-1]) for d in range(5,13)])
sg=lambda v:m([v[d]-v[d-1] for d in (5,7,9,11)])
s2=lambda v:m([abs(v[d]-v[d-2]) for d in range(5,13)])
for name,f in (('adj',adj),('odd-even bias',sg),('same-parity |v(d)-v(d-2)|',s2)):
    a=per('ours',f); b=per('edax_nompc',f)
    rs=[]
    for _ in range(5000):
        smp=[random.choice(pos) for _ in pos]
        rs.append(m([a[p] for p in smp])/m([b[p] for p in smp]))
    rs.sort(); print(name,'ratio',round(m(list(a.values()))/m(list(b.values())),2),'95%CI',round(rs[125],2),round(rs[4875],2))
rnd=[p for p in pos if p.startswith('rnd')]; stg=[p for p in pos if not p.startswith('rnd')]
for nm,sel in (('stage/p86 (n=%d)'%len(stg),stg),('random (n=%d)'%len(rnd),rnd)):
    print(nm,{e:(round(metrics(e,sel=sel)['adj'][0],2),round(metrics(e,sel=sel)['odd-prev_even'][0],2),round(metrics(e,sel=sel)['same2'][0],2)) for e in engs})
# deviation from own d12 reference per depth (MAE vs edax_nompc d12)
print('MAE vs edax_nompc d12:')
for e in ('ours','edax_nompc'):
    print(e,' '.join(f"d{d}:{m([abs(R[(e,p)][d]-R[('edax_nompc',p)][12]) for p in pos]):.2f}" for d in range(4,13)))
print('odd-depth minus even-depth mean abs by sign: frac positions odd>prev even', 'ours',m([sg(R[('ours',p)])>0 for p in pos]),'edax',m([sg(R[('edax_nompc',p)])>0 for p in pos]))
# depth 11 pair: smooth vs
pe=[p for p in pos if p in('p86_end_d1',)]
print(pe)
