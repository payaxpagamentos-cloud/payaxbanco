/**
 * Telefonia vista pelo master: quem tem telefonia, com que limites e tarifas, por qual operadora
 * sai, quais números (DIDs) chegam, as chamadas e o faturamento de todas as empresas, e as chaves
 * que a central telefônica (Asterisk) usa. As empresas e os usuários são os da ZOE.
 */
import { api, qs, BASE as RAIZ } from './api.js';
import { el, limpar, dinheiro, dataHora, inteiro, gb, barraUso, toast, campo, escolha, marcar, formModal, modal, confirmar, repetir, telefone,
  reaisCampo, centavos } from './ui.js';
import { cartao, indicador, tabela, td, botao, botaoIcone, acoesTopo } from './comum.js';
import { cartaoUtilizacao, cartaoSimultaneas, cartaoRamais, cartaoUsoMes, cartaoRecursos, cartaoStatusLigacoes, indicadoresTelefonia,
  painelChamadas, painelRelatorios, situacaoDiag, TIPOS_EMPRESA } from './telefonia-comum.js';

const BASE = '/master/telefonia';
const listaEmpresas = (q = {}) => api.get(`${BASE}/empresas${qs(q)}`);
const ligada = (e) => (e.telefonia_ativa ? el('span', { class: 'etiqueta ok' }, 'ligada') : el('span', { class: 'etiqueta' }, 'desligada'));

// ---------- Painel ----------
async function abaPainel(ctx) {
  ctx.parar(repetir(async () => {
    const d = await api.get(`${BASE}/dashboard`);
    limpar(ctx.conteudo, el('div', { class: 'grade-dash' },
      el('div', { class: 'c12' }, el('div', { class: 'grade' },
        indicadoresTelefonia(d).slice(0, 3),
        indicador('Faturamento do mês', dinheiro(d.utilizacao.mes.gastos_centavos), `hoje: ${dinheiro(d.utilizacao.hoje.gastos_centavos)}`, 'dinheiro', 'laranja'))),
      el('div', { class: 'c8' }, cartaoSimultaneas(d.simultaneas, d.em_curso)),
      el('div', { class: 'c4' }, cartaoStatusLigacoes(d.utilizacao.hoje, d.em_curso)),
      el('div', { class: 'c5' }, cartaoUtilizacao(d.utilizacao)),
      el('div', { class: 'c3' }, cartaoRamais(d.ramais)),
      el('div', { class: 'c4' }, cartaoUsoMes(d.uso_mes)),
      el('div', { class: 'c7' }, cartao('Empresas com mais chamadas hoje', tabela(['Empresa', '>Chamadas', '>Agora', '>Valor'], d.top_empresas.map((e) =>
        el('tr', {}, td(e.nome), td(inteiro(e.chamadas), 'dir num'), td(inteiro(e.em_curso), 'dir num'), td(dinheiro(e.custo_centavos), 'dir num'))),
      'Nenhuma chamada hoje.'))),
      el('div', { class: 'c5' }, cartaoRecursos(d.recursos))));
  }, 10_000));
}

