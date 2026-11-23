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
// Do mais novo para o mais antigo, pela hora gravada no fim do nome (backup-<versão>-<timestamp>), não pela ordem alfabética.
const horaDoBackup = (nome) => Number(nome.slice(nome.lastIndexOf('-') + 1)) || 0;
function backupsExistentes() {
  try { return fs.readdirSync(DIR_BACKUP).filter((n) => n.startsWith('backup-')).sort((a, b) => horaDoBackup(b) - horaDoBackup(a)); } catch { return []; }
}
function estado() {
  return { versao: versaoAtual(), node: process.versions.node, backups: backupsExistentes(), ultima_falha: require('./guardaAtualizacao').ultimaFalha() };
}

/**
 * Teste antes de instalar: confere a sintaxe de cada arquivo do servidor e carrega a versão nova num processo à parte, com a
 * configuração real deste servidor (o mesmo .env). Se ela não carregar aqui, não é instalada, e o sistema continua como está.
 */
function testarAntes(base) {
  const arquivos = [];
  const juntar = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) juntar(path.join(dir, e.name)); else if (e.name.endsWith('.js')) arquivos.push(path.join(dir, e.name));
    }
  };
  juntar(path.join(base, 'server'));
  // O teste usa as bibliotecas instaladas NESTE servidor (as do pacote não são copiadas na atualização): se a versão nova
  // precisar de uma biblioteca que aqui não existe, isso aparece agora, e não depois de instalada.
  fs.rmSync(path.join(base, 'node_modules'), { recursive: true, force: true });
  const rodar = (args, opcoes = {}) => {
    try {
      execFileSync(process.execPath, args, { stdio: 'pipe', timeout: 60_000, ...opcoes });
      return null;
    } catch (err) {
      const txt = `${err.stderr ?? ''}${err.stdout ?? ''}`.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('at ') && !/^node:|^\^+$|^Node\.js/.test(l));
      // A linha que diz o erro ("Error: ..."), sem o trecho de código que o Node mostra antes dela.
      const linha = txt.find((l) => /^\w*Error\b|^Erro\b/.test(l)) ?? txt.find((l) => /\[Rastreador\]/.test(l)) ?? txt[0] ?? err.message;
      return linha.replace(/^\w*Error:\s*/, '').slice(0, 300);
    }
  };
  for (let i = 0; i < arquivos.length; i += 40) {
    const erro = rodar(['--check', ...arquivos.slice(i, i + 40)]);
    if (erro) throw new ErroNegocio(`Atualização recusada: o pacote tem um arquivo com erro (${erro}). Nada foi alterado.`, 400);
  }
  // Carrega a configuração e os módulos do painel da versão nova, usando as bibliotecas já instaladas neste servidor.
  const teste = "require('./server/config');require('./server/db');require('./server/app');require('./server/lib/gt06');require('./server/lib/manutencao');process.exit(0)";
  const erro = rodar(['--disable-warning=ExperimentalWarning', '-e', teste], { cwd: base, env: { ...process.env, NODE_PATH: path.join(RAIZ, 'node_modules'), RASTREADOR_TESTE_ATUALIZACAO: '1' } });
  if (erro) throw new ErroNegocio(`Atualização recusada: a versão nova não inicia neste servidor (${erro}). Nada foi alterado; o sistema continua na versão atual.`, 400);
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
    // Nada de atalhos (links simbólicos) dentro do pacote, nem pacote gigante: um arquivo assim não saiu do empacotador.
    let bytes = 0;
    const conferir = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        const st = fs.lstatSync(p);
        if (st.isSymbolicLink()) throw new ErroNegocio('Pacote recusado: contém atalhos (links simbólicos).', 400);
        if (st.isDirectory()) conferir(p); else bytes += st.size;
        if (bytes > 300 * 1024 * 1024) throw new ErroNegocio('Pacote recusado: grande demais.', 400);
      }
    };
    conferir(path.join(base, 'server')); conferir(path.join(base, 'public'));
    testarAntes(base);
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
    const gt06 = require('./servicoGt06');
    const sit = gt06.ler();
    const antes = sit?.arquivos ? gt06.digital(sit.arquivos) : null;
    fs.cpSync(path.join(base, 'server'), path.join(RAIZ, 'server'), { recursive: true });
    fs.cpSync(path.join(base, 'public'), path.join(RAIZ, 'public'), { recursive: true });
    // Serviço GT06 separado: só reinicia (e os rastreadores reconectam) se o código que ele usa mudou.
    if (antes && gt06.digital(sit.arquivos) !== antes) gt06.pedirReinicio();

    // Marca para a guarda: se a versão nova não ficar de pé, o sistema volta sozinho para este backup.
    require('./guardaAtualizacao').marcar({ backup: path.basename(bkp), de: anterior, para: novaVersao });
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
  fs.rmSync(require('./guardaAtualizacao').PENDENTE, { force: true }); // volta pedida pelo master: nada pendente de confirmar
  const gt06 = require('./servicoGt06');
  const sit = gt06.ler();
  const antes = sit?.arquivos ? gt06.digital(sit.arquivos) : null;
  fs.cpSync(path.join(bkp, 'server'), path.join(RAIZ, 'server'), { recursive: true });
  fs.cpSync(path.join(bkp, 'public'), path.join(RAIZ, 'public'), { recursive: true });
  if (antes && gt06.digital(sit.arquivos) !== antes) gt06.pedirReinicio();
  return { de, versao: versaoAtual() };
}

module.exports = { estado, versaoAtual, aplicar, reverter };
