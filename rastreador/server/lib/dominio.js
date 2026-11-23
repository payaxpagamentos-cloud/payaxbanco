'use strict';
/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/

/**
 * Publicar o painel num domínio próprio (ex.: frota.empresa.com.br), pelo menu Sistema, quando o servidor web da máquina é o
 * Caddy. O Caddy emite e renova o certificado HTTPS sozinho; aqui só entra um bloco NOVO, só para o domínio pedido.
 *
 * Cuidados (a máquina tem outros sistemas no mesmo Caddy):
 *  - só mexe se o Caddy do sistema usa o arquivo /etc/caddy/Caddyfile (conferido no serviço); senão recusa e explica;
 *  - o bloco fica entre duas linhas de marca, para ser retirado depois sem tocar no resto do arquivo;
 *  - antes de recarregar, guarda uma cópia do arquivo e pede ao próprio Caddy para validar o arquivo novo; se a validação ou
 *    a recarga falhar, a cópia volta e nada muda para os outros sites;
 *  - o domínio é conferido letra por letra (só nome de site), e nenhum texto digitado vira comando: os programas são chamados
 *    com argumentos fixos, sem shell.
 */
const fs = require('node:fs');
const dns = require('node:dns').promises;
const { spawnSync } = require('node:child_process');
const config = require('../config');
const { ErroNegocio } = require('./erros');

// O arquivo do Caddy do sistema. (A variável só existe para os testes automáticos usarem um arquivo de mentira.)
const CADDYFILE = process.env.RASTREADOR_CADDYFILE_TESTE || '/etc/caddy/Caddyfile';
const MARCA = (dominio) => [`# >>> gestao-de-frota: ${dominio} (criado pelo painel; não edite à mão)`, `# <<< gestao-de-frota: ${dominio}`];

