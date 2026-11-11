'use strict';
/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/

// Atualização pelo painel (só master): recebe o .zip da nova versão, faz backup e aplica SÓ "server/" e "public/".
// Nunca toca em .env, data/ (banco) nem node_modules. Por segurança, mesmo que enviem o pacote completo, só o código é aplicado.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ErroNegocio } = require('./erros');

const RAIZ = path.join(__dirname, '..', '..'); // pasta da instalação (rastreador/)
const DIR_BACKUP = path.join(RAIZ, 'data', 'atualizacoes');
const MANTER_BACKUPS = 3;

function versaoAtual() {
  try { return JSON.parse(fs.readFileSync(path.join(RAIZ, 'server', 'versao.json'), 'utf8')).versao; } catch { return null; }
}
function backupsExistentes() {
  try { return fs.readdirSync(DIR_BACKUP).filter((n) => n.startsWith('backup-')).sort().reverse(); } catch { return []; }
}
function estado() {
  return { versao: versaoAtual(), node: process.versions.node, backups: backupsExistentes() };
}

function limparBackupsAntigos() {
  const lista = backupsExistentes();
  for (const antigo of lista.slice(MANTER_BACKUPS)) {
    try { fs.rmSync(path.join(DIR_BACKUP, antigo), { recursive: true, force: true }); } catch { /* ignora */ }
  }
}

/** Aplica o pacote (zip com rastreador/server e rastreador/public). Faz backup antes. Devolve { versao, anterior }. */
function aplicar(bufferZip) {
  if (!Buffer.isBuffer(bufferZip) || bufferZip.length < 500) throw new ErroNegocio('Arquivo de atualização vazio ou inválido.', 400);
  if (!(bufferZip[0] === 0x50 && bufferZip[1] === 0x4B)) throw new ErroNegocio('O arquivo enviado não é um .zip de atualização.', 400);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rastr-atualiz-'));
  try {
    const zipPath = path.join(tmp, 'pacote.zip');
    fs.writeFileSync(zipPath, bufferZip);
    try { execFileSync('unzip', ['-q', '-o', zipPath, '-d', tmp], { stdio: 'pipe' }); }
    catch { throw new ErroNegocio('Não consegui abrir o .zip (arquivo corrompido). Baixe de novo e tente outra vez.', 400); }

    // O pacote traz uma pasta "rastreador/" dentro; se vier sem ela, usa a raiz do tmp.
    const base = fs.existsSync(path.join(tmp, 'rastreador', 'server')) ? path.join(tmp, 'rastreador') : tmp;
    for (const req of ['server/index.js', 'server/versao.json', 'public']) {
      if (!fs.existsSync(path.join(base, req))) {
        throw new ErroNegocio('Este .zip não é um pacote de atualização do Rastreador (faltam arquivos do sistema). Envie o arquivo de atualização correto.', 400);
      }
    }
    let novaVersao;
    try { novaVersao = JSON.parse(fs.readFileSync(path.join(base, 'server', 'versao.json'), 'utf8')).versao; }
    catch { throw new ErroNegocio('O pacote não tem a versão (versao.json). Envie o arquivo de atualização correto.', 400); }

    const anterior = versaoAtual();
    // Backup do código atual (só server/ e public/), para poder reverter.
    fs.mkdirSync(DIR_BACKUP, { recursive: true });
    const bkp = path.join(DIR_BACKUP, `backup-${anterior || 'inicial'}-${Date.now()}`);
    fs.mkdirSync(bkp, { recursive: true });
    fs.cpSync(path.join(RAIZ, 'server'), path.join(bkp, 'server'), { recursive: true });
    fs.cpSync(path.join(RAIZ, 'public'), path.join(bkp, 'public'), { recursive: true });

    // Aplica SÓ server/ e public/ (nunca .env, data/ ou node_modules).
    fs.cpSync(path.join(base, 'server'), path.join(RAIZ, 'server'), { recursive: true });
    fs.cpSync(path.join(base, 'public'), path.join(RAIZ, 'public'), { recursive: true });

    limparBackupsAntigos();
    return { versao: novaVersao, anterior };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Restaura o backup mais recente (server/ e public/). Devolve { versao }. */
function reverter() {
  const lista = backupsExistentes();
  if (!lista.length) throw new ErroNegocio('Não há backup guardado para reverter.', 400);
  const de = versaoAtual();
  const bkp = path.join(DIR_BACKUP, lista[0]);
  fs.cpSync(path.join(bkp, 'server'), path.join(RAIZ, 'server'), { recursive: true });
  fs.cpSync(path.join(bkp, 'public'), path.join(RAIZ, 'public'), { recursive: true });
  return { de, versao: versaoAtual() };
}

module.exports = { estado, versaoAtual, aplicar, reverter };
