import { readFile, writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { createHash } from 'node:crypto'
import { Engine, initSync } from '../../app/src/engine/pkg/engine.js'
const [candidatePath, disabledPath, outputPath] = process.argv.slice(2)
if (!candidatePath || !disabledPath || !outputPath) throw new Error('expected candidate, zeroed candidate, output')
const wasm = await readFile(new URL('../../app/src/engine/pkg/engine_bg.wasm', import.meta.url)); initSync({ module: wasm })
const positions = JSON.parse(await readFile(new URL('./t158a_engine_cost_positions.json', import.meta.url), 'utf8'))
const models = { on: await readFile(candidatePath), off: await readFile(disabledPath) }; const repetitions = 3
const samples = { on: positions.map(() => []), off: positions.map(() => []) }; const refs = {}
function deterministic(r) { return { move:r.pv?.[0]??null, score:r.score, depth:r.depth, nodes:r.nodes, pv:r.pv, nodeLimitHit:r.nodeLimitHit, timedOut:r.timedOut } }
function once(bytes,p) {
  const e=new Engine()
  try { e.load_pattern_weights(bytes); const req=JSON.stringify({id:1,cmd:'analyze',board:{black:p.black,white:p.white,turn:p.turn},limit:{depth:12,maxNodes:160000,exactFromEmpties:16}}); const start=performance.now(); const response=JSON.parse(e.analyze(req)); const elapsedMs=performance.now()-start; if(response.error)throw new Error(response.error); return {elapsedMs,deterministic:deterministic(response)} } finally { e.free() }
}
for(let rep=0;rep<repetitions;rep+=1){
  for(const mode of (rep%2===0?['on','off']:['off','on'])) for(let i=0;i<positions.length;i+=1){ const s=once(models[mode],positions[i]); const key=`${mode}:${positions[i].id}`; if(refs[key]&&JSON.stringify(refs[key])!==JSON.stringify(s.deterministic))throw new Error(`WASM nondeterminism ${key}`); refs[key]=s.deterministic; samples[mode][i].push(s) }
  console.error(`[t158c wasm nps] repetition ${rep+1}/${repetitions}`)
}
const median=v=>[...v].sort((a,b)=>a-b)[Math.floor(v.length/2)]; const modes={}
for(const mode of ['on','off']){ const rows=positions.map((p,i)=>({id:p.id,bucket:p.bucket,elapsedMedianMs:median(samples[mode][i].map(s=>s.elapsedMs)),depth:samples[mode][i][0].deterministic.depth,nodes:samples[mode][i][0].deterministic.nodes,move:samples[mode][i][0].deterministic.move})); const aggregateElapsedMs=rows.reduce((a,x)=>a+x.elapsedMedianMs,0); const aggregateNodes=rows.reduce((a,x)=>a+x.nodes,0); modes[mode]={positions:rows,aggregateElapsedMs,aggregateNodes,aggregateNps:aggregateNodes/(aggregateElapsedMs/1000)} }
const hex=bytes=>createHash('sha256').update(bytes).digest('hex')
const result={repetitions,deterministic:true,featureOffMethod:'same learned PWV4 pattern tables with both scalar coefficient arrays zeroed',candidateSha256:hex(models.on),featureOffSha256:hex(models.off),wasmSha256:hex(wasm),runtime:{node:process.version,platform:process.platform,arch:process.arch},modes,onOffNpsRatio:modes.on.aggregateNps/modes.off.aggregateNps}; let output={}; try{output=JSON.parse(await readFile(outputPath,'utf8'))}catch{} output.wasm=result; await writeFile(outputPath,`${JSON.stringify(output,null,2)}\n`,'utf8'); console.log(JSON.stringify(result,null,2))