/** Só nome de site válido: letras, números, hífen e pontos (sem espaço, barra, chave ou qualquer coisa que o Caddy interprete). */
function lerDominio(texto) {
  const d = String(texto ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (d.length > 120 || !/^(?=.{4,120}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(d)) {
    throw new ErroNegocio('Domínio inválido. Escreva só o endereço, como frota.suaempresa.com.br.', 422);
  }
  return d;
}

/** O bloco do domínio: tudo vai para o painel nesta máquina; a página inicial leva ao caminho em que o painel está publicado. */
function bloco(dominio, { porta = config.port, basePath = config.basePath } = {}) {
  const [ini, fim] = MARCA(dominio);
  return [ini, `${dominio} {`, ...(basePath ? [`\tredir / ${basePath}/`] : []), `\treverse_proxy 127.0.0.1:${porta}`, '}', fim].join('\n');
}

/** Domínios publicados pelo painel, lidos das marcas no arquivo. */
function publicados(texto) {
  return [...String(texto).matchAll(/^# >>> gestao-de-frota: (\S+)/gm)].map((m) => m[1]);
}

/** O arquivo com o bloco novo no fim. Recusa se o domínio já aparece no arquivo (como site de outro sistema ou já publicado). */
function comBloco(texto, dominio, opcoes) {
  if (publicados(texto).includes(dominio)) throw new ErroNegocio('Este domínio já está publicado pelo painel.', 409);
  const emUso = new RegExp(`(^|[\\s,/])${dominio.replace(/\./g, '\\.')}(:\\d+)?([\\s,{]|$)`, 'm');
  if (emUso.test(texto)) throw new ErroNegocio('Este domínio já aparece na configuração do servidor web, em outro site. Não vou mexer nele por aqui.', 409);
  return `${String(texto).replace(/\s+$/, '')}\n\n${bloco(dominio, opcoes)}\n`;
}

/** O arquivo sem o bloco do domínio (o resto fica exatamente como está). */
function semBloco(texto, dominio) {
  const [ini, fim] = MARCA(dominio);
  const i = texto.indexOf(ini);
  const f = texto.indexOf(fim);
  if (i < 0 || f < i) throw new ErroNegocio('Este domínio não foi publicado pelo painel.', 404);
  return `${texto.slice(0, i).replace(/\s+$/, '')}\n${texto.slice(f + fim.length).replace(/^\n+/, '\n')}`.replace(/\s+$/, '') + '\n';
}

// ---------- Programas do sistema (argumentos fixos, sem shell) ----------
const rodar = (programa, args) => {
  const r = spawnSync(programa, args, { timeout: 30_000, encoding: 'utf8' });
  return { ok: !r.error && r.status === 0, existe: r.error?.code !== 'ENOENT', saida: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
};

/** Como o Caddy está nesta máquina e se dá para publicar por aqui. */
function situacao(exec = rodar) {
  const versao = exec('caddy', ['version']);
  const arquivo = fs.existsSync(CADDYFILE);
  let texto = '';
  try { texto = arquivo ? fs.readFileSync(CADDYFILE, 'utf8') : ''; } catch { /* sem permissão de leitura */ }
  const ativo = exec('systemctl', ['is-active', 'caddy']);
  const unidade = exec('systemctl', ['show', 'caddy', '-p', 'ExecStart', '-p', 'ExecReload']);
  const usaArquivo = unidade.ok && unidade.saida.includes(CADDYFILE) && /ExecReload=.*reload/.test(unidade.saida);
  let gravavel = false;
  try { fs.accessSync(CADDYFILE, fs.constants.W_OK); gravavel = true; } catch { /* sem permissão */ }
  const motivo = !versao.existe ? 'O servidor web desta máquina não é o Caddy (ou ele não está instalado como programa do sistema).'
    : !arquivo ? `Não achei o arquivo ${CADDYFILE}.`
      : ativo.saida.split('\n')[0] !== 'active' ? 'O serviço "caddy" do sistema não está ativo (pode estar rodando de outro jeito, como em Docker).'
        : !usaArquivo ? `O serviço do Caddy não usa o arquivo ${CADDYFILE} (ou não tem recarga): mexer por aqui poderia afetar os outros sites.`
          : !gravavel ? `O painel não tem permissão para gravar em ${CADDYFILE}.` : null;
  return { pode: !motivo, motivo, caddy: versao.existe ? versao.saida.split('\n')[0].slice(0, 60) : null, publicados: publicados(texto), porta: config.port, caminho: config.basePath || '/' };
}

/** O domínio aponta para algum lugar? (Só informa; quem decide é o DNS de quem publica.) */
async function resolver(dominio) {
  try { return await dns.resolve4(dominio); } catch { return []; }
}

/** Grava o arquivo novo, valida com o próprio Caddy e recarrega. Qualquer falha devolve o arquivo anterior. */
function aplicar(novoTexto, exec = rodar) {
  const anterior = fs.readFileSync(CADDYFILE, 'utf8');
  const copia = `${CADDYFILE}.antes-do-painel`;
  fs.writeFileSync(copia, anterior);
  const voltar = () => { fs.writeFileSync(CADDYFILE, anterior); };
  fs.writeFileSync(CADDYFILE, novoTexto);
  const validar = exec('caddy', ['validate', '--config', CADDYFILE, '--adapter', 'caddyfile']);
  if (!validar.ok) {
    voltar();
    throw new ErroNegocio(`O servidor web recusou a configuração nova, e nada foi alterado. (${validar.saida.split('\n').pop().slice(0, 200)})`, 422);
  }
  const recarga = exec('systemctl', ['reload', 'caddy']);
  if (!recarga.ok) {
    voltar();
    exec('systemctl', ['reload', 'caddy']);
    throw new ErroNegocio(`Não consegui recarregar o servidor web; a configuração anterior foi mantida. (${recarga.saida.slice(0, 200)})`, 500);
  }
}

async function publicar(dominioTexto, exec = rodar) {
  const dominio = lerDominio(dominioTexto);
  const s = situacao(exec);
  if (!s.pode) throw new ErroNegocio(`Não dá para publicar por aqui: ${s.motivo}`, 422);
  const ips = await resolver(dominio);
  if (!ips.length) throw new ErroNegocio(`O domínio ${dominio} ainda não aponta para lugar nenhum. Crie o registro no DNS (tipo A, com o IP deste servidor) e tente de novo em alguns minutos.`, 422);
  aplicar(comBloco(fs.readFileSync(CADDYFILE, 'utf8'), dominio), exec);
  return { dominio, endereco: `https://${dominio}${config.basePath}/`, ips };
}

function retirar(dominioTexto, exec = rodar) {
  const dominio = lerDominio(dominioTexto);
  const s = situacao(exec);
  if (!s.pode) throw new ErroNegocio(`Não dá para retirar por aqui: ${s.motivo}`, 422);
  aplicar(semBloco(fs.readFileSync(CADDYFILE, 'utf8'), dominio), exec);
  return { dominio };
}

module.exports = { lerDominio, bloco, comBloco, semBloco, publicados, situacao, publicar, retirar, CADDYFILE };
