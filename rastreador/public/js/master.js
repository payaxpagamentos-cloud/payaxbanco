/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/
/** Telas do master (equipe da plataforma). */
import { api, qs, baixar, sessao, BASE } from './api.js';
import { el, limpar, dinheiro, dataHora, data, desde, inteiro, toast, campo, area, escolha, marcar, formModal, perguntar, confirmar, repetir, telefone, etiqueta, placa,
  TIPOS_EMPRESA, PERFIS, PROTOCOLOS, MODELOS_RASTREADOR, reaisCampo, centavos, icone, acao } from './ui.js';
import { cartao, indicador, tabela, td, botao, botaoIcone, painelMapa, painelIntegracoes, situacaoDiag, linhaDado, blocoDestaque } from './comum.js';
import { configPublica } from './mapa.js';
import { detalheVeiculo } from './empresa.js';
import { abrirFicha } from './frota.js';
import { STATUS_ROUBO } from './seguranca.js';
import { area as graficoArea } from './graficos.js';

const listaEmpresas = () => api.get('/master/empresas');

// ---------- Dashboard ----------
const agora = () => new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const primeiroNome = (nome) => String(nome ?? '').trim().split(/\s+/)[0] || 'Olá';

async function telaDashboard(ctx) {
  // O bloco de destaque fica fixo; a cada 15 s só os textos e os painéis de baixo são trocados.
  const heroi = blocoDestaque(
    el('a', { class: 'btn', href: '#/mapa' }, icone('mapa'), 'Abrir o mapa geral'),
    el('a', { class: 'btn', href: '#/diagnostico' }, icone('diagnostico'), 'Diagnóstico'));
  heroi.atualizar({ rotulo: 'Carregando a plataforma…', vivo: false, titulo: `Olá, ${primeiroNome(ctx.usuario.nome)}.`, destaque: 'Central de rastreamento.', texto: '' });
  const corpo = el('div', { class: 'coluna', style: 'gap:16px' });
  limpar(ctx.conteudo, el('div', { class: 'coluna', style: 'gap:16px' }, heroi.raiz, corpo));
  ctx.parar(repetir(async () => {
    const d = await api.get('/master/dashboard');
    const gt06 = d.conexoes_gt06 === null ? 'servidor GT06 desligado' : `${inteiro(d.conexoes_gt06)} GT06 conectado(s)`;
    heroi.atualizar({
      rotulo: d.veiculos.online ? `${inteiro(d.veiculos.online)} veículo(s) online agora` : 'Nenhum veículo comunicando agora',
      vivo: d.veiculos.online > 0,
      titulo: `Olá, ${primeiroNome(ctx.usuario.nome)}.`,
      destaque: 'Central de rastreamento.',
      texto: `${inteiro(d.empresas.ativa ?? 0)} empresa(s) ativa(s) · ${inteiro(d.mensagens_hoje)} mensagem(ns) hoje · ${gt06}. Atualizado às ${agora()}.`,
    });
    limpar(corpo,
      d.roubos?.length ? cartao(`Modo Roubo em andamento (${d.roubos.length})`, tabela(['Empresa', 'Veículo', 'Situação', '>Velocidade', 'Desde', '^'], d.roubos.map((o) => el('tr', {},
        td(o.empresa), td([el('strong', {}, placa(o.placa)), o.descricao ? el('div', { class: 'pequeno mudo' }, o.descricao) : null]),
        td(etiqueta(STATUS_ROUBO[o.status]?.[0] ?? o.status, STATUS_ROUBO[o.status]?.[1] ?? '')), td(`${Math.round(o.velocidade_kmh ?? 0)} km/h`, 'dir num'), td(desde(o.criada_em)),
        el('td', { class: 'acoes' }, botao('Acompanhar', 'perigo', () => { ctx.renomearEmpresa(o.empresa_id, o.empresa); ctx.ir('roubo', o.empresa_id); })))))) : null,
      el('div', { class: 'grade' },
        indicador('Empresas ativas', inteiro(d.empresas.ativa ?? 0), d.empresas.bloqueada ? `${d.empresas.bloqueada} bloqueada(s)` : 'nenhuma bloqueada', '', 'empresas'),
        indicador('Veículos online', `${inteiro(d.veiculos.online)}/${inteiro(d.veiculos.total)}`, 'comunicaram nos últimos minutos', 'ok', 'radar'),
        indicador('Rastreadores', inteiro(d.rastreadores.total), `${inteiro(d.rastreadores.instalados)} instalados · ${inteiro(d.rastreadores.estoque)} no estoque`, '', 'rastreadores'),
        indicador('Mensagens hoje', inteiro(d.mensagens_hoje), gt06, '', 'atividade'),
        indicador('Faturamento mensal', dinheiro(d.faturamento_mensal_centavos), 'veículos ativos × mensalidade', '', 'carteira'),
        indicador('Não cadastrados', inteiro(d.desconhecidos), 'equipamentos que tentaram enviar', d.desconhecidos ? 'aviso' : '', 'pergunta')),
      el('div', { class: 'grade-dash' },
        el('div', { class: 'c7' }, cartao('Mensagens recebidas por dia (14 dias)', graficoArea(d.mensagens_por_dia.map((x) => ({
          rotulo: x.data.slice(8), valor: x.mensagens, titulo: `${data(x.data)}: ${inteiro(x.mensagens)} mensagem(ns)` }))))),
        el('div', { class: 'c5' }, cartao('Empresas', tabela(['Empresa', '>Veículos', '>Online', '>Alertas'], d.top_empresas.map((e) =>
          el('tr', { class: 'clicavel', onclick: () => { ctx.renomearEmpresa(e.id, e.nome); ctx.ir('dashboard', e.id); } }, td(e.nome),
            td(`${inteiro(e.veiculos)}/${inteiro(e.limite_veiculos)}`, 'dir num'), td(inteiro(e.online), 'dir num'),
            td(e.alertas_pendentes ? etiqueta(inteiro(e.alertas_pendentes), 'aviso') : '0', 'dir'))), 'Nenhuma empresa.')))),
      d.alertas_pendentes ? el('p', { class: 'pequeno mudo' }, `${inteiro(d.alertas_pendentes)} alerta(s) pendente(s) somando todas as empresas.`) : null);
  }, 15_000));
}

async function telaMapa(ctx) {
  // A faixa do veículo tem as mesmas ações do painel da empresa (bloquear, desbloquear, pedir posição...), na empresa do veículo.
  await painelMapa(ctx, '/master/mapa', {
    mostrarEmpresa: true,
    detalhe: (v, painel, fechar) => detalheVeiculo({ ...ctx, empresaId: v.empresa_id, somenteLeitura: false }, v, painel, fechar, { mostrarEmpresa: true }),
  });
}

