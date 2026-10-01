import { api } from '../api.js';
import { ehAdmin, usuarioAtual } from '../contexto.js';
import { html, raw, $, $$, numero, dataHora, documento, modal, toast, iniciais } from '../ui.js';
import { baloes, rolarFim, duracao } from '../chat.js';

const PERIODOS = [[7, '7 dias'], [30, '30 dias'], [90, '90 dias']];

/** Barras de mensagens recebidas e enviadas por dia. */
function grafico(serie) {
  const W = 720, H = 220, M = { t: 12, r: 12, b: 28, l: 36 };
  const max = Math.max(1, ...serie.flatMap((d) => [d.recebidas, d.enviadas]));
  const topo = Math.max(4, Math.ceil(max / 4) * 4);
  const larg = (W - M.l - M.r) / serie.length;
  const y = (v) => M.t + (H - M.t - M.b) * (1 - v / topo);
  const grade = [0, 0.25, 0.5, 0.75, 1].map((f) => `<line class="grade" x1="${M.l}" x2="${W - M.r}" y1="${y(topo * f)}" y2="${y(topo * f)}"/>
    <text x="${M.l - 8}" y="${y(topo * f) + 4}" text-anchor="end">${topo * f}</text>`).join('');
  const passoRotulo = Math.ceil(serie.length / 10);
  const barras = serie.map((d, i) => {
    const x = M.l + i * larg;
    const b = Math.max(1.5, larg / 2 - 2);
    const rot = `${d.dia.slice(8, 10)}/${d.dia.slice(5, 7)}`;
    return `<g><title>${rot}: ${d.recebidas} recebidas · ${d.enviadas} enviadas</title>
      <rect x="${x + larg / 2 - b - 0.5}" y="${y(d.recebidas)}" width="${b}" height="${y(0) - y(d.recebidas)}" rx="2" fill="#1565C0"/>
      <rect x="${x + larg / 2 + 0.5}" y="${y(d.enviadas)}" width="${b}" height="${y(0) - y(d.enviadas)}" rx="2" fill="#00C8FF"/>
      ${i % passoRotulo === 0 ? `<text x="${x + larg / 2}" y="${H - 8}" text-anchor="middle">${rot}</text>` : ''}</g>`;
  }).join('');
  return raw(`<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Mensagens recebidas e enviadas por dia">${grade}${barras}</svg>`);
}

/** Parâmetro de gerente para a API: número, "atendimento" (sem gerente) ou nada (todos). */
const paramGerente = (g) => (g === null ? 'atendimento' : g);

