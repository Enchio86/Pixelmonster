const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('pxm',{
  setMini:on=>ipcRenderer.send('mini',on),
  onUpdate:cb=>ipcRenderer.on('update',(e,info)=>cb(info)),
  reloadGame:()=>ipcRenderer.send('reload-game'),
  openLink:url=>ipcRenderer.send('open-link',url),
  version:()=>ipcRenderer.invoke('version')
});
