#!/usr/bin/env node
'use strict';
/**
 * Define a senha de um usuário direto no servidor (para quando ninguém consegue entrar no painel).
 *
 *   sudo zoe-senha                      → usuário master do .env (ATEND_ADMIN_EMAIL)
 *   sudo zoe-senha pessoa@empresa.com   → outro usuário
 *
 * Pede a senha nova duas vezes, sem mostrar na tela. Para usar em script: echo "senha" | zoe-senha --stdin
 */
const readline = require('node:readline');
const config = require('../server/config');
const { abrir, agora, auditar } = require('../server/db');
const { hashSenha } = require('../server/lib/senha');

function perguntarEscondido(texto) {
  return new Promise((ok) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.startsWith(texto)) rl.output.write(texto); else if (s.includes('\n')) rl.output.write('\n'); };
    rl.question(texto, (r) => { rl.close(); ok(r); });
  });
}

async function lerStdin() {
  let t = '';
  for await (const parte of process.stdin) t += parte;
  return t.split('\n')[0];
}

async function principal() {
  const args = process.argv.slice(2);
  const email = (args.find((a) => !a.startsWith('--')) || config.admin.email || '').trim().toLowerCase();
  const db = abrir();
  const u = db.prepare('SELECT id, nome, email, perfil, ativo FROM usuarios WHERE email = ? COLLATE NOCASE').get(email);
  if (!u) {
    console.error(`Não existe usuário com o e-mail ${email}.`);
    const masters = db.prepare("SELECT email FROM usuarios WHERE perfil = 'master'").all().map((x) => x.email);
    if (masters.length) console.error(`Usuário(s) master: ${masters.join(', ')}`);
    process.exit(1);
  }
  let senha;
  if (args.includes('--stdin')) senha = await lerStdin();
  else {
    console.log(`Nova senha para ${u.nome} <${u.email}> (${u.perfil}). Mínimo 8 caracteres.`);
    senha = await perguntarEscondido('Senha nova: ');
    const repetida = await perguntarEscondido('Repita a senha: ');
    if (senha !== repetida) { console.error('As duas não conferem. Nada foi alterado.'); process.exit(1); }
  }
  if (!senha || senha.length < 8) { console.error('A senha precisa ter pelo menos 8 caracteres. Nada foi alterado.'); process.exit(1); }
  db.prepare('UPDATE usuarios SET senha_hash = ?, ativo = 1 WHERE id = ?').run(hashSenha(senha), u.id);
  try { auditar(db, { usuario: u, acao: 'senha definida no servidor (zoe-senha)', ip: 'servidor' }); } catch { /* registro opcional */ }
  console.log(`Senha de ${u.email} alterada em ${agora()}. Já pode entrar no painel.`);
}

principal().catch((err) => { console.error(err.message); process.exit(1); });
