import sys; sys.path.insert(0,'.')
from oth import *
import concurrent.futures as cf, csv, threading
P=json.load(open('positions_b.json'))
lock=threading.Lock()
def run(tag,wpath):
    OUT=f'diag_smooth_{tag}.csv'
    done=set()
    if Path(OUT).exists():
        for r in csv.DictReader(open(OUT)): done.add(r['pos'])
    else: open(OUT,'w').write('pos,empties,depth,score\n')
    def job(p):
        rows=[]
        for d in range(0,9):
            r=subprocess.run([str(CLI),'eval','--depth',str(d),'--exact-from-empties','0','--pattern-weights',wpath],input=json.dumps([{'id':'x','board':p['board'],'side_to_move':p['side']}]),capture_output=True,text=True)
            o=json.loads(r.stdout)[0]; rows.append([p['id'],p['empties'],d,o['searchDiscDiff']])
        with lock:
            with open(OUT,'a',newline='') as fh: csv.writer(fh).writerows(rows)
    with cf.ThreadPoolExecutor(12) as ex:
        list(ex.map(job,[p for p in P if p['id'] not in done]))
    print(tag,'done',flush=True)
for tag in ('par','adj'): run(tag,str(SP/f'pattern_v6_smooth_{tag}.bin'))
