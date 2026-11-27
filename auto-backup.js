/* Local, opt-in two-copy recovery. App adapters explicitly select saved data. */
(function (g) {
  "use strict";
  const format = 'local-auto-backup', version = 1;
  const copy = JSON.stringify;
  function create({id,name,read,validate,apply,serialize,parse,canRestore}) {
    if (!/^[a-z0-9-]+$/.test(id) || [read,validate,apply].some(x=>typeof x!=='function')) throw new Error('Invalid Auto Backup adapter');
    const key='auto-backup-v1:'+id;
    const blank=()=>({enabled:false,slots:[],seq:0,folder:null,folderToken:null});
    const state=()=>{
      const raw=localStorage.getItem(key);
      if(!raw)return blank();
      const s=JSON.parse(raw);
      if(typeof s.enabled!=='boolean'||!Array.isArray(s.slots)||s.slots.length>2||!Number.isSafeInteger(s.seq)||s.seq<0)throw new Error('Unreadable Auto Backup metadata.');
      return s;
    };
    const persist=s=>localStorage.setItem(key,copy(s));
    const unpack=item=>{
      if(!item||item.format!==format||item.version!==version||item.app!==id||typeof item.savedAt!=='string'||!Number.isSafeInteger(item.seq))throw new Error('That file is not an Auto Backup for '+name+'.');
      return validate(item.data);
    };
    let panel, issue='', external='', busy=Promise.resolve();
    const supportsFolder=typeof g.showDirectoryPicker==='function' && !!g.indexedDB;
    function useHandle(mode,action) {
      return new Promise((resolve,reject)=>{
        const req=indexedDB.open('local-auto-backup-handles-v1',1);
        req.onupgradeneeded=()=>req.result.createObjectStore('handles');
        req.onerror=()=>reject(req.error);
        req.onsuccess=()=>{
          const db=req.result;
          try {
            const tx=db.transaction('handles',mode);
            const op=action(tx.objectStore('handles'));
            tx.oncomplete=()=>{db.close();resolve(op.result);};
            tx.onabort=tx.onerror=()=>{db.close();reject(tx.error||op.error);};
          }catch(e){db.close();reject(e);}
        };
      });
    }
    async function syncFolder(s,allowPrompt) {
      if(!supportsFolder||!s.folder||!s.slots.length)return;
      const handle=await useHandle('readonly',db=>db.get(id));
      if(!handle)throw new Error('Reconnect the backup folder.');
      const mode={mode:'readwrite'};
      let permission=await handle.queryPermission(mode);
      if(permission!=='granted'&&allowPrompt)permission=await handle.requestPermission(mode);
      if(permission!=='granted')throw new Error('Reconnect the backup folder to resume Files copies.');
      // Previous first. The opposite slot remains intact while one slot is replaced.
      for(const entry of s.slots.slice().reverse()){
        const basename=id+'-auto-backup-'+s.folder.token+'-'+(entry.seq%2+1)+'.json';
        let file;
        try{
          file=await handle.getFileHandle(basename);
          const content=await (await file.getFile()).text();
          if(content){
            const old=JSON.parse(content);
            if(old.folderToken!==s.folder.token||old.app!==id||old.format!==format)throw new Error('A file name is in use. Choose another backup folder.');
            if(old.seq>=entry.seq)continue;
          }
        }catch(e){if(e.name!=='NotFoundError')throw e;file=await handle.getFileHandle(basename,{create:true});}
        const body=copy({...entry,folderToken:s.folder.token});
        const writer=await file.createWritable();
        try{await writer.write(body);await writer.close();}
        catch(e){try{await writer.abort();}catch{}throw e;}
        if(await (await file.getFile()).text()!==body)throw new Error('The Files copy did not verify.');
      }
      external='Files folder copy verified.';
    }
    function queue(s){
      if(!supportsFolder||!s.folder)return;
      busy=busy.then(()=>syncFolder(s,false)).catch(e=>{external=e.message||'Could not save to the folder.';}).finally(update);
    }
    function capture(value){
      try{
        const s=state();
        if(!s.enabled)return false;
        const data=validate(value===undefined?read():value);
        if(copy(data)===copy(s.slots[0]?.data)){issue='';return false;}
        const seq=s.seq+1;
        const item={format,version,app:id,savedAt:new Date().toISOString(),seq,data};
        const next={...s,seq,slots:[item,...s.slots].slice(0,2)};
        persist(next);issue='';queue(next);update();return true;
      }catch(e){issue='Auto Backup could not save. Your previous recovery copies were not replaced.';update();return false;}
    }
    function enable(){
      const s=state();
      persist({...s,enabled:true});
      if(!capture()&&issue)throw new Error(issue);
      update();
    }
    function toggle(){
      try{
        const s=state();
        if(s.enabled)persist({...s,enabled:false});
        else enable();
        issue=''; update();
      }catch(e){issue=e.message||'Auto Backup setup failed.';update();}
    }
    async function connect(){
      try{
        if(!supportsFolder)return;
        const handle=await g.showDirectoryPicker({id:id+'-backup',mode:'readwrite'});
        await busy;
        const s=state();
        await useHandle('readwrite',db=>db.put(handle,id));
        const token=s.folderToken||s.folder?.token||(g.crypto?.randomUUID?.()||Date.now().toString(36)+Math.random().toString(36).slice(2)).replace(/[^a-z0-9-]/gi,'');
        persist({...s,folderToken:token,folder:{name:handle.name,token}});
        if(!s.enabled)enable();
        external='Folder selected.';queue(state());update();
      }catch(e){if(e.name!=='AbortError'){external=e.message||'Folder selection failed.';update();}}
    }
    async function reconnect(){
      try{await busy;await syncFolder(state(),true);}catch(e){external=e.message||'Unable to reconnect.';}update();
    }
    async function restore(item) {
      try{
        const data=unpack(item);
        if(canRestore&&!(await canRestore()))throw new Error('Finish what you are doing before restoring a backup.');
        if(!g.confirm('Restore '+name+' from this copy? It will replace the data this backup covers.'))return;
        if(state().enabled&&!capture()&&issue&&issue.startsWith('Auto Backup could not save'))throw new Error('Could not keep a copy of your current data. Nothing was restored.');
        const ok=await apply(data);
        if(ok===false)throw new Error('Restore did not complete successfully.');
        if(state().enabled)capture(data);
        issue='Backup restored.';update();
      }catch(e){issue=e.message||'Unable to restore this copy.';update();}
    }
    function saveFile(item) {
      const file=new File([serialize?serialize(unpack(item),item):copy(item)],id+'-backup-'+item.savedAt.replace(/[:.]/g,'-')+'.json',{type:'application/json'});
      if(g.navigator.canShare?.({files:[file]})){
        g.navigator.share({files:[file],title:name+' backup'}).catch(e=>{if(e.name!=='AbortError'){issue='Could not share this file.';update();}});
      }else{
        const uri=URL.createObjectURL(file), a=document.createElement('a');
        a.href=uri;a.download=file.name;a.hidden=true;document.body.append(a);a.click();a.remove();
        setTimeout(()=>URL.revokeObjectURL(uri),1000);
      }
    }
    function button(label,fn) { const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=fn;b.style.cssText='border:1px solid #7b858e;border-radius:.4rem;padding:.5rem .7rem;margin:.15rem;background:ButtonFace;color:ButtonText;font:inherit;min-height:2.75rem';return b; }
    function paragraph(value) { const el=document.createElement('p');el.textContent=value;el.style.margin='.55rem 0';return el; }
    function update(){
      if(!panel?.open)return;
      const focus=document.activeElement, label=focus?.textContent;
      try{
        const s=state(),h=document.createElement('h2');h.id=key+'-heading';h.textContent='Auto Backup';
        const helper=paragraph('Keeps the latest two distinct saved copies. On-device copies may be lost if you remove the app or clear its storage. Use Save a copy to keep a separate file.');
        const status=paragraph(issue||external||'');status.setAttribute('role','status');
        panel.replaceChildren(h,helper,button(s.enabled?'Pause Auto Backup':'Turn on Auto Backup',toggle));
        if(supportsFolder){
          panel.append(paragraph(s.folder?'Selected folder: '+s.folder.name:'Choose a writable folder for automatic external copies.'));
          if(!s.folder)panel.append(button('Choose folder',connect));
          else panel.append(button('Reconnect folder',reconnect),button('Disconnect folder',()=>{
            try{const v=state();persist({...v,folder:null});external='Folder disconnected; previous files were not changed.';update();}
            catch(e){external=e.message;update();}
          }),button('Choose another folder',connect));
        }else panel.append(paragraph('This browser cannot automatically write to an external Files folder. Saving a copy is a manual step.'));
        for(const [i,item] of s.slots.entries()){
          const area=document.createElement('section');
          area.append(paragraph((i===0?'Most recent':'Previous')+' · '+new Date(item.savedAt).toLocaleString()),
            button('Restore '+(i===0?'most recent':'previous'),()=>restore(item)),
            button('Save a copy',()=>{try{saveFile(item);}catch(e){issue=e.message;update();}}));
          panel.append(area);
        }
        const input=document.createElement('input');input.type='file';input.accept='.json,application/json';input.hidden=true;
        input.onchange=async ()=>{try{
          if(!input.files?.length)return;
          const file=input.files[0];
          if(file.size>24*1024*1024)throw new Error('This backup is too large to import here.');
          const text=await file.text();
          let item=JSON.parse(text);
          if(item?.format!==format&&parse)item={format,version,app:id,seq:0,savedAt:new Date().toISOString(),data:parse(text)};
          await restore(item);
        }catch(e){issue=e.message;update();}};
        panel.append(input,button('Restore from file',()=>input.click()),button('Close',()=>panel.close()),status);
      }catch(e){panel.replaceChildren(paragraph(e.message||'Could not read Auto Backup.'),button('Close',()=>panel.close()));}
      if(label&&focus?.tagName==='BUTTON')[...panel.querySelectorAll('button')].find(b=>b.textContent===label)?.focus();
    }
    function open(){
      if(!panel){
        panel=document.createElement('dialog');panel.setAttribute('aria-labelledby',key+'-heading');
        panel.style.cssText='box-sizing:border-box;font:16px/1.4 system-ui;width:min(28rem,calc(100% - 2rem));max-height:85vh;overflow:auto;padding:1rem;background:Canvas;color:CanvasText;border:1px solid #7b858e;border-radius:.65rem';
        document.body.append(panel);
      }
      if(!panel.open)panel.showModal();
      update();
      panel.querySelector('button')?.focus();
    }
    function mount(holder){if(holder)holder.append(button('Auto Backup',open));}
    return Object.freeze({capture,open,mount});
  }
  g.AutoBackup=Object.freeze({create});
})(globalThis);
