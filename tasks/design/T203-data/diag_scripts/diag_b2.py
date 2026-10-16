import sys; sys.path.insert(0,'.')
from oth import *
import threading, concurrent.futures as cf, csv, tempfile
lock=threading.Lock()
ROW=re.compile(r'^\s*(\d+)(?:@(\d+)%)?\s+([+-]?\d+)\s+\d+:\d+\.\d+\s+(\d+)\s+(?:\d+\s+)?(\S+)')
def edax_sweep(board,side,dmax,td):
    # one run at level dmax prints every iteration depth 0..dmax (iterative deepening) -> take score at each depth
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
# ---- sweep
P=json.load(open('positions_b.json'))
OUT='diag_b2_sweep.csv'
done=set()
if Path(OUT).exists():
    for r in csv.DictReader(open(OUT)): done.add(r['pos'])
else: open(OUT,'w').write('pos,empties,engine,depth,score\n')
def job(p):
    rows=[]
    with tempfile.TemporaryDirectory(dir=str(SP)) as td:
        e=edax_sweep(p['board'],p['side'],8,td)
    for d in range(1,9):
        if d in e: rows.append([p['id'],p['empties'],'edax',d,e[d]])
    for d in range(1,9):
        o=ours_eval([('x',p['board'],p['side'])],d)['x']
        rows.append([p['id'],p['empties'],'ours',d,o['searchDiscDiff']])
    with lock:
        with open(OUT,'a',newline='') as fh: csv.writer(fh).writerows(rows)
jobs=[p for p in P if p['id'] not in done]
print(len(jobs),'sweep jobs',flush=True)
with cf.ThreadPoolExecutor(12) as ex:
    for f in cf.as_completed([ex.submit(job,p) for p in jobs]): f.result()
print('sweep done',flush=True)
