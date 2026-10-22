// Pixelmonster Online-Treffpunkt – Cloudflare Worker mit D1-Datenbank (Binding-Name: DB)
// Speichert Spieler, Freundschaften, Monster-Profile, Gast-Besuche und Quest-Belohnungen.

const CORS={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization'};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json',...CORS}});
const fail=(msg,status=400)=>json({error:msg},status);
const CODE_CHARS='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_MONSTER=8000,MAX_STATUS=6000,MAX_SPRITE=120000;
const REMOTE_CMDS=['feed','snack','play','clean','sleep','med'];

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

// Raid des Monats: ein riesiger Boss, alle Spieler zusammen, jeder einmal pro Tag (UTC)
const RAID_HP=20000,RAID_MAX_HIT=1500;
const monthId=(d=new Date())=>d.toISOString().slice(0,7),dayId=(d=new Date())=>d.toISOString().slice(0,10);
async function raidState(db,month,me){
  const hits=(await db.prepare('SELECT r.player,r.day,r.dmg,p.name FROM raidhits r JOIN players p ON p.id=r.player WHERE r.month=?').bind(month).all()).results;
  const mine=hits.filter(h=>h.player===me),names=[...new Set(hits.map(h=>h.name))];
  const claimed=!!(await db.prepare('SELECT 1 FROM raidclaims WHERE month=? AND player=?').bind(month,me).first());
  return{month,hp:RAID_HP,dmg:hits.reduce((a,h)=>a+h.dmg,0),fights:mine.length,myDmg:mine.reduce((a,h)=>a+h.dmg,0),today:mine.some(h=>h.day===dayId()),claimed,players:names};
}

