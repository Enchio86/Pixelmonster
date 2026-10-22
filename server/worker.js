// Pixelmonster Online-Treffpunkt – Cloudflare Worker mit D1-Datenbank (Binding-Name: DB)
// Speichert Spieler, Freundschaften, Monster-Profile, Gast-Besuche und Quest-Belohnungen.

const CORS={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization'};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json',...CORS}});
const fail=(msg,status=400)=>json({error:msg},status);
const CODE_CHARS='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_MONSTER=8000;

const BOSS_HP=1200,BOSS_MAX_HIT=700;
function weekId(d=new Date()){
  const t=new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate())),day=t.getUTCDay()||7;t.setUTCDate(t.getUTCDate()+4-day);
  const y=t.getUTCFullYear();return`${y}-W${String(Math.ceil(((t-Date.UTC(y,0,1))/864e5+1)/7)).padStart(2,'0')}`;
}
async function bossState(db,week,me){
  const hits=(await db.prepare('SELECT b.player,b.dmg,b.claimed,p.name FROM bosshits b JOIN players p ON p.id=b.player WHERE b.week=?').bind(week).all()).results;
  const mine=hits.find(h=>h.player===me);
  return{week,hp:BOSS_HP,dmg:hits.reduce((a,h)=>a+h.dmg,0),hit:mine?mine.dmg:null,claimed:!!mine?.claimed,players:hits.map(h=>h.name)};
}

let ready=false;
async function init(db){
  if(ready)return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS players(id TEXT PRIMARY KEY,secret TEXT,name TEXT,code TEXT UNIQUE,monster TEXT,updated INTEGER)'),
    db.prepare('CREATE TABLE IF NOT EXISTS friends(a TEXT,b TEXT,PRIMARY KEY(a,b))'),
    db.prepare('CREATE TABLE IF NOT EXISTS guests(id TEXT PRIMARY KEY,owner TEXT,host TEXT,monster TEXT,created INTEGER)'),
    db.prepare('CREATE TABLE IF NOT EXISTS returns(id TEXT PRIMARY KEY,owner TEXT,data TEXT,created INTEGER)'),
    db.prepare('CREATE TABLE IF NOT EXISTS bosshits(week TEXT,player TEXT,dmg INTEGER,claimed INTEGER DEFAULT 0,PRIMARY KEY(week,player))')
  ]);
  ready=true;
}
function newCode(){let c='';const b=crypto.getRandomValues(new Uint8Array(6));for(const x of b)c+=CODE_CHARS[x%CODE_CHARS.length];return c.slice(0,3)+'-'+c.slice(3)}
const clean=(s,n)=>String(s||'').replace(/[\u0000-\u001f]/g,'').trim().slice(0,n);

async function auth(req,db){
  const [id,secret]=(req.headers.get('Authorization')||'').replace('Bearer ','').split('.');
  if(!id||!secret)return null;
  const p=await db.prepare('SELECT * FROM players WHERE id=?').bind(id).first();
  return p&&p.secret===secret?p:null;
}
async function state(db,me){
  const friends=(await db.prepare('SELECT p.id,p.name,p.code,p.monster,p.updated FROM friends f JOIN players p ON p.id=f.b WHERE f.a=? ORDER BY p.name').bind(me.id).all()).results
    .map(f=>({...f,monster:f.monster?JSON.parse(f.monster):null}));
  const guests=(await db.prepare('SELECT g.id,g.owner,g.monster,g.created,p.name AS ownerName FROM guests g JOIN players p ON p.id=g.owner WHERE g.host=?').bind(me.id).all()).results
    .map(g=>({...g,monster:JSON.parse(g.monster)}));
  const outgoing=(await db.prepare('SELECT g.id,g.host,g.created,p.name AS hostName FROM guests g JOIN players p ON p.id=g.host WHERE g.owner=?').bind(me.id).all()).results;
  const returns=(await db.prepare('SELECT id,data FROM returns WHERE owner=?').bind(me.id).all()).results.map(r=>({id:r.id,...JSON.parse(r.data)}));
  return{me:{id:me.id,name:me.name,code:me.code},friends,guests,outgoing,returns};
}

export default{
  async fetch(req,env){
    try{return await handle(req,env)}
    catch(e){return fail('Serverfehler: '+(e&&e.message||e),500)}
  }
};

