import { api } from '../api.js';
import { html, $, $$, numero, dataHora, modal, toast } from '../ui.js';

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
          <div class="small muted">Verificação ${v.origem === 'manual' ? 'manual' : v.origem === 'aprovacao' ? 'após aprovação de versão' : v.origem === 'inicial' ? 'ao iniciar o servidor' : 'automática'}
            em ${dataHora(v.criado_em)} · ${numero(v.duracao_ms)} ms${proxima !== null ? ` · próxima em cerca de ${proxima} min` : ''}</div></div>
      </div>

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
        ${i.status === 'alterado' && ehUltima ? html`<button class="btn" id="aprovar">Aprovar como nova versão</button>` : ''}</div>
        ${i.status === 'alterado' ? html`<div class="card-body" style="background:var(--danger-bg);color:var(--danger);font-weight:600;padding:12px 20px">
            O código da plataforma mudou desde a versão aprovada. Confira cada alteração; se for uma atualização legítima, aprove a nova versão.</div>
          <div class="arquivos-alterados">${i.alteracoes.map((a, k) => html`<details class="arq" ${k < 3 ? 'open' : ''}>
            <summary><span class="badge ${TIPO_ARQ[a.tipo][1]}">${TIPO_ARQ[a.tipo][0]}</span><span class="mono">${a.caminho}</span>
              <span class="small muted">${frente(a.caminho)}</span>
              ${a.diff ? html`<span class="small"><span class="pos">+${a.diff.adicionadas}</span> <span class="neg">−${a.diff.removidas}</span></span>` : ''}</summary>
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
          <td class="small">${{ manual: 'Manual', agendada: 'Automática', inicial: 'Início do servidor', aprovacao: 'Aprovação' }[h.origem] ?? h.origem}</td><td class="num small">${h.duracao_ms} ms</td></tr>`)}
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
    if (ap) ap.onclick = () => modal({
      titulo: 'Aprovar nova versão do código',
      rotuloEnviar: 'Aprovar versão',
      corpo: html`<p style="margin-top:0">Os ${i.alteracoes.length} arquivo(s) alterado(s) passam a ser a referência. Aprove somente alterações conhecidas, como uma atualização publicada pela equipe.</p>
        <label for="mot-ap">Motivo (ex.: atualização v1.15 validada na Central de Testes)</label><textarea id="mot-ap" name="motivo"></textarea>`,
      aoEnviar: async (form, fechar) => {
        const r = await api.post('/seguranca/integridade/aprovar', { motivo: form.motivo.value });
        fechar(); toast(`Nova versão aprovada (${r.arquivos} arquivos).`);
        dados = await api.get('/seguranca'); verificacao = dados.ultima; desenhar();
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