// ---------- Empresas ----------
async function formEmpresa(atual) {
  // Empresa nova: o plano (limite e mensalidade) é informado aqui, sem valor padrão; só o alerta sem comunicação vem dos parâmetros.
  const cfg = atual ? null : await api.get('/master/configuracoes').catch(() => null);
  const e = atual ?? { tipo: 'frota', limite_veiculos: '', mensalidade_centavos: null, sem_comunicacao_min: cfg?.sem_comunicacao_padrao_min ?? 120 };
  return formModal(atual ? `Editar ${atual.nome}` : 'Nova empresa', () => [
    el('fieldset', {}, el('legend', {}, 'Empresa'),
      campo('Nome', { name: 'nome', required: true, maxlength: 160, value: e.nome ?? '' }),
      el('div', { class: 'duas' }, campo('CNPJ ou CPF', { name: 'documento', value: e.documento ?? '', inputmode: 'numeric' }), escolha('Tipo', 'tipo', TIPOS_EMPRESA, e.tipo)),
      el('div', { class: 'duas' }, campo('E-mail', { name: 'email', type: 'email', value: e.email ?? '' }), campo('Telefone', { name: 'telefone', type: 'tel', value: e.telefone ?? '' }))),
    el('fieldset', {}, el('legend', {}, 'Plano contratado'),
      el('div', { class: 'duas' }, campo('Limite de veículos', { name: 'limite_veiculos', type: 'number', min: 0, required: true, value: e.limite_veiculos, placeholder: 'Ex.: 10' }),
        campo('Mensalidade por veículo (R$)', { name: 'mensalidade', inputmode: 'decimal', required: true, value: reaisCampo(e.mensalidade_centavos), placeholder: 'Ex.: 49,90' })),
      el('p', { class: 'pequeno fraco', style: 'margin:0' }, 'O valor do mês é a mensalidade × os veículos ativos da empresa (veja em Financeiro).')),
    el('fieldset', {}, el('legend', {}, 'Rastreamento'),
      campo('Alerta de veículo sem comunicação depois de (minutos, 0 = não alertar)', { name: 'sem_comunicacao_min', type: 'number', min: 0, value: e.sem_comunicacao_min })),
    atual ? null : el('fieldset', {}, el('legend', {}, 'Primeiro administrador da empresa (opcional)'),
      el('div', { class: 'duas' }, campo('Nome', { name: 'adm_nome', maxlength: 120 }), campo('E-mail', { name: 'adm_email', type: 'email' })),
      campo('Senha inicial (mínimo 8)', { name: 'adm_senha', type: 'password', minlength: 8, autocomplete: 'new-password' })),
  ], async (d) => {
    const corpo = { nome: d.nome, documento: d.documento, tipo: d.tipo, email: d.email, telefone: d.telefone, limite_veiculos: d.limite_veiculos,
      mensalidade_centavos: centavos(d.mensalidade), sem_comunicacao_min: d.sem_comunicacao_min };
    if (atual) return api.put(`/master/empresas/${atual.id}`, corpo);
    if (d.adm_email) corpo.administrador = { nome: d.adm_nome, email: d.adm_email, senha: d.adm_senha };
    return api.post('/master/empresas', corpo);
  }, { largo: true, rotulo: atual ? 'Salvar' : 'Criar empresa' });
}

async function telaEmpresas(ctx) {
  const estado = { busca: '', tipo: '', status: '' };
  const lista = el('div');
  const busca = el('input', { placeholder: 'Empresa ou CNPJ…', value: estado.busca });
  const tipo = escolha(null, 'tipo', { '': 'Tipo', ...TIPOS_EMPRESA }, '');
  const status = escolha(null, 'status', { '': 'Status', ativa: 'Ativa', bloqueada: 'Bloqueada' }, '');
  const filtrar = () => { Object.assign(estado, { busca: busca.value, tipo: tipo.value, status: status.value }); carregar(); };
  busca.addEventListener('keydown', (e) => { if (e.key === 'Enter') filtrar(); });

  async function carregar() {
    const empresas = await api.get(`/master/empresas${qs(estado)}`);
    limpar(lista, tabela(['Empresa', 'Tipo', '^Veículos', '^Online', '^Rastreadores', '^Alertas', '^Ações'], empresas.map((e) => el('tr', { class: 'clicavel', onclick: () => {
      ctx.renomearEmpresa(e.id, e.nome);
      ctx.ir('dashboard', e.id);
    } },
      td([el('strong', {}, e.nome), e.status === 'bloqueada' ? el('div', {}, el('span', { class: 'etiqueta erro', title: e.motivo_bloqueio ?? '' }, `bloqueada: ${e.motivo_bloqueio ?? ''}`)) : null]),
      td(TIPOS_EMPRESA[e.tipo]), td(`${e.veiculos}/${e.limite_veiculos}`, 'centro num'), td(inteiro(e.online), 'centro num'), td(inteiro(e.rastreadores), 'centro num'),
      td(e.alertas_pendentes ? etiqueta(inteiro(e.alertas_pendentes), 'aviso') : '0', 'centro'),
      el('td', { class: 'acoes' },
        botaoIcone('editar', 'Editar', async () => { if (await formEmpresa(await api.get(`/master/empresas/${e.id}`))) { toast('Empresa salva.'); carregar(); } }),
        e.status === 'bloqueada'
          ? botaoIcone('aberto', 'Desbloquear', async () => {
            if (!await confirmar('Desbloquear empresa', `${e.nome} volta a ter as posições gravadas e os usuários voltam a entrar.`, 'Desbloquear')) return;
            await api.post(`/master/empresas/${e.id}/desbloquear`);
            toast('Empresa desbloqueada.');
            carregar();
          })
          : botaoIcone('cadeado', 'Bloquear', async () => {
            const motivo = await perguntar(`Bloquear ${e.nome}`, 'Motivo (os usuários da empresa não entram e as posições deixam de ser gravadas)');
            if (!motivo) return;
            await api.post(`/master/empresas/${e.id}/bloquear`, { motivo });
            toast('Empresa bloqueada.');
            carregar();
          }),
        ctx.soMaster ? botaoIcone('lixo', 'Excluir', async () => {
          const nome = await perguntar(`Excluir ${e.nome}`, 'Digite o nome da empresa para confirmar. Usuários e chaves são desativados e os rastreadores voltam ao estoque; o histórico fica guardado até a retenção.');
          if (!nome) return;
          await api.del(`/master/empresas/${e.id}`, { confirmacao: nome });
          toast('Empresa excluída.');
          carregar();
        }, 'perigo') : null))), 'Nenhuma empresa encontrada.'));
  }
  limpar(ctx.conteudo, el('section', { class: 'cartao grande' },
    el('div', { class: 'filtros' }, busca, tipo, status, el('button', { class: 'btn primario largo', onclick: filtrar }, 'Filtrar')),
    lista,
    el('div', { class: 'linha', style: 'justify-content:flex-end;margin-top:16px' },
      el('button', { class: 'btn primario', onclick: async () => { if (await formEmpresa()) { toast('Empresa criada.'); carregar(); } } }, 'Nova empresa'))));
  await carregar();
}

