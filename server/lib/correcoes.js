'use strict';

/*
 * Problemas encontrados pela verificação de segurança e como corrigir cada um.
 * Cada problema traz ações automáticas (botão "Corrigir") quando é seguro fazer pelo sistema e, sempre, os passos
 * manuais. Toda correção fica na auditoria e é seguida de uma nova verificação.
 */

const { ErroNegocio } = require('./erros');
const { registrar } = require('./auditoria');
const integridade = require('./integridade');

/** Passos para o que só se corrige na configuração do servidor (variáveis do arquivo .env). */
const PASSOS_CHECAGEM = {
  producao: ['No servidor, defina NODE_ENV=production no arquivo .env.', 'Reinicie a aplicação: docker compose up -d.'],
  segredos: ['Gere dois valores aleatórios com: openssl rand -hex 32.', 'Defina PAYAX_SECRET e PAYAX_PEPPER no arquivo .env do servidor (o PEPPER nunca pode mudar depois de entrar em produção).', 'Reinicie a aplicação: docker compose up -d.'],
  webhook: ['Combine com o Bradesco um token para as notificações (webhook) de PIX recebido.', 'Defina BRADESCO_WEBHOOK_TOKEN no arquivo .env e reinicie a aplicação.'],
  bradesco_real: ['Receba do Bradesco as credenciais do BaaS (client id, client secret e certificado digital).', 'Preencha BRADESCO_MODO, BRADESCO_CLIENT_ID, BRADESCO_CLIENT_SECRET, BRADESCO_CERT_PFX e BRADESCO_CERT_SENHA no .env.', 'Reinicie a aplicação e confira o menu Bradesco.'],
  https: ['Aponte o domínio (ex.: banco.payax.com.br) para o servidor e informe-o no Caddyfile.', 'Com NODE_ENV=production, o sistema passa a exigir HTTPS (HSTS) e ativa a política de conteúdo (CSP).'],
  backup: ['Use "Fazer backup agora" para gerar uma cópia imediata.', 'Agende o backup diário no servidor (cron): 0 3 * * * cd /app && npm run backup.', 'Guarde uma cópia fora do servidor (outro disco ou conta de nuvem).'],
};

/** Correção automática e passos para cada função com falha. */
const CORRECAO_FUNCAO = {
  banco: { acao: 'reparar_banco', rotulo: 'Reparar banco de dados', passos: ['O reparo reconstrói os índices e atualiza as estatísticas do banco.', 'Se a falha continuar, restaure o último backup e acione o suporte técnico.'] },
  teclado: { acao: 'limpar_teclado', rotulo: 'Limpar teclados vencidos', passos: ['Remove os teclados virtuais vencidos ou já usados e testa de novo.'] },
  limites: { acao: 'efetivar_limites', rotulo: 'Processar pedidos de limite', passos: ['Efetiva os aumentos de limite cujo prazo de 24 horas já passou.'] },
  antifraude: { acao: 'analisar_antifraude', rotulo: 'Rodar a análise antifraude', passos: ['Analisa de novo as transações e os acessos recentes.'] },
  login_equipe: { passos: ['Não há administrador ativo. Defina PAYAX_ADMIN_EMAIL e PAYAX_ADMIN_SENHA no .env e reinicie a aplicação: o administrador é recriado.'] },
  bradesco: { passos: ['Confira se as credenciais e o certificado do Bradesco estão válidos (menu Bradesco).', 'Confira se o servidor alcança a internet (firewall e DNS).'] },
};