export function abrirConversa(clienteId, { gerenteId, gerenteNome, aoFechar } = {}) {
  const query = ehAdmin() && gerenteId !== undefined ? { gerente_id: paramGerente(gerenteId) } : {};
  api.get(`/relacionamento/conversas/${clienteId}`, query).then((c) => {
    const { el } = modal({
      titulo: `Conversa com ${c.cliente.nome}`,
      grande: true,
      corpo: html`<div class="row small muted" style="margin:-4px 0 10px">${documento(c.cliente.documento)}
          ${ehAdmin() ? html` · ${gerenteId === null ? 'Atendimento PAY AX (cliente sem gerente)' : `Gerente: ${gerenteNome ?? ''}`}` : ''}
          · <a href="#/clientes/${c.cliente.id}" data-cancelar>Ver cadastro</a></div>
        <div class="chat-lista" id="chat-lista">${baloes(c.mensagens, { lado: 'gerente', nomeOutro: c.cliente.nome.split(' ')[0], meuNome: usuarioAtual().nome })}</div>
        <form class="chat-envio" id="chat-form" novalidate>
          <textarea id="chat-texto" maxlength="2000" placeholder="Escreva sua resposta ao cliente…" aria-label="Mensagem"></textarea>
          <button class="btn primario" type="submit">Enviar</button></form>
        <p class="small muted" style="margin:8px 0 0">O cliente vê a resposta no Internet Banking, em "Meu gerente".</p>`,
      rodape: html`<div class="modal-foot"><button class="btn" data-cancelar>Fechar</button></div>`,
    });
    const lista = $('#chat-lista', el);
    rolarFim(lista);
    const texto = $('#chat-texto', el);
    texto.focus();
    texto.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#chat-form', el).requestSubmit(); });
    $('#chat-form', el).addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!texto.value.trim()) return;
      const botao = e.target.querySelector('button');
      botao.disabled = true;
      try {
        await api.post(`/relacionamento/conversas/${c.cliente.id}`, { texto: texto.value, ...(ehAdmin() ? { gerente_id: paramGerente(gerenteId) } : {}) });
        texto.value = '';
        const novo = await api.get(`/relacionamento/conversas/${c.cliente.id}`, query);
        lista.innerHTML = String(baloes(novo.mensagens, { lado: 'gerente', nomeOutro: c.cliente.nome.split(' ')[0], meuNome: usuarioAtual().nome }));
        rolarFim(lista);
      } catch (err) { toast(err.message, 'erro'); } finally { botao.disabled = false; texto.focus(); }
    });
    const observar = new MutationObserver(() => { if (!el.isConnected) { observar.disconnect(); aoFechar?.(); } });
    observar.observe(document.querySelector('#modal-root'), { childList: true });
  }).catch((e) => toast(e.message, 'erro'));
}

function novaMensagem(gerente, aoEnviar) {
  api.get('/relacionamento/carteira', ehAdmin() && gerente !== undefined ? { gerente_id: paramGerente(gerente.id) } : {}).then((clientes) => {
    modal({
      titulo: 'Nova mensagem para cliente',
      rotuloEnviar: 'Enviar',
      corpo: clientes.length ? html`<div class="stack" style="gap:12px">
          <div><label for="nm-cliente">Cliente da carteira</label><select id="nm-cliente" name="cliente">${clientes.map((c) => html`<option value="${c.id}">${c.nome} · ${documento(c.documento)}</option>`)}</select></div>
          <div><label for="nm-texto">Mensagem</label><textarea id="nm-texto" name="texto" maxlength="2000" placeholder="Ex.: Olá! Sou seu gerente na PAY AX. Posso ajudar com algo?"></textarea></div></div>`
        : html`<p class="muted" style="margin:0">Nenhum cliente na carteira. Defina o gerente nas contas (Contas → conta → Alterar gerente).</p>`,
      aoEnviar: async (form, fechar) => {
        if (!clientes.length) { fechar(); return; }
        await api.post(`/relacionamento/conversas/${form.cliente.value}`, { texto: form.texto.value, ...(ehAdmin() && gerente ? { gerente_id: gerente.id } : {}) });
        fechar(); toast('Mensagem enviada.'); aoEnviar();
      },
    });
  }).catch((e) => toast(e.message, 'erro'));
}

