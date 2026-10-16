import csv, statistics as st, collections, math
S=r'C:\Users\yoshi\AppData\Roaming\Claude\side-session-notes\local_4bcd5530-ff13-46d2-92e4-30bacd57ddff\depth_parity.csv'
R=collections.defaultdict(dict)
for r in csv.DictReader(open(S)): R[(r['engine'],r['pos'])][int(r['depth'])]=float(r['score'])
pos=sorted({p for e,p in R if e=='ours'}); print('n pos',len(pos))
def ms(x): return (sum(x)/len(x), st.pstdev(x))
rows=[]
print('depth | ours-edaxD12: mean sd mae | edax(d)-edax(12): mean sd mae | ours(d)-ours(12) mean sd')
for d in range(1,13):
    a=[R[('ours',p)][d]-R[('edax_nompc',p)][12] for p in pos]
    b=[R[('edax_nompc',p)][d]-R[('edax_nompc',p)][12] for p in pos]
    c=[R[('ours',p)][d]-R[('ours',p)][12] for p in pos]
    print(f'd{d:2d} | {ms(a)[0]:+.2f} {ms(a)[1]:.2f} {sum(map(abs,a))/len(a):.2f} | {ms(b)[0]:+.2f} {ms(b)[1]:.2f} {sum(map(abs,b))/len(b):.2f} | {ms(c)[0]:+.2f} {ms(c)[1]:.2f}')
    rows.append((d,)+ms(a)+ms(b)+ms(c))
for name,ds in (('even d4-12',[4,6,8,10,12]),('odd d3-11',[3,5,7,9,11]),('even d6-12',[6,8,10,12]),('odd d5-11',[5,7,9,11])):
    a=[R[('ours',p)][d]-R[('edax_nompc',p)][12] for p in pos for d in ds]
    b=[R[('edax_nompc',p)][d]-R[('edax_nompc',p)][12] for p in pos for d in ds if d!=12]
    print(name,'ours-edax12 mean %+.2f sd %.2f | edax(d)-edax12 mean %+.2f sd %.2f'%(ms(a)+ms(b)))
# also ours vs edax same depth
print('ours(d)-edax(d) same depth mean/sd:',' '.join(f"d{d}:{ms([R[('ours',p)][d]-R[('edax_nompc',p)][d] for p in pos])[0]:+.2f}/{ms([R[('ours',p)][d]-R[('edax_nompc',p)][d] for p in pos])[1]:.2f}" for d in range(1,13)))
with open('diag_a.csv','w',newline='') as f:
    w=csv.writer(f); w.writerow(['depth','ours_minus_edax12_mean','sd','edax_minus_edax12_mean','sd','ours_minus_ours12_mean','sd'])
    for r in rows: w.writerow([r[0]]+[round(x,3) for x in r[1:]])