// ---------- Financeiro ----------
// CNPJ (14 dígitos) ou CPF (11) com pontuação.
const documentoFmt = (d) => {
  const x = String(d ?? '').replace(/\D/g, '');
  if (x.length === 14) return x.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (x.length === 11) return x.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return x || null;
};

/** Plano de um cliente: limite de veículos e mensalidade por veículo, com a prévia do total pelos veículos ativos de agora. */
async function formPlano(c) {
  return formModal(`Plano de ${c.nome}`, (f) => {
    const previa = el('p', { class: 'aviso ok', style: 'margin:0' });
    const atualizar = () => {
      const m = centavos(f.querySelector('[name=mensalidade]')?.value ?? '') ?? 0;
      previa.textContent = `Com os ${inteiro(c.veiculos)} veículo(s) ativo(s) de hoje: ${dinheiro(Math.max(0, m) * c.veiculos)} por mês.`;
    };
    queueMicrotask(() => { f.querySelector('[name=mensalidade]').addEventListener('input', atualizar); atualizar(); });
    return [
      el('div', { class: 'duas' },
        campo('Limite de veículos', { name: 'limite_veiculos', type: 'number', min: 0, required: true, value: c.limite_veiculos }),
        campo('Mensalidade por veículo (R$)', { name: 'mensalidade', inputmode: 'decimal', required: true, value: reaisCampo(c.mensalidade_centavos) })),
      previa,
    ];
  }, (d) => api.put(`/master/empresas/${c.id}`, { limite_veiculos: d.limite_veiculos, mensalidade_centavos: centavos(d.mensalidade) ?? 0 }), { rotulo: 'Salvar plano' });
}

async function telaFinanceiro(ctx) {
  const estado = { busca: '', status: '' };
  const busca = el('input', { placeholder: 'Cliente ou CNPJ/CPF…', 'aria-label': 'Buscar cliente' });
  const status = escolha(null, 'status', { '': 'Todas as situações', ativa: 'Ativas', bloqueada: 'Bloqueadas' }, '');
  status.setAttribute('aria-label', 'Situação');
  const filtrar = () => { Object.assign(estado, { busca: busca.value.trim(), status: status.value }); carregar(); };
  busca.addEventListener('keydown', (e) => { if (e.key === 'Enter') filtrar(); });
  status.addEventListener('change', filtrar);
  const indicadores = el('div', { class: 'grade' });
  const lista = el('div');
  const rodape = el('div', { class: 'total-financeiro' });

  async function carregar() {
    const { resumo: r, clientes } = await api.get(`/master/financeiro${qs(estado)}`);
    limpar(indicadores,
      indicador('Faturamento mensal', dinheiro(r.faturamento_mensal_centavos), `${inteiro(r.clientes_ativos)} cliente(s) ativo(s)`, 'ok', 'carteira'),
      indicador('Veículos cobrados', inteiro(r.veiculos_cobrados), `${inteiro(r.vagas_livres)} vaga(s) livre(s) nos planos`, '', 'veiculos'),
      indicador('Ticket médio', dinheiro(r.ticket_medio_centavos), `por cliente pagante (${inteiro(r.clientes_pagantes)})`, '', 'empresas'),
      indicador('Valor médio por veículo', dinheiro(r.valor_medio_veiculo_centavos), 'faturamento ÷ veículos cobrados', '', 'rota'),
      indicador('Bloqueadas', dinheiro(r.bloqueadas_centavos), `${inteiro(r.bloqueadas)} cliente(s) fora do faturamento`, r.bloqueadas ? 'aviso' : '', 'cadeado'));
    const total = r.faturamento_mensal_centavos;
    limpar(lista, tabela(['Cliente', 'Tipo', 'Situação', 'Veículos', '>Mensalidade/veículo', '>Total mensal', 'Participação', '^Ações'], clientes.map((c) => {
      const uso = c.limite_veiculos ? Math.min(100, Math.round((c.veiculos / c.limite_veiculos) * 100)) : 0;
      const parte = c.status === 'ativa' && total ? (c.total_centavos / total) * 100 : 0;
      return el('tr', {},
        td([el('strong', {}, c.nome), documentoFmt(c.documento) ? el('div', { class: 'pequeno mudo mono' }, documentoFmt(c.documento)) : null]),
        td(TIPOS_EMPRESA[c.tipo] ?? c.tipo),
        td(c.status === 'ativa' ? etiqueta('ativa', 'ok') : el('span', { class: 'etiqueta erro', title: c.motivo_bloqueio ?? '' }, 'bloqueada')),
        td(el('div', { class: `uso${c.veiculos >= c.limite_veiculos && c.limite_veiculos ? ' cheio' : ''}` },
          el('div', { class: 'numeros' }, el('span', {}, `${inteiro(c.veiculos)} de ${inteiro(c.limite_veiculos)}`), el('span', {}, `${uso}%`)),
          el('div', { class: 'trilho' }, el('span', { style: `width:${uso}%` })))),
        td(dinheiro(c.mensalidade_centavos), 'dir num'),
        td(el('strong', { class: c.status === 'ativa' ? '' : 'mudo' }, dinheiro(c.total_centavos)), 'dir num'),
        td(c.status === 'ativa'
          ? el('div', { class: 'participacao', title: `${parte.toFixed(1).replace('.', ',')}% do faturamento` },
            el('div', { class: 'trilho' }, el('span', { style: `width:${parte.toFixed(1)}%` })), el('span', { class: 'num' }, `${parte.toFixed(1).replace('.', ',')}%`))
          : el('span', { class: 'pequeno mudo' }, 'fora do total')),
        el('td', { class: 'acoes' },
          botaoIcone('editar', 'Editar plano', async () => { if (await formPlano(c)) { toast('Plano salvo.'); carregar(); } }),
          botaoIcone('dashboard', 'Abrir o painel do cliente', () => { ctx.renomearEmpresa(c.id, c.nome); ctx.ir('dashboard', c.id); })));
    }), estado.busca || estado.status ? 'Nenhum cliente com esse filtro.' : 'Nenhum cliente cadastrado.'));
    limpar(rodape, el('span', { class: 'mudo' }, `${inteiro(clientes.length)} cliente(s) na lista · só as empresas ativas entram no total`),
      el('span', {}, 'Total mensal: ', el('strong', { class: 'num' }, dinheiro(total))));
  }

  limpar(ctx.conteudo, el('div', { class: 'coluna', style: 'gap:16px' },
    indicadores,
    el('section', { class: 'cartao' },
      el('div', { class: 'linha entre', style: 'margin-bottom:14px' }, el('h2', { style: 'margin:0' }, 'Valor por cliente'),
        el('div', { class: 'linha' }, busca, status,
          el('button', { class: 'btn', type: 'button', onclick: () => baixar(`/master/financeiro${qs({ ...estado, csv: 1 })}`, 'financeiro.csv') }, icone('baixar'), 'Baixar planilha'))),
      lista, rodape)));
  await carregar();
}

