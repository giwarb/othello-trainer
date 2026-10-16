import sys; sys.path.insert(0,'.')
from oth import *
import threading, concurrent.futures as cf, csv, tempfile, random
OUT=SP/'diag_b.csv'
P=json.load(open(SP/'positions_b.json'))
done=set()
if OUT.exists():
    for r in csv.DictReader(open(OUT)): done.add(r['pos'])
else:
    OUT.write_text('pos,empties,node,move,engine,level,score\n')
lock=threading.Lock()
ROW=re.compile(r'^\s*(\d+)(?:@(\d+)%)?\s+([+-]?\d+)\s+\d+:\d+\.\d+\s+(\d+)\s+(?:\d+\s+)?(\S+)')
def edax_run(board,side,d,td):
    f=Path(td)/'p.obf'; f.write_text(f"{board} {'X' if side=='black' else 'O'};\n",encoding='ascii')
    cmd=[str(EDAX),'-solve',str(f),'-l',str(d),'-eval-file',str(EDAX_DIR/'data'/'eval.dat'),'-book-usage','off','-vv','-n','1','-selectivity','5']
    r=subprocess.run(cmd,cwd=td,capture_output=True,text=True)
    last=None
    for line in r.stdout.splitlines():
        m=ROW.match(line)
        if m: last=m
    assert last and int(last.group(1))>=d,(board,d,r.stdout[-300:])
    return float(last.group(3)),last.group(5).lower(),int(last.group(1))
def ours_eval(items,depth):
    r=subprocess.run([str(CLI),'eval','--depth',str(depth),'--exact-from-empties','0','--pattern-weights',str(W)],input=json.dumps([{'id':i,'board':b,'side_to_move':s} for i,b,s in items]),capture_output=True,text=True)
    return {x['id']:x for x in json.loads(r.stdout)}
def job(p):
    rows=[]
    b,s=p['board'],p['side']
    rng=random.Random(hash(p['id'])%100000 if False else sum(map(ord,p['id'])))
    with tempfile.TemporaryDirectory(dir=str(SP)) as td:
        l0,m0,_=edax_run(b,s,0,td); l1,m1,_=edax_run(b,s,1,td)
        e10,m10,a10=edax_run(b,s,10,td); e11,m11,a11=edax_run(b,s,11,td)
        nodes={'P':(b,s,'')}
        cands=[('Cbest',m1),('Crand',None)]
        L=legal(b,s)
        for tag,mv in cands:
            if mv is None:
                mv=name(rng.choice(L))
            if idx(mv) not in L: continue
            cb=apply(b,s,mv); cs=opp(s)
            if not legal(cb,cs): continue
            nodes[tag]=(cb,cs,mv)
        for tag,(nb,ns,mv) in nodes.items():
            if tag!='P':
                rows.append([p['id'],nb.count('-'),tag,mv,'edax_l0',0,edax_run(nb,ns,0,td)[0]])
                cs,_,ca=edax_run(nb,ns,10,td)
                rows.append([p['id'],nb.count('-'),tag,mv,'edax_d10',ca,cs])
    rows+= [[p['id'],p['empties'],'P','','edax_l0',0,l0],[p['id'],p['empties'],'P',m1,'edax_l1',1,l1],[p['id'],p['empties'],'P',m10,'edax_d10',a10,e10],[p['id'],p['empties'],'P',m11,'edax_d11',a11,e11]]
    o=ours_eval([('P',b,s)],10)['P']
    assert o['searchDepth']==10
    rows.append([p['id'],p['empties'],'P','','ours_static',0,o['staticDiscDiff']])
    rows.append([p['id'],p['empties'],'P','','ours_d10',10,o['searchDiscDiff']])
    ch=[(t,v) for t,v in nodes.items() if t!='P']
    if ch:
        oc=ours_eval([(t,v[0],v[1]) for t,v in ch],0)
        for t,v in ch: rows.append([p['id'],v[0].count('-'),t,v[2],'ours_static',0,oc[t]['staticDiscDiff']])
    with lock:
        with open(OUT,'a',newline='') as fh: csv.writer(fh).writerows(rows)
jobs=[p for p in P if p['id'] not in done]
print(len(jobs),'jobs',flush=True)
n=0
with cf.ThreadPoolExecutor(12) as ex:
    for f in cf.as_completed([ex.submit(job,p) for p in jobs]):
        f.result(); n+=1
        if n%25==0: print(n,'done',flush=True)
print('done')