// ---------- Empresas: ligar a telefonia, limites, tarifas e rota ----------
async function formTelefonia(e, troncos) {
  return formModal(`Telefonia de ${e.nome}`, () => [
    el('fieldset', {}, el('legend', {}, 'Telefonia'),
      marcar('Telefonia ligada para esta empresa', { name: 'telefonia_ativa', checked: Boolean(e.telefonia_ativa) }),
      el('div', { class: 'duas' }, escolha('Tipo', 'tipo', TIPOS_EMPRESA, e.tipo ?? 'pabx'),
        escolha('Rota de saída', 'tronco_id', { '': 'Sem rota', ...Object.fromEntries(troncos.map((t) => [t.id, `${t.nome}${t.ativo ? '' : ' (inativa)'}`])) }, e.tronco_id ?? ''))),
    el('fieldset', {}, el('legend', {}, 'Limites'),
      el('div', { class: 'tres' }, campo('Ramais', { name: 'limite_ramais', type: 'number', min: 0, required: true, value: e.limite_ramais }),
        campo('Chamadas simultâneas', { name: 'limite_canais', type: 'number', min: 0, required: true, value: e.limite_canais }),
        campo('Disco das gravações (MB)', { name: 'disco_mb', type: 'number', min: 0, required: true, value: e.disco_mb })),
      el('div', { class: 'duas' }, campo('Falas sintetizadas (TTS) por mês', { name: 'tts_limite', type: 'number', min: 0, value: e.tts_limite }),
        campo('Transcrições (STT) por mês', { name: 'stt_limite', type: 'number', min: 0, value: e.stt_limite })),
      marcar('Gravar as chamadas', { name: 'gravar_chamadas', checked: Boolean(e.gravar_chamadas) })),
    el('fieldset', {}, el('legend', {}, 'Tarifas cobradas da empresa (por minuto)'),
      el('div', { class: 'tres' }, campo('Fixo (R$)', { name: 'tarifa_fixo', inputmode: 'decimal', value: reaisCampo(e.tarifa_fixo_centavos) }),
        campo('Móvel (R$)', { name: 'tarifa_movel', inputmode: 'decimal', value: reaisCampo(e.tarifa_movel_centavos) }),
        campo('Internacional (R$)', { name: 'tarifa_internacional', inputmode: 'decimal', value: reaisCampo(e.tarifa_internacional_centavos) }))),
  ], (d) => api.put(`${BASE}/empresas/${e.id}`, {
    telefonia_ativa: d.telefonia_ativa, tipo: d.tipo, tronco_id: d.tronco_id || null, gravar_chamadas: d.gravar_chamadas,
    limite_ramais: d.limite_ramais, limite_canais: d.limite_canais, disco_mb: d.disco_mb, tts_limite: d.tts_limite || 0, stt_limite: d.stt_limite || 0,
    tarifa_fixo_centavos: centavos(d.tarifa_fixo) ?? 0, tarifa_movel_centavos: centavos(d.tarifa_movel) ?? 0, tarifa_internacional_centavos: centavos(d.tarifa_internacional) ?? 0,
  }).then(() => true), { largo: true });
}

async function abaEmpresas(ctx) {
  const estado = { busca: '', tipo: '' };
  const lista = el('div');
  const busca = el('input', { placeholder: 'Empresa...' });
  const tipo = escolha(null, 'tipo', { '': 'Tipo', ...TIPOS_EMPRESA }, '');
  const filtrar = () => { Object.assign(estado, { busca: busca.value, tipo: tipo.value }); carregar(); };
  busca.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') filtrar(); });

  async function carregar() {
    const [empresas, troncos] = await Promise.all([listaEmpresas(estado), api.get(`${BASE}/troncos`)]);
    limpar(lista, tabela(['Empresa', '^Telefonia', '^Tipo', '^Ramais', '^Agora / hoje', '^Uso do disco', '^Chave da central', '^Ações'], empresas.map((e) => el('tr', {},
      td([e.nome, e.status === 'bloqueada' ? el('div', {}, el('span', { class: 'etiqueta erro', title: e.motivo_bloqueio ?? '' }, 'bloqueada')) : null]),
      td(ligada(e), 'centro'),
      td(e.telefonia_ativa ? TIPOS_EMPRESA[e.tipo] : '—', 'centro'),
      td(e.telefonia_ativa ? `${e.ramais}/${e.limite_ramais}` : '—', 'centro num'),
      td(e.telefonia_ativa ? `${e.chamadas_online} / ${e.chamadas_hoje}` : '—', 'centro num'),
      el('td', { style: 'width:170px' }, e.telefonia_ativa ? barraUso(e.disco_bytes, e.disco_mb * 1048576, { formato: (b) => gb(b).replace('GB', ''), sufixo: 'GB' }) : '—'),
      td(e.chaves_central ? el('span', { class: 'etiqueta ok' }, `${e.chaves_central} ativa(s)`) : e.telefonia_ativa ? el('span', { class: 'etiqueta aviso' }, 'falta') : '—', 'centro'),
      el('td', { class: 'acoes' }, botaoIcone('editar', 'Telefonia da empresa', async () => {
        if (!await formTelefonia(e, troncos)) return;
        ctx.esquecerEmpresa?.(e.id); // o menu da empresa mostra (ou esconde) a Telefonia
        toast('Telefonia da empresa salva.');
        carregar();
      })))), 'Nenhuma empresa encontrada. As empresas são criadas em Empresas.'));
  }
  limpar(ctx.conteudo, el('section', { class: 'cartao grande' },
    el('div', { class: 'filtros' }, busca, tipo, el('button', { class: 'btn primario largo', onclick: filtrar }, 'Filtrar')),
    el('p', { class: 'pequeno mudo' }, 'Ligue a telefonia por empresa e defina os limites, as tarifas e a operadora. Ramais, filas, URA e números de cada empresa ficam no painel dela, em Telefonia.'),
    lista));
  await carregar();
}

