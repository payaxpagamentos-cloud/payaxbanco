import { api, abrirAnexo, baixar, qs } from '../api.js';
import { el, limpar, pode, usuario, cabecalho, painel, tabela, paginacao, abas, etq, rotulo, dataHora, data, hoje, toast, acao, carregar, formulario, modal, dl,
  botao, faixa, dinheiro, km, litros, precoLitro, placa, numero, localParaIso, isoParaLocal, stat, icone } from '../ui.js';

const COMBUSTIVEIS = [['gasolina', 'Gasolina'], ['etanol', 'Etanol'], ['diesel', 'Diesel'], ['gnv', 'GNV'], ['eletrico', 'Elétrico']];

export default async function combustivel({ alvo }) {
  const ehTecnico = usuario().perfil === 'tecnico';
  const lista = [['lancamentos', ehTecnico ? 'Meus abastecimentos' : 'Lançamentos'], ehTecnico ? null : ['consumo', 'Consumo e custos'], ehTecnico ? null : ['relatorios', 'Por técnico e posto']].filter(Boolean);
  let aba = 'lancamentos';
  const corpo = el('div');
  const barra = el('div');
  const filtro = { veiculo_id: '', de: '', ate: '', pagina: 1 };
  const [veiculos, postos] = await Promise.all([api.get('/frota/veiculos?ativos=1&por_pagina=200').then((x) => x.itens).catch(() => []),
    api.get('/frota/fornecedores?tipo=posto').then((x) => x.itens).catch(() => [])]);
  const trocar = (id) => { aba = id; barra.replaceChildren(abas(lista, aba, trocar)); TELAS[aba](); };
  const filtros = () => {
    const veic = el('select', { 'aria-label': 'Veículo' }, el('option', { value: '' }, 'Todos os veículos'), veiculos.map((v) => el('option', { value: v.id, selected: String(v.id) === String(filtro.veiculo_id) }, `${placa(v.placa)} · ${v.modelo}`)));
    const de = el('input', { type: 'date', value: filtro.de, 'aria-label': 'De' });
    const ate = el('input', { type: 'date', value: filtro.ate, 'aria-label': 'Até' });
    const mudar = () => { Object.assign(filtro, { veiculo_id: veic.value, de: de.value, ate: ate.value, pagina: 1 }); TELAS[aba](); };
    for (const x of [veic, de, ate]) x.addEventListener('change', mudar);
    return el('div', { class: 'filtros' }, veic, el('label', { class: 'check' }, 'De', de), el('label', { class: 'check' }, 'até', ate),
      !ehTecnico ? botao('Exportar CSV', () => baixar('/combustivel/exportar.csv', `abastecimentos-${hoje()}.csv`), { tipo: 'secundario', ic: 'baixar' }) : null);
  };
  limpar(alvo, cabecalho({ sobretitulo: 'Gestão de frota', titulo: 'Abastecimentos',
    descricao: 'Comprovante, volume, preço e odômetro. Consumo calculado só entre dois tanques cheios do mesmo veículo, incluindo os parciais do ciclo.',
    acoes: [pode('combustivel.lancar') ? botao('Registrar abastecimento', () => registrar(veiculos, postos, () => trocar('lancamentos')), { ic: 'mais' }) : null] }), barra, corpo);

  const TELAS = {
    lancamentos: () => {
      const area = el('div');
      limpar(corpo, filtros(), area);
      carregar(area, () => api.get(`/combustivel/abastecimentos${qs(filtro)}`), (l) => painel(null, tabela([
        { titulo: 'Data', valor: (a) => dataHora(a.data_hora) },
        { titulo: 'Veículo', valor: (a) => el('div', {}, el('div', { class: 'forte' }, placa(a.placa)), el('div', { class: 'fraco' }, [a.tecnico_nome, a.posto_nome].filter(Boolean).join(' · '))) },
        { titulo: 'Odômetro', valor: (a) => km(a.odometro_km), classe: 'num' }, { titulo: 'Volume', valor: (a) => litros(a.litros_ml), classe: 'num' },
        { titulo: 'Preço/L', valor: (a) => precoLitro(a.preco_milesimos), classe: 'num' }, { titulo: 'Total', valor: (a) => dinheiro(a.total_centavos), classe: 'num' },
        { titulo: 'Tanque', valor: (a) => el('div', {}, a.tanque_cheio ? etq('Cheio', 'ok') : etq('Parcial', 'neutra'), a.alerta_volume ? etq('Acima do tanque', 'aviso') : null,
          a.correcoes ? etq('Corrigido', 'info') : null) },
        { titulo: 'Comprovante', valor: (a) => (a.comprovantes ? 'Sim' : '—') },
      ], l.itens, { vazioTexto: 'Nenhum abastecimento no período.', aoClicar: (a) => detalhe(a.id, () => TELAS.lancamentos()),
        pagina: paginacao(l, (p) => { filtro.pagina = p; TELAS.lancamentos(); }) }), { semCorpo: true }));
    },
    consumo: () => {
      const area = el('div');
      limpar(corpo, filtros(), area);
      carregar(area, () => api.get(`/combustivel/resumo${qs({ veiculo_id: filtro.veiculo_id, de: filtro.de, ate: filtro.ate })}`), (r) => el('div', {},
        el('div', { class: 'stats' },
          stat({ rotulo: 'Volume no período', ic: 'gota', valor: litros(r.total.litros_ml), nota: `${r.total.lancamentos} lançamento(s)`, notaTipo: 'neutra' }),
          stat({ rotulo: 'Gasto com combustível', ic: 'dinheiro', valor: dinheiro(r.total.total_centavos), nota: 'Soma dos abastecimentos', notaTipo: 'neutra' }),
          stat({ rotulo: 'Preço médio ponderado', ic: 'combustivel', valor: r.total.preco_medio_milesimos ? precoLitro(r.total.preco_medio_milesimos) : '—', nota: 'Soma dos valores ÷ soma dos litros', notaTipo: 'neutra' }),
          stat({ rotulo: 'Veículos', ic: 'carro', valor: String(r.por_veiculo.length), nota: 'Com abastecimento no período', notaTipo: 'neutra' })),
        painel('Consumo por veículo', tabela([
          { titulo: 'Veículo', valor: (v) => `${placa(v.placa)} · ${v.modelo}` }, { titulo: 'Volume', valor: (v) => litros(v.litros_ml), classe: 'num' },
          { titulo: 'Gasto', valor: (v) => dinheiro(v.total_centavos), classe: 'num' }, { titulo: 'Preço médio', valor: (v) => precoLitro(v.preco_medio_milesimos), classe: 'num' },
          { titulo: 'Consumo', valor: (v) => (v.consumo.situacao === 'ok' ? `${numero(v.consumo.km_por_litro, 2)} km/L` : el('span', { class: 'fraco' }, 'Dados insuficientes')), classe: 'num' },
          { titulo: 'Combustível por km', valor: (v) => (v.consumo.situacao === 'ok' ? dinheiro(v.consumo.custo_combustivel_km_centavos) : '—'), classe: 'num' },
          { titulo: 'Ciclos válidos', valor: (v) => (v.consumo.situacao === 'ok' ? v.consumo.ciclos : 0), classe: 'num' },
        ], r.por_veiculo, { vazioTexto: 'Nenhum abastecimento no período.', aoClicar: (v) => ciclos(v) }), { semCorpo: true, rodape: [el('span', {}, r.observacao)] })));
    },
    relatorios: () => {
      const area = el('div');
      limpar(corpo, filtros(), area);
      carregar(area, () => api.get(`/combustivel/resumo${qs({ veiculo_id: filtro.veiculo_id, de: filtro.de, ate: filtro.ate })}`), (r) => el('div', { class: 'grade duas' },
        painel('Por técnico', tabela([{ titulo: 'Técnico', valor: (x) => x.nome }, { titulo: 'Volume', valor: (x) => litros(x.litros_ml), classe: 'num' },
          { titulo: 'Gasto', valor: (x) => dinheiro(x.total_centavos), classe: 'num' }, { titulo: 'Preço médio', valor: (x) => precoLitro(x.preco_medio_milesimos), classe: 'num' }], r.por_tecnico), { semCorpo: true }),
        painel('Por posto', tabela([{ titulo: 'Posto', valor: (x) => x.posto }, { titulo: 'Volume', valor: (x) => litros(x.litros_ml), classe: 'num' },
          { titulo: 'Gasto', valor: (x) => dinheiro(x.total_centavos), classe: 'num' }, { titulo: 'Preço médio', valor: (x) => precoLitro(x.preco_medio_milesimos), classe: 'num' }], r.por_posto), { semCorpo: true })));
    },
  };
  trocar(aba);
}