async function handle(req,env){
  {
    if(req.method==='OPTIONS')return new Response(null,{headers:CORS});
    const db=env.DB;if(!db)return fail('Die Datenbank ist nicht verbunden (Binding „DB“ fehlt).',500);
    await init(db);
    const path=new URL(req.url).pathname.replace(/\/+$/,'');
    const body=req.method==='POST'?await req.json().catch(()=>({})):{};
    if(path===''||path==='/ping')return json({ok:true,game:'pixelmonster'});

    if(path==='/register'){
      const name=clean(body.name,20)||'Spieler',id=crypto.randomUUID(),secret=crypto.randomUUID().replace(/-/g,'');
      let code;for(let i=0;i<5;i++){code=newCode();if(!await db.prepare('SELECT 1 FROM players WHERE code=?').bind(code).first())break}
      await db.prepare('INSERT INTO players(id,secret,name,code,monster,updated) VALUES(?,?,?,?,NULL,?)').bind(id,secret,name,code,Date.now()).run();
      return json({id,secret,code,name});
    }

    const me=await auth(req,db);if(!me)return fail('Nicht angemeldet.',401);

    if(path==='/state')return json(await state(db,me));
    if(path==='/sync'){
      const m=body.monster?JSON.stringify(body.monster):null;
      if(m&&m.length>MAX_MONSTER)return fail('Monsterdaten zu groß.');
      const name=clean(body.name,20)||me.name;
      await db.prepare('UPDATE players SET monster=COALESCE(?,monster),name=?,updated=? WHERE id=?').bind(m,name,Date.now(),me.id).run();
      return json(await state(db,{...me,name}));
    }
    if(path==='/friend'){
      const code=clean(body.code,7).toUpperCase().replace(/^([A-Z0-9]{3})([A-Z0-9]{3})$/,'$1-$2');
      const f=await db.prepare('SELECT id,name FROM players WHERE code=?').bind(code).first();
      if(!f)return fail('Diesen Freundescode gibt es nicht.',404);
      if(f.id===me.id)return fail('Das ist dein eigener Code.');
      await db.batch([db.prepare('INSERT OR IGNORE INTO friends(a,b) VALUES(?,?)').bind(me.id,f.id),db.prepare('INSERT OR IGNORE INTO friends(a,b) VALUES(?,?)').bind(f.id,me.id)]);
      return json({ok:true,name:f.name,...await state(db,me)});
    }
    if(path==='/unfriend'){
      await db.batch([db.prepare('DELETE FROM friends WHERE a=? AND b=?').bind(me.id,body.id),db.prepare('DELETE FROM friends WHERE a=? AND b=?').bind(body.id,me.id)]);
      return json(await state(db,me));
    }
    if(path==='/visit'){
      const isFriend=await db.prepare('SELECT 1 FROM friends WHERE a=? AND b=?').bind(me.id,body.to).first();
      if(!isFriend)return fail('Ihr seid noch keine Freunde.');
      if(!me.monster)return fail('Dein Monster ist noch nicht online.');
      if(await db.prepare('SELECT 1 FROM guests WHERE owner=? AND host=?').bind(me.id,body.to).first())return fail('Dein Monster ist dort schon zu Besuch.');
      await db.prepare('INSERT INTO guests(id,owner,host,monster,created) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),me.id,body.to,me.monster,Date.now()).run();
      return json(await state(db,me));
    }
    if(path==='/return'){
      const g=await db.prepare('SELECT * FROM guests WHERE id=? AND host=?').bind(body.guest,me.id).first();
      if(!g)return fail('Diesen Gast gibt es nicht mehr.',404);
      const r=body.result||{},data=JSON.stringify({host:me.name,monsterName:clean(r.monsterName,20),quest:clean(r.quest,30),ok:!!r.ok,
        xp:Math.min(Math.max(+r.xp||0,0),300),coins:Math.min(Math.max(+r.coins||0,0),200),items:{beere:Math.min(+r.items?.beere||0,5),trank:Math.min(+r.items?.trank||0,5)}});
      await db.batch([db.prepare('DELETE FROM guests WHERE id=?').bind(g.id),db.prepare('INSERT INTO returns(id,owner,data,created) VALUES(?,?,?,?)').bind(crypto.randomUUID(),g.owner,data,Date.now())]);
      return json(await state(db,me));
    }
    if(path==='/claim'){
      const r=await db.prepare('SELECT data FROM returns WHERE id=? AND owner=?').bind(body.id,me.id).first();
      if(!r)return fail('Schon abgeholt.',404);
      await db.prepare('DELETE FROM returns WHERE id=?').bind(body.id).run();
      return json({id:body.id,...JSON.parse(r.data)});
    }
    // Wochen-Boss: alle Spieler kämpfen gemeinsam, jeder einmal pro Woche
    if(path==='/boss'||path==='/boss/hit'||path==='/boss/claim'){
      // Die Woche des Spielers zählt, solange sie höchstens einen halben Tag von der Serverzeit abweicht (Zeitzonen)
      const near=[-1,0,1].map(k=>weekId(new Date(Date.now()+k*432e5)));
      const week=near.includes(body.week)?body.week:weekId();
      if(path==='/boss/hit'){
        if(body.week!==week)return fail('Diese Boss-Woche ist vorbei.');
        const dmg=Math.min(Math.max(Math.round(+body.dmg||0),0),BOSS_MAX_HIT);
        const r=await db.prepare('INSERT OR IGNORE INTO bosshits(week,player,dmg) VALUES(?,?,?)').bind(week,me.id,dmg).run();
        if(!(r.meta?.changes??r.changes))return fail('Du hast diese Woche schon gegen den Boss gekämpft.');
      }
      if(path==='/boss/claim'){
        const st=await bossState(db,week,me.id);
        if(st.dmg<st.hp)return fail('Der Boss ist noch nicht besiegt.');
        if(st.hit==null)return fail('Du hast diese Woche nicht mitgekämpft.');
        if(st.claimed)return fail('Belohnung schon abgeholt.');
        await db.prepare('UPDATE bosshits SET claimed=1 WHERE week=? AND player=?').bind(week,me.id).run();
      }
      return json(await bossState(db,week,me.id));
    }
    return fail('Unbekannte Adresse.',404);
  }
}
