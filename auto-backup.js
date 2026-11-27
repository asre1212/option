/* Files-folder-only automatic backups. App adapters explicitly select saved data. */
(function (g) {
  "use strict";
  const format = 'local-auto-backup', version = 1;
  const copy = JSON.stringify;
  function create({id,name,read,validate,apply,serialize,parse,canRestore}) {
    if (!/^[a-z0-9-]+$/.test(id) || [read,validate,apply].some(x=>typeof x!=='function')) throw new Error('Invalid Auto Backup adapter');
    const key='auto-backup-files-v2:'+id;
    const legacyKey='auto-backup-v1:'+id;
    const state=()=>{
      const raw=localStorage.getItem(key);
      if(!raw)return {folder:null,folderToken:null};
      const value=JSON.parse(raw);
      if(value.folder&&!/^[a-z0-9-]{8,80}$/i.test(value.folderToken||''))throw new Error('Unreadable backup folder settings.');
      return value;
    };
    // Connection metadata only. No backup payload is ever written to app or browser storage.
    const persist=s=>localStorage.setItem(key,JSON.stringify({folder:s.folder?{name:s.folder.name}:null,folderToken:s.folderToken||null}));
    const unpack=item=>{
      if(!item||item.format!==format||item.version!==version||item.app!==id||typeof item.savedAt!=='string'||!Number.isSafeInteger(item.seq))throw new Error('That file is not an Auto Backup for '+name+'.');
      return validate(item.data);
    };
    let panel, issue='', external='', busy=Promise.resolve(), folderCopies=[], generation=0;
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
    const slotName=(cfg,i)=>id+'-auto-backup-'+cfg.folderToken+'-'+i+'.json';
    async function handleFor(prompt){
      const handle=await useHandle('readonly',db=>db.get(id));
      if(!handle)throw new Error('Choose the backup folder again.');
      const mode={mode:'readwrite'};
      let permission=await handle.queryPermission(mode);
      if(permission!=='granted'&&prompt)permission=await handle.requestPermission(mode);
      if(permission!=='granted')throw new Error('Reconnect the folder to resume automatic backups.');
      return handle;
    }
    async function readSlot(handle,cfg,i){
      try {
        const file=await handle.getFileHandle(slotName(cfg,i)), text=await (await file.getFile()).text();
        // Empty file can result from an interrupted first creation. Do not blindly overwrite it.
        if(!text)throw new Error('An empty backup slot needs inspection. Choose a different folder or remove the empty file in Files.');
        const item=JSON.parse(text);
        if(item.folderToken!==cfg.folderToken)throw new Error('A file name is in use. Choose a different folder.');
        unpack(item);
        return {i,file,item};
      }catch(e){if(e.name==='NotFoundError')return {i,file:null,item:null};throw e;}
    }
    async function sync(cfg,encoded,prompt,gen){
      if(gen!==generation)return;
      const handle=await handleFor(prompt);
      const slots=await Promise.all([readSlot(handle,cfg,1),readSlot(handle,cfg,2)]);
      if(gen!==generation)return;
      const ranked=slots.filter(s=>s.item).sort((a,b)=>b.item.seq-a.item.seq);
      folderCopies=ranked.map(s=>s.item);
      if(encoded===null||ranked[0]&&copy(ranked[0].item.data)===encoded){
        external=folderCopies.length?'Files folder connected.':'Folder connected; no backups have been saved yet.';
        return;
      }
      const seq=(ranked[0]?.item.seq||0)+1;
      if(!Number.isSafeInteger(seq))throw new Error('Invalid backup sequence.');
      const item={format,version,app:id,savedAt:new Date().toISOString(),seq,data:JSON.parse(encoded),folderToken:cfg.folderToken};
      const target=slots.find(s=>!s.item)||ranked.at(-1);
      const file=target.file||await handle.getFileHandle(slotName(cfg,target.i),{create:true});
      const body=copy(item), writer=await file.createWritable();
      try{await writer.write(body);await writer.close();}
      catch(e){try{await writer.abort();}catch{}throw e;}
      if(await (await file.getFile()).text()!==body)throw new Error('The Files backup did not verify.');
      folderCopies=[item,...ranked.filter(s=>s.i!==target.i).map(s=>s.item)].slice(0,2);
      external='Latest backup saved to the selected folder.';
    }
    function queued(cfg,encoded,prompt){
      const gen=generation;
      busy=busy.then(()=>sync(cfg,encoded,prompt,gen)).catch(e=>{external=e.message||'Could not save to the folder.';}).finally(update);
      return busy;
    }
    function capture(value){
      try{
        if(!supportsFolder)return false;
        const cfg=state();
        if(!cfg.folder)return false;
        const encoded=copy(validate(value===undefined?read():value));
        if(typeof encoded!=='string')throw new Error('Invalid backup data.');
        queued(cfg,encoded,false);return true;
      }catch(e){issue=e.message||'Could not prepare backup.';update();return false;}
    }
    function legacyState(){
      try{return JSON.parse(localStorage.getItem(legacyKey)||'null');}catch{return null;}
    }
    function migrateFolder(){
      if(!supportsFolder||localStorage.getItem(key))return;
      const old=legacyState(),token=old?.folder?.token;
      if(old?.enabled&&old.folder?.name&&/^[a-z0-9-]{8,80}$/i.test(token||'')){
        persist({folder:{name:old.folder.name},folderToken:token});
      }
    }
    async function connect(){
      try{
        if(!supportsFolder)return;
        const handle=await g.showDirectoryPicker({id:id+'-backup',mode:'readwrite'});
        await busy;
        const cfg=state();
        const oldToken=legacyState()?.folder?.token;
        const token=cfg.folderToken||(/^[a-z0-9-]{8,80}$/i.test(oldToken||'')?oldToken:null)||(g.crypto?.randomUUID?.()||Date.now().toString(36)+Math.random().toString(36).slice(2)).replace(/[^a-z0-9-]/gi,'');
        await useHandle('readwrite',db=>db.put(handle,id));
        generation++;folderCopies=[];issue='';
        persist({folder:{name:handle.name},folderToken:token});
        external='Folder selected.';capture();update();
      }catch(e){if(e.name!=='AbortError'){external=e.message||'Folder selection failed.';update();}}
    }
    async function reconnect(){
      try{const cfg=state();if(cfg.folder)await queued(cfg,null,true);}catch(e){external=e.message||'Unable to reconnect.';}update();
    }
    function disconnect(){
      try{const cfg=state();generation++;folderCopies=[];persist({...cfg,folder:null});external='Folder disconnected; existing files were not changed.';update();}
      catch(e){external=e.message;update();}
    }
    function legacyCopies(){
      try{
        const s=legacyState();
        return Array.isArray(s?.slots)?s.slots.slice(0,2).filter(item=>{try{unpack(item);return true;}catch{return false;}}):[];
      }catch{return [];}
    }
    async function restore(item) {
      try{
        const data=unpack(item);
        if(canRestore&&!(await canRestore()))throw new Error('Finish what you are doing before restoring a backup.');
        if(!g.confirm('Restore '+name+' from this copy? It will replace the data this backup covers.'))return;
        const ok=await apply(data);
        if(ok===false)throw new Error('Restore did not complete successfully.');
        capture(data);
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
        const helper=paragraph('Auto Backup writes only to the folder you select. It keeps two verified copies there and does not create app or browser backup copies.');
        const status=paragraph(issue||external||'');status.setAttribute('role','status');
        panel.replaceChildren(h,helper);
        if(supportsFolder){
          panel.append(paragraph(s.folder?'Selected folder: '+s.folder.name:'Choose a writable folder to turn on Auto Backup.'));
          if(!s.folder)panel.append(button('Choose folder',connect));
          else panel.append(button('Reconnect folder',reconnect),button('Disconnect folder',disconnect),button('Choose another folder',connect));
        }else panel.append(paragraph('This browser does not support automatic writes to a chosen Files folder. You can still save a copy manually.'));
        function showCopy(item,title){
          const area=document.createElement('section');
          area.append(paragraph(title+' · '+new Date(item.savedAt).toLocaleString()),
            button('Restore '+title.toLowerCase(),()=>restore(item)),
            button('Save a copy',()=>{try{saveFile(item);}catch(e){issue=e.message;update();}}));
          panel.append(area);
        }
        for(const [i,item] of folderCopies.entries())showCopy(item,i===0?'Most recent':'Previous');
        const legacy=legacyCopies();
        if(legacy.length){
          panel.append(paragraph('Existing recovery copies from an older release are unchanged. No new copies are saved in the app.'));
          for(const [i,item] of legacy.entries())showCopy(item,i===0?'Older app recovery copy':'Second older app recovery copy');
        }
        panel.append(button('Save current copy manually',()=>{try{
          const data=validate(read());
          saveFile({format,version,app:id,savedAt:new Date().toISOString(),seq:0,data});
        }catch(e){issue=e.message;update();}}));
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
      try{migrateFolder();}catch{}
      update();
      try{const cfg=state();if(supportsFolder&&cfg.folder)queued(cfg,null,false);}catch{}
      panel.querySelector('button')?.focus();
    }
    function mount(holder){if(holder)holder.append(button('Auto Backup',open));}
    return Object.freeze({capture,open,mount});
  }
  g.AutoBackup=Object.freeze({create});
})(globalThis);
