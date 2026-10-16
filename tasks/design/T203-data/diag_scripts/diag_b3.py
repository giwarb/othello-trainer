import sys; sys.path.insert(0,'.')
from oth import *
import threading, concurrent.futures as cf, csv, tempfile
lock=threading.Lock()
ROW=re.compile(r'^\s*(\d+)(?:@(\d+)%)?\s+([+-]?\d+)\s+\d+:\d+\.\d+\s+(\d+)\s+(?:\d+\s+)?(\S+)')
def edax_sweep(board,side,dmax,td):
    f=Path(td)/'p.obf'; f.write_text(f"{board} {'X' if side=='black' else 'O'};\n",encoding='ascii')
    cmd=[str(EDAX),'-solve',str(f),'-l',str(dmax),'-eval-file',str(EDAX_DIR/'data'/'eval.dat'),'-book-usage','off','-vv','-n','1','-selectivity','5']
    r=subprocess.run(cmd,cwd=td,capture_output=True,text=True)
    res={}
    for line in r.stdout.splitlines():
        m=ROW.match(line)
        if m: res[int(m.group(1))]=float(m.group(3))
    return res
def ours_eval(items,depth):
    r=subprocess.run([str(CLI),'eval','--depth',str(depth),'--exact-from-empties','0','--pattern-weights',str(W)],input=json.dumps([{'id':i,'board':b,'side_to_move':s} for i,b,s in items]),capture_output=True,text=True)
    return {x['id']:x for x in json.loads(r.stdout)}
P=json.load(open('positions_b.json'))
sel=[p for p in P if p['src']=='existing']+[p for i,p in enumerate([q for q in P if q['src']=='gen']) if i%3==0]
OUT='diag_b3_siblings.csv'
done=set()
if Path(OUT).exists():
    for r in csv.DictReader(open(OUT)): done.add(r['pos'])
else: open(OUT,'w').write('pos,empties,child,child_empties,engine,depth,score\n')
def job(p):
    b,s=p['board'],p['side']; rows=[]
    kids=[]
    for i in legal(b,s):
        mv=name(i); cb=apply(b,s,mv); cs=opp(s)
        if legal(cb,cs): kids.append((mv,cb,cs))
    if not kids: return
    oc=ours_eval([(m,cb,cs) for m,cb,cs in kids],0)
    o9=None
    with tempfile.TemporaryDirectory(dir=str(SP)) as td:
        for m,cb,cs in kids:
            e={d:edax_sweep(cb,cs,d,td)[d] for d in (0,8,9)}
            ce=cb.count('-')
            rows.append([p['id'],p['empties'],m,ce,'ours_static',0,oc[m]['staticDiscDiff']])
            for d in (0,8,9):
                rows.append([p['id'],p['empties'],m,ce,'edax',d,e[d]])
    with lock:
        with open(OUT,'a',newline='') as fh: csv.writer(fh).writerows(rows)
jobs=[p for p in sel if p['id'] not in done]
print(len(jobs),'sibling jobs',flush=True)
n=0
with cf.ThreadPoolExecutor(12) as ex:
    for f in cf.as_completed([ex.submit(job,p) for p in jobs]):
        f.result(); n+=1
        if n%20==0: print(n,flush=True)
print('sibling done',flush=True)
