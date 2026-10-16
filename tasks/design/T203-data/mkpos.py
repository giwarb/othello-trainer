import sys; sys.path.insert(0,'.')
from oth import *
st={}
for l in open(REPO/'logs/t201/tmp_t201_positions.jsonl'):
    r=json.loads(l); st[r['stageNumber']]=r
P=[]
def add(pid,src,b,s): P.append({'id':pid,'source':src,'board':b,'side':s,'empties':b.count('-')})
b0=st[86]['board']
for name_,mv in [('p86_end_d1',['f2','c2','f1','d6','e1','d1']),('p86_end_g3',['f2','c2','f1','d6','e1','g3']),('p86_alt_end',['g6','g5','f2','c2','h5','d6'])]:
    b,s=play(b0,'black',mv); add(name_,'stage86 start + '+' '.join(mv),b,s)
for n in (86,34,37,40,49,52,58,67,76,82,85,88,91,109):
    add(f's{n}_start',f'midgame stage {n} start (logs/t201/tmp_t201_positions.jsonl)',st[n]['board'],st[n]['sideToMove'])
r=subprocess.run([str(CLI),'gen','--category','rnd','--min-empties','30','--max-empties','34','--count','3','--seed','11'],capture_output=True,text=True)
for g in json.loads(r.stdout): add('rnd_'+g['id'].split('-')[-1],'eval_cli gen seed=11 empties30-34',g['board'],g['side_to_move'])
# validate: both sides have legal moves at root
for p in P:
    assert legal(p['board'],p['side']),p['id']
json.dump(P,open('positions.json','w'),indent=1)
for p in P: print(p['id'],p['empties'],p['side'])
