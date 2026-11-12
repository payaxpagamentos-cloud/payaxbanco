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
const INTERVALO = { 0: 'só quando alguém consultar (manual)', 1: 'todo dia', 7: 'uma vez por semana', 15: 'a cada 15 dias' };
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
          ? (dados.automatica?.intervalo_dias ? `Consulta automática ligada (DETRAN-${dados.automatica.uf}): os veículos são consultados ${INTERVALO[dados.automatica.intervalo_dias]}.` : `Consulta ligada ao DETRAN-${dados.automatica?.uf ?? 'SP'} no modo manual: use "Consultar agora" ou a aba Consultar multas.`)
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

// ---------- Consultar multas (na hora) ----------
const TIPO_APONT = { ipva: 'IPVA', licenciamento: 'Licenciamento', dpvat: 'DPVAT', restricao: 'Restrição', roubo_furto: 'Roubo / furto', recall: 'Recall',
  gravame: 'Gravame (financiamento)', renajud: 'RENAJUD (judicial)', bloqueio: 'Bloqueio' };

function resultadoConsulta(r) {
  const nada = !r.multas.length && !r.apontamentos.length;
  return el('div', { class: 'coluna', style: 'gap:12px' },
    el('div', { class: 'linha entre', style: 'flex-wrap:wrap;gap:8px' },
      el('div', {}, el('strong', { style: 'font-size:20px' }, placa(r.placa)), el('div', { class: 'pequeno mudo' }, `Consultado em ${dataHora(r.consultado_em)}${r.veiculo_da_frota ? ' · veículo da frota' : ' · fora da frota'}`)),
      el('div', { class: 'linha', style: 'gap:6px;flex-wrap:wrap' }, r.homolog ? etiqueta('TESTE · dados de exemplo, sem cobrança', 'info') : null,
        r.custo ? etiqueta(`custo: R$ ${r.custo}`, '') : null,
        nada ? etiqueta('Nada consta', 'ok') : etiqueta(`${r.multas.length} multa(s) · ${r.apontamentos.length} apontamento(s)`, 'erro'))),
    nada ? el('div', { class: 'cartao', style: 'text-align:center;padding:22px' }, el('div', { style: 'font-size:34px' }, '✅'), el('strong', {}, 'Nenhuma multa e nenhum apontamento para esta placa.')) : null,
    r.multas.length ? cartao(`Multas (${r.multas.length})`, tabela(['Data', 'Infração', '>Valor', '^Central'], r.multas.map((m) => el('tr', {},
      td(m.ocorrida_em ? dataHora(m.ocorrida_em) : '—'), td([m.descricao, el('div', { class: 'pequeno mudo' }, [m.auto_infracao, m.orgao, m.gravidade ? GRAV[m.gravidade] : null].filter(Boolean).join(' · '))]),
      td(m.valor_centavos !== null ? dinheiro(m.valor_centavos) : '—', 'dir num'),
      td(m.nova ? etiqueta('nova · adicionada', 'aviso') : m.na_central ? etiqueta('já na central', 'ok') : etiqueta(r.homolog ? 'teste' : r.veiculo_da_frota ? 'não adicionada' : 'fora da frota', ''), 'centro'))))) : null,
    r.apontamentos.length ? cartao(`Apontamentos (${r.apontamentos.length})`, tabela(['Tipo', 'Descrição', '>Valor', 'Situação'], r.apontamentos.map((a) => el('tr', {},
      td(el('strong', {}, TIPO_APONT[a.tipo] ?? a.tipo)), td(a.descricao || '—'), td(a.valor_centavos !== null ? dinheiro(a.valor_centavos) : '—', 'dir num'), td(a.situacao ?? '—'))))) : null);
}

