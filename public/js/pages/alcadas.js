import { api } from '../api.js';
import { html, $, $$, toast, confirmar, moeda, mascaraMoeda, centavos, valorMoedaInput } from '../ui.js';

const PERFIL = { gerente: 'Gerente', operador: 'Operador', ouvidoria: 'Ouvidoria' };

/** Alçadas: o administrador define o que gerente e operador podem fazer e até que valor. */
export default async function alcadas({ alvo, ativo }) {
  const dados = await api.get('/alcadas');
  if (!ativo()) return;
  desenhar(alvo, dados);
}

function celula(p, perfil) {
  const r = p.regras[perfil];
  const id = `${perfil}-${p.chave}`;
  const semTeto = r.limite_centavos === null;
  return html`<td class="alc-celula" data-perfil="${perfil}" data-chave="${p.chave}">
    <label class="alc-chave" for="${id}"><input type="checkbox" role="switch" id="${id}" data-permitido ${r.permitido ? 'checked' : ''}>
      <span>${r.permitido ? 'Pode' : 'Não pode'}</span></label>
    ${p.valor ? html`<div class="alc-valor" ${r.permitido ? '' : 'hidden'}>
      <label class="alc-sem" for="${id}-sem"><input type="checkbox" id="${id}-sem" data-sem-teto ${semTeto ? 'checked' : ''}> Sem limite de valor</label>
      <div class="alc-teto" ${semTeto ? 'hidden' : ''}><span class="small muted">Até R$</span>
        <input class="moeda" inputmode="numeric" data-teto aria-label="${p.ajuda_valor} para ${PERFIL[perfil]}" value="${valorMoedaInput(r.limite_centavos ?? 0)}"></div>
    </div>` : ''}
  </td>`;
}

function desenhar(alvo, { perfis, permissoes, analises }) {
  const grupos = [...new Set(permissoes.map((p) => p.grupo))];
  alvo.innerHTML = String(html`
    <div class="page-head"><div><h1>Alçadas</h1>
      <p class="muted">Defina o que cada perfil pode fazer, até que valor e quais ações precisam de análise da Ouvidoria. O administrador tem acesso total;
        gerenciar usuários e alçadas é exclusivo dele. As mudanças valem no próximo acesso de cada usuário e ficam registradas na auditoria.</p></div>
      <div class="row"><button class="btn" id="padrao">Restaurar padrão</button><button class="btn primario" id="salvar" disabled>Salvar alterações</button></div></div>
    <div class="card" style="margin-bottom:16px"><div class="card-head"><div><h2>Exigem análise da Ouvidoria</h2>
      <p class="small muted" style="margin:4px 0 0">Quando ligado, quem tem a alçada faz o pedido com motivo e a ação só acontece depois que a Ouvidoria aprovar. Pedidos de encerramento feitos pelo cliente no Internet Banking sempre vão para a Ouvidoria.</p></div></div>
      <div class="card-body alc-analises">${analises.map((a) => html`<label class="alc-chave alc-analise" for="an-${a.acao}">
        <input type="checkbox" role="switch" id="an-${a.acao}" data-analise="${a.acao}" ${a.exige ? 'checked' : ''}><span>${a.rotulo}</span></label>`)}</div></div>
    <div class="card"><div class="table-wrap"><table class="alc-tabela">
      <thead><tr><th>Permissão</th><th>Administrador</th>${perfis.map((pf) => html`<th>${PERFIL[pf]}</th>`)}</tr></thead>
      ${grupos.map((g) => html`<tbody>
        <tr class="alc-grupo"><th colspan="${perfis.length + 2}">${g}</th></tr>
        ${permissoes.filter((p) => p.grupo === g).map((p) => html`<tr>
          <td><strong>${p.rotulo}</strong>${p.valor ? html`<div class="small muted">${p.ajuda_valor}</div>` : ''}</td>
          <td><span class="badge ok">Pode</span>${p.valor ? html`<div class="small muted" style="margin-top:6px">Sem limite</div>` : ''}</td>
          ${perfis.map((pf) => celula(p, pf))}
        </tr>`)}
      </tbody>`)}
    </table></div></div>
    <div class="card card-body small muted" style="margin-top:16px">Valores de referência atuais:
      ${perfis.map((pf) => html`<span style="margin-left:10px"><strong>${PERFIL[pf]}</strong>: ${resumo(permissoes, pf)}</span>`)}</div>`);

  $$('.moeda', alvo).forEach(mascaraMoeda);
  const salvar = $('#salvar', alvo);
  const marcarAlterado = () => { salvar.disabled = false; };
  $$('.alc-celula', alvo).forEach((td) => {
    const permitido = $('[data-permitido]', td);
    const valor = $('.alc-valor', td);
    const sem = $('[data-sem-teto]', td);
    permitido.addEventListener('change', () => {
      td.querySelector('.alc-chave span').textContent = permitido.checked ? 'Pode' : 'Não pode';
      if (valor) valor.hidden = !permitido.checked;
      marcarAlterado();
    });
    sem?.addEventListener('change', () => { $('.alc-teto', td).hidden = sem.checked; marcarAlterado(); });
    $('[data-teto]', td)?.addEventListener('input', marcarAlterado);
  });
  $$('[data-analise]', alvo).forEach((i) => i.addEventListener('change', marcarAlterado));

  salvar.onclick = async () => {
    const corpo = Object.fromEntries(perfis.map((pf) => [pf, {}]));
    corpo.analises = Object.fromEntries($$('[data-analise]', alvo).map((i) => [i.dataset.analise, i.checked]));
    for (const td of $$('.alc-celula', alvo)) {
      const permitido = $('[data-permitido]', td).checked;
      const sem = $('[data-sem-teto]', td);
      corpo[td.dataset.perfil][td.dataset.chave] = {
        permitido,
        limite_centavos: sem && !sem.checked ? centavos($('[data-teto]', td).value) : null,
      };
    }
    salvar.disabled = true;
    try {
      const r = await api.put('/alcadas', corpo);
      toast(r.alteradas ? `${r.alteradas} ${r.alteradas === 1 ? 'regra alterada' : 'regras alteradas'}.` : 'Nenhuma alteração.');
      desenhar(alvo, r);
    } catch (err) {
      toast(err.message, 'erro');
      salvar.disabled = false;
    }
  };

  $('#padrao', alvo).onclick = async () => {
    if (!(await confirmar('Restaurar padrão', 'Todas as regras de gerente, operador e ouvidoria, e as análises da Ouvidoria, voltam ao padrão do sistema.', 'Restaurar'))) return;
    try {
      const r = await api.post('/alcadas/restaurar-padrao');
      toast('Alçadas restauradas ao padrão.');
      desenhar(alvo, r);
    } catch (err) { toast(err.message, 'erro'); }
  };
}

function resumo(permissoes, perfil) {
  const comValor = permissoes.filter((p) => p.valor && p.regras[perfil].permitido);
  if (!comValor.length) return 'nenhuma alçada de valor';
  return comValor.map((p) => `${p.rotulo.toLowerCase()} ${p.regras[perfil].limite_centavos === null ? 'sem limite' : `até ${moeda(p.regras[perfil].limite_centavos)}`}`).join('; ');
}
