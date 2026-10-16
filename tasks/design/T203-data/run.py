import sys; sys.path.insert(0,'.')
from oth import *
import threading, concurrent.futures as cf, csv, tempfile
OUT=SP/'depth_parity.csv'
P=json.load(open(SP/'positions.json'))
DEPTHS=range(1,13)
done=set()
if OUT.exists():
    for r in csv.DictReader(open(OUT)): done.add((r['pos'],r['engine'],int(r['depth'])))
else:
    OUT.write_text('pos,empties,side,engine,depth,score,move,nodes,sec\n')
lock=threading.Lock()
ROW=re.compile(r'^\s*(\d+)(?:@(\d+)%)?\s+([+-]?\d+)\s+\S+\s+(\d+)\s+(?:\d+\s+)?(\S+)')
def job(p,eng,d):
    t=time.time()
    if eng=='ours':
        r=subprocess.run([str(CLI),'best','--depth',str(d),'--exact-from-empties','0','--pattern-weights',str(W)],input=json.dumps({'board':p['board'],'side_to_move':p['side']}),capture_output=True,text=True)
        j=json.loads(r.stdout); sc=j['score']['discDiff']; mv=j['move']; nodes=j['nodes']
        assert j['depth']==d and j['score']['type']=='midgame',(p['id'],d,j['depth'])
    else:
        with tempfile.TemporaryDirectory(dir=str(SP)) as td:
            f=Path(td)/'p.obf'; f.write_text(f"{p['board']} {'X' if p['side']=='black' else 'O'};\n",encoding='ascii')
            cmd=[str(EDAX),'-solve',str(f),'-l',str(d),'-eval-file',str(EDAX_DIR/'data'/'eval.dat'),'-book-usage','off','-vv','-n','1']
            if eng=='edax_nompc': cmd+=['-selectivity','5']
            r=subprocess.run(cmd,cwd=td,capture_output=True,text=True)
        last=None
        for line in r.stdout.splitlines():
            m=ROW.match(line)
            if m: last=m
        assert last and int(last.group(1))==d,(p['id'],d,r.stdout[-500:])
        sc=float(last.group(3)); nodes=int(last.group(4)); mv=last.group(5).lower()
    row=[p['id'],p['empties'],p['side'],eng,d,sc,mv,nodes,round(time.time()-t,2)]
    with lock:
        with open(OUT,'a',newline='') as fh: csv.writer(fh).writerow(row)
jobs=[(p,e,d) for p in P for e in ('ours','edax_nompc','edax_mpc') for d in DEPTHS if (p['id'],e,d) not in done]
print(len(jobs),'jobs',flush=True)
with cf.ThreadPoolExecutor(6) as ex:
    futs=[ex.submit(job,*j) for j in jobs]
    for f in futs: f.result()
print('done')