// ---------- Rastreadores (estoque) ----------
async function telaRastreadores(ctx) {
  const empresas = await listaEmpresas();
  const nomesEmp = Object.fromEntries(empresas.map((e) => [e.id, e.nome]));
  const estado = { busca: '', situacao: '', empresa_id: '', protocolo: '' };
  const lista = el('div');
  const desconhecidos = el('div');
  const filtro = (rotulo, nome, opcoes) => {
    const s = escolha(null, nome, opcoes, estado[nome]);
    s.addEventListener('change', () => { estado[nome] = s.value; carregar(); });
    return el('label', { class: 'campo' }, rotulo, s);
  };
  const busca = el('input', { placeholder: 'IMEI, chip, modelo ou placa' });
  busca.addEventListener('change', () => { estado.busca = busca.value; carregar(); });

  const form = (r, padrao = {}) => formModal(r ? `Rastreador ${r.imei}` : 'Novo rastreador', () => [
    el('div', { class: 'duas' }, campo('IMEI / identificador (15 dígitos da etiqueta)', { name: 'imei', required: true, maxlength: 46, value: r?.imei ?? padrao.imei ?? '', class: 'mono', inputmode: 'numeric' }),
      escolha('Protocolo', 'protocolo', PROTOCOLOS, r?.protocolo ?? padrao.protocolo ?? 'gt06')),
    campo('Modelo (J16 já vem com os comandos de bloqueio e consulta dele)', { name: 'modelo', maxlength: 60, value: r?.modelo ?? padrao.modelo ?? 'J16 4G', list: 'modelos-rastreador' }),
    el('datalist', { id: 'modelos-rastreador' }, MODELOS_RASTREADOR.map((m) => el('option', { value: m }))),
    el('div', { class: 'duas' }, campo('Número do chip', { name: 'chip_numero', inputmode: 'tel', value: r?.chip_numero ?? '' }),
      campo('Operadora do chip', { name: 'chip_operadora', maxlength: 40, value: r?.chip_operadora ?? '' })),
    escolha('Empresa', 'empresa_id', { '': 'Estoque (sem empresa)', ...nomesEmp }, r?.empresa_id ?? ''),
    r?.placa ? el('p', { class: 'aviso pequeno', style: 'margin:0' }, `Instalado em ${placa(r.placa)}. Trocar a empresa tira o rastreador do veículo.`) : null,
    area('Observações', { name: 'observacoes', maxlength: 300 }, r?.observacoes ?? ''),
  ], (d) => {
    const corpo = { ...d, empresa_id: d.empresa_id || null };
    return r ? api.put(`/master/rastreadores/${r.id}`, corpo) : api.post('/master/rastreadores', corpo);
  });

  async function carregar() {
    const [rs, desc] = await Promise.all([api.get(`/master/rastreadores${qs(estado)}`), api.get('/master/desconhecidos')]);
    limpar(lista, tabela(['IMEI', 'Modelo', 'Protocolo', 'Chip', 'Empresa', 'Veículo', 'Última comunicação', '^Ações'], rs.map((r) => el('tr', {},
      td([el('span', { class: 'mono' }, r.imei), r.conectado ? el('div', {}, etiqueta('conectado', 'ok')) : null]), td(r.modelo ?? '—'), td(PROTOCOLOS[r.protocolo]),
      td(r.chip_numero ? [telefone(r.chip_numero), r.chip_operadora ? el('div', { class: 'pequeno mudo' }, r.chip_operadora) : null] : '—'),
      td(r.empresa ?? etiqueta('estoque', 'info')), td(r.placa ? placa(r.placa) : '—'),
      td(r.ultima_comunicacao ? [dataHora(r.ultima_comunicacao), el('div', { class: 'pequeno mudo' }, desde(r.ultima_comunicacao))] : 'nunca'),
      el('td', { class: 'acoes' },
        r.veiculo_id && r.protocolo === 'gt06' ? botaoIcone('rastreadores', 'Ficha do equipamento', () => abrirFicha({ ...ctx, empresaId: r.empresa_id }, r.veiculo_id)) : null,
        botaoIcone('editar', 'Editar', async () => { if (await form(r)) { toast('Rastreador salvo.'); carregar(); } }),
        ctx.soMaster ? botaoIcone('lixo', 'Excluir', async () => {
          if (!await confirmar('Excluir rastreador', `Excluir ${r.imei}?`, 'Excluir')) return;
          await api.del(`/master/rastreadores/${r.id}`);
          toast('Rastreador excluído.');
          carregar();
        }, 'perigo') : null))), 'Nenhum rastreador.'));
    limpar(desconhecidos, desc.length ? cartao('Equipamentos não cadastrados',
      el('p', { class: 'mudo', style: 'margin-top:0' }, 'Tentaram enviar posições sem estar cadastrados. Cadastre para começar a receber.'),
      tabela(['IMEI', 'Protocolo', 'IP', 'Primeiro contato', 'Último contato', '>Mensagens', '^Ações'], desc.map((x) => el('tr', {},
        td(el('span', { class: 'mono' }, x.imei)), td(PROTOCOLOS[x.protocolo] ?? x.protocolo), td(el('span', { class: 'mono pequeno' }, x.ip ?? '—')),
        td(dataHora(x.primeiro_contato)), td(desde(x.ultimo_contato)), td(inteiro(x.mensagens), 'dir num'),
        el('td', { class: 'acoes' }, botao('Cadastrar', 'primario', async () => { if (await form(null, { imei: x.imei, protocolo: x.protocolo })) { toast('Rastreador cadastrado.'); carregar(); } }),
          botaoIcone('lixo', 'Ignorar', async () => { await api.del(`/master/desconhecidos/${encodeURIComponent(x.imei)}`); carregar(); }, 'perigo')))))) : null);
  }
  limpar(ctx.conteudo, el('div', { class: 'coluna', style: 'gap:18px' },
    el('div', { class: 'filtros livre' }, el('label', { class: 'campo' }, 'Buscar', busca),
      filtro('Situação', 'situacao', { '': 'Todos', estoque: 'No estoque', empresa: 'Na empresa, sem veículo', instalado: 'Instalado' }),
      filtro('Empresa', 'empresa_id', { '': 'Todas', ...nomesEmp }), filtro('Protocolo', 'protocolo', { '': 'Todos', ...PROTOCOLOS }),
      el('button', { class: 'btn primario', onclick: async () => { if (await form(null)) { toast('Rastreador cadastrado.'); carregar(); } } }, 'Novo rastreador')),
    desconhecidos, cartao(null, lista)));
  await carregar();
}

