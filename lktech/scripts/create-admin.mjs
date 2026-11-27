import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { openStore } from '../server/store.mjs';
import { hashPassword } from '../server/auth.mjs';
let muted=false;
const output=new Writable({write(chunk,encoding,callback){if(!muted)process.stdout.write(chunk,encoding);callback();}});
output.isTTY=process.stdout.isTTY;
const rl=createInterface({input:process.stdin,output,terminal:Boolean(process.stdin.isTTY)});
try{
  const emailIndex=process.argv.indexOf('--email');
  const email=String(emailIndex>=0?process.argv[emailIndex+1]:await rl.question('E-mail do administrador: ')).trim().toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>160)throw new Error('Informe um e-mail válido.');
  let password=process.env.LK_ADMIN_PASSWORD;
  if(!password){if(!process.stdin.isTTY)throw new Error('Use um terminal interativo ou LK_ADMIN_PASSWORD para definir a senha.');const answer=rl.question('Senha (mínimo de 12 caracteres; entrada oculta): ');muted=true;password=await answer;muted=false;process.stdout.write('\n');}
  if(password.length<12||password.length>512)throw new Error('Use uma senha entre 12 e 512 caracteres.');
  const store=openStore();
  try{
    const existing=store.db.prepare('SELECT id FROM admins WHERE email=?').get(email);
    const reset=process.argv.includes('--reset');
    if(existing&&!reset)throw new Error('Esta conta já existe. Para redefinir, execute com --reset.');
    const hash=await hashPassword(password);
    if(existing){store.transaction(()=>{store.db.prepare('UPDATE admins SET password_hash=? WHERE id=?').run(hash,existing.id);store.db.prepare('DELETE FROM sessions WHERE admin_id=?').run(existing.id);});}
    else store.db.prepare('INSERT INTO admins(email,password_hash,created_at) VALUES(?,?,?)').run(email,hash,new Date().toISOString());
    console.log(existing?'Senha redefinida. Sessões anteriores encerradas.':'Administrador criado. Acesse /admin para entrar.');
  }finally{store.db.close();}
}catch(e){muted=false;console.error(e.message);process.exitCode=1;}finally{rl.close();}
