import { api } from '../api.js';
import { el, limpar, pode, cabecalho, painel, tabela, etq, rotulo, opcoes, dinheiro, numero, velocidade, carregar, formulario, botao, toast, faixa } from '../ui.js';

export default async function planos({ alvo }) {
  const corpo = el('div');
  const mostrarInativos = el('label', { class: 'check' }, el('input', { type: 'checkbox', onchange: (e) => { estado.inativos = e.target.checked; atualizar(); } }), 'Mostrar planos inativos');
  const estado = { inativos: false };

  limpar(alvo, cabecalho({
    sobretitulo: 'Assinantes e financeiro',
    titulo: 'Planos',
    descricao: 'A tabela comercial. Alterar um plano nunca altera o que já foi contratado: cada contrato guarda a própria mensalidade.',
    acoes: [pode('planos.editar') ? botao('Novo plano', () => editar(null, atualizar), { ic: 'mais' }) : null],
  }), el('div', { class: 'filtros' }, mostrarInativos), corpo);

  function atualizar() {
    return carregar(corpo, () => api.get(`/planos${estado.inativos ? '?ativos=0' : ''}`), (lista) => painel(null, tabela([
      { titulo: 'Plano', valor: (p) => el('div', {}, el('div', { class: 'forte' }, p.nome),
        el('div', { class: 'fraco' }, [rotulo('tipoPlano', p.tipo), p.tecnologia ? rotulo('tecnologia', p.tecnologia) : null, p.descricao].filter(Boolean).join(' · '))) },
      { titulo: 'Velocidade', valor: (p) => velocidade(p.download_mbps, p.upload_mbps), classe: 'num' },
      { titulo: 'Mensalidade', valor: (p) => dinheiro(p.mensalidade_centavos), classe: 'num' },
      { titulo: 'Instalação', valor: (p) => (p.instalacao_centavos ? dinheiro(p.instalacao_centavos) : el('span', { class: 'fraco' }, 'Isenta')), classe: 'num' },
      { titulo: 'Fidelidade', valor: (p) => (p.fidelidade_meses ? `${numero(p.fidelidade_meses)} meses` : el('span', { class: 'fraco' }, 'Sem fidelidade')), classe: 'num' },
      { titulo: 'Contratos', valor: (p) => numero(p.contratos), classe: 'num' },
      { titulo: 'Situação', valor: (p) => (p.ativo ? etq('Ativo', 'ok') : etq('Inativo', 'neutra')) },
      { titulo: '', valor: (p) => (pode('planos.editar') ? el('button', { class: 'botao secundario pequeno', onclick: () => editar(p, atualizar) }, 'Editar') : '') },
    ], lista, { vazioTexto: 'Nenhum plano cadastrado.' }), { semCorpo: true }));
  }
  atualizar();
}

function editar(p, depois) {
  return formulario(p ? `Plano ${p.nome}` : 'Novo plano', [
    { nome: 'nome', rotulo: 'Nome', obrigatorio: true, valor: p?.nome, inteiro: true },
    { nome: 'tipo', rotulo: 'Tipo', tipo: 'select', vazio: false, opcoes: opcoes('tipoPlano'), valor: p?.tipo ?? 'internet' },
    { nome: 'tecnologia', rotulo: 'Tecnologia', tipo: 'select', vazio: 'Não se aplica', opcoes: opcoes('tecnologia'), valor: p?.tecnologia },
    { nome: 'download_mbps', rotulo: 'Download (Mbps)', tipo: 'number', valor: p?.download_mbps, ajuda: 'Obrigatório em planos de internet e combo.' },
    { nome: 'upload_mbps', rotulo: 'Upload (Mbps)', tipo: 'number', valor: p?.upload_mbps },
    { nome: 'mensalidade', rotulo: 'Mensalidade (R$)', tipo: 'decimal', obrigatorio: true, valor: p ? (p.mensalidade_centavos / 100).toFixed(2).replace('.', ',') : '' },
    { nome: 'instalacao', rotulo: 'Taxa de instalação (R$)', tipo: 'decimal', valor: p ? (p.instalacao_centavos / 100).toFixed(2).replace('.', ',') : '0,00',
      ajuda: 'Cobrada uma única vez, na primeira fatura do contrato.' },
    { nome: 'fidelidade_meses', rotulo: 'Fidelidade (meses)', tipo: 'number', valor: p?.fidelidade_meses ?? 0 },
    { nome: 'descricao', rotulo: 'Descrição', tipo: 'textarea', valor: p?.descricao, inteiro: true },
    p ? { nome: 'ativo', rotulo: 'Plano disponível para novos contratos', tipo: 'checkbox', valor: Boolean(p.ativo), inteiro: true } : null,
  ], {
    largo: true,
    antes: p?.contratos ? faixa(`${p.contratos} contrato(s) usam este plano. A alteração vale para contratos novos; os em vigor mantêm o valor contratado.`, '', 'info') : null,
    enviar: async (d) => {
      const corpo = { ...d, download_mbps: d.download_mbps || null, upload_mbps: d.upload_mbps || null, tecnologia: d.tecnologia || null };
      const r = p ? await api.patch(`/planos/${p.id}`, { ...corpo, versao: p.versao }) : await api.post('/planos', corpo);
      toast(r.aviso ?? 'Plano salvo.');
      depois?.();
      return r;
    },
  });
}