// ---------- Permissões e usuários ----------
async function telaUsuarios(ctx) {
  const empresas = await listaEmpresas();
  const estado = { empresa_id: '', perfil: '', busca: '' };
  const lista = el('div');
  const opcoesEmpresa = { '': 'Todos', plataforma: 'Equipe da plataforma', ...Object.fromEntries(empresas.map((e) => [e.id, e.nome])) };
  const filtro = (rotulo, nome, opcoes) => {
    const s = escolha(null, nome, opcoes, estado[nome]);
    s.addEventListener('change', () => { estado[nome] = s.value; carregar(); });
    return el('label', { class: 'campo' }, rotulo, s);
  };
  const busca = el('input', { placeholder: 'Nome ou e-mail' });
  busca.addEventListener('change', () => { estado.busca = busca.value; carregar(); });
  const formUsuario = (u) => formModal(u ? `Editar ${u.nome}` : 'Novo usuário', (f) => {
    const perfil = escolha('Perfil', 'perfil', PERFIS, u?.perfil ?? 'cliente', { required: true });
    const empresa = escolha('Empresa', 'empresa_id', Object.fromEntries(empresas.map((e) => [e.id, e.nome])), u?.empresa_id ?? empresas[0]?.id);
    const ajustar = () => { empresa.classList.toggle('oculto', ['master', 'suporte'].includes(f.querySelector('[name=perfil]').value) || Boolean(u)); };
    perfil.querySelector('select').addEventListener('change', ajustar);
    queueMicrotask(ajustar);
    return [
      campo('Nome', { name: 'nome', required: true, maxlength: 120, value: u?.nome ?? '' }),
      u ? el('p', { class: 'pequeno mudo', style: 'margin:0' }, `${u.email}${u.empresa_nome ? ` · ${u.empresa_nome}` : ''}`) : campo('E-mail', { name: 'email', type: 'email', required: true }),
      perfil, empresa,
      el('p', { class: 'pequeno mudo', style: 'margin:0' }, 'Master: tudo. Suporte: empresas, rastreadores, mapa geral e diagnóstico. Administrador da empresa: o painel da empresa. Operador: acompanha a frota e trata alertas.'),
      campo(u ? 'Nova senha (deixe em branco para manter)' : 'Senha inicial (mínimo 8)', { name: 'senha', type: 'password', minlength: 8, required: !u, autocomplete: 'new-password' }),
      u ? marcar('Usuário ativo', { name: 'ativo', checked: Boolean(u.ativo) }) : null,
    ];
  }, async (d) => {
    if (!d.senha) delete d.senha;
    if (u) {
      delete d.empresa_id;
      return api.patch(`/master/usuarios/${u.id}`, d);
    }
    return api.post('/master/usuarios', d);
  });

  async function carregar() {
    const usuarios = await api.get(`/master/usuarios${qs(estado)}`);
    limpar(lista, tabela(['Nome', 'E-mail', 'Perfil', 'Empresa', 'Último acesso', 'Situação', '^Ações'], usuarios.map((u) => el('tr', {},
      td(u.nome), td(u.email), td(PERFIS[u.perfil]), td(u.empresa_nome ?? el('span', { class: 'mudo' }, 'Plataforma')), td(dataHora(u.ultimo_acesso)),
      td(u.ativo ? etiqueta('ativo', 'ok') : etiqueta('inativo', 'erro')),
      el('td', { class: 'acoes' }, botaoIcone('editar', 'Editar', async () => { if (await formUsuario(u)) { toast('Usuário salvo.'); carregar(); } })))), 'Nenhum usuário.'));
  }
  limpar(ctx.conteudo, el('div', { class: 'filtros livre' }, filtro('Empresa', 'empresa_id', opcoesEmpresa), filtro('Perfil', 'perfil', { '': 'Todos', ...PERFIS }),
    el('label', { class: 'campo' }, 'Buscar', busca),
    el('button', { class: 'btn primario', onclick: async () => { if (await formUsuario()) { toast('Usuário criado.'); carregar(); } } }, 'Novo usuário')),
  cartao(null, lista));
  await carregar();
}

// ---------- Diagnóstico ----------
async function telaDiagnostico(ctx) {
  ctx.parar(repetir(async () => {
    const d = await api.get('/master/diagnostico');
    const PROT = { ...PROTOCOLOS };
    limpar(ctx.conteudo, el('div', { class: 'coluna', style: 'gap:18px' },
      cartao('Verificações', tabela(['Item', 'Situação', 'Detalhe'], d.verificacoes.map((x) => el('tr', {},
        td(x.nome), td([el('span', { class: `bolinha ${situacaoDiag[x.situacao][0]}` }), situacaoDiag[x.situacao][1]]), td(x.detalhe.replace(/(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/, (m) => dataHora(m))))))),
      el('div', { class: 'grade-dash' },
        el('div', { class: 'c6' }, cartao('Mensagens recebidas (7 dias)', tabela(['Dia', 'Protocolo', '>Mensagens'], d.recepcao.map((x) => el('tr', {},
          td(data(x.data)), td(PROT[x.protocolo] ?? x.protocolo), td(inteiro(x.mensagens), 'dir num'))), 'Nenhuma mensagem recebida.'))),
        el('div', { class: 'c6' }, cartao('Servidor',
          ...[['No ar desde', dataHora(d.servidor.iniciado_em)], ['Node.js', d.servidor.node], ['Memória', `${d.servidor.memoria_mb} MB`], ['Fuso', d.servidor.fuso],
            ['Posições guardadas', inteiro(d.servidor.posicoes)], ['Retenção', `${d.servidor.retencao_dias} dias`]].map(([r, v]) => linhaDado(r, v)))))));
  }, 15_000));
}

// ---------- Configurações ----------
/** Campo de parâmetro com a explicação embaixo. */
const parametro = (rotulo, attrs, dica) => el('div', { class: 'parametro' }, campo(rotulo, attrs), dica ? el('small', { class: 'dica-campo' }, dica) : null);

/** Formulário de parâmetros: os cartões montados por `montar(config)` e um único Salvar, que grava só os campos desta tela. */
async function telaParametros(ctx, montar) {
  const c = await api.get('/master/configuracoes');
  const salvar = el('button', { class: 'btn primario largo' }, 'Salvar');
  const f = el('form', { class: 'coluna', style: 'gap:16px' }, montar(c), el('div', { class: 'linha', style: 'justify-content:flex-end' }, salvar));
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    salvar.disabled = true;
    api.patch('/master/configuracoes', Object.fromEntries(new FormData(f)))
      .then(() => toast('Parâmetros salvos.'), (err) => toast(err.message, true)).finally(() => { salvar.disabled = false; });
  });
  limpar(ctx.conteudo, f);
}

