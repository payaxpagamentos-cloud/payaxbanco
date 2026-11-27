import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
let count=0;
function check(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){if(entry.isDirectory())check(resolve(dir,entry.name));else if(/\.(mjs|js)$/.test(entry.name)){const result=spawnSync(process.execPath,['--check',resolve(dir,entry.name)],{encoding:'utf8'});if(result.status!==0){console.error(result.stderr);process.exit(1);}count++;}}}
for(const dir of ['server','public','scripts','tests'])check(resolve(dir));
console.log(`${count} arquivos JavaScript verificados.`);
