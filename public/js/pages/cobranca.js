import { api } from '../api.js';
import { html, $, $$, moeda, numero, data, dataHora, pct, opcoes, modal, dadosForm, toast, centavos, valorMoedaInput, hoje, somarDias, icone } from '../ui.js';

const CANAIS = [
  { id: 'ligacao', nome: 'Ligação' }, { id: 'whatsapp', nome: 'WhatsApp' }, { id: 'email', nome: 'E-mail' },
  { id: 'lembrete', nome: 'Lembrete de vencimento' }, { id: 'visita', nome: 'Visita' }, { id: 'outro', nome: 'Outro' },
];
const rotuloCanal = (c) => CANAIS.find((x) => x.id === c)?.nome ?? c;
const whatsapp = (tel, texto) => {
  const d = String(tel ?? '').replace(/\D/g, '');
  return d.length >= 10 ? `https://wa.me/55${d}?text=${encodeURIComponent(texto)}` : null;
};

export default async function cobranca({ alvo, ativo, base, empresa }) {
  let aba = 'inadimplencia';
  alvo.innerHTML = String(html`
    <div class="page-head"><div><h1>Cobrança e inadimplência</h1><p class="muted">Lembretes de vencimento, histórico de contatos, promessas de pagamento e acordos.</p></div>
      <button class="btn" id="pix">Configurar cobrança</button></div>
    <div id="cob-config"></div>
    <div class="tabs">${[['inadimplencia', 'Inadimplência'], ['lembretes', 'Lembretes'], ['promessas', 'Promessas de pagamento']].map(([k, r]) =>
      html`<button data-aba="${k}" class="${k === aba ? 'ativo' : ''}">${r}</button>`)}</div>
    <div id="aba-cob"></div>`);
  const el = () => $('#aba-cob', alvo);

  const telas = {
    async inadimplencia() {
      const p = await api.get(`${base}/cobranca`);
      if (!ativo()) return;
      const maxFaixa = Math.max(1, ...p.faixas.map((f) => f.total_centavos));
      el().innerHTML = String(html`
        <div class="grid grid-3">
          <div class="card kpi vermelho"><div class="rotulo">Vencido em aberto</div><div class="valor">${moeda(p.total_vencido_centavos)}</div><div class="sub">${numero(p.titulos_vencidos)} título(s)</div></div>
          <div class="card kpi"><div class="rotulo">Inadimplência (90 dias)</div><div class="valor">${p.taxa_90_dias === null ? '—' : pct(p.taxa_90_dias)}</div><div class="sub">Vencido e não pago ÷ tudo que venceu nos últimos 90 dias</div></div>
          <div class="card kpi azul"><div class="rotulo">Promessas pendentes</div><div class="valor">${numero(p.promessas.length)}</div>
            <div class="sub">${numero(p.promessas.filter((x) => x.atrasada).length)} já passaram da data</div></div>
        </div>
        <div class="grid grid-2-1" style="margin-top:16px;align-items:start">
          <div class="card"><div class="card-head"><h2>Devedores</h2><span class="small muted">Clique para abrir a ficha de cobrança</span></div>
            <div class="table-wrap"><table><thead><tr><th>Cliente</th><th class="num">Títulos</th><th class="num">Maior atraso</th><th class="num">Vencido</th><th>Último contato</th><th>Promessa</th></tr></thead><tbody>
              ${p.devedores.length ? p.devedores.map((d) => html`<tr class="${d.contato_id ? 'clicavel' : ''}" data-contato="${d.contato_id ?? ''}">
                <td><strong>${d.nome}</strong></td><td class="num">${numero(d.titulos)}</td>
                <td class="num ${d.maior_atraso > 30 ? 'neg' : ''}">${numero(d.maior_atraso)} dia(s)</td><td class="num"><strong>${moeda(d.total_centavos)}</strong></td>
                <td class="small">${d.ultima_interacao ? html`${rotuloCanal(d.ultima_interacao.canal)} · ${dataHora(d.ultima_interacao.criado_em)}` : html`<span class="neg">Nunca contatado</span>`}</td>
                <td class="small">${d.promessa ? html`${moeda(d.promessa.valor_centavos)} em ${data(d.promessa.data_prometida)}` : '—'}</td></tr>`)
                : html`<tr><td colspan="6" class="vazio">Nenhum título vencido.</td></tr>`}
            </tbody></table></div></div>
          <div class="card"><div class="card-head"><h2>Por tempo de atraso</h2></div><div class="card-body stack">
            ${p.faixas.map((f) => html`<div><div class="row" style="justify-content:space-between"><span>${f.rotulo} dias <span class="small muted">(${numero(f.quantidade)})</span></span><strong class="num">${moeda(f.total_centavos)}</strong></div>
              <div class="barra-h" style="margin-top:6px"><span style="width:${((f.total_centavos / maxFaixa) * 100).toFixed(1)}%"></span></div></div>`)}
          </div></div>
        </div>`);
      $$('tr[data-contato]', el()).forEach((tr) => tr.dataset.contato && tr.addEventListener('click', () => ficha(Number(tr.dataset.contato))));
    },

    async lembretes() {
      const lista = await api.get(`${base}/cobranca/lembretes`, { dias: 3 });
      if (!ativo()) return;
      el().innerHTML = String(html`<div class="card"><div class="card-head"><h2>Vencendo em até 3 dias e vencidos</h2>
          <span class="small muted">Envie pelo WhatsApp ou e-mail do seu computador e registre o envio.</span></div>
        ${lista.length ? lista.map((l) => {
          const wa = whatsapp(l.telefone, l.texto);
          return html`<div class="conc-item" data-l="${l.id}">
            <div><strong>${data(l.vencimento)}</strong><div class="small ${l.atraso > 0 ? 'neg' : 'muted'}">${l.atraso > 0 ? `${l.atraso} dia(s) de atraso` : l.atraso === 0 ? 'vence hoje' : `em ${-l.atraso} dia(s)`}</div></div>
            <div><strong>${l.contato_nome}</strong> · ${l.descricao}<div class="small muted" style="margin-top:4px">${l.texto}</div>
              ${l.ultimo_lembrete ? html`<div class="small" style="margin-top:4px">Último lembrete: ${dataHora(l.ultimo_lembrete)}</div>` : ''}</div>
            <div class="valor">${moeda(l.valor_centavos)}</div>
            <div class="acoes">
              ${wa ? html`<a class="btn sm" href="${wa}" target="_blank" rel="noopener" data-enviado="whatsapp">WhatsApp</a>` : html`<span class="small muted">Sem telefone</span>`}
              ${l.email && cfg.email_configurado ? html`<button class="btn sm primario" data-email-servidor>Enviar e-mail</button>` : ''}
              ${l.email && !cfg.email_configurado ? html`<a class="btn sm" href="mailto:${l.email}?subject=${encodeURIComponent(`Lembrete de pagamento — ${empresa.nome_fantasia || empresa.razao_social}`)}&body=${encodeURIComponent(l.texto)}" data-enviado="email">E-mail</a>` : ''}
              <button class="btn sm" data-copiar>Copiar texto</button>
              <button class="btn sm" data-registrar>Registrar envio</button>
            </div></div>`;
        }) : html`<div class="vazio">Nenhum título vencendo nos próximos 3 dias.</div>`}</div>`);
      for (const item of $$('[data-l]', el())) {
        const l = lista.find((x) => x.id === Number(item.dataset.l));
        const registrar = (canal) => api.post(`${base}/cobranca/registros`, { contato_id: l.contato_id, lancamento_id: l.id, canal: 'lembrete', descricao: `Lembrete enviado por ${canal}.` });
        $$('[data-enviado]', item).forEach((a) => a.addEventListener('click', () => registrar(a.dataset.enviado === 'email' ? 'e-mail' : 'WhatsApp').then(() => toast('Envio registrado no histórico.')).catch(() => {})));
        $('[data-email-servidor]', item)?.addEventListener('click', async (ev) => {
          ev.target.disabled = true;
          try { await api.post(`${base}/cobranca/lembretes/${l.id}/email`); toast(`Lembrete enviado para ${l.email}.`); telas.lembretes(); }
          catch (err) { toast(err.message, 'erro'); ev.target.disabled = false; }
        });
        $('[data-copiar]', item).addEventListener('click', () => navigator.clipboard?.writeText(l.texto).then(() => toast('Texto copiado.')).catch(() => toast('Não foi possível copiar.', 'erro')));
        $('[data-registrar]', item).addEventListener('click', () => registrar('outro canal').then(() => { toast('Lembrete registrado.'); telas.lembretes(); }).catch((err) => toast(err.message, 'erro')));
      }
    },

    async promessas() {
      const p = await api.get(`${base}/cobranca`);
      if (!ativo()) return;
      el().innerHTML = String(html`<div class="card"><div class="table-wrap"><table><thead><tr><th>Data prometida</th><th>Cliente</th><th class="num">Valor</th><th>Registrada por</th><th></th></tr></thead><tbody>
        ${p.promessas.length ? p.promessas.map((x) => html`<tr><td>${data(x.data_prometida)} ${x.atrasada ? html`<span class="badge danger">Passou</span>` : ''}</td>
          <td class="clicavel" data-contato="${x.contato_id}"><strong>${x.contato_nome}</strong>${x.observacao ? html`<div class="small muted">${x.observacao}</div>` : ''}</td>
          <td class="num">${moeda(x.valor_centavos)}</td><td class="small">${x.usuario_nome ?? ''}</td>
          <td class="right"><button class="btn sm" data-resolver="${x.id}" data-status="quebrada">Não cumprida</button> <button class="btn sm primario" data-resolver="${x.id}" data-status="cumprida">Cumprida</button></td></tr>`)
          : html`<tr><td colspan="5" class="vazio">Nenhuma promessa pendente. Promessas ligadas a um título viram "cumpridas" sozinhas quando ele é pago.</td></tr>`}</tbody></table></div></div>`);
      $$('[data-contato]', el()).forEach((td) => td.addEventListener('click', () => ficha(Number(td.dataset.contato))));
      $$('[data-resolver]', el()).forEach((b) => b.addEventListener('click', async () => {
        try { await api.post(`${base}/cobranca/promessas/${b.dataset.resolver}/resolver`, { status: b.dataset.status }); toast('Promessa atualizada.'); telas.promessas(); } catch (err) { toast(err.message, 'erro'); }
      }));
    },
  };

  /** Ficha de cobrança do cliente: títulos, histórico, promessas e acordos, com as ações. */
  async function ficha(contatoId) {
    const f = await api.get(`${base}/cobranca/clientes/${contatoId}`);
    const c = f.contato;
    const { el: m, fechar } = modal({
      titulo: `Cobrança · ${c.nome}`, grande: true,
      corpo: html`<div class="small muted" style="margin-bottom:12px">${[c.telefone, c.email].filter(Boolean).join(' · ') || 'Sem telefone e e-mail no cadastro.'}</div>
        <h3 style="margin:0 0 8px">Títulos em aberto</h3>
        <div class="table-wrap"><table><tbody>${f.titulos.length ? f.titulos.map((t) => html`<tr>
          <td class="sel"><input type="checkbox" data-titulo="${t.id}" ${t.atraso > 0 ? '' : 'disabled'} aria-label="Incluir no acordo"></td>
          <td>${data(t.vencimento)}${t.atraso ? html`<div class="small neg">${t.atraso} dia(s)</div>` : ''}</td><td>${t.descricao}${t.acordo_id ? html` <span class="badge info">Acordo #${t.acordo_id}</span>` : ''}</td>
          <td class="num">${moeda(t.valor_centavos)}</td></tr>`) : html`<tr><td class="vazio">Nenhum título em aberto.</td></tr>`}</tbody></table></div>
        <div class="row" style="margin:10px 0 18px"><button class="btn sm" id="contato">Registrar contato</button><button class="btn sm" id="promessa">Registrar promessa</button>
          <button class="btn sm primario" id="acordo">Negociar selecionados (acordo)</button></div>
        <div class="grid grid-2" style="align-items:start">
          <div><h3 style="margin:0 0 8px">Histórico de contatos</h3><ul class="linha-tempo">${f.historico.length ? f.historico.map((h) => html`<li>
            <strong>${rotuloCanal(h.canal)}</strong> · <span class="muted">${dataHora(h.criado_em)} · ${h.usuario_nome ?? ''}</span><div class="small">${h.descricao}</div></li>`)
            : html`<li class="muted">Nenhum contato registrado.</li>`}</ul></div>
          <div><h3 style="margin:0 0 8px">Promessas e acordos</h3><ul class="linha-tempo">
            ${f.promessas.map((p) => html`<li><strong>Promessa</strong> ${moeda(p.valor_centavos)} para ${data(p.data_prometida)} · <span class="badge ${p.status === 'cumprida' ? 'ok' : p.status === 'quebrada' ? 'danger' : 'warn'}">${p.status}</span></li>`)}
            ${f.acordos.map((a) => html`<li><strong>Acordo #${a.id}</strong> · ${dataHora(a.criado_em)}<div class="small">${moeda(a.valor_original_centavos)} renegociados por ${moeda(a.valor_acordo_centavos)} em ${a.parcelas}x a partir de ${data(a.primeiro_vencimento)}</div></li>`)}
            ${!f.promessas.length && !f.acordos.length ? html`<li class="muted">Nenhum.</li>` : ''}</ul></div>
        </div>`,
    });
    const reabrir = () => { fechar(); ficha(contatoId); };
    const titulosAbertos = f.titulos.filter((t) => t.atraso >= 0);
    $('#contato', m).addEventListener('click', () => modal({
      titulo: 'Registrar contato',
      corpo: html`<div class="form"><div class="c6"><label>Canal</label><select name="canal">${opcoes(CANAIS, { selecionado: 'ligacao' })}</select></div>
        <div class="c6"><label>Título (opcional)</label><select name="lancamento_id">${opcoes(f.titulos.map((t) => ({ id: t.id, nome: `${data(t.vencimento)} · ${moeda(t.valor_centavos)}` })), { vazio: 'Geral' })}</select></div>
        <div class="c12"><label>O que foi conversado</label><textarea name="descricao" required></textarea></div></div>`,
      aoEnviar: async (form, f2) => { await api.post(`${base}/cobranca/registros`, { ...dadosForm(form), contato_id: contatoId }); f2(); toast('Contato registrado.'); reabrir(); },
    }));
    $('#promessa', m).addEventListener('click', () => modal({
      titulo: 'Promessa de pagamento',
      corpo: html`<div class="form"><div class="c6"><label>Data prometida</label><input name="data_prometida" type="date" required value="${somarDias(hoje(), 3)}"></div>
        <div class="c6"><label>Valor (R$)</label><input name="valor" class="moeda" inputmode="numeric" value="${valorMoedaInput(titulosAbertos[0]?.valor_centavos ?? 0)}"></div>
        <div class="c12"><label>Título (a promessa vira "cumprida" quando ele for pago)</label><select name="lancamento_id">${opcoes(f.titulos.map((t) => ({ id: t.id, nome: `${data(t.vencimento)} · ${t.descricao} · ${moeda(t.valor_centavos)}` })), { vazio: 'Nenhum' })}</select></div>
        <div class="c12"><label>Observação</label><input name="observacao"></div></div>`,
      aoEnviar: async (form, f2) => {
        const d = dadosForm(form);
        await api.post(`${base}/cobranca/promessas`, { contato_id: contatoId, data_prometida: d.data_prometida, valor_centavos: centavos(d.valor), lancamento_id: d.lancamento_id || null, observacao: d.observacao });
        f2(); toast('Promessa registrada.'); reabrir();
      },
    }));
    $('#acordo', m).addEventListener('click', () => {
      const ids = $$('[data-titulo]:checked', m).map((x) => Number(x.dataset.titulo));
      if (!ids.length) { toast('Selecione os títulos vencidos que entram no acordo.', 'erro'); return; }
      const original = f.titulos.filter((t) => ids.includes(t.id)).reduce((a, t) => a + t.valor_centavos, 0);
      modal({
        titulo: 'Acordo de pagamento',
        corpo: html`<p style="margin-top:0">${ids.length} título(s) somando <strong>${moeda(original)}</strong>. Eles serão cancelados e substituídos pelas parcelas do acordo.</p>
          <div class="form"><div class="c6"><label>Valor total do acordo (R$)</label><input name="valor" class="moeda" inputmode="numeric" value="${valorMoedaInput(original)}"><div class="ajuda">Inclua juros ou desconto negociados.</div></div>
          <div class="c3"><label>Parcelas</label><input name="parcelas" type="number" min="1" max="60" value="1"></div>
          <div class="c3"><label>1º vencimento</label><input name="primeiro_vencimento" type="date" value="${somarDias(hoje(), 7)}"></div>
          <div class="c12"><label>Observação</label><input name="observacao"></div></div>`,
        rotuloEnviar: 'Fechar acordo',
        aoEnviar: async (form, f2) => {
          const d = dadosForm(form);
          const r = await api.post(`${base}/cobranca/acordos`, { contato_id: contatoId, lancamento_ids: ids, valor_centavos: centavos(d.valor), parcelas: Number(d.parcelas),
            primeiro_vencimento: d.primeiro_vencimento, observacao: d.observacao });
          f2(); toast(`Acordo #${r.acordo_id} registrado.`); reabrir();
        },
      });
    });
  }

  const abrir = () => { el().innerHTML = '<div class="carregando">Carregando…</div>'; return telas[aba]().catch((err) => { el().innerHTML = String(html`<div class="card vazio">${err.message}</div>`); }); };
  $$('[data-aba]', alvo).forEach((b) => b.addEventListener('click', () => {
    aba = b.dataset.aba;
    $$('[data-aba]', alvo).forEach((x) => x.classList.toggle('ativo', x === b));
    abrir();
  }));
  let cfg = await api.get(`${base}/cobranca/config`);
  const faixaConfig = () => {
    $('#cob-config', alvo).innerHTML = String(html`<div class="alerta ${cfg.lembrete_auto && cfg.email_configurado ? 'info' : 'aviso'}">${icone('email')}<div>
      ${!cfg.email_configurado ? html`O envio de e-mails não está configurado no servidor: os lembretes são enviados à mão (WhatsApp ou e-mail do seu computador).`
        : cfg.lembrete_auto ? html`<strong>Lembretes automáticos ligados:</strong> e-mail ${cfg.lembrete_dias_antes} dia(s) antes do vencimento, no dia e com 1, 7, 15 e 30 dias de atraso.`
          : html`Lembretes automáticos desligados. Ligue em "Configurar cobrança" para o sistema enviar os e-mails sozinho.`}</div></div>`);
  };
  faixaConfig();
  $('#pix', alvo).addEventListener('click', () => modal({
    titulo: 'Configurar cobrança',
    corpo: html`<div class="form">
      <div class="c12"><label class="linha-check"><input type="checkbox" name="auto" ${cfg.lembrete_auto ? 'checked' : ''} ${cfg.email_configurado ? '' : 'disabled'}> Enviar lembretes automáticos por e-mail aos clientes</label>
        ${cfg.email_configurado ? '' : html`<div class="ajuda">Disponível quando o e-mail (SMTP) estiver configurado no servidor.</div>`}</div>
      <div class="c6"><label>Dias antes do vencimento</label><input name="dias" type="number" min="0" max="15" value="${cfg.lembrete_dias_antes}"></div>
      <div class="c12"><label>Chave PIX da empresa (vai no texto dos lembretes)</label><input name="chave" value="${cfg.chave_pix_cobranca ?? ''}"></div></div>`,
    aoEnviar: async (form, fechar) => {
      const d = dadosForm(form);
      await api.patch(`${base}/cobranca/config`, { chave_pix_cobranca: d.chave, lembrete_auto: Boolean(d.auto), lembrete_dias_antes: Number(d.dias) });
      cfg = await api.get(`${base}/cobranca/config`);
      fechar(); toast('Cobrança configurada.'); faixaConfig();
    },
  }));
  await abrir();
}