async function telaConfiguracoes(ctx) {
  await telaParametros(ctx, (c) => el('div', { class: 'grade-dash' },
    el('div', { class: 'c4' }, cartao('Plataforma',
      el('div', { class: 'form' }, parametro('Nome exibido no painel', { name: 'nome_plataforma', required: true, maxlength: 60, value: c.nome_plataforma },
        'Aparece no menu, na tela de entrada e no título das páginas.')))),
    el('div', { class: 'c8' }, cartao('Rastreamento',
      el('div', { class: 'form' },
        el('div', { class: 'tres' },
          parametro('Online se comunicou há até (min)', { name: 'online_min', type: 'number', min: 1, required: true, value: c.online_min }, 'Dentro desse tempo, o veículo conta como online.'),
          parametro('Parada que encerra a viagem (min)', { name: 'parada_min', type: 'number', min: 1, required: true, value: c.parada_min }, 'Parado por mais tempo, a viagem termina no histórico.'),
          parametro('Guardar posições por (dias)', { name: 'retencao_dias', type: 'number', min: 7, required: true, value: c.retencao_dias }, 'Posições mais antigas são apagadas.')),
        el('div', { class: 'tres' },
          parametro('Descartar saltos do GPS acima de (km/h)', { name: 'velocidade_max_plausivel_kmh', type: 'number', min: 50, required: true, value: c.velocidade_max_plausivel_kmh },
            'Pontos com velocidade impossível são ignorados.'),
          parametro('Comando sem resposta expira em (horas)', { name: 'comando_expira_horas', type: 'number', min: 1, required: true, value: c.comando_expira_horas },
            'Depois disso, o comando é cancelado.'),
          parametro('Alerta sem comunicação nas empresas novas (min)', { name: 'sem_comunicacao_padrao_min', type: 'number', min: 0, required: true, value: c.sem_comunicacao_padrao_min },
            'Valor inicial; cada empresa pode mudar no cadastro.'))))),
    el('div', { class: 'c12' }, cartao('Segurança',
      el('div', { class: 'form' },
        el('div', { class: 'tres' },
          parametro('Velocidade segura para o corte (km/h)', { name: 'bloqueio_velocidade_segura_kmh', type: 'number', min: 5, max: 60, required: true, value: c.bloqueio_velocidade_segura_kmh },
            'Bloqueio inteligente: acima disso, o corte espera.'),
          parametro('Raio do Modo Estacionado (m)', { name: 'estacionado_raio_m', type: 'number', min: 30, max: 2000, required: true, value: c.estacionado_raio_m },
            'Sair mais que isso do ponto vira alerta.'),
          parametro('Sumiço suspeito depois de (min)', { name: 'sumico_min', type: 'number', min: 2, max: 120, required: true, value: c.sumico_min },
            'Andando ou ligado e sem comunicar por esse tempo.')),
        el('div', { class: 'tres' },
          parametro('Validade do código de liberação (min)', { name: 'liberacao_codigo_min', type: 'number', min: 3, max: 60, required: true, value: c.liberacao_codigo_min },
            'Código que o motorista gera no app.'),
          parametro('Aviso antes de acabar a liberação (min)', { name: 'liberacao_aviso_min', type: 'number', min: 0, max: 120, required: true, value: c.liberacao_aviso_min },
            'Pelo WhatsApp, para o gestor e o motorista.'),
          el('div')))))));
}

// ---------- WhatsApp (Evolution) ----------
const STATUS_MSG = { pendente: ['na fila', 'aviso'], enviada: ['enviada', 'ok'], falhou: ['falhou', 'erro'] };
const numeroLeitura = (n) => (String(n ?? '').startsWith('55') ? telefone(String(n).slice(2)) : n);
async function telaWhatsapp(ctx) {
  const corpo = el('div', { class: 'coluna', style: 'gap:16px' });
  limpar(ctx.conteudo, corpo);
  let dados = null;
  const formContato = async (c) => {
    const marcados = new Set(c ? c.tipos.split(',') : dados.seguranca);
    const r = await formModal(c ? `Editar ${c.nome}` : 'Contato da central', () => [
      el('div', { class: 'duas' }, campo('Nome', { name: 'nome', required: true, maxlength: 80, value: c?.nome ?? '' }),
        campo('WhatsApp (com DDD)', { name: 'numero', required: true, inputmode: 'tel', value: c ? numeroLeitura(c.numero) : '' })),
      el('fieldset', {}, el('legend', {}, 'Avisos de segurança de todas as empresas'), el('div', { class: 'grade-marcar' }, dados.seguranca.map((k) => el('label', { class: 'marcar' },
        el('input', { type: 'checkbox', name: `tipo_${k}`, checked: marcados.has(k) || null }), dados.tipos[k] ?? k)))),
      c ? marcar('Ativo', { name: 'ativo', checked: Boolean(c.ativo) }) : null,
    ], (d) => {
      const corpoReq = { nome: d.nome, numero: d.numero, tipos: dados.seguranca.filter((k) => d[`tipo_${k}`]), ativo: d.ativo };
      return c ? api.put(`/master/contatos/${c.id}`, corpoReq) : api.post('/master/contatos', corpoReq);
    }, { largo: true });
    if (r) { toast('Contato salvo.'); carregar(); }
  };
  async function carregar() {
    dados = await api.get('/master/whatsapp');
    const s = dados.situacao;
    const fila = Object.fromEntries(dados.fila.map((x) => [x.status, x.n]));
    limpar(corpo,
      el('div', { class: 'grade' },
        indicador('Conexão', s.conectado ? 'Conectado' : s.configurado ? 'Desconectado' : 'Não configurado',
          s.configurado ? `instância ${s.instancia} · ${s.estado}` : 'falta configurar no servidor', s.conectado ? 'ok' : 'erro', 'radar'),
        indicador('Enviadas (24 h)', inteiro(fila.enviada ?? 0), 'mensagens entregues à Evolution', '', 'check'),
        indicador('Na fila', inteiro(fila.pendente ?? 0), 'tentando de novo se falhar', fila.pendente ? 'aviso' : '', 'historico'),
        indicador('Falharam (24 h)', inteiro(fila.falhou ?? 0), 'depois de todas as tentativas', fila.falhou ? 'erro' : '', 'alertas')),
      s.configurado ? null : cartao('Como ligar', el('p', { class: 'mudo', style: 'margin-top:0' },
        'Use a mesma Evolution do manager. No arquivo .env do servidor (nunca no chat), coloque as três linhas abaixo e reinicie o Rastreador:'),
      el('pre', { class: 'codigo' }, 'RASTREADOR_EVOLUTION_URL=https://endereco-da-evolution\nRASTREADOR_EVOLUTION_INSTANCIA=nome-da-instancia\nRASTREADOR_EVOLUTION_CHAVE=chave-da-api\nRASTREADOR_URL_PUBLICA=https://seu-endereco/rastreador')),
      s.erro ? el('p', { class: 'aviso erro' }, `A Evolution respondeu com erro: ${s.erro}`) : null,
      el('div', { class: 'grade-dash' },
        el('div', { class: 'c5' }, cartao('Mensagem de teste', (() => {
          const f = el('form', { class: 'form' }, campo('Mandar para (WhatsApp com DDD)', { name: 'numero', required: true, inputmode: 'tel' }),
            el('button', { class: 'btn primario', disabled: !s.configurado || null }, 'Enviar teste'));
          f.addEventListener('submit', (e) => { e.preventDefault(); const b = f.querySelector('button'); b.disabled = true;
            api.post('/master/whatsapp/teste', { numero: f.numero.value }).then(() => { toast('Teste na fila.'); setTimeout(() => corpo.isConnected && carregar(), 3000); }, (err) => toast(err.message, true))
              .finally(() => { b.disabled = false; }); });
          return f;
        })())),
        el('div', { class: 'c7' }, cartao('Contatos da central', el('p', { class: 'mudo', style: 'margin-top:0' }, 'Recebem os avisos de segurança de todas as empresas (roubo, sumiço, estacionado violado...).'),
          tabela(['Nome', 'WhatsApp', 'Avisos', '^'], dados.contatos.map((c) => el('tr', { class: c.ativo ? '' : 'inativo' }, td(c.nome), td(numeroLeitura(c.numero)),
            td(c.tipos.split(',').map((t) => dados.tipos[t] ?? t).join(', ')),
            el('td', { class: 'acoes' }, ctx.soMaster ? [botaoIcone('editar', 'Editar', () => formContato(c)), botaoIcone('lixo', 'Excluir', async () => {
              if (!await confirmar('Excluir contato', `${c.nome} deixa de receber os avisos.`, 'Excluir')) return;
              await api.del(`/master/contatos/${c.id}`);
              carregar();
            }, 'perigo')] : null))), 'Nenhum contato da central.'),
          ctx.soMaster ? el('div', { style: 'margin-top:12px' }, botao('Novo contato', 'primario', () => formContato(null))) : null))),
      cartao('Últimas mensagens', tabela(['Quando', 'Empresa', 'Para', 'Mensagem', 'Situação'], dados.mensagens.map((m) => {
        const [rot, tom] = STATUS_MSG[m.status] ?? [m.status, ''];
        return el('tr', {}, td(dataHora(m.enviado_em ?? m.criado_em)), td(m.empresa ?? 'Plataforma'), td(numeroLeitura(m.numero)), td(el('span', { class: 'pequeno' }, m.texto)),
          td([etiqueta(rot, tom), m.erro ? el('div', { class: 'pequeno mudo' }, m.erro) : null]));
      }), 'Nenhuma mensagem ainda.')));
  }
  ctx.parar(repetir(carregar, 30_000));
}

