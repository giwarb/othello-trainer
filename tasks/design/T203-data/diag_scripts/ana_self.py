import csv, statistics as st, collections
S=collections.defaultdict(dict)
for r in csv.DictReader(open('diag_b2_sweep_all.csv')): S[(r['engine'],r['pos'])][int(r['depth'])]=float(r['score'])
B=collections.defaultdict(dict); emp={}
for r in csv.DictReader(open('diag_b.csv')):
    if r['node']=='P': B[r['pos']][r['engine']]=float(r['score']); emp[r['pos']]=int(r['empties'])
pos=sorted(emp)
for p in pos:
    S[('ours',p)][10]=B[p]['ours_d10']; S[('edax',p)][10]=B[p]['edax_d10']; S[('edax',p)][11]=B[p]['edax_d11']
def ms(x): return sum(x)/len(x), st.pstdev(x)
print('self-referenced: v(d)-v(10) same engine; (mean sd) | also v(d)-v(d-2)')
print('d | ours | edax | ratio sd')
for d in range(1,9):
    a=[S[('ours',p)][d]-S[('ours',p)][10] for p in pos]; e=[S[('edax',p)][d]-S[('edax',p)][10] for p in pos]
    print(d,'| %+.2f %.2f | %+.2f %.2f | %.2f'%(ms(a)+ms(e)+(ms(a)[1]/ms(e)[1],)))
    print()
print('even-depth only d2..8 -> sd ratio: ', end='')
for eng in ('ours','edax'):
    x=[S[(eng,p)][d]-S[(eng,p)][10] for p in pos for d in (4,6,8)]; print(eng,'%+.2f %.2f'%ms(x),end=' | ')
print()
print('odd d3,5,7,9 vs d11 (edax) / ours d9 vs ours d10 signed:')
for eng in ('ours','edax'):
    x=[S[(eng,p)][d]-S[(eng,p)][10] for p in pos for d in (5,7)]; print(eng,'odd-vs-d10 %+.2f %.2f'%ms(x))
# per-position |v(d)-v(d-1)| for d=9,10 (adjacent parity step) ours vs edax
for eng in ('ours','edax'):
    x=[S[(eng,p)][10]-S[(eng,p)][8] for p in pos]; print(eng,'v10-v9 mean %+.2f sd %.2f mean abs %.2f'%(ms(x)+(sum(map(abs,x))/len(x),)))
# existing 38 subset check: even bias
ex=[p for p in pos if not p.startswith('g')]
for eng in ('ours','edax'):
    x=[S[(eng,p)][d]-(B[p]['edax_d10']+B[p]['edax_d11'])/2 for p in ex for d in (4,6,8)]; print('existing38',eng,'even d4-8 vs avg ref %+.2f %.2f'%ms(x))
