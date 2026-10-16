import sys; sys.path.insert(0,'.')
from oth import *
import random
out=[]
seen=set()
P0=json.load(open('positions.json'))
for p in P0:
    out.append({'id':p['id'],'board':p['board'],'side':p['side'],'empties':p['empties'],'src':'existing'}); seen.add((p['board'],p['side']))
rng=random.Random(5)
for band,(lo,hi,seed) in enumerate([(20,29,2001),(30,39,3001),(40,50,4001)]):
    r=subprocess.run([str(CLI),'gen','--category','rnd','--min-empties',str(lo),'--max-empties',str(hi),'--count','110','--seed',str(seed)],capture_output=True,text=True)
    n=0
    for g in json.loads(r.stdout):
        b,s=g['board'],g['side_to_move']
        if (b,s) in seen: continue
        L=legal(b,s)
        if not L: continue
        # require opponent can reply after at least one move; checked later per child
        seen.add((b,s)); out.append({'id':f"g{lo}_{g['id'].split('-')[-1]}",'board':b,'side':s,'empties':b.count('-'),'src':'gen'}); n+=1
    print(lo,hi,n)
json.dump(out,open('positions_b.json','w'))
print(len(out))