// ---------- Rotas de saída e números ----------
async function abaTerminacao(ctx, so) {
  const corpo = el('div', { class: 'coluna' });
  limpar(ctx.conteudo, corpo);
  const formTronco = (t) => formModal(t ? `Editar ${t.nome}` : 'Nova rota de saída', () => [
    campo('Nome', { name: 'nome', required: true, maxlength: 80, value: t?.nome ?? '' }),
    el('div', { class: 'duas' }, campo('Endereço (host) da operadora', { name: 'host', required: true, value: t?.host ?? '' }), campo('Porta', { name: 'porta', type: 'number', value: t?.porta ?? 5060 })),
    el('div', { class: 'duas' }, campo('Usuário', { name: 'usuario', value: t?.usuario ?? '', autocomplete: 'off' }),
      campo(t?.tem_senha ? 'Senha (em branco mantém a atual)' : 'Senha', { name: 'senha', type: 'password', autocomplete: 'new-password' })),
    el('div', { class: 'duas' }, campo('Prefixo de discagem', { name: 'prefixo', value: t?.prefixo ?? '', inputmode: 'numeric' }), campo('Canais', { name: 'canais', type: 'number', min: 1, value: t?.canais ?? 30 })),
    el('fieldset', {}, el('legend', {}, 'Custo da operadora por minuto (R$)'), el('div', { class: 'tres' },
      campo('Fixo', { name: 'custo_fixo', inputmode: 'decimal', value: reaisCampo(t?.custo_fixo_centavos ?? 0) }),
      campo('Móvel', { name: 'custo_movel', inputmode: 'decimal', value: reaisCampo(t?.custo_movel_centavos ?? 0) }),
      campo('Internacional', { name: 'custo_internacional', inputmode: 'decimal', value: reaisCampo(t?.custo_internacional_centavos ?? 0) }))),
    marcar('Rota ativa', { name: 'ativo', checked: t ? Boolean(t.ativo) : true }),
  ], (d) => {
    const c = { nome: d.nome, host: d.host, porta: d.porta, usuario: d.usuario, senha: d.senha || undefined, prefixo: d.prefixo, canais: d.canais, ativo: d.ativo,
      custo_fixo_centavos: centavos(d.custo_fixo) ?? 0, custo_movel_centavos: centavos(d.custo_movel) ?? 0, custo_internacional_centavos: centavos(d.custo_internacional) ?? 0 };
    return (t ? api.put(`${BASE}/troncos/${t.id}`, c) : api.post(`${BASE}/troncos`, c)).then(() => true);
  });

  async function carregar() {
    const [troncos, numeros, empresas] = await Promise.all([api.get(`${BASE}/troncos`), api.get(`${BASE}/numeros`), listaEmpresas()]);
    const nomesEmp = Object.fromEntries(empresas.map((e) => [e.id, e.nome]));
    const rotasEntrada = { '': 'Nenhuma', ...Object.fromEntries(troncos.map((t) => [t.id, t.nome])) };
    const formNumeros = () => formModal('Adicionar números', () => [
      el('label', { class: 'campo' }, 'Números (um por linha, com DDD)', el('textarea', { name: 'numeros', required: true, placeholder: '1130000000\n1130000001' })),
      campo('Descrição', { name: 'descricao', maxlength: 120 }),
      escolha('Rota de entrada', 'tronco_id', rotasEntrada, troncos[0]?.id ?? ''),
      escolha('Empresa', 'empresa_id', { '': 'Deixar no estoque', ...nomesEmp }, ''),
    ], async (d) => {
      const r = await api.post(`${BASE}/numeros`, d);
      toast(`${r.criados} número(s) adicionado(s)${r.repetidos ? `, ${r.repetidos} já existia(m)` : ''}.`);
      return true;
    });
    const formNumero = (n) => formModal(`Número ${telefone(n.numero)}`, () => [
      escolha('Empresa', 'empresa_id', { '': 'Estoque (sem empresa)', ...nomesEmp }, n.empresa_id ?? ''),
      escolha('Rota de entrada', 'tronco_id', rotasEntrada, n.tronco_id ?? ''),
      campo('Descrição', { name: 'descricao', value: n.descricao ?? '', maxlength: 120 }),
      el('p', { class: 'pequeno mudo', style: 'margin:0' }, 'Trocar a empresa apaga o destino configurado; a nova empresa escolhe para onde as chamadas vão.'),
    ], (d) => api.patch(`${BASE}/numeros/${n.id}`, { empresa_id: d.empresa_id || null, tronco_id: d.tronco_id || null, descricao: d.descricao }).then(() => true));

    const cartaoRotas = () => cartao('Rotas de saída (operadoras)',
      tabela(['^Nº', 'Nome', 'Endereço', '^Canais', '^Agora', '^Hoje', '^Empresas', '>Custo fixo/móvel/intern.', 'Situação', '^Ações'], troncos.map((t) => el('tr', {},
        td(t.id, 'centro num'), td(t.nome), td(el('span', { class: 'mono pequeno' }, `${t.usuario ? `${t.usuario}@` : ''}${t.host}:${t.porta}`)), td(t.canais, 'centro num'), td(t.em_curso, 'centro num'),
        td(t.chamadas_hoje, 'centro num'), td(t.empresas, 'centro num'),
        td(`${dinheiro(t.custo_fixo_centavos)} / ${dinheiro(t.custo_movel_centavos)} / ${dinheiro(t.custo_internacional_centavos)}`, 'dir num'),
        td(t.ativo ? el('span', { class: 'etiqueta ok' }, 'ativa') : el('span', { class: 'etiqueta erro' }, 'inativa')),
        el('td', { class: 'acoes' }, ctx.soMaster ? [
          botaoIcone('editar', 'Editar', async () => { if (await formTronco(t)) { toast('Rota salva.'); carregar(); } }),
          botaoIcone('lixo', 'Excluir', async () => {
            if (!await confirmar('Excluir rota', `Excluir a rota ${t.nome}?`, 'Excluir')) return;
            await api.del(`${BASE}/troncos/${t.id}`);
            toast('Rota excluída.');
            carregar();
          }, 'perigo')] : null))), 'Nenhuma rota cadastrada. Cadastre a operadora que faz as ligações para fora.'),
      ctx.soMaster ? el('div', { style: 'margin-top:12px' }, botao('Nova rota', 'primario', async () => { if (await formTronco()) { toast('Rota criada.'); carregar(); } })) : null);

    const cartaoDids = () => cartao('Números (DIDs)',
      tabela(['Número', 'Descrição', 'Rota', 'Empresa', 'Destino', '^Ações'], numeros.map((n) => el('tr', {},
        td(telefone(n.numero), 'num'), td(n.descricao ?? '—'), td(n.tronco ?? '—'), td(n.empresa ?? el('span', { class: 'etiqueta' }, 'estoque')),
        td(n.empresa ? (n.destino_tipo ? el('span', { class: 'etiqueta ok' }, n.destino_tipo) : el('span', { class: 'etiqueta aviso' }, 'sem destino')) : '—'),
        el('td', { class: 'acoes' }, ctx.soMaster ? [
          botaoIcone('editar', 'Editar', async () => { if (await formNumero(n)) { toast('Número salvo.'); carregar(); } }),
          botaoIcone('lixo', 'Excluir', async () => {
            if (!await confirmar('Excluir número', `Excluir ${telefone(n.numero)}?`, 'Excluir')) return;
            await api.del(`${BASE}/numeros/${n.id}`);
            toast('Número excluído.');
            carregar();
          }, 'perigo')] : null))), 'Nenhum número cadastrado.'),
      ctx.soMaster ? el('div', { style: 'margin-top:12px' }, botao('Adicionar números', 'primario', async () => { if (await formNumeros()) carregar(); })) : null);

    limpar(corpo, so === 'rotas' ? cartaoRotas() : cartaoDids());
  }
  await carregar();
}

