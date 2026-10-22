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

const port=+(process.argv[2]||8787);
http.createServer(async(req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c);
  const body=chunks.length?Buffer.concat(chunks):undefined;
  const r=await worker.fetch(new Request(`http://localhost:${port}${req.url}`,{method:req.method,headers:req.headers,body:req.method==='GET'||req.method==='OPTIONS'?undefined:body}),{DB});
  res.writeHead(r.status,Object.fromEntries(r.headers));res.end(Buffer.from(await r.arrayBuffer()));
}).listen(port,()=>console.log(`Pixelmonster-Treffpunkt läuft auf http://localhost:${port}`));