// ---------- Assistente IA ----------
async function telaAssistenteIa(ctx) {
  const d = await api.get('/master/ia');
  const tokens = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace('.', ',')} mi` : n >= 1000 ? `${Math.round(n / 1000)} mil` : inteiro(n));
  await telaParametros(ctx, (c) => el('div', { class: 'coluna', style: 'gap:16px' },
    el('div', { class: 'grade' },
      indicador('Assistente', d.configurado ? 'Ligado' : 'Desligado', d.configurado ? `modelo ${d.modelo}` : 'falta a chave no servidor', d.configurado ? 'ok' : 'erro', 'pergunta'),
      indicador('Perguntas hoje', inteiro(d.uso.reduce((s, u) => s + u.hoje, 0)), `limite de ${inteiro(c.ia_limite_dia)} por empresa`, '', 'atividade'),
      indicador('Perguntas no mês', inteiro(d.uso.reduce((s, u) => s + u.mes, 0)), `${inteiro(d.uso.length)} empresa(s) usando`, '', 'dashboard')),
    d.configurado ? null : cartao('Como ligar', el('p', { class: 'mudo', style: 'margin-top:0' },
      'Crie a chave no console do provedor de IA e coloque no arquivo .env do servidor (nunca no chat). Depois reinicie o Rastreador. A chave tem custo por uso, por isso o limite diário por empresa.'),
    el('pre', { class: 'codigo' }, 'RASTREADOR_IA_CHAVE=sk-ant-...')),
    el('div', { class: 'grade-dash' },
      el('div', { class: 'c4' }, cartao('Limite', el('div', { class: 'form' },
        parametro('Perguntas por dia, por empresa', { name: 'ia_limite_dia', type: 'number', min: 0, max: 10000, required: true, value: c.ia_limite_dia },
          '0 desliga o assistente em todas as empresas.')))),
      el('div', { class: 'c8' }, cartao('Uso no mês', tabela(['Empresa', '>Hoje', '>No mês', '>Tokens (entrada / saída)'], d.uso.map((u) => el('tr', {},
        td(u.empresa), td(inteiro(u.hoje), 'dir num'), td(inteiro(u.mes), 'dir num'), td(`${tokens(u.tokens_entrada ?? 0)} / ${tokens(u.tokens_saida ?? 0)}`, 'dir num'))),
      'Ninguém usou o assistente este mês.'))))));
}

async function telaComandosGt06(ctx) {
  await telaParametros(ctx, (c) => cartao('Textos dos comandos',
    el('p', { class: 'mudo', style: 'margin-top:0' }, 'Usados nos rastreadores GT06 sem comandos próprios (o J16 4G já tem os dele: RELAY,1#, RELAY,0#, STATUS#, PARAM#). O texto varia por fabricante, por exemplo DYD,000000# e HFYD,000000#.'),
    el('div', { class: 'form' },
      el('div', { class: 'duas' },
        parametro('Bloquear', { name: 'gt06_cmd_bloquear', required: true, maxlength: 60, value: c.gt06_cmd_bloquear, class: 'mono' }, 'Corta o combustível ou a ignição.'),
        parametro('Desbloquear', { name: 'gt06_cmd_desbloquear', required: true, maxlength: 60, value: c.gt06_cmd_desbloquear, class: 'mono' }, 'Libera o veículo de novo.')),
      el('div', { class: 'duas' },
        parametro('Pedir posição', { name: 'gt06_cmd_localizar', required: true, maxlength: 60, value: c.gt06_cmd_localizar, class: 'mono' }, 'O rastreador manda a localização na hora.'),
        parametro('Reiniciar', { name: 'gt06_cmd_reiniciar', required: true, maxlength: 60, value: c.gt06_cmd_reiniciar, class: 'mono' }, 'Reinicia o equipamento.')))));
}

// ---------- Integrações ----------
async function telaIntegracoes(ctx) {
  const [empresas, cfg] = await Promise.all([listaEmpresas(), configPublica()]);
  await painelIntegracoes(ctx.conteudo, {
    empresas, podeCriar: ctx.soMaster, portaGt06: cfg.gt06_porta,
    listar: () => api.get('/master/chaves'),
    criar: (d) => api.post('/master/chaves', d),
    revogar: (id) => api.del(`/master/chaves/${id}`),
  });
}

// ---------- Atividades ----------
async function telaAtividades(ctx) {
  const corpo = el('div');
  let pagina = 1;
  const NOMES = { login: 'Entrou no painel', login_falhou: 'Login recusado', senha_alterada: 'Alterou a senha', comando_criado: 'Enviou comando' };
  async function carregar() {
    const itens = await api.get(`/master/auditoria${qs({ pagina })}`);
    limpar(corpo, cartao(null, tabela(['Quando', 'Usuário', 'Empresa', 'Ação', 'Detalhes', 'IP'], itens.map((a) => el('tr', {},
      td(dataHora(a.criado_em)), td(a.usuario ?? el('span', { class: 'mudo' }, a.detalhes?.email ?? '—')), td(a.empresa ?? '—'),
      td(a.acao === 'login_falhou' ? etiqueta(NOMES[a.acao], 'erro') : NOMES[a.acao] ?? a.acao.replace(/_/g, ' ')),
      td(el('span', { class: 'pequeno mono' }, a.detalhes ? JSON.stringify(a.detalhes).slice(0, 140) : '')), td(el('span', { class: 'mono pequeno' }, a.ip ?? '')))), 'Nada registrado.'),
    el('div', { class: 'paginacao' }, el('span', { class: 'pequeno mudo' }, `Página ${pagina}`), el('div', { class: 'linha' },
      el('button', { class: 'btn pequeno', disabled: pagina <= 1, onclick: () => { pagina--; carregar(); } }, 'Anterior'),
      el('button', { class: 'btn pequeno', disabled: itens.length < 100, onclick: () => { pagina++; carregar(); } }, 'Próxima')))));
  }
  limpar(ctx.conteudo, corpo);
  await carregar();
}

// ---------- Atualizar o sistema (só master): sobe o .zip e o sistema reinicia sozinho ----------
async function esperarReinicio(versaoNova, status) {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const resp = await fetch(`${BASE}/api/saude`, { cache: 'no-store' });
      if (resp.ok) {
        const j = await resp.json().catch(() => ({}));
        if (j.versao === versaoNova) {
          limpar(status, el('p', { class: 'aviso ok' }, `✅ Atualizado! Agora na versão ${j.versao}. Recarregando a página…`));
          setTimeout(() => location.reload(), 2500);
          return;
        }
      }
    } catch { /* ainda reiniciando */ }
    limpar(status, el('p', { class: 'mudo' }, `Reiniciando o sistema… aguarde (${i + 1})`));
  }
  limpar(status, el('p', { class: 'aviso' }, 'O sistema está demorando a voltar. Recarregue a página (F5) em alguns segundos.'));
}

async function telaSistema(ctx) {
  const info = await api.get('/master/sistema');
  const ultima = (info.historico || []).find((h) => h.acao === 'sistema_atualizado');

  const arquivo = el('input', { type: 'file', accept: '.zip,application/zip', style: 'display:none' });
  const nomeArq = el('span', { class: 'mudo' }, 'Nenhum arquivo escolhido');
  arquivo.addEventListener('change', () => { nomeArq.textContent = arquivo.files?.[0]?.name || 'Nenhum arquivo escolhido'; });
  const seletor = el('label', { class: 'seletor-arquivo' }, icone('baixar'),
    el('div', {}, el('strong', {}, 'Escolher o arquivo da atualização'), el('br'), nomeArq), arquivo);
  const senha = el('input', { type: 'password', autocomplete: 'current-password', placeholder: 'sua senha' });
  const status = el('div');
  const enviar = el('button', { class: 'btn primario' }, 'Enviar e atualizar');
  enviar.addEventListener('click', () => acao(enviar, async () => {
    const f = arquivo.files?.[0];
    if (!f) { toast('Escolha o arquivo .zip da atualização.', true); return; }
    if (!senha.value) { toast('Digite a sua senha para confirmar.', true); return; }
    limpar(status, el('p', { class: 'mudo' }, 'Enviando o arquivo…'));
    const buf = await f.arrayBuffer();
    let resp;
    try {
      resp = await fetch(`${BASE}/api/master/sistema/atualizar`, {
        method: 'POST', headers: { Authorization: `Bearer ${sessao.get()?.token ?? ''}`, 'Content-Type': 'application/octet-stream', 'x-confirmacao': senha.value }, body: buf,
      });
    } catch { throw new Error('Falha ao enviar o arquivo. Verifique a internet e tente de novo.'); }
    if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e.erro || `Erro ${resp.status} ao atualizar.`); }
    const r = await resp.json();
    senha.value = '';
    limpar(status, el('p', { class: 'mudo' }, `Arquivo recebido (versão ${r.versao}). O sistema está reiniciando…`));
    await esperarReinicio(r.versao, status);
  }));

  const linhaHist = (h) => {
    const d = h.detalhes || {};
    const txt = h.acao === 'sistema_revertido' ? `↩ Revertido → ${d.para || '—'}` : `${d.de || '—'} → ${d.para || '—'}`;
    return linhaDado(txt, `${dataHora(h.criado_em)}${h.usuario ? ` · ${h.usuario}` : ''}`);
  };
  const reverter = info.backups?.length ? el('button', { class: 'btn' }, 'Reverter para a versão anterior') : null;
  if (reverter) reverter.addEventListener('click', () => acao(reverter, async () => {
    const s = await perguntar('Voltar à versão anterior', 'Digite a sua senha para confirmar. O sistema reinicia na versão anterior; os dados continuam intactos.');
    if (!s) return;
    const r = await api.post('/master/sistema/reverter', { senha: s });
    limpar(status, el('p', { class: 'mudo' }, 'Revertendo e reiniciando…'));
    await esperarReinicio(r.versao, status);
  }));

  limpar(ctx.conteudo,
    cartao('Atualizar o sistema',
      el('p', { class: 'mudo', style: 'margin:0 0 14px' }, 'Envie aqui o arquivo da atualização (rastreador-AAAA.MM.NN.zip). O sistema confere o arquivo e instala sozinho, do mesmo jeito que a atualização pelo terminal. Se a versão nova não subir, ele volta para a anterior.'),
      linhaDado('Versão instalada', info.versao || '—'),
      linhaDado('Node.js', info.node),
      ultima ? el('p', { class: 'aviso ok', style: 'margin:14px 0 0' }, `✓ Atualizado para a versão ${ultima.detalhes?.para || info.versao} em ${dataHora(ultima.criado_em)}.`) : null,
      el('h3', { style: 'margin:22px 0 10px;font-size:15px' }, 'Enviar uma versão nova'),
      seletor,
      el('label', { class: 'campo', style: 'margin-top:12px;max-width:320px' }, 'Sua senha (para confirmar)', senha),
      el('div', { class: 'linha', style: 'margin-top:14px' }, enviar),
      status),
    cartao('Atualizações', (info.historico || []).length ? el('div', {}, info.historico.map(linhaHist)) : el('p', { class: 'mudo', style: 'margin:0' }, 'Ainda sem atualizações registradas.')),
    reverter ? cartao('Segurança', el('p', { class: 'pequeno fraco', style: 'margin:0 0 10px' }, `${info.backups.length} backup(s) guardado(s). Se algo sair errado depois de atualizar, reverta para a versão anterior.`), reverter) : null);
}

export const TELAS_MASTER = {
  sistema: telaSistema,
  dashboard: telaDashboard, mapa: telaMapa, empresas: telaEmpresas, financeiro: telaFinanceiro, rastreadores: telaRastreadores, usuarios: telaUsuarios, diagnostico: telaDiagnostico,
  configuracoes: telaConfiguracoes, 'comandos-gt06': telaComandosGt06, integracoes: telaIntegracoes, atividades: telaAtividades,
  whatsapp: telaWhatsapp, 'assistente-ia': telaAssistenteIa,
};