async function telaConsultar(ctx, { master = false } = {}) {
  const base = master ? '/master/multas' : `/empresas/${ctx.empresaId}/multas`;
  const podeConsultar = master || !ctx.somenteLeitura;
  const resultado = el('div');
  const historicoEl = el('div');
  const situacaoEl = el('div');
  async function carregar() {
    const d = await api.get(`${base}/consultas`);
    const a = d.automatica;
    limpar(situacaoEl, el('div', { class: `aviso-faixa ${d.ligada ? 'ok' : 'aviso'}`, style: 'padding:12px 14px;border-radius:12px;margin-bottom:14px;background:var(--surface-2)' },
      d.ligada
        ? (a.intervalo_dias === 0
          ? el('div', {}, el('strong', {}, `● Consulta ligada${a.fornecedor === 'apibrasil' ? ' à API Brasil' : ''} (${a.uf}), no modo manual${a.homolog ? ' — EM TESTE, dados de exemplo e sem cobrança' : ''}. `), 'Consulte um veículo quando quiser abaixo; as multas encontradas dos veículos da frota entram na central.')
          : el('div', {}, el('strong', {}, `● Consulta automática ligada (DETRAN-${a.uf}). `), `O sistema consulta sozinho os veículos ativos ${INTERVALO[a.intervalo_dias]} (${a.em_dia} de ${a.veiculos} em dia${a.ultima ? `, a última em ${dataHora(a.ultima)}` : ''}). Multas novas entram na central e geram aviso.`))
        : el('div', {}, el('strong', {}, '● Consulta aguardando o serviço. '), `Quando o serviço de consulta (DETRAN-${a.uf}) for contratado e ligado no servidor, esta consulta passa a funcionar${a.intervalo_dias ? ` e os veículos são consultados sozinhos ${INTERVALO[a.intervalo_dias]}` : ''}.`),
      master ? el('div', { class: 'linha', style: 'gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap' }, el('span', { class: 'pequeno' }, 'Consultar cada veículo:'),
        ...[[0, 'Manual'], [1, 'Diária'], [7, 'Semanal'], [15, 'Quinzenal']].map(([dias, rot]) => el('button', { type: 'button', class: `btn pequeno${a.intervalo_dias === dias ? ' primario' : ''}`, onclick: async () => {
          await api.put('/master/multas/intervalo', { dias }); toast(dias ? `Consulta automática: ${rot.toLowerCase()}.` : 'Consulta manual: só quando alguém consultar.'); carregar();
        } }, rot)), el('span', { class: 'pequeno mudo' }, 'manual: paga só as consultas feitas')) : null));
    limpar(historicoEl, cartao('Consultas feitas', tabela(['Quando', 'Placa', master ? 'Empresa' : null, '^Multas', '^Apontamentos', '^Novas', 'Por', '^'].filter(Boolean),
      d.consultas.map((c) => el('tr', {}, td(dataHora(c.criado_em)), td(el('strong', {}, placa(c.placa))), master ? td(c.empresa ?? '—') : null,
        td(c.status === 'consultando' ? etiqueta('consultando…', 'aviso') : c.erro ? etiqueta('erro', 'erro') : String(c.multas), 'centro'), td(c.erro || c.status === 'consultando' ? '—' : String(c.apontamentos), 'centro'), td(String(c.novas), 'centro'), td(c.usuario ?? 'automática'),
        el('td', { class: 'acoes' }, c.status === 'consultando' ? null : c.erro ? el('span', { class: 'pequeno mudo', title: c.erro }, 'falhou') : botaoIcone('olho', 'Ver o resultado', async () => {
          const x = await api.get(`${base}/consultas/${c.id}`);
          modal(`Consulta · ${placa(x.placa)}`, () => [resultadoConsulta(x.resultado)], { largo: true });
        })))), 'Nenhuma consulta feita ainda.')));
    return d;
  }
  const d = await (async () => { limpar(ctx.conteudo, situacaoEl); return carregar(); })();
  const selVeic = escolha('Veículo da frota', 'veiculo', { '': '— digitar a placa —', ...Object.fromEntries((d.veiculos ?? []).map((v) => [v.id, `${placa(v.placa)}${v.descricao ? ` · ${v.descricao}` : ''}`])) }, '');
  const inPlaca = campo('Placa', { name: 'placa', maxlength: 8, placeholder: 'ABC1D23', style: 'text-transform:uppercase' });
  const inRenavam = campo('RENAVAM (opcional, alguns estados exigem)', { name: 'renavam', inputmode: 'numeric', maxlength: 11 });
  selVeic.querySelector('select')?.addEventListener('change', (e) => {
    const v = (d.veiculos ?? []).find((x) => String(x.id) === e.target.value);
    inPlaca.querySelector('input').value = v ? placa(v.placa) : '';
    inRenavam.querySelector('input').value = v?.renavam ?? '';
  });
  const botaoConsultar = el('button', { class: 'btn primario', type: 'submit', disabled: !podeConsultar }, icone('lupa'), 'Consultar');
  const form = el('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault();
    const placaTxt = inPlaca.querySelector('input').value.trim();
    if (!placaTxt) return toast('Informe a placa.', true);
    botaoConsultar.disabled = true;
    const texto = el('p', { class: 'mudo' }, `Consultando ${placaTxt.toUpperCase()} no DETRAN, na prefeitura e no Renainf…`);
    limpar(resultado, el('div', { class: 'carregando-linha' }), texto,
      el('p', { class: 'pequeno mudo', style: 'margin:0' }, 'Pode levar até 2 minutos. Pode sair desta tela: o resultado fica guardado em "Consultas feitas".'));
    try {
      const ini = await api.post(`${base}/consultar-placa`, { placa: placaTxt, renavam: inRenavam.querySelector('input').value });
      const t0 = Date.now();
      let c;
      for (;;) {
        await new Promise((ok) => { setTimeout(ok, 2500); });
        if (!resultado.isConnected) return; // saiu da tela: o resultado fica no histórico
        c = await api.get(`${base}/consultas/${ini.id}`);
        if (c.status !== 'consultando') break;
        texto.textContent = `Consultando ${ini.placa} no DETRAN, na prefeitura e no Renainf… ${Math.round((Date.now() - t0) / 1000)} s`;
        if (Date.now() - t0 > 240_000) throw new Error('A consulta está demorando mais que o normal. O resultado aparece em "Consultas feitas" quando chegar.');
      }
      if (c.status === 'erro') throw new Error(c.erro);
      limpar(resultado, resultadoConsulta(c.resultado));
      if (c.resultado.novas) toast(`${c.resultado.novas} multa(s) nova(s) adicionada(s) à central.`);
    } catch (err) {
      limpar(resultado, el('p', { class: 'aviso erro' }, err.message));
    } finally { botaoConsultar.disabled = !podeConsultar; carregar(); }
  } },
    master ? null : selVeic,
    el('div', { class: 'duas' }, inPlaca, inRenavam),
    el('div', { class: 'linha', style: 'justify-content:flex-end' }, botaoConsultar));
  ctx.conteudo.append(
    cartao('Consultar multas', el('p', { class: 'mudo', style: 'margin:0 0 12px' }, 'Veja na hora se um veículo tem multas ou algum apontamento (IPVA, licenciamento, restrição, roubo/furto). As multas dos veículos da frota entram sozinhas na central.'), form),
    resultado, historicoEl);
}

export const TELAS_MULTAS = { multas: (ctx) => telaMultas(ctx), 'multas-consultar': (ctx) => telaConsultar(ctx) };
export const TELAS_MULTAS_MASTER = { multas: (ctx) => telaMultas(ctx, { master: true }), 'multas-consultar': (ctx) => telaConsultar(ctx, { master: true }) };
