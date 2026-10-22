// Startet den Online-Treffpunkt lokal (zum Testen oder im Heimnetz): node local-server.mjs [port]
// Benutzt Nodes eingebautes SQLite anstelle von Cloudflare D1.
import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import worker from './worker.js';

const file=process.env.PXM_DB||new URL('./pixelmonster.db',import.meta.url).pathname;
const sqlite=new DatabaseSync(file);
function stmt(sql,args=[]){
  const s=sqlite.prepare(sql);
  return{bind:(...a)=>stmt(sql,a),first:async()=>s.get(...args)??null,all:async()=>({results:s.all(...args)}),run:async()=>s.run(...args),_run:()=>s.run(...args)};
}
const DB={prepare:sql=>stmt(sql),batch:async list=>{sqlite.exec('BEGIN');try{const r=list.map(x=>x._run());sqlite.exec('COMMIT');return r}catch(e){sqlite.exec('ROLLBACK');throw e}}};

// Mit PXM_FAKE_AI=1 antwortet eine Test-KI, die nur zeigt, was sie bekommen hat (die echte Cloudflare-KI gibt es lokal nicht)
const AI=process.env.PXM_FAKE_AI?{run:async(model,{messages})=>{const sys=messages[0].content,last=messages.at(-1).content;
  if(process.env.PXM_FAKE_AI==='log')console.log('SYSTEM:\n'+sys);return{response:`*grrr* Du hast „${last}“ gesagt! (${(sys.match(/So geht es dir gerade: (.*)/)||[])[1]})`}}}:undefined;
const port=+(process.argv[2]||8787);
http.createServer(async(req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c);
  const body=chunks.length?Buffer.concat(chunks):undefined;
  const r=await worker.fetch(new Request(`http://localhost:${port}${req.url}`,{method:req.method,headers:req.headers,body:req.method==='GET'||req.method==='OPTIONS'?undefined:body}),{DB,AI});
  res.writeHead(r.status,Object.fromEntries(r.headers));res.end(Buffer.from(await r.arrayBuffer()));
}).listen(port,()=>console.log(`Pixelmonster-Treffpunkt läuft auf http://localhost:${port}`));
