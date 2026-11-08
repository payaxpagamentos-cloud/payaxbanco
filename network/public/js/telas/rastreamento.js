import { api } from '../api.js';
import { el, limpar, pode, cabecalho, painel, tabela, etqDe, dataHora, desde, toast, carregar, formulario, botao, placa, fonteHorario, localParaIso, isoParaLocal, pedirMotivo, numero } from '../ui.js';
import { criarMapa } from '../mapa.js';

export default async function rastreamento({ alvo, ir, aoSair }) {
  const area = el('div', { class: 'mapa alto', role: 'region', 'aria-label': 'Mapa da frota' });
  const estado = el('div', { class: 'filtros' });
  const lista = el('div');
  const vinculos = el('div');
  limpar(alvo, cabecalho({ sobretitulo: 'Gestão de frota', titulo: 'Rastreamento',
    descricao: 'Posições do Rastreador de Veículos com o horário da medição e a idade. Parado ≠ sem comunicação; ignição ausente é desconhecida.',
    acoes: [botao('Ver trajeto', () => verTrajeto(), { tipo: 'secundario', ic: 'rota' }), botao('Atualizar', () => atualizar(), { tipo: 'secundario', ic: 'atualizar' })] }),
  estado, el('div', { class: 'grade principal-lateral' }, painel(null, area, { semCorpo: true }), painel('Veículos', lista, { semCorpo: true })),
  painel('Dispositivos do rastreador', vinculos, { semCorpo: true, rodape: [el('span', {}, 'O vínculo usa o identificador do equipamento (IMEI); a placa serve só para sugerir a conciliação.')] }));
  const mapa = await criarMapa(area);
  const verTrajeto = async () => {
    const vs = (await api.get('/rastreamento/mapa')).veiculos.filter((v) => v.dispositivo_id);
    return formulario('Trajeto do veículo', [
      { nome: 'veiculo_id', rotulo: 'Veículo', tipo: 'select', obrigatorio: true, opcoes: vs.map((v) => [v.id, placa(v.placa)]) },
      { nome: 'de', rotulo: 'De', tipo: 'datetime-local', valor: isoParaLocal(new Date(Date.now() - 8 * 3600_000).toISOString()) },
      { nome: 'ate', rotulo: 'Até', tipo: 'datetime-local', valor: isoParaLocal(new Date().toISOString()) },
    ], { rotuloEnviar: 'Mostrar', enviar: async (d) => {
      const r = await api.get(`/rastreamento/veiculos/${d.veiculo_id}/trajeto?de=${encodeURIComponent(localParaIso(d.de))}&ate=${encodeURIComponent(localParaIso(d.ate))}`);
      mapa.trajeto(r.pontos);
      toast(r.aviso ?? `${numero(r.pontos.length)} posição(ões) de ${r.fonte === 'rastreador' ? 'rastreador' : 'armazenamento local'}.`, Boolean(r.aviso));
    } });
  };

  aoSair(() => mapa.destruir());

  async function atualizar() {
    await carregar(lista, () => api.get('/rastreamento/mapa'), (m) => {
      limpar(estado, fonteHorario(m.conexao.estado, m.conexao.ultimo_sucesso, m.conexao.fonte),
        m.conexao.ultimo_erro && m.conexao.estado !== 'conectada' ? el('span', { class: 'fraco' }, `Último erro: ${m.conexao.ultimo_erro}`) : null,
        m.conexao.estado === 'nao_configurada' && pode('integracoes.ver') ? el('a', { href: '#/integracoes' }, 'Configurar a integração') : null);
      mapa.mostrarFrota(m.veiculos, (v) => ir(`#/veiculos/${v.id}`));
      return tabela([
        { titulo: 'Veículo', valor: (v) => el('div', {}, el('div', { class: 'forte' }, placa(v.placa)), el('div', { class: 'fraco' }, [v.modelo, v.responsavel].filter(Boolean).join(' · '))) },
        { titulo: 'Situação', valor: (v) => el('div', {}, etqDe('situacaoRastreio', v.situacao), v.observado_em ? el('div', { class: 'fraco' }, `${desde(v.observado_em)} · ignição ${v.ignicao}`) : null) },
      ], m.veiculos, { vazioTexto: 'Nenhum veículo ativo.', aoClicar: (v) => (v.lat !== null ? mapa.focar(`v${v.id}`) : null) });
    });
    await carregar(vinculos, () => Promise.all([api.get('/rastreamento/dispositivos'), api.get('/frota/veiculos?ativos=1&por_pagina=200')]), ([ds, vs]) => tabela([
      { titulo: 'Dispositivo', valor: (d) => el('div', {}, el('div', { class: 'forte' }, d.dispositivo_id), el('div', { class: 'fraco' }, [d.placa ? `placa na fonte ${placa(d.placa)}` : null, d.descricao].filter(Boolean).join(' · '))) },
      { titulo: 'Visto', valor: (d) => desde(d.ultimo_visto) },
      { titulo: 'Vinculado a', valor: (d) => (d.veiculo_placa ? `${placa(d.veiculo_placa)} desde ${dataHora(d.vinculado_em)}` : el('span', { class: 'fraco' }, 'Sem vínculo: posições não são atribuídas')) },
      { titulo: '', valor: (d) => (!pode('rastreamento.vincular') ? '' : d.vinculo_id
        ? el('button', { class: 'botao fantasma pequeno', onclick: () => pedirMotivo('Encerrar vínculo', 'Motivo (troca de equipamento, venda…)', async (m) => { await api.post(`/rastreamento/vinculos/${d.vinculo_id}/encerrar`, { motivo: m }); atualizar(); }) }, 'Encerrar')
        : el('button', { class: 'botao secundario pequeno', onclick: () => formulario(`Vincular ${d.dispositivo_id}`, [{ nome: 'veiculo_id', rotulo: 'Veículo', tipo: 'select', obrigatorio: true,
          valor: d.sugestao_veiculo_id, opcoes: vs.itens.map((v) => [v.id, `${placa(v.placa)} · ${v.modelo}${v.id === d.sugestao_veiculo_id ? ' (mesma placa)' : ''}`]) }],
        { enviar: async (x) => { await api.post('/rastreamento/vinculos', { dispositivo_id: d.dispositivo_id, veiculo_id: x.veiculo_id }); toast('Dispositivo vinculado.'); atualizar(); } }) }, 'Vincular')) },
    ], ds, { vazioTexto: 'Nenhum dispositivo recebido do rastreador ainda.' }));
  }

  await atualizar();
  const t = setInterval(atualizar, 60_000);
  aoSair(() => clearInterval(t));

}
