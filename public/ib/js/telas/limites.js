import { api } from '../api.js';
import { html, $, moeda, dataHora, modal, toast, mascaraMoeda, centavos, valorMoedaInput } from '../../../js/ui.js';
import { confirmarComPin, linhaRecibo, rotuloConta, carregarResumo } from '../comum.js';
import { ligarContagens, restante } from '../../../js/prazo.js';

const STATUS = { agendado: ['Aguardando 24 h', 'warn'], efetivado: ['Em vigor', 'ok'], cancelado: ['Cancelado', ''], recusado: ['Não aprovado', 'danger'] };

/** Meus limites (aba do PIX): limite diário (com pedido de aumento em 24 horas e contagem regressiva) e cheque especial das contas. */
export default async function limites(alvo) {
  const r = await api.get('/limites');
  const d = r.diario;
  const p = d.pedido;
  alvo.innerHTML = String(html`
    ${p ? html`<div class="card card-body pedido-limite" style="margin-bottom:16px">
      <div><strong>Aumento de limite agendado: ${moeda(p.valor_atual_centavos)} → ${moeda(p.valor_novo_centavos)}</strong>
        <div class="tempo-restante">Falta <strong data-prazo-ate="${p.efetiva_em}">${restante(p.efetiva_em)}</strong> para o novo limite entrar em vigor</div>
        <div class="small muted">Pedido em ${dataHora(p.criado_em)} · em vigor a partir de ${dataHora(p.efetiva_em)}</div>
        <div class="barra-h" style="margin-top:10px"><span data-prazo-barra="${p.efetiva_em}" data-desde="${p.criado_em}"></span></div></div>
      <button class="btn sm" id="cancelar-pedido">Cancelar pedido</button></div>` : ''}

    <div class="grid grid-2">
      <div class="card card-body stack">
        <div><h2>Limite diário</h2><p class="small muted" style="margin:4px 0 0">Vale para PIX, transferências e pagamentos feitos no Internet Banking, somados por dia.</p></div>
        <div class="limites-grade" style="grid-template-columns:repeat(3,minmax(0,1fr))">
          <div><div class="rotulo">Limite</div><strong>${moeda(d.limite_centavos)}</strong></div>
          <div><div class="rotulo">Usado hoje</div><strong>${moeda(d.usado_centavos)}</strong></div>
          <div><div class="rotulo">Disponível hoje</div><strong>${moeda(d.disponivel_centavos)}</strong></div></div>
        <div class="barra-h"><span style="width:${Math.min(100, (d.usado_centavos / Math.max(1, d.limite_centavos)) * 100).toFixed(1)}%"></span></div>
      </div>
      <form class="card card-body stack" id="form-limite" novalidate>
        <div><h2>Alterar limite diário</h2>
          <p class="small muted" style="margin:4px 0 0">Reduções valem na hora. Por segurança, aumentos entram em vigor <strong>24 horas</strong> depois do pedido.
            Pelo Internet Banking o limite vai até ${moeda(d.maximo_centavos)}; para mais, fale com seu gerente.</p></div>
        <div><label for="novo-limite">Novo limite diário (R$)</label><input id="novo-limite" class="moeda valor-grande" inputmode="numeric" value="${valorMoedaInput(d.limite_centavos)}"></div>
        <div class="small" id="aviso-limite"></div>
        <button class="btn primario" type="submit" ${p ? 'disabled' : ''}>${p ? 'Há um aumento agendado' : 'Continuar'}</button>
      </form>
    </div>

    <div class="card" style="margin-top:16px"><div class="card-head"><h2>Cheque especial das contas</h2><a class="small" href="#/gerente">Pedir alteração ao gerente</a></div>
      <div class="table-wrap"><table><tbody>${r.contas.map((c) => html`<tr><td>${rotuloConta(c)}</td>
        <td class="num"><strong>${c.tipo === 'poupanca' ? 'Não se aplica' : moeda(c.limite_centavos)}</strong></td></tr>`)}</tbody></table></div></div>

    <div class="card" style="margin-top:16px"><div class="card-head"><h2>Pedidos de alteração</h2></div>
      <div class="table-wrap"><table><thead><tr><th>Pedido em</th><th>De</th><th>Para</th><th>Vigência</th><th>Situação</th></tr></thead><tbody>
      ${r.pedidos.length ? r.pedidos.map((x) => html`<tr><td class="small">${dataHora(x.criado_em)}</td><td class="num">${moeda(x.valor_atual_centavos)}</td>
        <td class="num"><strong>${moeda(x.valor_novo_centavos)}</strong></td>
        <td class="small">${x.status === 'agendado' ? html`em <span data-prazo-ate="${x.efetiva_em}">${restante(x.efetiva_em)}</span>` : x.status === 'efetivado' ? dataHora(x.concluido_em) : '—'}</td>
        <td><span class="badge ${STATUS[x.status][1]}">${STATUS[x.status][0]}</span></td></tr>`)
        : html`<tr><td colspan="5" class="vazio">Nenhum pedido ainda.</td></tr>`}</tbody></table></div></div>`);

  const recarregar = () => limites(alvo);
  ligarContagens(alvo, recarregar);
  const input = $('#novo-limite', alvo);
  mascaraMoeda(input);
  const aviso = $('#aviso-limite', alvo);
  const atualizarAviso = () => {
    const novo = centavos(input.value);
    aviso.className = 'small';
    if (novo > d.maximo_centavos) { aviso.textContent = `Acima do máximo de ${moeda(d.maximo_centavos)} pelo Internet Banking.`; aviso.classList.add('neg'); }
    else if (novo > d.limite_centavos) aviso.textContent = `Aumento: o novo limite entra em vigor em 24 horas.`;
    else if (novo < d.limite_centavos) aviso.textContent = 'Redução: vale imediatamente.';
    else aviso.textContent = '';
  };
  // A máscara de moeda trata a digitação no beforeinput: o aviso acompanha pelas teclas soltas.
  ['input', 'keyup', 'paste'].forEach((ev) => input.addEventListener(ev, () => setTimeout(atualizarAviso, 0)));
  atualizarAviso();

  $('#form-limite', alvo).addEventListener('submit', async (e) => {
    e.preventDefault();
    const novo = centavos(input.value);
    if (novo === d.limite_centavos) { toast('Informe um valor diferente do limite atual.', 'erro'); return; }
    const aumento = novo > d.limite_centavos;
    const res = await confirmarComPin({
      titulo: aumento ? 'Confirmar aumento de limite' : 'Confirmar redução de limite',
      resumo: html`<div class="recibo">${linhaRecibo('Limite atual', moeda(d.limite_centavos))}${linhaRecibo('Novo limite', moeda(novo))}
        ${linhaRecibo('Vigência', aumento ? 'em 24 horas' : 'imediata')}</div>`,
      executar: (pin) => api.post('/limites/diario', { valor_centavos: novo, pin }),
    });
    if (!res) return;
    await carregarResumo();
    if (res.imediato) toast('Limite reduzido. Já está valendo.');
    else modal({
      titulo: 'Pedido de aumento registrado',
      corpo: html`<p style="margin-top:0">Seu novo limite diário de <strong>${moeda(novo)}</strong> entra em vigor em <strong>24 horas</strong>, em ${dataHora(res.pedido.efetiva_em)}.</p>
        <p class="small muted">Você acompanha o tempo que falta nesta tela e pode cancelar o pedido até lá.</p>`,
      rodape: html`<div class="modal-foot"><button class="btn primario" data-cancelar>Entendi</button></div>`,
    });
    recarregar();
  });

  const cancelar = $('#cancelar-pedido', alvo);
  if (cancelar) cancelar.onclick = async () => {
    cancelar.disabled = true;
    try { await api.post(`/limites/pedidos/${p.id}/cancelar`); toast('Pedido cancelado.'); recarregar(); } catch (err) { toast(err.message, 'erro'); cancelar.disabled = false; }
  };
}
