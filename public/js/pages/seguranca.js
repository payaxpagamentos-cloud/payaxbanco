import { api } from '../api.js';
import { html, raw, $, $$, numero, dataHora, modal, toast } from '../ui.js';
import { imagemServico } from '../servicos-img.js';

const STATUS = { ok: ['Tudo certo', 'ok'], atencao: ['Atenção', 'warn'], critico: ['Crítico', 'danger'] };
const TIPO_ARQ = { adicionado: ['Adicionado', 'warn'], alterado: ['Alterado', 'info'], removido: ['Removido', 'danger'] };
const INTEG = { ok: 'Sem alterações', alterado: 'Código alterado', base_criada: 'Versão de referência criada', indisponivel: 'Indisponível', erro: 'Erro na leitura' };

/** Frente da plataforma a que o arquivo pertence. */
function frente(caminho) {
  if (caminho.startsWith('public/site/')) return 'Site';
  if (caminho.startsWith('public/ib/')) return 'Internet Banking';
  if (caminho.startsWith('public/')) return 'Banqueiro';
  if (caminho.startsWith('server/')) return 'Servidor';
  return 'Implantação';
}

const bytes = (n) => {
  if (n === null || n === undefined) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} ${u[i]}`;
};
const tempo = (s) => (s === null || s === undefined ? '—' : s < 3600 ? `${Math.round(s / 60)} min` : s < 86400 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h`);
const pilula = (s) => html`<span class="badge ${STATUS[s][1]}">${STATUS[s][0]}</span>`;
const ORIGEM = { manual: 'Manual', agendada: 'Automática', inicial: 'Início do servidor', aprovacao: 'Aprovação', correcao: 'Correção' };

// ----- Serviços (página de status) -----
const SERV = { ok: ['Operacional', 'ok'], degradado: ['Degradado', 'warn'], fora: ['Fora do ar', 'danger'] };
const pilulaServ = (s) => html`<span class="badge ${SERV[s]?.[1] ?? ''}">${SERV[s]?.[0] ?? 'Sem dados'}</span>`;
const instante = (t) => Date.parse(/[zZ]$/.test(t) ? t : `${String(t).replace(' ', 'T')}Z`);
const ha = (t) => (t ? Math.max(0, Math.round((Date.now() - instante(t)) / 1000)) : null);
const porcento = (v) => (v === null || v === undefined ? '—' : `${v.toLocaleString('pt-BR', { maximumFractionDigits: v === 100 ? 0 : 2 })}%`);
const chaveHora = (d) => `${d.toISOString().slice(0, 13).replace('T', ' ')}:00:00`;
const COR_BARRA = { ok: '#22c55e', degradado: '#f59e0b', fora: 'var(--danger)' };

/** Barras por hora (como numa página de status): verde no ar, amarelo degradado, vermelho fora do ar, cinza sem teste. */
function barrasHoras(barras, horas, altura = 28) {
  const mapa = new Map(barras.map((b) => [b.hora, b]));
  const agora = Date.now();
  const w = 6; const gap = 2;
  const rects = [];
  for (let k = horas - 1, x = 0; k >= 0; k--, x += w + gap) {
    const d = new Date(agora - k * 3600_000);
    const b = mapa.get(chaveHora(d));
    const quando = d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit' });
    rects.push(`<rect x="${x}" y="0" width="${w}" height="${altura}" rx="1.5" fill="${b ? COR_BARRA[b.status] : 'var(--border)'}"><title>${quando}h · ${b ? SERV[b.status][0] : 'sem teste'}</title></rect>`);
  }
  return html`<svg class="serv-barras" viewBox="0 0 ${horas * (w + gap) - gap} ${altura}" preserveAspectRatio="none" role="img" aria-label="Situação por hora">${raw(rects.join(''))}</svg>`;
}

function textoDesde(sv) {
  const t = ha(sv.desde);
  if (t === null) return 'Ainda sem histórico';
  return sv.status === 'fora' ? `Fora do ar há ${tempo(t)}` : `No ar há ${tempo(t)}`;
}

