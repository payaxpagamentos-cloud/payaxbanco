import { backup } from 'node:sqlite';
import { mkdir, cp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openStore } from '../server/store.mjs';
const store=openStore();
try{
 const name='lk-tech-'+new Date().toISOString().replace(/[:.]/g,'-');
 const destination=resolve(process.env.BACKUP_DIR||'backups',name);await mkdir(destination,{recursive:true,mode:0o700});
 await backup(store.db,resolve(destination,'site.sqlite'));
 await cp(resolve(store.directory,'uploads'),resolve(destination,'uploads'),{recursive:true});
 console.log('Backup criado em '+destination);
}finally{store.db.close();}
