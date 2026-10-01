import { api } from '../api.js';
import { pode } from '../contexto.js';
import { html, raw, $, $$, moeda, dataHora, modal, toast, centavos } from '../ui.js';
import { seletor, ligarSeletor } from './seletores.js';

const MODOS = { simulador: 'Simulador', sandbox: 'Sandbox (homologação)', producao: 'Produção' };
const ST_COB = { ativa: 'Aguardando pagamento', concluida: 'Paga', expirada: 'Expirada', cancelada: 'Cancelada' };
const ST_SAIDA = { processando: 'Processando', concluido: 'Concluído', falhou: 'Falhou' };
const CLASSE = { ativa: 'warn', concluida: 'ok', expirada: '', cancelada: '', processando: 'warn', concluido: 'ok', falhou: 'danger' };
const pilula = (mapa, s) => html`<span class="badge ${CLASSE[s] ?? ''}">${mapa[s] ?? s}</span>`;

let statusCache = null;
export async function statusBradesco() {
  if (!statusCache) statusCache = await api.get('/integracoes/bradesco/status');
  return statusCache;
}

async function copiar(texto, campo) {
  try {
    await navigator.clipboard.writeText(texto);
    toast('Código PIX copiado.');
  } catch {
    campo.focus();
    campo.select();
    toast('Selecione e copie o código (Ctrl+C).');
  }
}

/** Mostra a cobrança PIX (QR Code + copia e cola) e, no simulador, permite simular o pagamento. */
export async function mostrarCobranca(txid, aoPagar) {
  const [c, st] = await Promise.all([api.get(`/integracoes/bradesco/cobrancas/${txid}`), statusBradesco()]);
  const { el, fechar } = modal({
    titulo: `Cobrança PIX · ${moeda(c.valor_centavos)}`,
    corpo: html`<div class="stack" style="align-items:center;text-align:center">
      <div>${pilula(ST_COB, c.status)} <span class="small muted">Conta ${c.numero}-${c.digito} · ${c.cliente_nome}</span></div>
      ${c.qr_svg ? html`<div class="qr-pix" aria-label="QR Code PIX">${raw(c.qr_svg)}</div>` : ''}
      <div style="width:100%;text-align:left"><label for="pix-copia">PIX copia e cola</label>
        <div class="row" style="flex-wrap:nowrap"><input id="pix-copia" readonly value="${c.pix_copia_e_cola ?? ''}" class="mono small"><button type="button" class="btn" id="copiar">Copiar</button></div>
        <div class="ajuda">Válido até ${dataHora(c.expira_em)} · txid <span class="mono">${c.txid}</span></div></div>
      <p class="small muted" style="margin:0">O valor entra na conta do cliente assim que o Bradesco confirmar o pagamento.</p>
    </div>`,
    rodape: html`<div class="modal-foot">
      ${st.modo === 'simulador' && c.status === 'ativa' ? html`<button class="btn ouro" id="simular">Simular pagamento</button>` : ''}
      <button class="btn primario" data-cancelar>Fechar</button></div>`,
  });
  $('#copiar', el).onclick = () => copiar(c.pix_copia_e_cola, $('#pix-copia', el));
  const sim = $('#simular', el);
  if (sim) sim.onclick = async () => {
    sim.disabled = true;
    try {
      const r = await api.post(`/integracoes/bradesco/cobrancas/${txid}/simular-pagamento`);
      toast(r.creditados ? `Pagamento confirmado: ${moeda(c.valor_centavos)} creditado.` : 'PIX recebido, mas ficou pendente de vínculo.');
      fechar();
      aoPagar?.();
    } catch (e) { toast(e.message, 'erro'); sim.disabled = false; }
  };
}

/** Formulário para gerar cobrança PIX para a conta informada. */
export function receberViaPix(contaSel, aoPagar) {
  modal({
    titulo: 'Receber via PIX (Bradesco)',
    rotuloEnviar: 'Gerar QR Code',
    corpo: html`<div class="form">
      <div class="c12"><label>Conta de crédito</label><input readonly value="${contaSel.agencia} / ${contaSel.numero}-${contaSel.digito} · ${contaSel.cliente_nome}"></div>
      <div class="c6"><label for="valor-cob">Valor (R$)</label><input id="valor-cob" name="valor" class="moeda" inputmode="numeric" value="0,00"></div>
      <div class="c12 ajuda">O pagador paga para a conta PAY AX no Bradesco; o Banqueiro identifica a cobrança e credita esta conta.</div></div>`,
    aoEnviar: async (form, fechar) => {
      const valor = centavos(form.valor.value);
      if (valor <= 0) throw new Error('Informe um valor maior que zero.');
      const c = await api.post('/integracoes/bradesco/cobrancas', { conta_id: contaSel.id, valor_centavos: valor });
      fechar();
      mostrarCobranca(c.txid, aoPagar);
    },
  });
}