// ---------- Chamadas e relatórios de todas as empresas ----------
async function abaChamadas(ctx) {
  const empresas = (await listaEmpresas()).filter((e) => e.telefonia_ativa);
  await painelChamadas(ctx.conteudo, `${BASE}/chamadas`, { master: true, empresas });
}
const abaRelatorios = (ctx) => painelRelatorios(ctx.conteudo, `${BASE}/relatorios`, { master: true });

// ---------- Situação da central ----------
async function abaDiagnostico(ctx) {
  ctx.parar(repetir(async () => {
    const d = await api.get(`${BASE}/diagnostico`);
    limpar(ctx.conteudo, el('div', { class: 'coluna' },
      cartao('Verificações', tabela(['Item', 'Situação', 'Detalhe'], d.verificacoes.map((x) => el('tr', {},
        td(x.nome), td([el('span', { class: `bolinha ${situacaoDiag[x.situacao][0]}` }), situacaoDiag[x.situacao][1]]),
        td(x.detalhe.replace(/(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/, (m) => dataHora(m))))))),
      cartao('Rotas de saída', tabela(['Rota', '^Agora / canais', 'Última chamada', 'Situação'], d.troncos.map((t) => el('tr', {},
        td(t.nome), td(`${t.em_curso} / ${t.canais}`, 'centro num'), td(dataHora(t.ultima_chamada)),
        td(t.ativo ? el('span', { class: 'etiqueta ok' }, 'ativa') : el('span', { class: 'etiqueta erro' }, 'inativa')))), 'Nenhuma rota cadastrada.'))));
  }, 15_000));
}

// ---------- Tarifação e padrões ----------
async function abaTarifacao(ctx) {
  if (!ctx.soMaster) { limpar(ctx.conteudo, cartao('Tarifação', el('p', { class: 'mudo' }, 'Só o master altera a tarifação.'))); return; }
  const c = await api.get(`${BASE}/configuracoes`);
  const f = el('form', { class: 'form', style: 'max-width:760px' },
    el('fieldset', {}, el('legend', {}, 'Cobrança por tempo'),
      el('div', { class: 'duas' }, campo('Cobrança mínima (segundos)', { name: 'cadencia_inicial_s', type: 'number', min: 1, value: c.cadencia_inicial_s }),
        campo('Depois, em blocos de (segundos)', { name: 'cadencia_s', type: 'number', min: 1, value: c.cadencia_s })),
      el('p', { class: 'pequeno mudo', style: 'margin:0' }, `Ex.: ${c.cadencia_inicial_s}/${c.cadencia_s} cobra ${c.cadencia_inicial_s} s no mínimo e depois a cada ${c.cadencia_s} s. Só as ligações realizadas e atendidas são cobradas.`)),
    el('fieldset', {}, el('legend', {}, 'Padrões ao ligar a telefonia de uma empresa'),
      el('div', { class: 'tres' }, campo('Tarifa fixo (R$/min)', { name: 'tarifa_fixo', inputmode: 'decimal', value: reaisCampo(c.tarifa_fixo_centavos) }),
        campo('Tarifa móvel (R$/min)', { name: 'tarifa_movel', inputmode: 'decimal', value: reaisCampo(c.tarifa_movel_centavos) }),
        campo('Tarifa internacional (R$/min)', { name: 'tarifa_internacional', inputmode: 'decimal', value: reaisCampo(c.tarifa_internacional_centavos) })),
      el('div', { class: 'tres' }, campo('Ramais', { name: 'limite_ramais_padrao', type: 'number', min: 0, value: c.limite_ramais_padrao }),
        campo('Chamadas simultâneas', { name: 'limite_canais_padrao', type: 'number', min: 0, value: c.limite_canais_padrao }),
        campo('Disco (MB)', { name: 'disco_mb_padrao', type: 'number', min: 0, value: c.disco_mb_padrao }))),
    el('fieldset', {}, el('legend', {}, 'Central telefônica'),
      el('div', { class: 'duas' }, campo('Encerrar chamadas presas após (horas)', { name: 'chamada_max_horas', type: 'number', min: 1, max: 48, value: c.chamada_max_horas }),
        campo('Ramal offline sem registro há (minutos)', { name: 'registro_expira_min', type: 'number', min: 1, value: c.registro_expira_min }))),
    el('div', {}, el('button', { class: 'btn primario largo' }, 'Salvar')));
  f.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const d = Object.fromEntries(new FormData(f));
    const corpo = { ...d, tarifa_fixo_centavos: centavos(d.tarifa_fixo), tarifa_movel_centavos: centavos(d.tarifa_movel), tarifa_internacional_centavos: centavos(d.tarifa_internacional) };
    delete corpo.tarifa_fixo; delete corpo.tarifa_movel; delete corpo.tarifa_internacional;
    const b = f.querySelector('button');
    b.disabled = true;
    api.patch(`${BASE}/configuracoes`, corpo).then(() => toast('Tarifação salva.'), (err) => toast(err.message, true)).finally(() => { b.disabled = false; });
  });
  limpar(ctx.conteudo, el('section', { class: 'cartao' }, f));
}

