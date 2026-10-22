const {app,BrowserWindow,Menu,ipcMain,screen,shell}=require('electron');
const crypto=require('crypto');
const path=require('path');
const fs=require('fs');

// Fenster-Einstellungen (Mini-Ansicht und ihre Position) bleiben über Neustarts erhalten
const settingsFile=path.join(app.getPath('userData'),'fenster.json');
let settings={mini:false,miniPos:null};
try{settings={...settings,...JSON.parse(fs.readFileSync(settingsFile,'utf8'))}}catch(e){}
const saveSettings=()=>{try{fs.writeFileSync(settingsFile,JSON.stringify(settings))}catch(e){}};

const MINI={width:200,height:282};

// ---------- Updates ----------
// Das Spiel selbst steckt komplett in pixelmonster.html. Neue Versionen davon werden aus dem Internet geladen
// und im Benutzerordner gespeichert, sodass niemand die App neu herunterladen muss.
const PKG=require('./package.json');
const UPDATE_URL=(process.env.PXM_UPDATE_URL||PKG.updateUrl||'').replace(/\/?$/,'/');
const gameDir=path.join(app.getPath('userData'),'spiel');
const newer=(a,b)=>{const x=String(a).split('.').map(Number),y=String(b).split('.').map(Number);for(let i=0;i<3;i++)if((x[i]||0)!==(y[i]||0))return(x[i]||0)>(y[i]||0);return false};
function currentGame(){
  try{const info=JSON.parse(fs.readFileSync(path.join(gameDir,'version.json'),'utf8')),file=path.join(gameDir,'pixelmonster.html');
    if(newer(info.version,PKG.version)&&fs.existsSync(file))return{version:info.version,file}}catch(e){}
  return{version:PKG.version,file:path.join(__dirname,'pixelmonster.html')};
}
let pending=null,loadedVersion=PKG.version;
async function checkUpdate(){
  if(!/^(https:\/\/|http:\/\/localhost)/.test(UPDATE_URL))return;
  try{
    const get=async(f,ms)=>{const r=await fetch(UPDATE_URL+f+'?t='+Date.now(),{signal:AbortSignal.timeout(ms),cache:'no-store'});if(!r.ok)throw new Error(r.status);return r};
    const info=await (await get('version.json',8000)).json();
    if(!newer(info.version,currentGame().version))return;
    if(info.minApp&&newer(info.minApp,PKG.version)){pending={...info,needApp:true};return notify()}
    const html=Buffer.from(await (await get('pixelmonster.html',30000)).arrayBuffer());
    if(info.sha256&&crypto.createHash('sha256').update(html).digest('hex')!==info.sha256)throw new Error('Prüfsumme falsch');
    fs.mkdirSync(gameDir,{recursive:true});
    fs.writeFileSync(path.join(gameDir,'pixelmonster.html.neu'),html);fs.renameSync(path.join(gameDir,'pixelmonster.html.neu'),path.join(gameDir,'pixelmonster.html'));
    fs.writeFileSync(path.join(gameDir,'version.json'),JSON.stringify(info));
    pending=info;notify();
  }catch(e){console.log('Update-Prüfung fehlgeschlagen:',e.message)}
}
function notify(){if(pending&&win&&!win.isDestroyed())win.webContents.send('update',pending)}
let win=null;

function createWindow(){
  const common={title:'Pixelmonster',webPreferences:{preload:path.join(__dirname,'preload.js')}};
  if(settings.mini){
    const wa=screen.getPrimaryDisplay().workArea;
    let [x,y]=settings.miniPos||[wa.x+wa.width-MINI.width-16,wa.y+wa.height-MINI.height-16];
    if(!screen.getAllDisplays().some(d=>x>=d.workArea.x-50&&x<d.workArea.x+d.workArea.width&&y>=d.workArea.y-50&&y<d.workArea.y+d.workArea.height)){x=wa.x+wa.width-MINI.width-16;y=wa.y+wa.height-MINI.height-16}
    win=new BrowserWindow({...common,...MINI,x,y,frame:false,transparent:true,resizable:false,maximizable:false,alwaysOnTop:true,hasShadow:false});
    win.on('moved',()=>{settings.miniPos=win.getPosition();saveSettings()});
  }else{
    win=new BrowserWindow({...common,width:1080,height:900,minWidth:420,minHeight:600,backgroundColor:'#1d1b2e',autoHideMenuBar:true});
  }
  const g=currentGame();loadedVersion=g.version;win.loadFile(g.file,settings.mini?{query:{mini:'1'}}:{});
  win.webContents.on('did-finish-load',notify);
}

ipcMain.on('mini',(e,on)=>{
  if(!!on===settings.mini)return;
  settings.mini=!!on;saveSettings();
  const old=win;createWindow();old.destroy();
});

ipcMain.on('reload-game',()=>{pending=null;const old=win;createWindow();old.destroy()});
ipcMain.on('open-link',(e,url)=>{if(/^https:\/\//.test(url))shell.openExternal(url)});
ipcMain.handle('version',()=>loadedVersion);

Menu.setApplicationMenu(null);
app.whenReady().then(()=>{createWindow();checkUpdate();setInterval(checkUpdate,3*3600e3)});
app.on('window-all-closed',()=>app.quit());
