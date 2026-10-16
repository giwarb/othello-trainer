import csv, statistics as st, collections
S=collections.defaultdict(dict)
for r in csv.DictReader(open('diag_b2_sweep_all.csv')): S[(r['engine'],r['pos'])][int(r['depth'])]=float(r['score'])
B=collections.defaultdict(dict); emp={}
for r in csv.DictReader(open('diag_b.csv')):
    if r['node']=='P': B[r['pos']][r['engine']]=float(r['score']); emp[r['pos']]=int(r['empties'])
pos=sorted(emp)
def ms(x): return sum(x)/len(x), st.pstdev(x)
for refn,ref in (('edax d10',lambda p:B[p]['edax_d10']),('edax (d10+d11)/2',lambda p:(B[p]['edax_d10']+B[p]['edax_d11'])/2)):
    print('===',refn,'n=',len(pos),' columns: mean sd (signed, v(d)-ref)')
    print('d | ours | edax | ours-edax (paired) ')
    for d in range(1,9):
        a=[S[('ours',p)][d]-ref(p) for p in pos]; e=[S[('edax',p)][d]-ref(p) for p in pos]; df=[S[('ours',p)][d]-S[('edax',p)][d] for p in pos]
        print(d,'| %+.2f %.2f | %+.2f %.2f | %+.2f %.2f'%(ms(a)+ms(e)+ms(df)))
    for lab,ds in (('even',[2,4,6,8]),('odd',[1,3,5,7]),('even4-8',[4,6,8]),('odd3-7',[3,5,7])):
        a=[S[('ours',p)][d]-ref(p) for p in pos for d in ds]; e=[S[('edax',p)][d]-ref(p) for p in pos for d in ds]
        print(lab,'ours mean %+.2f sd %.2f | edax mean %+.2f sd %.2f'%(ms(a)+ms(e)))
# oscillation: |v(d)-v(d-2)| at d=4..8, mean |v(d)-v(d-1)|
print('=== same-parity change |v(d)-v(d-2)|, d=4..8, and adjacent |v(d)-v(d-1)| d=3..8 (all 368)')
for eng in ('ours','edax'):
    s2=[abs(S[(eng,p)][d]-S[(eng,p)][d-2]) for p in pos for d in range(4,9)]
    a1=[abs(S[(eng,p)][d]-S[(eng,p)][d-1]) for p in pos for d in range(3,9)]
    print(eng,'same2 %.2f adj %.2f'%(sum(s2)/len(s2),sum(a1)/len(a1)), ' odd-minus-prev-even signed:', '%.2f'%(sum(S[(eng,p)][d]-S[(eng,p)][d-1] for p in pos for d in (3,5,7))/(3*len(pos))))
print('=== by empties band, d=5..8: signed (odd d - mean of adjacent evens)')
for lo,hi in ((20,29),(30,39),(40,50)):
    ps=[p for p in pos if lo<=emp[p]<=hi]
    for eng in ('ours','edax'):
        x=[S[(eng,p)][d]-(S[(eng,p)][d-1]+S[(eng,p)][d+1])/2 for p in ps for d in (3,5,7)]
        z=[abs(S[(eng,p)][d]-S[(eng,p)][d-2]) for p in ps for d in range(4,9)]
        print(lo,hi,eng,'odd-over-neighbour-evens mean %+.2f sd %.2f | same2 %.2f'%(ms(x)+(sum(z)/len(z),)))