// ---------- Chave da central (Asterisk) ----------
async function abaCentral(ctx) {
  const lista = el('div');
  const carregar = async () => {
    const chaves = await api.get(`${BASE}/chaves`);
    limpar(lista, tabela(['Empresa', 'Nome', 'Chave', 'Criada', 'Último uso', 'Situação', '^Ações'], chaves.map((k) => el('tr', {},
      td(k.empresa), td(k.nome), td(el('span', { class: 'mono' }, `${k.prefixo}…`)), td(dataHora(k.criada_em)), td(dataHora(k.ultimo_uso)),
      td(k.ativa ? el('span', { class: 'etiqueta ok' }, 'ativa') : el('span', { class: 'etiqueta erro' }, 'revogada')),
      el('td', { class: 'acoes' }, k.ativa && ctx.soMaster ? botao('Revogar', 'perigo', async () => {
        if (!await confirmar('Revogar chave', `A central telefônica que usa "${k.nome}" perde o acesso na hora. Continuar?`, 'Revogar')) return;
        await api.del(`${BASE}/chaves/${k.id}`);
        toast('Chave revogada.');
        carregar();
      }) : null))), 'Nenhuma chave criada.'));
  };
  const nova = ctx.soMaster ? el('button', { class: 'btn primario', onclick: async () => {
    const empresas = (await listaEmpresas()).filter((e) => e.telefonia_ativa);
    if (!empresas.length) { toast('Ligue a telefonia de uma empresa primeiro (aba Empresas).', true); return; }
    let criada = null;
    const ok = await formModal('Nova chave da central', () => [
      escolha('Empresa', 'empresa_id', Object.fromEntries(empresas.map((e) => [e.id, e.nome])), empresas[0].id, { required: true }),
      campo('Nome (onde será usada)', { name: 'nome', required: true, maxlength: 80, placeholder: 'Ex.: Asterisk principal' }),
    ], async (d) => { criada = await api.post(`${BASE}/chaves`, d); return true; });
    if (!ok || !criada) return;
    carregar();
    modal('Chave criada', (fechar) => [
      el('p', { class: 'mudo' }, 'Copie agora: por segurança, a chave completa não aparece de novo. Ela vai no zoe-agi.conf do Asterisk (ZOE_CHAVE).'),
      el('div', { class: 'segredo' }, criada.chave),
      el('div', { class: 'linha entre', style: 'margin-top:14px' },
        el('button', { class: 'btn', onclick: () => navigator.clipboard?.writeText(criada.chave).then(() => toast('Copiada.'), () => toast('Não foi possível copiar.', true)) }, 'Copiar'),
        el('button', { class: 'btn primario', onclick: () => fechar() }, 'Pronto')),
    ]);
  } }, 'Nova chave') : null;

  const base = `${location.origin}${RAIZ}/api/central`;
  const doc = cartao('Como ligar a central telefônica',
    el('p', { class: 'mudo', style: 'margin-top:0' }, 'A central (Asterisk) usa a chave no cabeçalho X-Api-Key. Ela busca ramais, números, filas e URAs e avisa a ZOE de cada chamada. A mesma chave serve para a ligação conversada com a ZOE (/api/integracao/voz).'),
    el('pre', { class: 'codigo' }, [
      `GET  ${base}/config`,
      `POST ${base}/chamadas                    { "uid": "1729512345.42", "direcao": "saida", "origem": "1001", "destino": "11987654321" }`,
      `POST ${base}/chamadas/<uid>/atendida`,
      `POST ${base}/chamadas/<uid>/fim          { "status": "atendida", "gravacao_bytes": 480000 }`,
      `POST ${base}/ramais/1001/registro        { "online": true, "ip": "200.1.2.3" }`,
      `POST ${base}/recursos                    { "recurso": "tts", "quantidade": 1 }`,
      `POST ${base}/campanhas/5/proximos`,
    ].join('\n')));
  limpar(ctx.conteudo, acoesTopo(el('p', { class: 'mudo', style: 'margin:0' }, 'Uma chave por empresa (ou por central). Só serve para telefonia.'), nova),
    cartao(null, lista), el('div', { style: 'height:18px' }), doc);
  await carregar();
}

