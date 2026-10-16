import csv, statistics as st, collections, math
K=collections.defaultdict(dict); ce={}
for r in csv.DictReader(open('diag_b3_siblings.csv')):
    k=(r['pos'],r['child']); K[k][(r['engine'],int(r['depth']))]=float(r['score']); ce[k]=int(r['child_empties'])
kids=collections.defaultdict(list)
for (p,c) in K: kids[p].append(c)
print('positions',len(kids),'children',len(K))
def ref(k): return (K[k][('edax',8)]+K[k][('edax',9)])/2
def sd(x): return st.pstdev(x)
res={}
for lab,fn in (('ours static',lambda k:K[k][('ours_static',0)]),('edax l0',lambda k:K[k][('edax',0)])):
    err={k:fn(k)-ref(k) for k in K}
    allv=list(err.values())
    # within-parent deviation
    wv=[]; selbias=[]; 
    for p,cs in kids.items():
        e=[err[(p,c)] for c in cs]
        if len(cs)>=2:
            m=sum(e)/len(e); wv+= [(x-m) for x in e]
    # variance within parent (unbiased-ish, pooled with df correction)
    num=0;den=0
    for p,cs in kids.items():
        e=[err[(p,c)] for c in cs]
        if len(cs)>=2:
            m=sum(e)/len(e); num+=sum((x-m)**2 for x in e); den+=len(e)-1
    within=math.sqrt(num/den)
    # 1-ply selection: parent's value from child static = max_c(-s(c)); ref likewise
    sb=[]
    for p,cs in kids.items():
        v=max(-fn((p,c)) for c in cs); r=max(-ref((p,c)) for c in cs); sb.append(v-r)
    # selection bias vs. oracle: error of the chosen child
    print(f'{lab}: child err global mean {sum(allv)/len(allv):+.2f} sd {sd(allv):.2f} | within-parent sd {within:.2f} | 1-ply max(-static)-max(-ref) mean {sum(sb)/len(sb):+.2f} sd {sd(sb):.2f}')
    # note parent's mover frame: err in child's frame; parent frame error = -err
# also by child-empties band
for lo,hi in ((15,29),(30,39),(40,50)):
    for lab,fn in (('ours static',lambda k:K[k][('ours_static',0)]),('edax l0',lambda k:K[k][('edax',0)])):
        err={k:fn(k)-ref(k) for k in K if lo<=ce[k]<=hi}
        pk=collections.defaultdict(list)
        for (p,c),v in err.items(): pk[p].append(v)
        num=sum(sum((x-sum(e)/len(e))**2 for x in e) for e in pk.values() if len(e)>1); den=sum(len(e)-1 for e in pk.values() if len(e)>1)
        print(f' child empties {lo}-{hi} {lab}: n={len(err)} global sd {sd(list(err.values())):.2f} within sd {math.sqrt(num/den):.2f}')
# correlation of ours and edax errors within parent
eo={k:K[k][('ours_static',0)]-ref(k) for k in K}; ee={k:K[k][('edax',0)]-ref(k) for k in K}
xs=[];ys=[]
for p,cs in kids.items():
    if len(cs)<2: continue
    mo=sum(eo[(p,c)] for c in cs)/len(cs); me=sum(ee[(p,c)] for c in cs)/len(cs)
    for c in cs: xs.append(eo[(p,c)]-mo); ys.append(ee[(p,c)]-me)
cor=sum(a*b for a,b in zip(xs,ys))/math.sqrt(sum(a*a for a in xs)*sum(b*b for b in ys)); print('within-parent corr(ours err, edax err)=%.2f'%cor)
# ref noise floor: sd of (d8 - d9) within parent as indication
d=[K[k][('edax',8)]-K[k][('edax',9)] for k in K]; print('ref d8-d9 diff mean %+.2f sd %.2f'%(sum(d)/len(d),sd(d)))
