import { api } from '../api.js';
import { html, $, $$, moeda, conta, modal, toast, dadosForm, centavos, icone } from '../ui.js';
import { seletor, ligarSeletor } from './seletores.js';

const OPS = {
  deposito: { titulo: 'Depósito', desc: 'Crédito em espécie na conta do cliente.', icone: 'baixar', origem: 'Conta de crédito' },
  saque: { titulo: 'Saque', desc: 'Retirada em espécie, respeitando saldo + limite.', icone: 'emprestimos', origem: 'Conta de débito' },
  transferencia: { titulo: 'Transferência', desc: 'Entre contas PAY AX por agência e número.', icone: 'operacoes', origem: 'Conta de origem' },
  pix: { titulo: 'PIX', desc: 'Para clientes PAY AX ou qualquer banco (via Bradesco).', icone: 'pix', origem: 'Conta de origem' },
};

/** Abre o formulário da operação. Se `contaSel` vier preenchida, a conta fica fixa. */
export function formOperacao(tipo, contaSel, aoConcluir) {
  const op = OPS[tipo];
  let origem = contaSel ?? null;
  modal({
    titulo: op.titulo,
    rotuloEnviar: `Confirmar ${op.titulo.toLowerCase()}`,
    corpo: html`<div class="form">
      <div class="c12">${contaSel
        ? html`<label>${op.origem}</label><input readonly value="${conta(contaSel)} · ${contaSel.cliente_nome} · saldo ${moeda(contaSel.saldo_centavos)}"><input type="hidden" name="conta" value="${contaSel.id}">`
        : seletor('conta', op.origem, 'Buscar por número da conta, titular ou documento')}</div>
      ${tipo === 'transferencia' ? html`
        <div class="c4"><label>Agência destino</label><input name="destino_agencia" value="0001" inputmode="numeric"></div>
        <div class="c8"><label>Conta destino (número-dígito)</label><input name="destino_numero" placeholder="100001-5" required></div>` : ''}
      ${tipo === 'pix' ? html`<div class="c12"><label>Chave PIX de destino</label><input name="chave" placeholder="CPF/CNPJ, e-mail, telefone ou chave aleatória" required>
        <div class="ajuda">Chaves de clientes PAY AX são liquidadas na hora; chaves de outros bancos saem pela conta PAY AX no Bradesco.</div></div>` : ''}
      <div class="c6"><label>Valor (R$)</label><input name="valor" class="moeda" inputmode="numeric" value="0,00" required></div>
      <div class="c6"><label>Descrição (opcional)</label><input name="descricao" maxlength="140"></div>
      <div class="c12 ajuda" id="disp">${origem && tipo !== 'deposito' ? `Disponível (saldo + limite): ${moeda(origem.saldo_centavos + origem.limite_centavos)}` : ''}</div>
    </div>`,
    aoAbrir: (el) => {
      if (!contaSel) {
        ligarSeletor(el, 'conta', 'conta', {
          aoSelecionar: (c) => {
            origem = c;
            if (tipo !== 'deposito' && c) $('#disp', el).textContent = `Disponível (saldo + limite): ${moeda(c.saldo_centavos + c.limite_centavos)}`;
          },
        });
      }
    },
    aoEnviar: async (form, fechar) => {
      const d = dadosForm(form);
      const contaId = Number(d.conta);
      if (!contaId) throw new Error('Selecione a conta.');
      const valor = centavos(d.valor);
      if (valor <= 0) throw new Error('Informe um valor maior que zero.');
      let r;
      if (tipo === 'deposito' || tipo === 'saque') {
        r = await api.post(`/operacoes/${tipo}`, { conta_id: contaId, valor_centavos: valor, descricao: d.descricao });
        toast(`${op.titulo} de ${moeda(valor)} realizado. Novo saldo: ${moeda(r.saldo_centavos)}.`);
      } else if (tipo === 'transferencia') {
        r = await api.post('/operacoes/transferencia', { origem_conta_id: contaId, destino_agencia: d.destino_agencia, destino_numero: d.destino_numero, valor_centavos: valor, descricao: d.descricao });
        toast(`Transferência de ${moeda(valor)} concluída.`);
      } else {
        r = await api.post('/operacoes/pix', { origem_conta_id: contaId, chave: d.chave, valor_centavos: valor, descricao: d.descricao });
        toast(r.externo
          ? `PIX de ${moeda(valor)} enviado via Bradesco para ${r.chave}.`
          : `PIX de ${moeda(valor)} enviado para ${r.destino.nome.replace(/\.$/, '')}.`);
      }
      fechar();
      aoConcluir?.(r);
    },
  });
}

export default async function operacoes({ alvo }) {
  alvo.innerHTML = String(html`
    <div class="page-head"><div><h1>Operações</h1><p class="muted">Movimentações de caixa e transferências entre contas.</p></div></div>
    <div class="grid grid-4">
      ${Object.entries(OPS).map(([k, o]) => html`<button class="card card-body" data-op="${k}" style="text-align:left;cursor:pointer;font:inherit;color:inherit">
        <div class="avatar" style="background:${k === 'deposito' ? 'var(--payax-ouro)' : 'var(--payax-azul-2)'};color:${k === 'deposito' ? 'var(--payax-azul)' : '#fff'};width:40px;height:40px;border-radius:10px">${icone(o.icone)}</div>
        <h2 style="margin-top:12px">${o.titulo}</h2><p class="muted" style="margin:4px 0 0">${o.desc}</p></button>`)}
    </div>
    <div class="card card-body" style="margin-top:16px">
      <h3>Regras operacionais</h3>
      <ul class="muted" style="margin:8px 0 0;padding-left:18px">
        <li>Somente contas <strong>ativas</strong> de clientes <strong>ativos</strong> podem movimentar.</li>
        <li>Débitos respeitam o saldo disponível (saldo + limite de cheque especial).</li>
        <li>Operações acima da alçada do operador exigem perfil gerente ou administrador.</li>
        <li>Estornos são feitos por gerentes no extrato da conta e revertem origem e destino.</li>
        <li>Todas as operações são registradas na trilha de auditoria.</li>
      </ul>
    </div>`);
  $$('[data-op]', alvo).forEach((b) => b.addEventListener('click', () => formOperacao(b.dataset.op, null, (r) => {
    if (r?.grupo) location.hash = '#/transacoes';
  })));
}
