import json, subprocess, re, os, sys, time
from pathlib import Path
REPO=Path(r'C:\Users\yoshi\work\othello-trainer')
SP=Path(__file__).resolve().parent
EDAX_DIR=REPO/'bench'/'edax-compare'/'edax-extract'
EDAX=EDAX_DIR/'wEdax-x86-64.exe'
CLI=SP/'target'/'release'/'eval_cli.exe'
W=REPO/'app'/'public'/'pattern_v6.bin'
DIRS=[(-1,-1),(0,-1),(1,-1),(-1,0),(1,0),(-1,1),(0,1),(1,1)]
def idx(sq): return (int(sq[1])-1)*8+(ord(sq[0])-97)
def name(i): return chr(97+i%8)+str(i//8+1)
def flips(b,i,me,op):
    x,y=i%8,i//8; out=[]
    for dx,dy in DIRS:
        cx,cy=x+dx,y+dy; line=[]
        while 0<=cx<8 and 0<=cy<8 and b[cy*8+cx]==op:
            line.append(cy*8+cx); cx+=dx; cy+=dy
        if line and 0<=cx<8 and 0<=cy<8 and b[cy*8+cx]==me: out+=line
    return out
def legal(b,side):
    me='X' if side=='black' else 'O'; op='O' if me=='X' else 'X'
    return [i for i in range(64) if b[i]=='-' and flips(b,i,me,op)]
def apply(b,side,sq):
    b=list(b); me='X' if side=='black' else 'O'; op='O' if me=='X' else 'X'; i=idx(sq)
    f=flips(b,i,me,op); assert f,(sq,)
    b[i]=me
    for j in f: b[j]=me
    return ''.join(b)
def opp(s): return 'white' if s=='black' else 'black'
def play(b,side,moves):
    for m in moves:
        assert idx(m) in legal(b,side),(m,side)
        b=apply(b,side,m); side=opp(side)
    return b,side
def edax(board,side,level):
    p=EDAX_DIR/'_side_tmp.obf'
    p.write_text(f"{board} {'X' if side=='black' else 'O'};\n",encoding='ascii')
    r=subprocess.run([str(EDAX),'-solve',str(p),'-l',str(level),'-eval-file',str(EDAX_DIR/'data'/'eval.dat'),'-book-usage','off','-vv','-n','1'],cwd=EDAX_DIR,capture_output=True,text=True)
    return r.stdout