/** Lista de problemas da verificação mais recente. */
function problemas(db, v, servicos = []) {
  const lista = [];
  const i = v.integridade;
  if (i.status === 'alterado') {
    lista.push({
      id: 'integridade', gravidade: 'critico', servico: null,
      titulo: `Código alterado em ${i.alteracoes.length} ${i.alteracoes.length === 1 ? 'arquivo' : 'arquivos'}`,
      detalhe: 'O código da plataforma está diferente da versão aprovada.',
      acoes: [{ acao: 'aprovar', rotulo: 'Aprovar como nova versão' }, { acao: 'restaurar_todos', rotulo: 'Restaurar versão aprovada', perigo: true }],
      passos: ['Se a alteração é uma atualização da equipe: confira as linhas e aprove a nova versão.',
        'Se ninguém reconhece a alteração: restaure a versão aprovada, troque as senhas de acesso ao servidor e investigue quem teve acesso.',
        'No servidor de produção o código fica protegido contra escrita; nesse caso, reimplante a versão aprovada (docker compose up -d --build).'],
    });
  } else if (i.status === 'erro') {
    lista.push({ id: 'integridade', gravidade: 'critico', titulo: 'Não foi possível ler os arquivos da plataforma', detalhe: i.erro, acoes: [{ acao: 'retestar', rotulo: 'Testar novamente' }], passos: ['Confira as permissões de leitura da pasta da aplicação.'] });
  }
  for (const f of v.funcoes.filter((x) => !x.ok)) {
    const c = CORRECAO_FUNCAO[f.id] ?? {};
    const acoes = [];
    if (c.acao) acoes.push({ acao: c.acao, rotulo: c.rotulo });
    const ausente = /^Arquivo ausente: (.+)$/.exec(f.detalhe);
    if (ausente) acoes.push({ acao: 'restaurar_arquivo', alvo: ausente[1], rotulo: 'Restaurar arquivo' });
    acoes.push({ acao: 'retestar', rotulo: 'Testar novamente' });
    lista.push({ id: `funcao:${f.id}`, gravidade: 'critico', titulo: `${f.nome} com falha`, detalhe: f.detalhe, acoes,
      passos: c.passos ?? (ausente ? ['Restaure o arquivo a partir da versão aprovada ou reimplante a aplicação.'] : ['Teste novamente; se continuar, verifique os registros do servidor (docker compose logs app).']) });
  }
  for (const c of v.conexoes.checagens.filter((x) => !x.ok)) {
    lista.push({ id: `checagem:${c.id}`, gravidade: 'atencao', tipo: c.id === 'backup' ? 'operacao' : 'implantacao', titulo: c.item, detalhe: c.detalhe,
      acoes: c.id === 'backup' ? [{ acao: 'backup', rotulo: 'Fazer backup agora' }] : [], passos: PASSOS_CHECAGEM[c.id] ?? [] });
  }
  const r = v.conexoes.requisicoes;
  if (r.s5xx) {
    lista.push({ id: 'erros_5xx', gravidade: 'atencao', titulo: `${r.s5xx} erro(s) do servidor na última hora`, detalhe: 'Requisições que terminaram com erro interno.',
      acoes: [{ acao: 'retestar', rotulo: 'Testar novamente' }], passos: ['Veja os registros do servidor: docker compose logs --since 1h app.', 'Confira na Auditoria a operação que falhou.'], link: { href: '#/auditoria', rotulo: 'Abrir Auditoria' } });
  }
  const altos = db.prepare("SELECT COUNT(*) AS n FROM alertas_fraude WHERE status = 'aberto' AND severidade = 'alta'").get().n;
  if (altos) {
    lista.push({ id: 'antifraude_alto', gravidade: 'atencao', titulo: `${altos} alerta(s) de fraude de alto risco em aberto`, detalhe: 'A equipe de antifraude precisa analisar.',
      acoes: [], passos: ['Abra o Antifraude, analise cada alerta e descarte ou confirme.'], link: { href: '#/antifraude', rotulo: 'Abrir Antifraude' } });
  }
  const bradesco = servicos.find((s) => s.chave === 'bradesco');
  if (bradesco?.status === 'degradado') {
    lista.push({ id: 'bradesco_pix', gravidade: 'atencao', titulo: 'Integração Bradesco degradada', detalhe: bradesco.detalhe, acoes: [],
      passos: ['Confira os PIX com falha em Transações e reenvie se necessário.', 'Se as falhas continuarem, abra um chamado com o Bradesco.'], link: { href: '#/transacoes', rotulo: 'Abrir Transações' } });
  }
  return lista;
}

// ---------- Ações de correção ----------