function cartoesServicos(servicos, pulsoMin) {
  return html`<div class="card" style="margin-top:16px"><div class="card-head"><div><h2>Monitoramento dos serviços</h2>
      <div class="small muted" style="margin-top:2px">Teste automático a cada ${pulsoMin} min · clique em um serviço para ver os detalhes</div></div>
      <div class="small muted">${servicos.filter((s) => s.status === 'ok').length} de ${servicos.length} operacionais</div></div>
    <div class="serv-grade">${servicos.map((sv) => html`<button type="button" class="serv-card serv-${sv.status ?? 'nd'}" data-servico="${sv.chave}">
      ${imagemServico(sv.chave, sv.status)}
      <div class="serv-corpo"><div class="serv-topo"><strong>${sv.nome}</strong>${pilulaServ(sv.status)}</div>
        <div class="small ${sv.status === 'fora' ? 'neg' : 'muted'}">${textoDesde(sv)}</div>
        ${barrasHoras(sv.barras_24h ?? [], 24, 18)}
        <div class="serv-rodape small muted"><span>24 h atrás</span><span>Disponível ${porcento(sv.disponibilidade_24h)}</span><span>agora</span></div>
      </div></button>`)}</div></div>`;
}

const formatarInfo = (l) => {
  if (l.valor === null || l.valor === undefined) return '—';
  if (l.tipo === 'data') return `${dataHora(l.valor)} (há ${tempo(ha(l.valor))})`;
  if (l.tipo === 'duracao') return tempo(l.valor);
  if (l.tipo === 'bytes') return bytes(l.valor);
  if (l.tipo === 'numero') return numero(l.valor);
  return l.valor;
};

// ----- Problemas e correções -----
function cartaoProblema(p) {
  const critico = p.gravidade === 'critico';
  return html`<div class="problema ${critico ? 'prob-critico' : 'prob-atencao'}">
    <div class="problema-topo"><span class="badge ${critico ? 'danger' : 'warn'}">${critico ? 'Crítico' : 'Atenção'}</span><strong>${p.titulo}</strong></div>
    ${p.detalhe ? html`<div class="small muted">${p.detalhe}</div>` : ''}
    ${p.acoes.length || p.link ? html`<div class="row problema-acoes">${p.acoes.map((a) => html`<button type="button" class="btn sm ${a.perigo ? 'perigo' : a.acao === 'retestar' ? '' : 'primario'}" data-corrigir="${a.acao}" data-alvo="${a.alvo ?? ''}">${a.rotulo}</button>`)}
      ${p.link ? html`<a class="btn sm" href="${p.link.href}">${p.link.rotulo}</a>` : ''}</div>` : ''}
    ${p.passos?.length ? html`<details class="como-corrigir"><summary>Como corrigir</summary><ol>${p.passos.map((x) => html`<li>${x}</li>`)}</ol></details>` : ''}
  </div>`;
}

function cartaoProblemas(problemas) {
  if (!problemas.length) return html`<div class="card card-body" style="margin-top:16px"><strong>Nenhum problema para corrigir.</strong></div>`;
  const pendencias = problemas.filter((p) => p.tipo === 'implantacao');
  const agora = problemas.filter((p) => p.tipo !== 'implantacao');
  return html`<div class="card" style="margin-top:16px"><div class="card-head"><div><h2>Problemas e correções</h2>
      <div class="small muted" style="margin-top:2px">Use "Corrigir" para resolver pelo sistema; cada correção fica na auditoria e é seguida de nova verificação.</div></div>
      <span class="small muted">${agora.length} para resolver</span></div>
    <div class="problemas">${agora.length ? agora.map(cartaoProblema) : html`<p class="muted" style="margin:0">Nada a resolver agora.</p>`}
    ${pendencias.length ? html`<details class="pendencias"><summary><strong>Pendências para produção (${pendencias.length})</strong>
        <span class="small muted"> · configurações do servidor, feitas na implantação</span></summary>
      <div class="problemas" style="padding:12px 0 0">${pendencias.map(cartaoProblema)}</div></details>` : ''}</div></div>`;
}

