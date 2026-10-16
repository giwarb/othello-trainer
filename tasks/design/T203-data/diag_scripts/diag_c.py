import struct, numpy as np, csv
b=open(r'C:\Users\yoshi\work\othello-trainer\app\public\pattern_v6.bin','rb').read()
pos=4
def u32():
    global pos; v=struct.unpack_from('<I',b,pos)[0]; pos+=4; return v
ver=u32(); fl=u32(); ns=u32(); dv=u32(); ni=u32(); nc=u32(); nsc=u32(); pos+=32
cnt=[0]*nc; cells=[]
for i in range(ni):
    cc=b[pos]; cid=struct.unpack_from('<H',b,pos+1)[0]; pos+=3+cc; cnt[cid]+=1; cells.append(cc)
tabs=[]
for c in range(nc):
    cc=b[pos]; pos+=1; nst=u32()
    a=np.frombuffer(b,dtype='<f4',count=ns*nst,offset=pos).reshape(ns,nst); pos+=ns*nst*4; tabs.append(a)
    print('class',c,'cells',cc,'states',nst,'instances',cnt[c])
sc={}
for k in range(nsc):
    kind=b[pos]; pos+=4
    sc[kind]=np.frombuffer(b,dtype='<f4',count=ns,offset=pos); pos+=ns*4
print('scalar kinds',list(sc), 'pos',pos,'len',len(b))
for k,v in sc.items(): print('scalar',k,'w@stage[0,10,20,30,40,50,60]',[round(float(v[s]),3) for s in (0,10,20,30,40,50,60)])
# stage index = empties. per-stage: RMS of (w[s]-w[s+1]) over all states, nonzero-both states; weighted by instance count (variance sum)
rows=[]
for s in range(ns-1):
    var_all=0; var_nz=0; var_w=0; 
    for c,a in enumerate(tabs):
        d=a[s]-a[s+1]; m=(a[s]!=0)&(a[s+1]!=0)
        var_all+=cnt[c]*float(np.mean(d**2))
        var_nz+=cnt[c]*(float(np.mean(d[m]**2)) if m.any() else 0)
        var_w+=cnt[c]*float(np.mean(a[s]**2))
    rows.append((s,np.sqrt(var_all/ni),np.sqrt(var_nz/ni),np.sqrt(var_nz),np.sqrt(var_w/ni)))
with open('diag_c.csv','w',newline='') as f:
    w=csv.writer(f); w.writerow(['empties_s','rms_diff_all_perinst','rms_diff_nonzero_perinst','sqrt_sum_nonzero_total_indep','rms_weight_perinst'])
    for r in rows: w.writerow([r[0]]+[round(float(x),4) for x in r[1:]])
import statistics
for lo,hi in ((0,9),(10,19),(20,29),(30,39),(40,49),(50,59)):
    sel=[r for r in rows if lo<=r[0]<=hi]
    print(f'empties {lo}-{hi}: rms_diff_nz/inst={np.mean([r[2] for r in sel]):.3f} total(indep sum)={np.mean([r[3] for r in sel]):.2f} rms_w={np.mean([r[4] for r in sel]):.3f} ratio={np.mean([r[2]/r[4] for r in sel]):.2f}')
# parity of stage: even vs odd s diff
for par in (0,1):
    sel=[r for r in rows if r[0]%2==par and 15<=r[0]<=50]
    print('s parity',par,'mean rms_diff_nz',np.mean([r[2] for r in sel]),'total',np.mean([r[3] for r in sel]))
# consecutive: compare diff(s,s+1) vs diff(s,s+2)/... smoothness: ratio of rms(w[s]-w[s+2]) to rms(w[s]-w[s+1])
r2=[]
for s in range(15,50):
    v1=0;v2=0
    for c,a in enumerate(tabs):
        m=(a[s]!=0)&(a[s+1]!=0)&(a[s+2]!=0)
        if m.any(): v1+=cnt[c]*np.mean((a[s]-a[s+1])[m]**2); v2+=cnt[c]*np.mean((a[s]-a[s+2])[m]**2)
    r2.append(np.sqrt(v2/v1))
print('rms(w[s]-w[s+2])/rms(w[s]-w[s+1]) mean over s15-50:',np.mean(r2),'(sqrt2=1.41 if independent noise, 2 if linear drift)')
print('--- spectrum over stages (empties) 16..47 (32 pts), states nonzero in all stages')
for (lo,hi) in ((16,47),(24,55)):
    acc=np.zeros(hi-lo+1); n=0; accw=0
    for c,a in enumerate(tabs):
        seg=a[lo:hi+1]; m=np.all(seg!=0,axis=0)
        if m.sum()==0: continue
        X=seg[:,m]; X=X-X.mean(axis=0,keepdims=True)
        F=np.abs(np.fft.fft(X,axis=0))**2/len(X)
        acc+=cnt[c]*F.mean(axis=1); accw+=cnt[c]; 
        print(' class',c,'states used',int(m.sum()),'of',a.shape[1]) if lo==16 and False else None
    acc/=accw; N=hi-lo+1
    half=acc[:N//2+1]
    print(f'window {lo}-{hi}: power by freq index k (k=N/2 is Nyquist=period-2):')
    print(' '.join(f'{k}:{half[k]:.3f}' for k in range(0,N//2+1)))
    print(' Nyquist/mean(others k>=1) =',half[N//2]/np.mean(half[1:N//2]), ' mean power k>=1 =',np.mean(half[1:N//2]))
print('--- alternating (parity) component of weights, stage s=empties; A=(-1)^s*(w[s]-(w[s-1]+w[s+1])/2)/2 averaged over s')
for (lo,hi) in ((20,29),(30,39),(40,49)):
    tot_ms=0;tot_mean=0;W=0
    for c,a in enumerate(tabs):
        seg=a[lo-1:hi+2]; m=np.all(seg!=0,axis=0)
        if m.sum()==0: continue
        s=np.arange(lo,hi+1)
        y=(a[lo:hi+1]-(a[lo-1:hi]+a[lo+1:hi+2])/2)/2
        A=((-1.0)**s)[:,None]*y; Am=A[:,m].mean(axis=0)
        tot_ms+=cnt[c]*np.mean(Am**2); tot_mean+=cnt[c]*Am.mean(); W+=cnt[c]
    print(f'empties {lo}-{hi}: mean A per instance={tot_mean/W:+.4f}  rms A={np.sqrt(tot_ms/W):.4f}')
for k,v in sc.items():
    print('scalar',k,'alt component by band:',[round(float(np.mean([(-1)**s*(v[s]-(v[s-1]+v[s+1])/2)/2 for s in range(lo,hi+1)])),3) for lo,hi in ((20,29),(30,39),(40,49))], 'mean weight', [round(float(v[lo:hi+1].mean()),2) for lo,hi in ((20,29),(30,39),(40,49))])
