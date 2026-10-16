import struct, numpy as np
src=open(r'C:\Users\yoshi\work\othello-trainer\app\public\pattern_v6.bin','rb').read()
b=bytearray(src); pos=4
def u32():
    global pos; v=struct.unpack_from('<I',b,pos)[0]; pos+=4; return v
ver=u32(); fl=u32(); ns=u32(); dv=u32(); ni=u32(); nc=u32(); nsc=u32(); pos+=32
for i in range(ni):
    cc=b[pos]; pos+=3+cc
def smooth(a,mode):
    # a: (ns, ...) ; parity-preserving 3-tap on stride 2 : (w[s-2]+2w[s]+w[s+2])/4 ; mode 'adj': also (w[s-1]+2w[s]+w[s+1])/4
    out=a.copy()
    for s in range(2,ns-2):
        if mode=='par': lo,hi=a[s-2],a[s+2]
        else: lo,hi=a[s-1],a[s+1]
        m=(lo!=0)&(a[s]!=0)&(hi!=0)
        out[s]=np.where(m,(lo+2*a[s]+hi)/4,a[s])
    return out
for mode in ('par','adj'):
    c=bytearray(src); pos=4
    pos=4+4*7+32
    for i in range(ni):
        cc=c[pos]; pos+=3+cc
    for k in range(nc):
        cc=c[pos]; pos+=1; nst=struct.unpack_from('<I',c,pos)[0]; pos+=4
        a=np.frombuffer(bytes(c[pos:pos+ns*nst*4]),dtype='<f4').reshape(ns,nst)
        c[pos:pos+ns*nst*4]=smooth(a,mode).astype('<f4').tobytes(); pos+=ns*nst*4
    for k in range(nsc):
        pos+=4
        a=np.frombuffer(bytes(c[pos:pos+ns*4]),dtype='<f4').reshape(ns,1)
        c[pos:pos+ns*4]=smooth(a,mode).astype('<f4').tobytes(); pos+=ns*4
    open(f'pattern_v6_smooth_{mode}.bin','wb').write(c)
    print(mode,'written',len(c)==len(src))