const ABAS = {
  painel: ['Painel', abaPainel],
  empresas: ['Empresas', abaEmpresas],
  rotas: ['Rotas de saída', (c) => abaTerminacao(c, 'rotas')],
  numeros: ['Números', (c) => abaTerminacao(c, 'numeros')],
  chamadas: ['Chamadas', abaChamadas],
  relatorios: ['Relatórios', abaRelatorios],
  diagnostico: ['Situação', abaDiagnostico],
  tarifacao: ['Tarifação', abaTarifacao],
  central: ['Chave da central', abaCentral],
};

export async function telaTelefoniaMaster(ctx) {
  const abas = el('div', { class: 'abas' });
  const corpo = el('div');
  limpar(ctx.conteudo, abas, corpo);
  let paradas = [];
  const sub = { ...ctx, conteudo: corpo, parar: (fn) => { paradas.push(fn); } };
  ctx.parar(() => { for (const p of paradas) p(); });
  const trocar = async (k) => {
    for (const p of paradas) p();
    paradas = [];
    limpar(abas, Object.entries(ABAS).map(([chave, [rotulo]]) => el('button', {
      class: `aba${chave === k ? ' on' : ''}`, type: 'button', onclick: () => trocar(chave),
    }, rotulo)));
    limpar(corpo, el('p', { class: 'mudo' }, 'Carregando…'));
    try { await ABAS[k][1](sub); } catch (err) { limpar(corpo, el('p', { class: 'mudo' }, err.message)); }
  };
  await trocar('painel');
}
