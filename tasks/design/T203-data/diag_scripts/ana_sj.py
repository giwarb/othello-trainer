import csv, statistics as st, collections, math
rows=list(csv.DictReader(open('diag_c_stagejump.csv')))
for r in rows:
    r['s']=[float(r[f'score_k{k}']) for k in range(-3,4)]; r['e']=int(r['empties'])
def ms(x): return sum(x)/len(x), st.pstdev(x)
print('n',len(rows))
for lo,hi in ((15,24),(25,34),(35,44),(45,50),(15,50)):
    R=[r for r in rows if lo<=r['e']<=hi and 3<=int(r['stage'])<=57]
    d1p=[r['s'][4]-r['s'][3] for r in R]  # score at stage+1 minus own  (stage=empties => more empties)
    d1m=[r['s'][2]-r['s'][3] for r in R]
    rough=[r['s'][4]+r['s'][2]-2*r['s'][3] for r in R]  # second difference
    d2=[r['s'][5]-r['s'][3] for r in R]; rough2=[r['s'][5]+r['s'][1]-2*r['s'][3] for r in R]
    print(f'empties {lo}-{hi} n={len(R)}: shift+1 mean %+.2f sd %.2f | shift-1 mean %+.2f sd %.2f | 2nd diff (+1,-1) mean %+.2f sd %.2f | shift+-2 2nd diff mean %+.2f sd %.2f'%(ms(d1p)+ms(d1m)+ms(rough)+ms(rough2)))
# parity of own empties
print('--- 2nd difference (smoothness) by parity of own empties, empties 15-50:')
for par in (0,1):
    R=[r for r in rows if r['e']%2==par and 15<=r['e']<=50 and int(r['stage'])>=3]
    rough=[r['s'][4]+r['s'][2]-2*r['s'][3] for r in R]; d1p=[r['s'][4]-r['s'][3] for r in R]; d1m=[r['s'][2]-r['s'][3] for r in R]
    print(('even','odd')[par],'empties: n=%d  stage+1 - own: %+.2f  stage-1 - own: %+.2f  2nd diff mean %+.2f sd %.2f'%((len(R),)+(ms(d1p)[0],ms(d1m)[0])+ms(rough)))
# alternating test: own stage minus avg(neighbors) for sign (-1)^e : rough above. Its mean signed by parity => tempo-like parity effect in weights
# compare: eval difference scale vs. total sd
R=[r for r in rows if 15<=r['e']<=50]
print('sd of own score across positions %.2f'%st.pstdev([r['s'][3] for r in R]))