function ciclos(v) {
  modal(`Ciclos de consumo · ${placa(v.placa)}`, [
    v.ciclos.length ? tabela([
      { titulo: 'De', valor: (c) => `${data(c.de_em)} · ${km(c.de_km)}` }, { titulo: 'Até', valor: (c) => `${data(c.ate_em)} · ${km(c.ate_km)}` },
      { titulo: 'Distância', valor: (c) => km(c.distancia_km), classe: 'num' }, { titulo: 'Litros no ciclo', valor: (c) => litros(c.litros_ml), classe: 'num' },
      { titulo: 'km/L', valor: (c) => numero(c.km_por_litro, 2), classe: 'num' }, { titulo: 'R$/km', valor: (c) => dinheiro(c.custo_km_centavos), classe: 'num' },
    ], v.ciclos) : faixa(v.consumo.mensagem, 'info'),
    el('p', { class: 'fraco', style: 'margin-top:12px' }, 'Litros do ciclo = abastecimentos depois do primeiro tanque cheio até o segundo, inclusive. O volume do primeiro fechamento não entra.'),
  ], { largo: true });
}

async function detalhe(id, recarregar) {
  const a = await api.get(`/combustivel/abastecimentos/${id}`);
  modal(`Abastecimento #${a.id}`, (fechar) => [
    dl([['Data e hora', dataHora(a.data_hora)], ['Combustível', rotulo('combustivel', a.combustivel)], ['Odômetro', km(a.odometro_km)], ['Volume', litros(a.litros_ml)],
      ['Preço por litro', precoLitro(a.preco_milesimos)], ['Total', `${dinheiro(a.total_centavos)} (litros × preço, arredondado ao centavo)`], ['Tanque', a.tanque_cheio ? 'Cheio' : 'Parcial'],
      ['Posto', a.posto], ['Observações', a.observacoes]]),
    a.alerta_volume ? faixa('Volume maior que a capacidade do tanque cadastrada.', '', 'alerta') : null,
    a.comprovantes.length ? el('div', { class: 'miniaturas', style: 'margin-top:12px' }, a.comprovantes.map((x) => el('a', { href: '#', onclick: (e) => { e.preventDefault(); acao(null, () => abrirAnexo(x.id)); } }, icone('arquivo'), x.nome))) : null,
    a.correcoes.length ? el('div', { style: 'margin-top:14px' }, el('strong', {}, 'Correções'), el('ul', { class: 'linha-tempo', style: 'margin-top:8px' }, a.correcoes.map((c) => el('li', {},
      `${c.campo}: ${c.valor_anterior} → ${c.valor_novo} — ${c.motivo}`, el('small', {}, `${dataHora(c.em)} · ${c.usuario_nome}`))))) : null,
    pode('combustivel.corrigir') ? el('div', { class: 'form-acoes' }, botao('Corrigir', () => formulario('Corrigir abastecimento', [
      { nome: 'odometro_km', rotulo: 'Odômetro (km)', tipo: 'number', valor: a.odometro_km }, { nome: 'litros', rotulo: 'Litros', tipo: 'decimal', valor: (a.litros_ml / 1000).toString().replace('.', ',') },
      { nome: 'preco_litro', rotulo: 'Preço por litro', tipo: 'decimal', valor: (a.preco_milesimos / 1000).toFixed(3).replace('.', ',') },
      { nome: 'data_hora', rotulo: 'Data e hora', tipo: 'datetime-local', valor: isoParaLocal(a.data_hora) }, { nome: 'tanque_cheio', rotulo: 'Tanque cheio', tipo: 'checkbox', valor: a.tanque_cheio },
      { nome: 'motivo', rotulo: 'Motivo da correção', obrigatorio: true, inteiro: true },
    ], { antes: faixa('O valor original fica guardado no histórico de correções.', 'info'), enviar: async (d) => {
      await api.post(`/combustivel/abastecimentos/${a.id}/corrigir`, { ...d, data_hora: localParaIso(d.data_hora) });
      toast('Correção registrada.');
      fechar();
      recarregar();
    } }), { tipo: 'secundario' })) : null,
  ], { largo: true });
}