export default async function relacionamento({ alvo, ativo }) {
  const admin = ehAdmin();
  const estado = { dias: 30, gerente: undefined }; // gerente: undefined = todos; null = atendimento; número = gerente
  const gerentes = admin ? (await api.get('/relacionamento/gerentes')).filter((g) => g.perfil === 'gerente') : [];
  if (!ativo()) return;

  async function carregar() {
    const q = { dias: estado.dias, ...(admin && estado.gerente !== undefined ? { gerente_id: paramGerente(estado.gerente) } : {}) };
    const [p, conversas] = await Promise.all([api.get('/relacionamento/painel', q), api.get('/relacionamento/conversas', q)]);
    if (!ativo()) return;
    const nomeGerente = estado.gerente === undefined ? null : estado.gerente === null ? 'Atendimento PAY AX' : gerentes.find((g) => g.id === estado.gerente)?.nome;
    const podeEscrever = !admin || (estado.gerente !== undefined && estado.gerente !== null);
    alvo.innerHTML = String(html`
      <div class="page-head"><div><h1>Relacionamento</h1>
        <p class="muted">${admin ? (nomeGerente ? `Carteira de ${nomeGerente}.` : 'Todos os gerentes.') : 'Sua carteira de clientes.'} Contatos dos últimos ${p.dias} dias.</p></div>
        <div class="row">
          ${admin ? html`<select id="rel-gerente" aria-label="Gerente" style="width:auto">
            <option value="">Todos os gerentes</option>${gerentes.map((g) => html`<option value="${g.id}" ${estado.gerente === g.id ? 'selected' : ''}>${g.nome}</option>`)}
            <option value="atendimento" ${estado.gerente === null ? 'selected' : ''}>Atendimento PAY AX (sem gerente)</option></select>` : ''}
          <div class="chips" id="rel-dias">${PERIODOS.map(([d, r]) => html`<button class="chip ${estado.dias === d ? 'ativo' : ''}" data-dias="${d}">${r}</button>`)}</div>
          ${podeEscrever ? html`<button class="btn primario" id="rel-nova">+ Nova mensagem</button>` : ''}</div></div>

      <div class="grid grid-4">
        <div class="card kpi azul"><div class="rotulo">Carteira</div><div class="valor">${numero(p.carteira_clientes)} <span class="kpi-unid">clientes</span></div>
          <div class="sub">${numero(p.carteira_contas)} contas sob gestão</div></div>
        <div class="card kpi"><div class="rotulo">Entraram em contato</div><div class="valor">${numero(p.clientes_contato)} <span class="kpi-unid">clientes</span></div>
          <div class="sub">${numero(p.recebidas)} mensagens recebidas</div></div>
        <div class="card kpi verde"><div class="rotulo">Clientes contatados</div><div class="valor">${numero(p.clientes_contatados)} <span class="kpi-unid">clientes</span></div>
          <div class="sub">${numero(p.enviadas)} mensagens enviadas</div></div>
        <div class="card kpi ${p.aguardando ? 'vermelho' : ''}"><div class="rotulo">Aguardando resposta</div><div class="valor">${numero(p.aguardando)} <span class="kpi-unid">${p.aguardando === 1 ? 'conversa' : 'conversas'}</span></div>
          <div class="sub">Tempo médio de resposta: ${duracao(p.tempo_medio_resposta_min)}</div></div>
      </div>

      <div class="grid grid-2-1" style="margin-top:16px">
        <div class="card"><div class="card-head"><h2>Mensagens por dia</h2>
          <div class="legenda"><span><i style="background:#1565C0"></i>Recebidas</span><span><i style="background:#00C8FF"></i>Enviadas</span></div></div>
          <div class="card-body">${grafico(p.serie)}</div></div>
        <div class="card"><div class="card-head"><h2>Conversas</h2><span class="small muted">${numero(conversas.length)}</span></div>
          <div class="conversas">${conversas.length ? conversas.map((c) => html`<button type="button" class="conversa ${c.ultima_autor === 'cliente' ? 'pendente' : ''}" data-cliente="${c.cliente_id}" data-gerente="${c.gerente_id ?? 'atendimento'}" data-gerente-nome="${c.gerente_nome ?? ''}">
              <span class="avatar">${iniciais(c.cliente_nome)}</span>
              <span class="conversa-txt"><strong>${c.cliente_nome}</strong>${admin ? html`<small>${c.gerente_nome ?? 'Atendimento PAY AX'}</small>` : ''}
                <span class="conversa-ultima">${c.ultima_autor === 'gerente' ? (admin ? 'Gerente: ' : 'Você: ') : ''}${c.ultima_texto}</span></span>
              <span class="conversa-lado"><small>${dataHora(c.ultima_em)}</small>${c.nao_lidas ? html`<span class="contador">${c.nao_lidas}</span>` : c.ultima_autor === 'cliente' ? html`<span class="badge warn">Responder</span>` : ''}</span>
            </button>`) : html`<div class="vazio">Nenhuma conversa ainda.</div>`}</div></div>
      </div>

      <div class="card" style="margin-top:16px"><div class="card-head"><h2>Quem entrou em contato e quem foi contatado</h2><span class="small muted">últimos ${p.dias} dias</span></div>
        <div class="table-wrap"><table><thead><tr><th>Cliente</th>${admin ? html`<th>Gerente</th>` : ''}<th>Iniciado por</th><th class="num">Recebidas</th><th class="num">Enviadas</th><th>Último contato</th><th>Situação</th></tr></thead><tbody>
        ${p.contatos.length ? p.contatos.map((c) => html`<tr class="clicavel" data-cliente="${c.cliente_id}" data-gerente="${c.gerente_id ?? 'atendimento'}" data-gerente-nome="${c.gerente_nome ?? ''}">
          <td><strong>${c.cliente_nome}</strong></td>${admin ? html`<td>${c.gerente_nome ?? 'Atendimento PAY AX'}</td>` : ''}
          <td>${c.iniciado_por === 'cliente' ? 'Cliente' : 'Gerente'}</td><td class="num">${numero(c.recebidas)}</td><td class="num">${numero(c.enviadas)}</td>
          <td class="small">${dataHora(c.ultima_em)}</td><td>${c.aguardando ? html`<span class="badge warn">Aguardando resposta</span>` : html`<span class="badge ok">Em dia</span>`}</td></tr>`)
          : html`<tr><td colspan="${admin ? 7 : 6}" class="vazio">Nenhum contato no período.</td></tr>`}</tbody></table></div></div>

      ${p.por_gerente ? html`<div class="card" style="margin-top:16px"><div class="card-head"><h2>Por gerente</h2><span class="small muted">últimos ${p.dias} dias</span></div>
        <div class="table-wrap"><table><thead><tr><th>Gerente</th><th class="num">Carteira</th><th class="num">Entraram em contato</th><th class="num">Clientes contatados</th>
          <th class="num">Recebidas</th><th class="num">Enviadas</th><th class="num">Aguardando</th><th class="num">Tempo médio de resposta</th></tr></thead><tbody>
          ${p.por_gerente.map((g) => html`<tr class="clicavel" data-ver-gerente="${g.id}"><td><strong>${g.nome}</strong></td><td class="num">${numero(g.carteira_clientes)}</td>
            <td class="num">${numero(g.clientes_contato)}</td><td class="num">${numero(g.clientes_contatados)}</td><td class="num">${numero(g.recebidas)}</td>
            <td class="num">${numero(g.enviadas)}</td><td class="num ${g.aguardando ? 'neg' : ''}">${numero(g.aguardando)}</td><td class="num">${duracao(g.tempo_medio_resposta_min)}</td></tr>`)}
        </tbody></table></div></div>` : ''}`);

    $$('[data-dias]', alvo).forEach((b) => b.addEventListener('click', () => { estado.dias = Number(b.dataset.dias); carregar(); }));
    const sel = $('#rel-gerente', alvo);
    if (sel) sel.addEventListener('change', () => {
      estado.gerente = sel.value === '' ? undefined : sel.value === 'atendimento' ? null : Number(sel.value);
      carregar();
    });
    $$('[data-ver-gerente]', alvo).forEach((tr) => tr.addEventListener('click', () => { estado.gerente = Number(tr.dataset.verGerente); carregar(); }));
    $$('[data-cliente]', alvo).forEach((b) => b.addEventListener('click', () => abrirConversa(b.dataset.cliente, {
      gerenteId: b.dataset.gerente === 'atendimento' ? null : Number(b.dataset.gerente), gerenteNome: b.dataset.gerenteNome, aoFechar: carregar,
    })));
    const nova = $('#rel-nova', alvo);
    if (nova) nova.onclick = () => novaMensagem(admin ? { id: estado.gerente } : undefined, carregar);
  }
  await carregar();
}
