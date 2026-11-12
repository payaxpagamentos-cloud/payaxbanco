/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/

/** Central de multas: lista com resumo, cadastro com a notificação, detalhe com o cruzamento do rastreamento e a indicação do condutor. */
import { api } from './api.js';
import { el, limpar, toast, formModal, modal, confirmar, campo, area, escolha, etiqueta, placa, dinheiro, dataHora, data, kmh, centavos, reaisCampo, icone } from './ui.js';
import { cartao, indicador, tabela, td, botao, botaoIcone } from './comum.js';
import { linkGoogle } from './mapa.js';

const TOM = { notificada: 'aviso', condutor_indicado: 'info', em_recurso: 'info', a_pagar: 'erro', paga: 'ok', cancelada: '' };
const GRAV = { leve: 'Leve', media: 'Média', grave: 'Grave', gravissima: 'Gravíssima' };
const prazoTexto = (dias, data_) => (dias === null || dias === undefined ? '—' : dias < 0 ? `venceu (${data(data_)})` : dias === 0 ? 'hoje' : `${dias} dia(s) · ${data(data_)}`);
const paraLocal = (iso) => { const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

/** Lê os arquivos escolhidos (PDF ou fotos) como data URL para enviar junto. */
const lerArquivos = (input) => Promise.all([...input.files].slice(0, 4).map((f) => new Promise((ok, falha) => {
  if (f.size > 4_000_000) return falha(new Error(`${f.name}: arquivo grande demais (máximo 4 MB).`));
  const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => falha(new Error(`Não foi possível ler ${f.name}.`)); r.readAsDataURL(f);
})));

async function abrirArquivo(caminho) {
  const janela = window.open('', '_blank');
  try {
    const b = await (await api.get(caminho, { bruto: true })).blob();
    const url = URL.createObjectURL(b);
    if (janela) janela.location = url; else location.href = url;
  } catch (err) { janela?.close(); toast(err.message, true); }
}

function formMulta(ctx, dados, m) {
  const arquivos = el('input', { type: 'file', name: 'arquivos_sel', accept: 'application/pdf,image/*', multiple: true });
  return formModal(m ? 'Editar multa' : 'Cadastrar multa', () => [
    el('div', { class: 'duas' },
      escolha('Veículo', 'placa', Object.fromEntries(dados.veiculos.map((v) => [v.placa, `${placa(v.placa)}${v.descricao ? ` · ${v.descricao}` : ''}`])), m?.placa ?? dados.veiculos[0]?.placa),
      campo('Data e hora da infração', { name: 'ocorrida_em', type: 'datetime-local', required: true, value: m ? paraLocal(m.ocorrida_em) : '' })),
    campo('Infração (descrição)', { name: 'descricao', required: true, maxlength: 300, value: m?.descricao ?? '', placeholder: 'Ex.: Velocidade superior à máxima permitida em até 20%' }),
    el('div', { class: 'tres' },
      campo('Nº do auto (AIT)', { name: 'auto_infracao', maxlength: 40, value: m?.auto_infracao ?? '' }),
      campo('Órgão autuador', { name: 'orgao', maxlength: 80, value: m?.orgao ?? '', placeholder: 'DETRAN-SP, DER, PRF…' }),
      campo('Código da infração', { name: 'infracao_codigo', maxlength: 20, value: m?.infracao_codigo ?? '' })),
    el('div', { class: 'tres' },
      escolha('Gravidade', 'gravidade', { '': '—', ...GRAV }, m?.gravidade ?? ''),
      campo('Valor (R$)', { name: 'valor', inputmode: 'decimal', value: reaisCampo(m?.valor_centavos) }),
      campo('Pontos', { name: 'pontos', type: 'number', min: 0, max: 40, value: m?.pontos ?? '', placeholder: 'pela gravidade' })),
    el('div', { class: 'duas' },
      campo('Local', { name: 'local_texto', maxlength: 200, value: m?.local_texto ?? '' }),
      campo('Município', { name: 'municipio', maxlength: 80, value: m?.municipio ?? '' })),
    el('div', { class: 'duas' },
      campo('Prazo para indicar o condutor', { name: 'prazo_indicacao', type: 'date', value: m?.prazo_indicacao ?? '' }),
      campo('Vencimento do pagamento', { name: 'vencimento', type: 'date', value: m?.vencimento ?? '' })),
    el('label', { class: 'campo' }, 'Notificação (PDF ou fotos, até 4 arquivos de 4 MB)', arquivos),
    area('Observação', { name: 'observacao', maxlength: 500, rows: 2 }, m?.observacao ?? ''),
  ], async (d) => {
    const corpo = { ...d, valor_centavos: centavos(d.valor) ?? null, ocorrida_em: d.ocorrida_em ? new Date(d.ocorrida_em).toISOString() : '', arquivos: await lerArquivos(arquivos) };
    delete corpo.valor; delete corpo.arquivos_sel;
    return m ? api.put(`/empresas/${ctx.empresaId}/multas/${m.id}`, corpo) : api.post(`/empresas/${ctx.empresaId}/multas`, corpo);
  }, { rotulo: m ? 'Salvar' : 'Cadastrar', largo: true });
}

/** Detalhe: dados da multa, a notificação, o cruzamento com o rastreamento e as ações (indicar condutor, situação). */
async function detalheMulta(ctx, dados, id, { master, gestor, aoMudar }) {
  const caminho = master ? `/master/multas/${id}` : `/empresas/${ctx.empresaId}/multas/${id}`;
  const m = await api.get(caminho);
  const c = m.cruzamento;
  const linha = (rot, val) => el('div', { class: 'linha entre', style: 'padding:6px 0;border-bottom:1px solid var(--border);gap:12px' }, el('span', { class: 'mudo pequeno' }, rot), el('strong', { style: 'text-align:right' }, val ?? '—'));
  const cruz = !c?.veiculo_cadastrado ? el('p', { class: 'mudo' }, 'A placa não está cadastrada como veículo rastreado.')
    : el('div', {},
      linha('Quem dirigia', c.condutor ? `${c.condutor.nome} (${c.condutor.origem})` : 'Sem motorista registrado no horário'),
      linha('Posição no horário', c.posicao ? el('a', { href: linkGoogle(c.posicao.lat, c.posicao.lng), target: '_blank', rel: 'noopener' }, `${c.posicao.lat.toFixed(5)}, ${c.posicao.lng.toFixed(5)} · ${c.posicao.diferenca_min} min de diferença`) : 'Sem posição até 15 min do horário'),
      linha('Velocidade no horário', c.posicao ? kmh(c.posicao.velocidade_kmh) : '—'),
      linha('Velocidade máxima (±3 min)', c.velocidade_max_kmh !== null ? kmh(c.velocidade_max_kmh) : '—'),
      linha('Ignição', c.posicao ? (c.posicao.ignicao === 1 ? 'ligada' : c.posicao.ignicao === 0 ? 'desligada' : '—') : '—'));
  modal(`Multa · ${placa(m.placa)}`, (fechar) => {
    const acoes = gestor && !master ? el('div', { class: 'linha', style: 'gap:8px;flex-wrap:wrap;margin-top:14px' },
      botao('Indicar condutor', 'primario', async () => {
        const r = await formModal('Indicar o condutor', () => [
          el('p', { class: 'mudo', style: 'margin:0' }, c?.condutor ? `No horário, quem dirigia era ${c.condutor.nome} (${c.condutor.origem}).` : 'Escolha o motorista que estava com o veículo.'),
          escolha('Motorista', 'motorista_id', { '': '— nenhum —', ...Object.fromEntries(dados.motoristas.map((x) => [x.id, x.nome])) }, m.motorista_id ?? c?.condutor?.motorista_id ?? ''),
        ], (d) => api.put(`/empresas/${ctx.empresaId}/multas/${m.id}`, { motorista_id: d.motorista_id || null, situacao: d.motorista_id ? 'condutor_indicado' : m.situacao }));
        if (r) { toast('Condutor indicado. A multa aparece no app dele em Minhas multas.'); fechar(); aoMudar(); }
      }),
      botao('Mudar situação', '', async () => {
        const r = await formModal('Situação da multa', () => [escolha('Situação', 'situacao', dados.situacoes, m.situacao)],
          (d) => api.put(`/empresas/${ctx.empresaId}/multas/${m.id}`, { situacao: d.situacao }));
        if (r) { toast('Situação atualizada.'); fechar(); aoMudar(); }
      }),
      botao('Editar', '', async () => { fechar(); if (await formMulta(ctx, dados, m)) { toast('Multa salva.'); aoMudar(); } }),
      botao('Excluir', 'perigo', async () => {
        if (!await confirmar('Excluir a multa', 'A multa e a notificação anexada são apagadas.', 'Excluir')) return;
        await api.del(`/empresas/${ctx.empresaId}/multas/${m.id}`); toast('Multa excluída.'); fechar(); aoMudar();
      })) : null;
    return [
      el('div', { class: 'linha', style: 'gap:6px;flex-wrap:wrap;margin-bottom:10px' }, etiqueta(dados.situacoes[m.situacao], TOM[m.situacao]),
        m.gravidade ? etiqueta(`${GRAV[m.gravidade]}${m.pontos ? ` · ${m.pontos} pontos` : ''}`, m.gravidade === 'gravissima' ? 'erro' : 'aviso') : null,
        etiqueta(m.fonte === 'consulta' ? 'consulta automática' : 'cadastrada', '')),
      el('h3', { style: 'margin:0 0 8px' }, m.descricao),
      master ? linha('Empresa', m.empresa) : null,
      linha('Data e hora', dataHora(m.ocorrida_em)), linha('Local', [m.local_texto, m.municipio].filter(Boolean).join(' · ') || '—'),
      linha('Auto / órgão', [m.auto_infracao, m.orgao, m.infracao_codigo ? `código ${m.infracao_codigo}` : null].filter(Boolean).join(' · ') || '—'),
      linha('Valor', m.valor_centavos !== null ? dinheiro(m.valor_centavos) : '—'),
      linha('Indicar o condutor até', prazoTexto(m.dias_indicacao, m.prazo_indicacao)), linha('Vencimento', prazoTexto(m.dias_vencimento, m.vencimento)),
      linha('Condutor indicado', m.motorista ?? '—'),
      m.observacao ? linha('Observação', m.observacao) : null,
      el('h4', { style: 'margin:16px 0 6px' }, 'Notificação'),
      m.arquivos.length ? el('div', { class: 'linha', style: 'gap:8px;flex-wrap:wrap' }, m.arquivos.map((a, i) => botao([icone('multa'), a.tipo === 'application/pdf' ? `PDF ${i + 1}` : `Foto ${i + 1}`], '',
        () => abrirArquivo(master ? `/master/multas/arquivos/${a.id}` : `/empresas/${ctx.empresaId}/multas/arquivos/${a.id}`))))
        : el('p', { class: 'mudo pequeno', style: 'margin:0' }, 'Nenhum arquivo anexado.'),
      el('h4', { style: 'margin:16px 0 6px' }, 'No rastreamento, no horário da multa'), cruz,
      acoes,
    ];
  }, { largo: true });
}

async function telaMultas(ctx, { master = false } = {}) {
  const gestor = master || !ctx.somenteLeitura;
  const filtros = { situacao: '', empresa_id: '' };
  const corpo = el('div');
  async function carregar() {
    const q = new URLSearchParams(Object.entries(filtros).filter(([, x]) => x));
    const dados = await api.get(`${master ? '/master' : `/empresas/${ctx.empresaId}`}/multas${q.size ? `?${q}` : ''}`);
    const r = dados.resumo;
    const filtroSit = escolha(null, 'situacao', { '': 'Todas as situações', ...dados.situacoes }, filtros.situacao);
    filtroSit.addEventListener('change', () => { filtros.situacao = filtroSit.value; carregar(); });
    const filtroEmp = master ? escolha(null, 'empresa_id', { '': 'Todas as empresas', ...Object.fromEntries(dados.empresas.map((e) => [e.id, e.nome])) }, filtros.empresa_id) : null;
    filtroEmp?.addEventListener('change', () => { filtros.empresa_id = filtroEmp.value; carregar(); });
    limpar(corpo,
      el('div', { class: 'grade' },
        indicador('Em aberto', String(r.em_aberto), `${r.total} no total`, r.em_aberto ? 'aviso' : 'ok', 'multa'),
        indicador('Valor em aberto', dinheiro(r.valor_aberto_centavos), 'multas não pagas', r.valor_aberto_centavos ? 'erro' : '', 'carteira'),
        indicador('Indicar condutor', String(r.indicar_7_dias), 'prazo vence em até 7 dias', r.indicar_7_dias ? 'erro' : 'ok', 'motoristas'),
        indicador('Sem condutor', String(r.sem_condutor), 'multas em aberto sem motorista', r.sem_condutor ? 'aviso' : 'ok', 'usuarios')),
      cartao(null,
        el('div', { class: 'linha entre', style: 'gap:10px;flex-wrap:wrap;margin-bottom:12px' },
          el('div', { class: 'linha', style: 'gap:8px;flex-wrap:wrap' }, filtroEmp, filtroSit),
          el('div', { class: 'linha', style: 'gap:8px;flex-wrap:wrap' },
            !master && gestor && dados.consulta_automatica ? botao('Consultar agora', '', async () => {
              const x = await api.post(`/empresas/${ctx.empresaId}/multas/consultar`, {});
              toast(`${x.consultados} veículo(s) consultado(s), ${x.novas} multa(s) nova(s).`); carregar();
            }) : null,
            !master && gestor ? botao([icone('multa'), 'Cadastrar multa'], 'primario', async () => {
              if (!dados.veiculos.length) return toast('Cadastre um veículo primeiro.', true);
              if (await formMulta(ctx, dados)) { toast('Multa cadastrada.'); carregar(); }
            }) : null)),
        el('p', { class: 'pequeno mudo', style: 'margin:0 0 10px' }, dados.consulta_automatica
          ? 'Consulta automática ligada: os veículos são consultados no DETRAN/SENATRAN uma vez por dia (com a placa e o RENAVAM).'
          : 'Consulta automática (DETRAN/SENATRAN): aguardando a contratação do serviço de consulta. Por enquanto, cadastre as multas com a notificação.'),
        tabela(['Data', 'Placa', master ? 'Empresa' : null, 'Infração', '>Valor', 'Condutor', '^Situação', 'Indicar até', '^'].filter(Boolean), dados.multas.map((m) => el('tr', { style: 'cursor:pointer', onclick: () => detalheMulta(ctx, dados, m.id, { master, gestor, aoMudar: carregar }) },
          td(dataHora(m.ocorrida_em)), td(el('strong', {}, placa(m.placa))), master ? td(m.empresa) : null,
          td([m.descricao, el('div', { class: 'pequeno mudo' }, [m.auto_infracao, m.orgao, m.gravidade ? GRAV[m.gravidade] : null].filter(Boolean).join(' · '))]),
          td(m.valor_centavos !== null ? dinheiro(m.valor_centavos) : '—', 'dir num'), td(m.motorista ?? el('span', { class: 'mudo' }, 'sem condutor')),
          td(etiqueta(dados.situacoes[m.situacao], TOM[m.situacao]), 'centro'),
          td(m.situacao === 'notificada' ? prazoTexto(m.dias_indicacao, m.prazo_indicacao) : '—'),
          el('td', { class: 'acoes' }, botaoIcone('multa', 'Abrir a multa', (e) => { e?.stopPropagation?.(); detalheMulta(ctx, dados, m.id, { master, gestor, aoMudar: carregar }); }))))
          .filter(Boolean), 'Nenhuma multa por aqui.')));
  }
  limpar(ctx.conteudo, corpo);
  await carregar();
}

export const TELAS_MULTAS = { multas: (ctx) => telaMultas(ctx) };
export const TELAS_MULTAS_MASTER = { multas: (ctx) => telaMultas(ctx, { master: true }) };