function diff(a) {
  if (!a.diff) return html`<p class="small muted" style="margin:8px 0 0">Arquivo binário ou grande demais para mostrar as linhas (conferido pela impressão digital SHA-256).</p>`;
  return html`<div class="diff">${a.diff.trechos.map((t) => html`<div class="diff-linha ${t.tipo === '+' ? 'mais' : 'menos'}"><span class="diff-n">${t.linha}</span><span class="diff-s">${t.tipo}</span><code>${t.texto}</code></div>`)}
    ${a.diff.cortado ? html`<div class="diff-linha"><code class="muted">… mais linhas alteradas não exibidas</code></div>` : ''}</div>`;
}

export default async function seguranca({ alvo, ativo }) {
  let dados = await api.get('/seguranca');
  if (!ativo()) return;
  let verificacao = dados.ultima;

  function desenhar() {
    const v = verificacao;
    if (!v) {
      alvo.innerHTML = String(html`<div class="page-head"><div><h1>Segurança</h1><p class="muted">Nenhuma verificação ainda.</p></div>
        <button class="btn primario" id="verificar">Verificar agora</button></div>`);
      $('#verificar', alvo).onclick = verificar;
      return;
    }
    const i = v.integridade;
    const f = v.funcoes;
    const falhas = f.filter((x) => !x.ok);
    const s = v.servidor;
    const c = v.conexoes;
    const ehUltima = dados.ultima && v.id === dados.ultima.id;
    const proxima = ehUltima ? Math.max(0, dados.intervalo_min - Math.round((Date.now() - Date.parse(`${v.criado_em.replace(' ', 'T')}Z`)) / 60000)) : null;
    alvo.innerHTML = String(html`
      <div class="page-head"><div><h1>Segurança</h1>
        <p class="muted">Monitoramento do Banqueiro, Internet Banking, site e servidor. Verificação automática a cada ${dados.intervalo_min} minutos.</p></div>
        <div class="row">${ehUltima ? '' : html`<button class="btn" id="voltar">Ver a mais recente</button>`}<button class="btn primario" id="verificar">Verificar agora</button></div></div>

      <div class="card card-body seg-status seg-${v.status}">
        ${pilula(v.status)}
        <div><strong>${v.status === 'ok' ? 'Nenhum problema encontrado' : v.status === 'atencao' ? 'Há pontos de atenção' : 'Problema crítico encontrado'}</strong>
          <div class="small muted">Verificação ${{ manual: 'manual', aprovacao: 'após aprovação de versão', inicial: 'ao iniciar o servidor', correcao: 'após correção' }[v.origem] ?? 'automática'}
            em ${dataHora(v.criado_em)} · ${numero(v.duracao_ms)} ms${proxima !== null ? ` · próxima em cerca de ${proxima} min` : ''}</div></div>
      </div>

      ${ehUltima ? cartoesServicos(dados.servicos, dados.pulso_min) : ''}
      ${ehUltima ? cartaoProblemas(dados.problemas) : ''}

      <div class="grid grid-4" style="margin-top:16px">
        <div class="card kpi ${i.status === 'alterado' || i.status === 'erro' ? 'vermelho' : 'verde'}"><div class="rotulo">Integridade do código</div>
          <div class="valor" style="font-size:20px">${i.status === 'alterado' ? `${i.alteracoes.length} ${i.alteracoes.length === 1 ? 'arquivo alterado' : 'arquivos alterados'}` : INTEG[i.status]}</div>
          <div class="sub">${numero(i.arquivos)} arquivos monitorados</div></div>
        <div class="card kpi ${falhas.length ? 'vermelho' : 'verde'}"><div class="rotulo">Funções da plataforma</div>
          <div class="valor">${f.length - falhas.length}/${f.length} <span class="kpi-unid">OK</span></div>
          <div class="sub">${falhas.length ? `Com falha: ${falhas.map((x) => x.nome).join(', ')}` : 'Todas respondendo'}</div></div>
        <div class="card kpi azul"><div class="rotulo">Servidor</div>
          ${s && s.ambiente === 'servidor' ? html`<div class="valor" style="font-size:20px">${Math.round((1 - s.memoria_livre_bytes / s.memoria_total_bytes) * 100)}% <span class="kpi-unid">memória em uso</span></div>
            <div class="sub">Carga ${s.carga.join(' / ')} · no ar há ${tempo(s.ativo_ha_s)}</div>`
          : html`<div class="valor" style="font-size:18px">Demonstração</div><div class="sub">Métricas do servidor aparecem na versão instalada</div>`}</div>
        <div class="card kpi ${c.requisicoes.s5xx ? 'vermelho' : ''}"><div class="rotulo">Conexões (última hora)</div>
          <div class="valor">${numero(c.requisicoes.total)} <span class="kpi-unid">requisições</span></div>
          <div class="sub">${numero(c.requisicoes.s5xx)} erros do servidor · ${numero(c.requisicoes.s401)} acessos negados · ${numero(c.requisicoes.s429)} bloqueios</div></div>
      </div>

      <div class="card" style="margin-top:16px"><div class="card-head"><div><h2>Integridade do código</h2>
          <div class="small muted" style="margin-top:2px">Versão de referência aprovada em ${dados.base?.aprovada_em ? dataHora(dados.base.aprovada_em) : '—'}${dados.base?.aprovada_por ? ` por ${dados.base.aprovada_por}` : ''} · ${numero(dados.base?.arquivos ?? 0)} arquivos</div></div>
        ${i.status === 'alterado' && ehUltima ? html`<div class="row"><button class="btn perigo" data-corrigir="restaurar_todos">Restaurar versão aprovada</button><button class="btn" id="aprovar">Aprovar como nova versão</button></div>` : ''}</div>
        ${i.status === 'alterado' ? html`<div class="card-body" style="background:var(--danger-bg);color:var(--danger);font-weight:600;padding:12px 20px">
            O código da plataforma mudou desde a versão aprovada. Confira cada alteração; se for uma atualização legítima, aprove a nova versão.</div>
          <div class="arquivos-alterados">${i.alteracoes.map((a, k) => html`<details class="arq" ${k < 3 ? 'open' : ''}>
            <summary><span class="badge ${TIPO_ARQ[a.tipo][1]}">${TIPO_ARQ[a.tipo][0]}</span><span class="mono">${a.caminho}</span>
              <span class="small muted">${frente(a.caminho)}</span>
              ${a.diff ? html`<span class="small"><span class="pos">+${a.diff.adicionadas}</span> <span class="neg">−${a.diff.removidas}</span></span>` : ''}</summary>
            ${ehUltima ? html`<div class="arq-acoes"><button type="button" class="btn sm" data-corrigir="restaurar_arquivo" data-alvo="${a.caminho}">${a.tipo === 'adicionado' ? 'Mover para a quarentena' : 'Restaurar este arquivo'}</button></div>` : ''}
            ${diff(a)}</details>`)}</div>`
          : html`<div class="card-body"><p style="margin:0">${i.status === 'base_criada' ? 'Primeira verificação: a versão atual do código foi guardada como referência. As próximas verificações mostram qualquer arquivo novo, removido ou alterado.'
            : i.status === 'ok' ? 'Nenhum arquivo foi adicionado, removido ou alterado desde a versão aprovada.' : i.erro ?? 'Verificação de arquivos indisponível.'}</p></div>`}
      </div>

      <div class="grid grid-2" style="margin-top:16px">
        <div class="card"><div class="card-head"><h2>Funções da plataforma</h2><span class="small muted">teste automático</span></div>
          <div class="table-wrap"><table><thead><tr><th>Função</th><th>Frente</th><th>Situação</th><th class="num">Tempo</th></tr></thead><tbody>
          ${f.map((x) => html`<tr><td><strong>${x.nome}</strong><div class="small muted">${x.detalhe}</div></td><td class="small">${x.frente}</td>
            <td>${x.ok ? html`<span class="badge ok">OK</span>` : html`<span class="badge danger">Falhou</span>`}</td><td class="num small">${x.ms} ms</td></tr>`)}</tbody></table></div></div>
        <div class="stack">
          <div class="card"><div class="card-head"><h2>Configuração e conexões</h2></div>
            <div class="checagens">${c.checagens.map((x) => html`<div class="checagem"><span class="badge ${x.ok ? 'ok' : 'warn'}">${x.ok ? 'OK' : 'Atenção'}</span>
              <div><strong>${x.item}</strong><div class="small muted">${x.detalhe}</div></div></div>`)}</div>
            <div class="card-body small" style="border-top:1px solid var(--border)">
              <div class="row" style="justify-content:space-between"><span class="muted">Integração bancária</span><strong>${c.banco.modo ?? '—'}</strong></div>
              <div class="row" style="justify-content:space-between"><span class="muted">PIX enviados (24 h)</span><strong>${numero(c.banco.pix_enviados_24h)} · ${numero(c.banco.pix_falhas_24h)} falha(s)</strong></div>
              <div class="row" style="justify-content:space-between"><span class="muted">Último recebimento do banco</span><strong>${c.banco.ultimo_recebimento ? dataHora(c.banco.ultimo_recebimento) : '—'}</strong></div>
              <div class="row" style="justify-content:space-between"><span class="muted">IPs distintos (última hora)</span><strong>${numero(c.requisicoes.ips_distintos)}</strong></div>
              ${c.requisicoes.top_ips.length ? html`<div class="muted" style="margin-top:6px">Mais ativos: ${c.requisicoes.top_ips.map((x) => `${x.ip} (${x.n})`).join(' · ')}</div>` : ''}
            </div></div>
          ${s && s.ambiente === 'servidor' ? html`<div class="card"><div class="card-head"><h2>Servidor</h2></div><div class="card-body"><dl class="dl">
            <div><dt>Sistema</dt><dd>${s.sistema}</dd></div><div><dt>Node.js</dt><dd>${s.node}</dd></div>
            <div><dt>Processadores</dt><dd>${s.cpus} · carga ${s.carga.join(' / ')}</dd></div>
            <div><dt>Memória</dt><dd>${bytes(s.memoria_total_bytes - s.memoria_livre_bytes)} de ${bytes(s.memoria_total_bytes)}</dd></div>
            <div><dt>Processo</dt><dd>${bytes(s.processo_memoria_bytes)} · no ar há ${tempo(s.ativo_ha_s)}</dd></div>
            <div><dt>Disco livre</dt><dd>${s.disco ? `${bytes(s.disco.livre_bytes)} de ${bytes(s.disco.total_bytes)}` : '—'}</dd></div>
            <div><dt>Banco de dados</dt><dd>${bytes(s.banco_bytes)}${s.banco_wal_bytes ? ` + ${bytes(s.banco_wal_bytes)} (WAL)` : ''}</dd></div>
            <div><dt>Último backup</dt><dd>${s.ultimo_backup ? dataHora(s.ultimo_backup) : 'Nenhum'}</dd></div></dl></div></div>` : ''}
        </div>
      </div>

      <div class="card" style="margin-top:16px"><div class="card-head"><h2>Histórico de verificações</h2><span class="small muted">últimas ${dados.historico.length}</span></div>
        <div class="table-wrap"><table><thead><tr><th>Quando</th><th>Situação</th><th>Código</th><th>Funções</th><th class="num">Alertas de fraude novos</th><th>Origem</th><th class="num">Duração</th></tr></thead><tbody>
        ${dados.historico.map((h) => html`<tr class="clicavel ${h.id === v.id ? 'selecionada' : ''}" data-ver="${h.id}"><td class="small">${dataHora(h.criado_em)}</td><td>${pilula(h.status)}</td>
          <td>${h.integridade === 'alterado' ? html`<span class="neg">${h.arquivos_alterados} alterado(s)</span>` : INTEG[h.integridade]}</td>
          <td>${h.funcoes_ok}/${h.funcoes_total}</td><td class="num">${numero(h.alertas_novos)}</td>
          <td class="small">${ORIGEM[h.origem] ?? h.origem}</td><td class="num small">${h.duracao_ms} ms</td></tr>`)}
        </tbody></table></div></div>`);

    $('#verificar', alvo).onclick = verificar;
    const volta = $('#voltar', alvo);
    if (volta) volta.onclick = () => { verificacao = dados.ultima; desenhar(); };
    $$('[data-ver]', alvo).forEach((tr) => tr.addEventListener('click', async () => {
      verificacao = await api.get(`/seguranca/verificacoes/${tr.dataset.ver}`);
      desenhar();
      window.scrollTo(0, 0);
    }));
    const ap = $('#aprovar', alvo);
    if (ap) ap.onclick = abrirAprovar;
    $$('[data-servico]', alvo).forEach((b) => b.addEventListener('click', () => abrirServico(b.dataset.servico)));
    $$('[data-corrigir]', alvo).forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); corrigir(b.dataset.corrigir, b.dataset.alvo || undefined, b); }));
  }

  async function recarregar() {
    dados = await api.get('/seguranca');
    verificacao = dados.ultima;
    if (ativo()) desenhar();
  }

  async function executarCorrecao(acao, alvoArq) {
    const r = await api.post('/seguranca/corrigir', { acao, alvo: alvoArq });
    toast(r.mensagem);
    await recarregar();
    return r;
  }

  /** Botão "Corrigir": restaurações pedem confirmação; aprovar abre o formulário de aprovação. */
  async function corrigir(acao, alvoArq, botao) {
    if (acao === 'aprovar') return abrirAprovar();
    if (acao === 'restaurar_todos' || acao === 'restaurar_arquivo') {
      const total = verificacao.integridade.alteracoes?.length ?? 0;
      return modal({
        titulo: acao === 'restaurar_todos' ? 'Restaurar a versão aprovada' : 'Restaurar arquivo',
        rotuloEnviar: 'Restaurar',
        corpo: html`<p style="margin-top:0">${acao === 'restaurar_todos'
          ? `Os ${total} arquivo(s) alterado(s) voltam a ser iguais à versão aprovada. Arquivos novos vão para a quarentena (não são apagados).`
          : html`O arquivo <span class="mono">${alvoArq}</span> volta a ser igual à versão aprovada.`}</p>
          <p class="small muted">Use quando ninguém reconhece a alteração. Se for uma atualização da equipe, aprove a nova versão.</p>`,
        aoEnviar: async (_form, fechar) => { await executarCorrecao(acao, alvoArq); fechar(); },
      });
    }
    const textoOriginal = botao?.textContent;
    if (botao) { botao.disabled = true; botao.textContent = 'Corrigindo…'; }
    try { await executarCorrecao(acao, alvoArq); } catch (err) {
      toast(err.message, 'erro');
      if (botao) { botao.disabled = false; botao.textContent = textoOriginal; }
    }
    return null;
  }

  /** Janela do serviço: há quanto tempo está no ar, disponibilidade, histórico por hora, incidentes, funções e correções. */
  async function abrirServico(chave) {
    let d;
    try { d = await api.get(`/seguranca/servicos/${chave}`); } catch (err) { toast(err.message, 'erro'); return; }
    const t = ha(d.desde);
    const m = modal({
      titulo: d.nome,
      grande: true,
      corpo: html`<div class="serv-cabeca">${imagemServico(d.chave, d.status, 72)}
          <div><div class="row" style="gap:10px">${pilulaServ(d.status)}<span class="small muted">testado ${d.ultima_em ? `há ${tempo(ha(d.ultima_em))}` : '—'}</span></div>
            <p class="muted" style="margin:6px 0 0">${d.descricao}</p><p style="margin:4px 0 0">${d.detalhe}</p></div></div>
        <div class="serv-kpis">
          <div class="serv-kpi destaque ${d.status === 'fora' ? 'neg' : ''}"><span>${d.status === 'fora' ? 'Fora do ar há' : 'No ar há'}</span><strong>${t === null ? '—' : tempo(t)}</strong>
            <small>${d.desde ? `desde ${dataHora(d.desde)}` : ''}</small></div>
          <div class="serv-kpi"><span>Disponibilidade 24 h</span><strong>${porcento(d.disponibilidade.h24)}</strong></div>
          <div class="serv-kpi"><span>7 dias</span><strong>${porcento(d.disponibilidade.d7)}</strong></div>
          <div class="serv-kpi"><span>30 dias</span><strong>${porcento(d.disponibilidade.d30)}</strong></div>
          <div class="serv-kpi"><span>Tempo de resposta médio</span><strong>${d.ms_medio === null ? '—' : `${numero(d.ms_medio)} ms`}</strong></div>
          <div class="serv-kpi"><span>Testes (30 dias)</span><strong>${numero(d.verificacoes_30d)}</strong><small>${d.monitorado_desde ? `desde ${dataHora(d.monitorado_desde)}` : ''}</small></div>
        </div>
        <h3 class="serv-titulo">Últimos 7 dias, hora a hora</h3>
        ${barrasHoras(d.barras, 168, 34)}
        <div class="serv-rodape small muted"><span>7 dias atrás</span><span><i class="leg ok"></i>no ar <i class="leg degradado"></i>degradado <i class="leg fora"></i>fora do ar <i class="leg nd"></i>sem teste</span><span>agora</span></div>
        ${d.info.length ? html`<h3 class="serv-titulo">Informações</h3><dl class="dl">${d.info.map((l) => html`<div><dt>${l.rotulo}</dt><dd>${formatarInfo(l)}</dd></div>`)}</dl>` : ''}
        ${d.funcoes.length ? html`<h3 class="serv-titulo">Funções testadas</h3><div class="table-wrap"><table><tbody>${d.funcoes.map((f) => html`<tr>
          <td><strong>${f.nome}</strong><div class="small muted">${f.detalhe}</div></td><td>${f.ok ? html`<span class="badge ok">OK</span>` : html`<span class="badge danger">Falhou</span>`}</td><td class="num small">${f.ms} ms</td></tr>`)}</tbody></table></div>` : ''}
        ${d.alterados?.length ? html`<h3 class="serv-titulo">Arquivos alterados desde a versão aprovada</h3><ul class="lista-simples">${d.alterados.map((a) => html`<li><span class="badge ${TIPO_ARQ[a.tipo][1]}">${TIPO_ARQ[a.tipo][0]}</span> <span class="mono small">${a.caminho}</span></li>`)}</ul>` : ''}
        <h3 class="serv-titulo">Incidentes (30 dias)</h3>
        ${d.incidentes.length ? html`<div class="table-wrap"><table><thead><tr><th>Início</th><th>Situação</th><th>Duração</th><th>Detalhe</th></tr></thead><tbody>
          ${d.incidentes.map((x) => html`<tr><td class="small">${dataHora(x.inicio)}</td><td>${pilulaServ(x.status)}</td>
            <td class="small">${x.fim ? tempo(x.duracao_s) : html`<strong>em andamento</strong> (${tempo(x.duracao_s)})`}</td><td class="small">${x.detalhe}</td></tr>`)}</tbody></table></div>`
          : html`<p class="muted" style="margin:0">Nenhum incidente nos últimos 30 dias.</p>`}`,
      rodape: html`<div class="modal-foot">${d.acoes.map((a) => html`<button type="button" class="btn ${a.acao === 'retestar' ? '' : 'primario'}" data-acao-serv="${a.acao}">${a.rotulo}</button>`)}
        <button type="button" class="btn" data-cancelar>Fechar</button></div>`,
    });
    $$('[data-acao-serv]', m.el).forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true; b.textContent = 'Executando…';
      try { await executarCorrecao(b.dataset.acaoServ); m.fechar(); abrirServico(chave); } catch (err) { toast(err.message, 'erro'); m.fechar(); }
    }));
  }

  function abrirAprovar() {
    const i = verificacao.integridade;
    return modal({
      titulo: 'Aprovar nova versão do código',
      rotuloEnviar: 'Aprovar versão',
      corpo: html`<p style="margin-top:0">Os ${i.alteracoes.length} arquivo(s) alterado(s) passam a ser a referência. Aprove somente alterações conhecidas, como uma atualização publicada pela equipe.</p>
        <label for="mot-ap">Motivo (ex.: atualização v1.15 validada na Central de Testes)</label><textarea id="mot-ap" name="motivo"></textarea>`,
      aoEnviar: async (form, fechar) => {
        const r = await api.post('/seguranca/integridade/aprovar', { motivo: form.motivo.value });
        fechar(); toast(`Nova versão aprovada (${r.arquivos} arquivos).`);
        await recarregar();
      },
    });
  }

  async function verificar(e) {
    const b = e.currentTarget;
    b.disabled = true; b.textContent = 'Verificando…';
    try {
      await api.post('/seguranca/verificar');
      dados = await api.get('/seguranca');
      verificacao = dados.ultima;
      toast('Verificação concluída.');
      desenhar();
    } catch (err) { toast(err.message, 'erro'); b.disabled = false; b.textContent = 'Verificar agora'; }
  }

  desenhar();
}