let ready=false;
async function init(db){
  if(ready)return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS players(id TEXT PRIMARY KEY,secret TEXT,name TEXT,code TEXT UNIQUE,monster TEXT,updated INTEGER)'),
    db.prepare('CREATE TABLE IF NOT EXISTS friends(a TEXT,b TEXT,PRIMARY KEY(a,b))'),
    db.prepare('CREATE TABLE IF NOT EXISTS guests(id TEXT PRIMARY KEY,owner TEXT,host TEXT,monster TEXT,created INTEGER)'),
    db.prepare('CREATE TABLE IF NOT EXISTS returns(id TEXT PRIMARY KEY,owner TEXT,data TEXT,created INTEGER)'),
    db.prepare('CREATE TABLE IF NOT EXISTS bosshits(week TEXT,player TEXT,dmg INTEGER,claimed INTEGER DEFAULT 0,PRIMARY KEY(week,player))'),
    db.prepare('CREATE TABLE IF NOT EXISTS raidhits(month TEXT,player TEXT,day TEXT,dmg INTEGER,PRIMARY KEY(month,player,day))'),
    db.prepare('CREATE TABLE IF NOT EXISTS raidclaims(month TEXT,player TEXT,PRIMARY KEY(month,player))'),
    db.prepare('CREATE TABLE IF NOT EXISTS pairs(code TEXT PRIMARY KEY,player TEXT,expires INTEGER)'),
    db.prepare('CREATE TABLE IF NOT EXISTS remotes(token TEXT PRIMARY KEY,player TEXT,created INTEGER)'),
    db.prepare('CREATE TABLE IF NOT EXISTS rstatus(player TEXT PRIMARY KEY,data TEXT,sprite TEXT,updated INTEGER)'),
    db.prepare('CREATE TABLE IF NOT EXISTS cmds(id INTEGER PRIMARY KEY AUTOINCREMENT,player TEXT,cmd TEXT,created INTEGER)')
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
  const remotes=(await db.prepare('SELECT COUNT(*) AS n FROM remotes WHERE player=?').bind(me.id).first())?.n||0;
  return{me:{id:me.id,name:me.name,code:me.code},friends,guests,outgoing,returns,remotes};
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
    if(path==='/handy')return new Response(HANDY_HTML,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'}});

    // Handy-Fernbedienung: koppeln per Code, dann Status lesen und Befehle schicken
    if(path==='/pair/claim'){
      const code=clean(body.code,7).toUpperCase().replace(/[^A-Z0-9]/g,'');
      const p=await db.prepare('SELECT * FROM pairs WHERE code=?').bind(code).first();
      if(!p||p.expires<Date.now())return fail('Der Code ist falsch oder abgelaufen. Lass dir in der PC-App einen neuen zeigen.',404);
      const token=crypto.randomUUID().replace(/-/g,'')+crypto.randomUUID().replace(/-/g,'');
      await db.batch([db.prepare('DELETE FROM pairs WHERE code=?').bind(code),db.prepare('INSERT INTO remotes(token,player,created) VALUES(?,?,?)').bind(token,p.player,Date.now())]);
      return json({token});
    }
    if(path.startsWith('/r/')){
      const tok=(req.headers.get('Authorization')||'').replace('Remote ','');
      const r=tok&&await db.prepare('SELECT player FROM remotes WHERE token=?').bind(tok).first();
      if(!r)return fail('Dieses Handy ist nicht mehr gekoppelt.',401);
      if(path==='/r/cmd'){
        if(!REMOTE_CMDS.includes(body.cmd))return fail('Unbekannter Befehl.');
        const n=(await db.prepare('SELECT COUNT(*) AS n FROM cmds WHERE player=?').bind(r.player).first())?.n||0;
        if(n>=10)return fail('Es warten schon 10 Befehle. Ist die PC-App an?');
        await db.prepare('INSERT INTO cmds(player,cmd,created) VALUES(?,?,?)').bind(r.player,body.cmd,Date.now()).run();
      }
      const st=await db.prepare('SELECT data,sprite,updated FROM rstatus WHERE player=?').bind(r.player).first();
      const pending=(await db.prepare('SELECT COUNT(*) AS n FROM cmds WHERE player=?').bind(r.player).first())?.n||0;
      return json({status:st?JSON.parse(st.data):null,sprite:st?.sprite||null,updated:st?.updated||0,now:Date.now(),pending});
    }

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
      let cmds=[];
      if(body.remote){
        const d=JSON.stringify(body.remote.status||{}),sp=typeof body.remote.sprite==='string'&&body.remote.sprite.startsWith('data:image/')?body.remote.sprite:null;
        if(d.length>MAX_STATUS||(sp&&sp.length>MAX_SPRITE))return fail('Statusdaten zu groß.');
        await db.prepare('INSERT INTO rstatus(player,data,sprite,updated) VALUES(?,?,?,?) ON CONFLICT(player) DO UPDATE SET data=excluded.data,sprite=COALESCE(excluded.sprite,rstatus.sprite),updated=excluded.updated').bind(me.id,d,sp,Date.now()).run();
        cmds=(await db.prepare('SELECT id,cmd,created FROM cmds WHERE player=? ORDER BY id').bind(me.id).all()).results;
        if(cmds.length)await db.prepare('DELETE FROM cmds WHERE player=? AND id<=?').bind(me.id,cmds[cmds.length-1].id).run();
      }
      return json({...await state(db,{...me,name}),cmds});
    }
    if(path==='/pair/new'){
      let code='';for(const x of crypto.getRandomValues(new Uint8Array(6)))code+=CODE_CHARS[x%CODE_CHARS.length];
      await db.batch([db.prepare('DELETE FROM pairs WHERE player=? OR expires<?').bind(me.id,Date.now()),db.prepare('INSERT INTO pairs(code,player,expires) VALUES(?,?,?)').bind(code,me.id,Date.now()+6e5)]);
      return json({code,expires:Date.now()+6e5});
    }
    if(path==='/pair/reset'){
      await db.batch([db.prepare('DELETE FROM remotes WHERE player=?').bind(me.id),db.prepare('DELETE FROM cmds WHERE player=?').bind(me.id)]);
      return json(await state(db,me));
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
    if(path==='/raid'||path==='/raid/hit'||path==='/raid/claim'){
      const near=[-1,0,1].map(k=>monthId(new Date(Date.now()+k*432e5)));
      const month=near.includes(body.month)?body.month:monthId();
      if(path==='/raid/hit'){
        if(body.month!==month)return fail('Dieser Raid ist vorbei.');
        const st=await raidState(db,month,me.id);if(st.dmg>=st.hp)return fail('Der Raidboss ist schon besiegt.');
        const dmg=Math.min(Math.max(Math.round(+body.dmg||0),0),RAID_MAX_HIT);
        const r=await db.prepare('INSERT OR IGNORE INTO raidhits(month,player,day,dmg) VALUES(?,?,?,?)').bind(month,me.id,dayId(),dmg).run();
        if(!(r.meta?.changes??r.changes))return fail('Du hast heute schon gegen den Raidboss gekämpft.');
      }
      if(path==='/raid/claim'){
        const st=await raidState(db,month,me.id);
        if(st.dmg<st.hp)return fail('Der Raidboss ist noch nicht besiegt.');
        if(!st.fights)return fail('Du hast in diesem Raid nicht mitgekämpft.');
        const r=await db.prepare('INSERT OR IGNORE INTO raidclaims(month,player) VALUES(?,?)').bind(month,me.id).run();
        if(!(r.meta?.changes??r.changes))return fail('Beute schon abgeholt.');
      }
      return json(await raidState(db,month,me.id));
    }
    return fail('Unbekannte Adresse.',404);
  }
}