function registrar(veiculos, postos, depois) {
  const meus = usuario().perfil === 'tecnico' ? veiculos.filter((v) => v.responsavel?.tecnico_id === usuario().tecnico_id) : veiculos;
  return formulario('Registrar abastecimento', [
    { nome: 'veiculo_id', rotulo: 'Veículo', tipo: 'select', obrigatorio: true, opcoes: meus.map((v) => [v.id, `${placa(v.placa)} · ${v.modelo}`]), valor: meus.length === 1 ? meus[0].id : '' },
    { nome: 'data_hora', rotulo: 'Data e hora', tipo: 'datetime-local', obrigatorio: true, valor: isoParaLocal(new Date().toISOString()) },
    { nome: 'combustivel', rotulo: 'Combustível', tipo: 'select', obrigatorio: true, opcoes: COMBUSTIVEIS },
    { nome: 'odometro_km', rotulo: 'Odômetro (km)', tipo: 'number', obrigatorio: true },
    { nome: 'litros', rotulo: 'Litros', tipo: 'decimal', obrigatorio: true, placeholder: '40,000' },
    { nome: 'preco_litro', rotulo: 'Preço por litro (R$)', tipo: 'decimal', obrigatorio: true, placeholder: '5,899' },
    postos.length ? { nome: 'fornecedor_id', rotulo: 'Posto cadastrado', tipo: 'select', vazio: 'Outro', opcoes: postos.map((p) => [p.id, p.nome]) } : null,
    { nome: 'posto', rotulo: 'Posto (se não cadastrado)' },
    { nome: 'tanque_cheio', rotulo: 'Completei o tanque', tipo: 'checkbox', inteiro: true },
    { nome: 'comprovante', rotulo: 'Comprovante (foto ou PDF)', tipo: 'file', capture: 'environment', inteiro: true },
    { nome: 'observacoes', rotulo: 'Observações', tipo: 'textarea', inteiro: true },
  ], { largo: true, rotuloEnviar: 'Registrar', antes: meus.length ? null : faixa('Nenhum veículo disponível para você. O técnico registra só o veículo sob sua responsabilidade.', 'info'),
    enviar: async (d) => {
      const c = d.comprovante ? await api.enviarArquivo('abastecimento', null, d.comprovante) : null;
      const r = await api.post('/combustivel/abastecimentos', { ...d, comprovante: undefined, comprovante_id: c?.id, fornecedor_id: d.fornecedor_id || null, data_hora: localParaIso(d.data_hora) });
      toast(`Registrado: ${dinheiro(r.total_centavos)}.${r.avisos.length ? ` ${r.avisos.join(' ')}` : ''}`);
      depois();
    } });
}
