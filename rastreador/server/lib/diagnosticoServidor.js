'use strict';
/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/

/**
 * Diagnóstico do servidor para o master (menu Sistema): que servidor web está na máquina, que portas estão abertas e como o
 * Rastreador está publicado. São consultas FIXAS e só de leitura: nada do que o usuário digita vira comando, e nenhum segredo
 * (senha, chave, conteúdo de arquivo de configuração) entra na resposta.
 */
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const config = require('../config');

/** Roda um programa fixo, sem shell, com tempo curto. Devolve a saída (ou null se o programa não existe / falhou). */
function rodar(programa, args) {
  try {
    return execFileSync(programa, args, { timeout: 4000, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 256 * 1024 }).trim();
  } catch (err) {
    // "nginx -v" e "apache2 -v" escrevem a versão na saída de erro.
    const txt = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim();
    return err.code === 'ENOENT' ? null : (txt || null);
  }
}
const versao = (programa, args = ['-v']) => {
  try {
    const r = spawnSync(programa, args, { timeout: 4000, encoding: 'utf8' });
    if (r.error) return null;
    return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n')[0] || null;
  } catch { return null; }
};
const nomes = (pasta) => { try { return fs.readdirSync(pasta).filter((n) => !n.startsWith('.')).slice(0, 60); } catch { return null; } };

function diagnostico() {
  const portas = [80, 443, config.port, config.portaGt06].filter(Boolean);
  const ss = rodar('ss', ['-ltnp']);
  const escutando = ss ? ss.split('\n').filter((l) => portas.some((p) => new RegExp(`:${p}\\s`).test(l))).map((l) => l.replace(/\s+/g, ' ').trim()) : null;
  let sistema = null;
  try { sistema = /PRETTY_NAME="?([^"\n]+)/.exec(fs.readFileSync('/etc/os-release', 'utf8'))?.[1] ?? null; } catch { /* outro sistema */ }
  const linhas = [
    `Sistema: ${sistema ?? os.type()} · Node ${process.versions.node} · usuário ${os.userInfo().username}`,
    `Rastreador: versão ${config.versao || '—'} · porta ${config.port} · endereço de escuta ${config.host || 'todos (0.0.0.0)'} · caminho "${config.basePath || '/'}"`,
    `Endereço público configurado: ${config.urlPublica || '(não definido)'} · proxy confiável: ${config.trustProxy}`,
    `Porta dos rastreadores (GT06): ${config.portaGt06 || 'desligada'}`,
    '',
    'Servidor web instalado:',
    `  Nginx:   ${versao('nginx') ?? 'não encontrado'}`,
    `  Apache:  ${versao('apache2') ?? versao('httpd') ?? 'não encontrado'}`,
    `  Certbot: ${versao('certbot', ['--version']) ?? 'não encontrado'}`,
    '',
    `Portas em uso (${portas.join(', ')}):`,
    ...(escutando === null ? ['  (não consegui consultar: o comando "ss" não está disponível)'] : escutando.length ? escutando.map((l) => `  ${l}`) : ['  nenhuma dessas portas está em uso']),
  ];
  for (const [rotulo, pasta] of [['Sites do Nginx (sites-enabled)', '/etc/nginx/sites-enabled'], ['Sites do Nginx (conf.d)', '/etc/nginx/conf.d'],
    ['Sites do Apache (sites-enabled)', '/etc/apache2/sites-enabled'], ['Sites do Apache (conf.d)', '/etc/httpd/conf.d']]) {
    const lista = nomes(pasta);
    if (lista) linhas.push('', `${rotulo}:`, ...(lista.length ? lista.map((n) => `  ${n}`) : ['  (vazio)']));
  }
  return linhas.join('\n');
}

module.exports = { diagnostico };