// ---------- Handy-Seite (automatisch aus handy.html eingefügt) ----------
const HANDY_HTML="<!doctype html>\n<html lang=\"de\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n<meta name=\"theme-color\" content=\"#120e18\">\n<meta name=\"apple-mobile-web-app-capable\" content=\"yes\">\n<meta name=\"mobile-web-app-capable\" content=\"yes\">\n<title>Pixelmonster Fernbedienung</title>\n<style>\n:root{--bg:#120e18;--panel:#1f1a28;--panel2:#2c2538;--text:#f3ecdf;--muted:#a99fb8;--accent:#e2b65c;--good:#5fd38a;--bad:#ff6b6b;--warn:#ffb347}\n*{box-sizing:border-box}\nbody{margin:0;background:radial-gradient(circle at 50% 0,#2a2036,var(--bg) 60%) fixed;background-color:var(--bg);color:var(--text);font:16px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;min-height:100vh;padding:16px 16px calc(24px + env(safe-area-inset-bottom))}\nmain{max-width:460px;margin:0 auto}\nh1{font:700 20px Georgia,serif;color:var(--accent);margin:4px 0 14px;text-align:center}\n.card{background:var(--panel);border:1px solid #3a3048;border-radius:16px;padding:14px;margin-bottom:12px}\n.muted{color:var(--muted);font-size:14px}\ninput{width:100%;padding:14px;border-radius:12px;border:1px solid #4a3e5c;background:var(--panel2);color:var(--text);font-size:22px;letter-spacing:4px;text-transform:uppercase;text-align:center}\nbutton{font:inherit;color:var(--text);background:var(--panel2);border:1px solid #4a3e5c;border-radius:14px;padding:12px;cursor:pointer;touch-action:manipulation}\nbutton:active{transform:scale(.97)}\nbutton.primary{background:linear-gradient(#e9c477,#b8945a);color:#1a1208;border:0;font-weight:700;width:100%;margin-top:10px}\nbutton:disabled{opacity:.45}\n.mon{display:flex;gap:12px;align-items:center}\n.mon img{width:120px;height:120px;flex:none;background:#17121f;border-radius:14px}\n.mon .t{font-weight:700;font-size:18px}\n.bar{margin:7px 0}\n.bar label{display:flex;justify-content:space-between;font-size:14px;color:var(--muted)}\n.track{height:10px;background:#120e18;border-radius:6px;overflow:hidden}\n.fill{height:100%;border-radius:6px;transition:width .4s}\n.acts{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}\n.acts button{display:flex;flex-direction:column;align-items:center;gap:2px;font-size:28px;padding:12px 4px}\n.acts span{font-size:13px;color:var(--muted)}\n.status{font-size:14px;margin-top:8px}\nul{list-style:none;margin:0;padding:0}\nli{font-size:14px;padding:6px 0;border-bottom:1px solid #2c2538}\nli time{color:var(--muted);margin-right:6px}\n.pill{display:inline-block;background:var(--panel2);border-radius:20px;padding:2px 9px;font-size:13px;margin:4px 4px 0 0}\n#toast{position:fixed;left:16px;right:16px;bottom:calc(20px + env(safe-area-inset-bottom));max-width:428px;margin:0 auto;background:#2c2538;border:1px solid var(--accent);border-radius:12px;padding:12px;text-align:center;opacity:0;transition:opacity .3s;pointer-events:none}\n#toast.on{opacity:1}\na{color:var(--accent)}\n</style>\n</head>\n<body>\n<main>\n<h1>📱 Pixelmonster</h1>\n<div id=\"app\"></div>\n</main>\n<div id=\"toast\"></div>\n<script>\nconst KEY='pixelmonster.remote';\nconst $=s=>document.querySelector(s);\nconst esc=s=>String(s??'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]));\nlet token=null,last=null,timer=null,toastT=null;\ntry{token=localStorage.getItem(KEY)}catch(e){}\nfunction toast(m){const t=$('#toast');t.textContent=m;t.classList.add('on');clearTimeout(toastT);toastT=setTimeout(()=>t.classList.remove('on'),2800)}\nasync function api(path,body){\n  let r;\n  try{r=await fetch(path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{Authorization:'Remote '+token}:{})},body:body?JSON.stringify(body):undefined})}\n  catch(e){throw Error('Keine Verbindung. Bist du online?')}\n  const d=await r.json().catch(()=>({error:'Ungültige Antwort vom Server.'}));\n  if(r.status===401&&token){unpairLocal();throw Error(d.error)}\n  if(!r.ok||d.error)throw Error(d.error||'Fehler '+r.status);\n  return d;\n}\nfunction unpairLocal(){token=null;try{localStorage.removeItem(KEY)}catch(e){}clearInterval(timer);renderPair()}\nfunction renderPair(){\n  $('#app').innerHTML=`<div class=\"card\"><p>Steuere dein Monster vom Handy aus.</p>\n    <ol class=\"muted\" style=\"padding-left:20px\"><li>Öffne am PC die Pixelmonster-App, Tab <b>🌐 Online</b>.</li><li>Tippe dort auf <b>📱 Handy koppeln</b>.</li><li>Gib den Code hier ein.</li></ol>\n    <input id=\"code\" maxlength=\"7\" autocomplete=\"off\" placeholder=\"ABC123\">\n    <button class=\"primary\" id=\"pairBtn\">Koppeln</button></div>\n    <p class=\"muted\" style=\"text-align:center\">Tipp: Über „Zum Startbildschirm hinzufügen“ im Browser-Menü wird daraus ein App-Symbol.</p>`;\n  $('#pairBtn').onclick=pair;$('#code').onkeydown=e=>{if(e.key==='Enter')pair()};\n}\nasync function pair(){\n  const code=$('#code').value.trim();if(!code)return;\n  try{const d=await api('/pair/claim',{code});token=d.token;try{localStorage.setItem(KEY,token)}catch(e){}toast('Gekoppelt!');start()}\n  catch(e){toast(e.message)}\n}\nconst ACTS=[['feed','🍙','Füttern'],['snack','🍓','Beere'],['play','⚽','Spielen'],['clean','🧽','Putzen'],['sleep','💤','Schlafen'],['med','💊','Medizin']];\nfunction ago(ms){const s=Math.round(ms/1000);return s<60?`vor ${s} s`:s<3600?`vor ${Math.round(s/60)} min`:s<86400?`vor ${Math.round(s/3600)} h`:`vor ${Math.round(s/86400)} Tagen`}\nfunction bar(lbl,v){v=Math.max(0,Math.min(100,v||0));const c=v>50?'var(--good)':v>20?'var(--warn)':'var(--bad)';return`<div class=\"bar\"><label>${lbl}<span>${Math.round(v)}</span></label><div class=\"track\"><div class=\"fill\" style=\"width:${v}%;background:${c}\"></div></div></div>`}\nfunction render(){\n  const d=last;if(!d)return;const s=d.status;\n  if(!s){$('#app').innerHTML=`<div class=\"card\"><p>Gekoppelt! Sobald die PC-App online ist, erscheint hier dein Monster.</p><p class=\"muted\">Die PC-App muss im Tab 🌐 Online verbunden sein.</p></div>${footer()}`;bindFooter();return}\n  const age=d.now-d.updated,live=age<45000;\n  const flags=[s.sick&&'🤒 krank',s.poop&&`💩 ×${s.poop}`,s.sleeping&&'💤 schläft',s.pension&&'🏨 in der Pension',s.quest&&'🧭 auf Quest',s.stage===0&&'🥚 noch ein Ei'].filter(Boolean);\n  $('#app').innerHTML=`<div class=\"card\"><div class=\"mon\">${d.sprite?`<img src=\"${d.sprite}\" alt=\"\">`:''}<div><div class=\"t\">${esc(s.name)}</div><div class=\"muted\">${esc(s.species)} · Lv ${s.level}</div>\n      <div>${flags.map(f=>`<span class=\"pill\">${f}</span>`).join('')}<span class=\"pill\">🍓 ${s.beere}</span></div></div></div>\n    <div class=\"status\">${live?`<span style=\"color:var(--good)\">● PC verbunden</span> <span class=\"muted\">· Stand ${ago(age)}</span>`:`<span style=\"color:var(--warn)\">⚠️ Die PC-App ist gerade nicht online</span> <span class=\"muted\">(zuletzt ${ago(age)}). Befehle warten, bis sie wieder läuft.</span>`}</div>\n    ${d.pending?`<div class=\"status muted\">⏳ ${d.pending} ${d.pending===1?'Befehl ist':'Befehle sind'} unterwegs …</div>`:''}</div>\n    <div class=\"card\">${bar('🍙 Sattheit',s.hunger)+bar('😊 Laune',s.mood)+bar('⚡ Energie',s.energy)+bar('🧽 Sauberkeit',s.clean)+bar('❤️ Gesundheit',s.health)}</div>\n    <div class=\"card acts\">${ACTS.map(([k,i,l])=>`<button data-cmd=\"${k}\">${k==='sleep'&&s.sleeping?'☀️':i}<span>${k==='sleep'&&s.sleeping?'Wecken':l}</span></button>`).join('')}</div>\n    <div class=\"card\"><div class=\"muted\" style=\"margin-bottom:4px\">Tagebuch</div><ul>${(s.log||[]).map(l=>`<li><time>${new Date(l.t).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'})}</time>${esc(l.m)}</li>`).join('')}</ul></div>${footer()}`;\n  document.querySelectorAll('[data-cmd]').forEach(b=>b.onclick=()=>send(b.dataset.cmd));bindFooter();\n}\nfunction footer(){return`<p style=\"text-align:center\"><a href=\"#\" id=\"unpair\">Handy entkoppeln</a></p>`}\nfunction bindFooter(){$('#unpair').onclick=e=>{e.preventDefault();if(confirm('Dieses Handy wirklich entkoppeln?'))unpairLocal()}}\nasync function send(cmd){\n  try{last=await api('/r/cmd',{cmd});render();toast(last.now-last.updated<45000?'Gesendet. Kommt in ein paar Sekunden an.':'Gesendet. Kommt an, sobald die PC-App läuft.')}\n  catch(e){toast(e.message)}\n}\nasync function poll(){try{last=await api('/r/status');render()}catch(e){if(token)toast(e.message)}}\nfunction start(){$('#app').innerHTML='<div class=\"card muted\">Lade …</div>';poll();clearInterval(timer);timer=setInterval(()=>{if(!document.hidden)poll()},5000)}\ndocument.addEventListener('visibilitychange',()=>{if(!document.hidden&&token)poll()});\ntoken?start():renderPair();\n</script>\n</body>\n</html>\n";