function restaurar(db, fonte, caminhos) {
  if (!fonte?.restaurar) throw new ErroNegocio('A restauração automática não está disponível nesta instalação. Reimplante a versão aprovada.', 422);
  const base = new Map(db.prepare('SELECT caminho, hash, tamanho, conteudo FROM integridade_base').all().map((b) => [b.caminho, b]));
  const atuais = new Set(fonte.listar().map((f) => f.caminho));
  const r = { restaurados: [], quarentena: [], sem_copia: [] };
  for (const caminho of caminhos) {
    const b = base.get(caminho);
    if (!b && !atuais.has(caminho)) throw new ErroNegocio(`Arquivo desconhecido: ${caminho}`, 422);
    try {
      if (!b) { fonte.restaurar(caminho, null); r.quarentena.push(caminho); } else if (b.conteudo === null) r.sem_copia.push(caminho);
      else { fonte.restaurar(caminho, b); r.restaurados.push(caminho); }
    } catch (err) {
      if (['EACCES', 'EPERM', 'EROFS'].includes(err.code)) {
        throw new ErroNegocio('O código do servidor está protegido contra escrita (o certo em produção). Para restaurar, reimplante a versão aprovada: docker compose up -d --build.', 422);
      }
      throw err;
    }
  }
  return r;
}

function textoRestauracao(r) {
  const partes = [];
  if (r.restaurados.length) partes.push(`${r.restaurados.length} arquivo(s) restaurado(s)`);
  if (r.quarentena.length) partes.push(`${r.quarentena.length} arquivo(s) novo(s) movido(s) para a quarentena`);
  if (r.sem_copia.length) partes.push(`${r.sem_copia.length} sem cópia guardada (reimplante a versão aprovada)`);
  const servidor = r.restaurados.some((c) => c.startsWith('server/'));
  return `${partes.join(', ') || 'Nada a restaurar'}.${servidor ? ' Arquivos do servidor voltam a valer depois de reiniciar a aplicação.' : ''}`;
}

/**
 * Executa uma correção. `estado` é o estado do módulo de segurança (fonte de arquivos e backup).
 * Retorna a mensagem para o administrador.
 */
function corrigir(db, req, estado, { acao, alvo }) {
  let mensagem;
  let resultado = null;
  switch (acao) {
    case 'retestar':
      mensagem = 'Teste refeito.';
      break;
    case 'reparar_banco': {
      db.exec('REINDEX');
      db.exec('ANALYZE');
      const v = Object.values(db.prepare('PRAGMA quick_check').get())[0];
      mensagem = v === 'ok' ? 'Banco de dados reparado e íntegro.' : `O banco ainda apresenta problema (${v}). Restaure o último backup.`;
      break;
    }
    case 'limpar_teclado': {
      const r = db.prepare("DELETE FROM desafios_teclado WHERE usado = 1 OR expira_em < datetime('now')").run();
      mensagem = `${r.changes} teclado(s) vencido(s) removido(s).`;
      break;
    }
    case 'efetivar_limites':
      require('./limites').efetivarVencidos(db);
      mensagem = 'Pedidos de limite processados.';
      break;
    case 'analisar_antifraude': {
      const n = require('./antifraude').analisar(db);
      mensagem = `Análise antifraude concluída: ${n} alerta(s) novo(s).`;
      break;
    }
    case 'backup': {
      if (!estado.fazerBackup) throw new ErroNegocio('Backup automático indisponível nesta instalação. Rode npm run backup no servidor.', 422);
      resultado = estado.fazerBackup(db);
      db.prepare('INSERT INTO estado_sistema (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor').run('ultimo_backup', new Date().toISOString());
      mensagem = `Backup gerado${resultado?.arquivo ? `: ${resultado.arquivo}` : ''}.`;
      break;
    }
    case 'restaurar_arquivo': {
      if (typeof alvo !== 'string' || !alvo) throw new ErroNegocio('Informe o arquivo.', 422);
      resultado = restaurar(db, estado.fonte, [alvo]);
      mensagem = textoRestauracao(resultado);
      break;
    }
    case 'restaurar_todos': {
      if (!estado.fonte) throw new ErroNegocio('Fonte de arquivos indisponível.', 422);
      const caminhos = integridade.verificar(db, estado.fonte).alteracoes.map((a) => a.caminho);
      resultado = restaurar(db, estado.fonte, caminhos);
      mensagem = textoRestauracao(resultado);
      break;
    }
    default:
      throw new ErroNegocio('Correção desconhecida.', 422);
  }
  registrar(db, req, 'seguranca_correcao', 'verificacao_seguranca', null, { acao, alvo: alvo ?? null, mensagem });
  return mensagem;
}

module.exports = { problemas, corrigir, PASSOS_CHECAGEM };
