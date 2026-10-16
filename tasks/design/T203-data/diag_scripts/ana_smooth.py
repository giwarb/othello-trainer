import csv, statistics as st, collections, sys
B=collections.defaultdict(dict)
for r in csv.DictReader(open('diag_b.csv')):
    if r['node']=='P': B[r['pos']][r['engine']]=float(r['score'])
S=collections.defaultdict(dict)
for r in csv.DictReader(open('diag_b2_sweep_all.csv')):
    if r['engine']=='ours': S[('ours',r['pos'])][int(r['depth'])]=float(r['score'])
for tag in ('par','adj'):
    try:
        for r in csv.DictReader(open(f'diag_smooth_{tag}.csv')): S[(tag,r['pos'])][int(r['depth'])]=float(r['score'])
    except FileNotFoundError: pass
for p in B: S[('ours',p)][0]=B[p]['ours_static']
pos=[p for p in B if (('par',p) in S and len(S[('par',p)])==9) and (('adj',p) in S and len(S[('adj',p)])==9)]
print('n',len(pos))
def ms(x): return sum(x)/len(x), st.pstdev(x)
for e in ('ours','par','adj'):
    ref=lambda p:(B[p]['edax_d10']+B[p]['edax_d11'])/2
    st0=[S[(e,p)][0]-ref(p) for p in pos]
    same2=[abs(S[(e,p)][d]-S[(e,p)][d-2]) for p in pos for d in range(4,9)]
    sd_e=[S[(e,p)][d]-ref(p) for p in pos for d in (4,6,8)]
    sd_o=[S[(e,p)][d]-ref(p) for p in pos for d in (3,5,7)]
    osc=[S[(e,p)][d]-(S[(e,p)][d-1]+S[(e,p)][d+1])/2 for p in pos for d in (3,5,7)]
    s2=[ (S[(e,p)][d]-S[(e,p)][d-2]) for p in pos for d in (6,8)]
    # rms of (v(d)-v(d-2)) for evens only and odds only
    ev=[ (S[(e,p)][d]-S[(e,p)][d-2])**2 for p in pos for d in (4,6,8)]; od=[(S[(e,p)][d]-S[(e,p)][d-2])**2 for p in pos for d in (5,7)]
    ad=[abs(S[(e,p)][d]-S[(e,p)][d-1]) for p in pos for d in range(3,9)]
    print(f'{e:5s} static-ref: mean %+.2f sd %.2f | even d4,6,8 - ref: mean %+.2f sd %.2f | odd d3,5,7 - ref: mean %+.2f sd %.2f | odd-over-even-neigh %+.2f | mean|v(d)-v(d-2)| %.2f (rms even %.2f odd %.2f) | adj %.2f'%(ms(st0)+ms(sd_e)+ms(sd_o)+(ms(osc)[0],sum(same2)/len(same2),(sum(ev)/len(ev))**.5,(sum(od)/len(od))**.5,sum(ad)/len(ad))))
# edax for comparison
S2=collections.defaultdict(dict)
for r in csv.DictReader(open('diag_b2_sweep_all.csv')): 
    if r['engine']=='edax': S2[r['pos']][int(r['depth'])]=float(r['score'])
same2=[abs(S2[p][d]-S2[p][d-2]) for p in pos for d in range(4,9)]
print('edax mean|v(d)-v(d-2)| %.2f'%(sum(same2)/len(same2)))