function vincular(pix, aoConcluir) {
  modal({
    titulo: `Vincular PIX de ${moeda(pix.valor_centavos)}`,
    rotuloEnviar: 'Creditar na conta',
    corpo: html`<p style="margin-top:0">${pix.pagador_nome ?? 'Pagador não informado'} · recebido em ${dataHora(pix.recebido_em || pix.criado_em)}<br>
      <span class="small muted">Motivo da pendência: ${pix.motivo}</span></p>
      ${seletor('conta', 'Conta que deve receber o valor', 'Buscar conta por número ou titular')}`,
    aoAbrir: (el) => ligarSeletor(el, 'conta', 'conta'),
    aoEnviar: async (form, fechar) => {
      if (!form.conta.value) throw new Error('Selecione a conta.');
      await api.post(`/integracoes/bradesco/recebidos/${pix.id}/vincular`, { conta_id: Number(form.conta.value) });
      fechar(); toast('PIX creditado na conta.'); aoConcluir();
    },
  });
}

export default async function bradesco({ alvo, ativo }) {
  const [c, st] = await Promise.all([api.get('/integracoes/bradesco/conciliacao'), statusBradesco()]);
  if (!ativo()) return;
  const dif = c.diferenca_centavos;
  const difClasse = dif === null ? '' : dif === 0 ? 'verde' : dif > 0 ? 'azul' : 'vermelho';
  const difTexto = dif === null ? 'Saldo do banco indisponível'
    : dif === 0 ? 'Conciliado: o saldo no banco cobre exatamente o saldo dos clientes.'
      : dif > 0 ? 'Sobra no banco: recursos próprios da PAY AX ou valores a identificar.'
        : 'Falta no banco: limites usados pelos clientes ou lançamentos a conferir.';
  alvo.innerHTML = String(html`
    <div class="page-head"><div><h1>Bradesco</h1>
      <p class="muted">Conta PJ da PAY AX · chave PIX <span class="mono">${st.chave_pix}</span> · <span class="badge ${st.modo === 'producao' ? 'ok' : 'warn'}">${MODOS[st.modo] ?? st.modo}</span></p></div>
      <div class="row">
        ${st.modo === 'simulador' ? html`<button class="btn" id="avulso">Simular PIX sem cobrança</button>` : ''}
        <button class="btn primario" id="sincronizar">Sincronizar recebimentos</button></div></div>
    ${c.avisos.length ? html`<div class="card card-body" style="margin-bottom:16px;background:var(--warn-bg);color:var(--warn);border:0">${c.avisos.map((a) => html`<div>${a}</div>`)}</div>` : ''}
    <div class="grid grid-3">
      <div class="card kpi azul"><div class="rotulo">Saldo na conta Bradesco</div><div class="valor">${c.saldo_bradesco_centavos === null ? '—' : moeda(c.saldo_bradesco_centavos)}</div><div class="sub">Conta única PAY AX</div></div>
      <div class="card kpi"><div class="rotulo">Saldo dos clientes no Banqueiro</div><div class="valor">${moeda(c.clientes_total_centavos)}</div>
        <div class="sub">Credores ${moeda(c.clientes_credores_centavos)} · devedores ${moeda(c.clientes_devedores_centavos)}</div></div>
      <div class="card kpi ${difClasse}"><div class="rotulo">Diferença</div><div class="valor">${dif === null ? '—' : moeda(dif)}</div><div class="sub">${difTexto}</div></div>
    </div>
    ${c.sem_vinculo.length ? html`<div class="card" style="margin-top:16px;border-color:var(--warn)"><div class="card-head"><h2>PIX recebidos sem identificação (${c.sem_vinculo.length})</h2><span class="small muted">Entraram no Bradesco, mas ainda não foram creditados a nenhum cliente.</span></div>
      <div class="table-wrap"><table><thead><tr><th>Recebido</th><th>Pagador</th><th>Motivo</th><th class="num">Valor</th><th></th></tr></thead><tbody>
      ${c.sem_vinculo.map((p) => html`<tr><td class="small">${dataHora(p.recebido_em || p.criado_em)}</td><td>${p.pagador_nome ?? '—'}<div class="small muted mono">${p.end_to_end_id}</div></td>
        <td class="small">${p.motivo}</td><td class="num">${moeda(p.valor_centavos)}</td>
        <td class="right"><button class="btn sm ouro" data-vincular="${p.id}">Vincular a uma conta</button></td></tr>`)}
      </tbody></table></div></div>` : ''}
    <div class="grid grid-2" style="margin-top:16px">
      <div class="card"><div class="card-head"><h2>Cobranças PIX recentes</h2></div><div class="table-wrap"><table>
        <thead><tr><th>Criada</th><th>Cliente / conta</th><th class="num">Valor</th><th>Situação</th></tr></thead><tbody>
        ${c.cobrancas.length ? c.cobrancas.map((x) => html`<tr class="clicavel" data-txid="${x.txid}"><td class="small">${dataHora(x.criado_em)}</td><td>${x.cliente_nome}<div class="small muted">Conta ${x.conta}</div></td>
          <td class="num">${moeda(x.valor_centavos)}</td><td>${pilula(ST_COB, x.status)}</td></tr>`)
          : html`<tr><td colspan="4" class="vazio">Nenhuma cobrança. Gere uma em Contas → “Receber via PIX”.</td></tr>`}
        </tbody></table></div></div>
      <div class="card"><div class="card-head"><h2>PIX enviados a outros bancos</h2></div><div class="table-wrap"><table>
        <thead><tr><th>Data</th><th>Cliente / chave</th><th class="num">Valor</th><th>Situação</th></tr></thead><tbody>
        ${c.saidas.length ? c.saidas.map((x) => html`<tr><td class="small">${dataHora(x.criado_em)}</td><td>${x.cliente_nome}<div class="small muted">${x.chave}${x.erro ? ` · ${x.erro}` : ''}</div></td>
          <td class="num">${moeda(x.valor_centavos)}</td><td>${pilula(ST_SAIDA, x.status)}</td></tr>`)
          : html`<tr><td colspan="4" class="vazio">Nenhum PIX enviado para fora.</td></tr>`}
        </tbody></table></div></div>
    </div>
    <div class="card" style="margin-top:16px"><div class="card-head"><h2>Extrato Bradesco · últimos 30 dias</h2><span class="small muted">“Conciliado” = lançamento identificado no Banqueiro</span></div>
      <div class="table-wrap"><table><thead><tr><th>Data</th><th>Descrição</th><th class="num">Valor</th><th>Conciliação</th></tr></thead><tbody>
      ${c.extrato === null ? html`<tr><td colspan="4" class="vazio">Extrato indisponível neste modo.</td></tr>`
        : c.extrato.length ? c.extrato.map((m) => html`<tr><td class="small">${dataHora(m.data)}</td><td>${m.descricao}${m.end_to_end_id ? html`<div class="small muted mono">${m.end_to_end_id}</div>` : ''}</td>
          <td class="num ${m.natureza === 'D' ? 'neg' : 'pos'}">${m.natureza === 'D' ? '-' : '+'}${moeda(m.valor_centavos)}</td>
          <td>${m.conciliado ? html`<span class="badge ok">Conciliado</span>` : html`<span class="badge danger">Não identificado</span>`}</td></tr>`)
          : html`<tr><td colspan="4" class="vazio">Sem movimentos.</td></tr>`}
      </tbody></table></div></div>
    ${pode('admin') ? html`<div class="card card-body" style="margin-top:16px"><h3>Configuração</h3>
      <p class="muted small" style="margin:6px 0 0">O modo, as credenciais e o certificado digital são definidos por variáveis de ambiente no servidor (veja o README). O webhook PIX deve ser cadastrado no Bradesco apontando para
      <span class="mono">https://SEU-DOMINIO/api/integracoes/bradesco/webhook?token=…</span>${st.webhook_protegido ? '' : html` <strong class="neg">— defina BRADESCO_WEBHOOK_TOKEN antes de ir para produção.</strong>`}</p></div>` : ''}`);

  const recarregar = () => bradesco({ alvo, ativo });
  $$('[data-txid]', alvo).forEach((tr) => tr.addEventListener('click', () => mostrarCobranca(tr.dataset.txid, recarregar)));
  $$('[data-vincular]', alvo).forEach((b) => b.addEventListener('click', () => vincular(c.sem_vinculo.find((p) => String(p.id) === b.dataset.vincular), recarregar)));
  $('#sincronizar', alvo).onclick = async (e) => {
    e.target.disabled = true;
    try {
      const r = await api.post('/integracoes/bradesco/sincronizar');
      toast(`Sincronizado: ${r.creditados} creditado(s), ${r.sem_vinculo} pendente(s), ${r.duplicados} já processado(s).`);
      recarregar();
    } catch (err) { toast(err.message, 'erro'); e.target.disabled = false; }
  };
  const av = $('#avulso', alvo);
  if (av) av.onclick = () => modal({
    titulo: 'Simular PIX sem cobrança',
    rotuloEnviar: 'Simular recebimento',
    corpo: html`<p style="margin-top:0" class="muted">Simula alguém pagando direto a chave PIX da PAY AX, sem QR Code de cobrança. O valor entra no Bradesco e fica pendente de vínculo.</p>
      <label for="valor-avulso">Valor (R$)</label><input id="valor-avulso" name="valor" class="moeda" inputmode="numeric" value="0,00">`,
    aoEnviar: async (form, fechar) => {
      const valor = centavos(form.valor.value);
      if (valor <= 0) throw new Error('Informe um valor maior que zero.');
      await api.post('/integracoes/bradesco/simular-pix-avulso', { valor_centavos: valor });
      fechar(); toast('PIX recebido no Bradesco e aguardando vínculo.'); recarregar();
    },
  });
}
