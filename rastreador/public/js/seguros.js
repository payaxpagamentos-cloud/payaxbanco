/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/

/** Seguros: portfólio por empresa (master), permissão por usuário (admin) e as contratações. A emissão é feita por uma plataforma externa. */
import { api } from './api.js';
import { el, limpar, toast, icone, acao, formModal, confirmar, escolha, campo, area, marcar, etiqueta, placa, dataHora } from './ui.js';
import { cartao, tabela, td, botaoIcone, linhaDado } from './comum.js';

const base = (ctx) => `/empresas/${ctx.empresaId}`;

const STATUS_SEGURO = { pendente: 'Pendente', enviada: 'Enviada à seguradora', emitida: 'Apólice emitida', recusada: 'Recusada', cancelada: 'Cancelada' };
const TOM_STATUS = { pendente: 'aviso', enviada: '', emitida: 'ok', recusada: 'erro', cancelada: '' };
const etiquetaStatus = (s) => etiqueta(STATUS_SEGURO[s] ?? s, TOM_STATUS[s] ?? '');

const ICONES_SEG = ['seguro', 'manutencao', 'carteira', 'motoristas', 'veiculos', 'seguranca', 'estrela', 'cadeado', 'alvo', 'rastreadores'];
const ROTULO_ICONE = {
  seguro: 'Guarda-chuva (seguro)', manutencao: 'Guincho / chave', carteira: 'Carteira (renda)', motoristas: 'Motorista',
  veiculos: 'Veículo', seguranca: 'Escudo', estrela: 'Estrela', cadeado: 'Cadeado', alvo: 'Alvo', rastreadores: 'Rastreador',
};
const lerMarcados = (checks) => checks.filter((c) => c.querySelector('input').checked).map((c) => Number(c.querySelector('input').value));

// ===================== EMPRESA =====================

async function telaSeguros(ctx) {
  const cont = el('div');
  limpar(ctx.conteudo, cont);
  const dados = await api.get(`${base(ctx)}/seguros`);
  if (!dados.tipos.length) {
    limpar(cont, cartao(null, el('div', { class: 'vazio-seguranca' }, icone('seguro'),
      el('strong', {}, 'Nenhum seguro liberado ainda.'),
      el('span', { class: 'mudo' }, 'A central ainda não habilitou seguros para a sua empresa. Fale com o suporte para liberar o portfólio.'))));
    return;
  }
  limpar(cont, el('section', { class: 'cartao grande' },
    el('p', { class: 'mudo', style: 'margin:0 0 16px' }, 'Seguros disponíveis para a sua frota. A apólice é emitida pela seguradora parceira; o status fica em Contratações.'),
    el('div', { class: 'grade-seguros' }, dados.tipos.map((t) => cardSeguro(ctx, t)))));
}

function cardSeguro(ctx, t) {
  return el('div', { class: 'cartao seguro-card' },
    el('div', { class: 'seguro-ic' }, icone(t.icone || 'seguro')),
    el('h3', {}, t.nome),
    el('p', { class: 'mudo' }, t.descricao || ''),
    t.pode_contratar
      ? (() => { const b = el('button', { class: 'btn primario largo' }, 'Contratar'); b.addEventListener('click', () => contratar(ctx, t)); return b; })()
      : el('div', { class: 'seguro-bloq mudo' }, icone('cadeado'), 'Sem permissão — fale com o administrador'));
}

async function contratar(ctx, t) {
  const [veiculos, motoristas] = await Promise.all([
    api.get(`${base(ctx)}/veiculos`).catch(() => []),
    api.get(`${base(ctx)}/motoristas`).catch(() => []),
  ]);
  const optsV = { '': 'Nenhum / não se aplica', ...Object.fromEntries(veiculos.map((v) => [v.id, `${placa(v.placa)}${v.descricao ? ` · ${v.descricao}` : ''}`])) };
  const optsM = { '': 'Nenhum / não se aplica', ...Object.fromEntries(motoristas.map((m) => [m.id, m.nome])) };
  await formModal(`Contratar · ${t.nome}`, () => [
    el('p', { class: 'mudo', style: 'margin:0' }, t.descricao || ''),
    escolha('Veículo (opcional)', 'veiculo_id', optsV, ''),
    escolha('Motorista (opcional)', 'motorista_id', optsM, ''),
    area('Observação (opcional)', { name: 'observacao', maxlength: 500, rows: 3 }),
    el('p', { class: 'aviso', style: 'margin:0' }, 'A contratação é registrada e enviada à seguradora parceira, que emite a apólice. Acompanhe o status em Contratações.'),
  ], async (d) => {
    await api.post(`${base(ctx)}/seguros/contratar`, {
      tipo_id: t.id, veiculo_id: d.veiculo_id || null, motorista_id: d.motorista_id || null, observacao: d.observacao || null,
    });
    toast('Contratação registrada! A apólice será emitida pela seguradora. Acompanhe em Contratações.');
  }, { rotulo: 'Confirmar contratação' });
}

async function telaSegurosContratacoes(ctx) {
  const lista = el('div');
  limpar(ctx.conteudo, el('section', { class: 'cartao grande' }, lista));
  const cs = await api.get(`${base(ctx)}/seguros/contratacoes`);
  limpar(lista, tabela(['Seguro', 'Veículo / Motorista', 'Solicitante', '^Status', 'Apólice', 'Data'], cs.map((c) => el('tr', {},
    td(el('span', { class: 'com-icone' }, icone(c.tipo_icone || 'seguro'), c.tipo_nome)),
    td(c.veiculo_placa ? placa(c.veiculo_placa) : (c.motorista_nome ?? '—')),
    td(c.usuario_nome ?? '—'),
    td(etiquetaStatus(c.status), 'centro'),
    td(c.apolice_numero ?? '—'),
    td(dataHora(c.criada_em)))), 'Nenhuma contratação ainda. Contrate na aba “Contratar”.'));
}

async function telaSegurosUsuarios(ctx) {
  const cont = el('div');
  limpar(ctx.conteudo, cont);
  const { tipos, usuarios } = await api.get(`${base(ctx)}/seguros/usuarios`);
  if (!tipos.length) {
    limpar(cont, cartao(null, el('p', { class: 'mudo', style: 'margin:0' }, 'Sua empresa ainda não tem seguros no portfólio. Fale com a central para liberar.')));
    return;
  }
  const operadores = usuarios.filter((u) => u.perfil === 'operador');
  const admins = usuarios.filter((u) => u.perfil !== 'operador');
  const blocos = [el('p', { class: 'mudo', style: 'margin:0 0 4px' }, 'Marque o que cada operador pode contratar. Administradores já contratam todo o portfólio.')];
  if (admins.length) blocos.push(el('div', { class: 'cartao sub-cartao' }, el('strong', {}, 'Administradores (acesso total)'),
    el('div', { class: 'chips', style: 'margin-top:8px' }, admins.map((a) => etiqueta(a.nome, 'ok')))));
  if (operadores.length) blocos.push(...operadores.map((u) => blocoOperador(ctx, u, tipos)));
  else blocos.push(el('p', { class: 'mudo' }, 'Nenhum operador cadastrado. Cadastre em Configurações → Geral → Usuários.'));
  limpar(cont, el('section', { class: 'cartao grande' }, blocos));
}

function blocoOperador(ctx, u, tipos) {
  const liberados = new Set(u.liberados === 'todos' ? tipos.map((t) => t.id) : u.liberados);
  const checks = tipos.map((t) => marcar(t.nome, { value: t.id, checked: liberados.has(t.id) }));
  const salvar = el('button', { class: 'btn primario pequeno' }, 'Salvar');
  salvar.addEventListener('click', () => acao(salvar, async () => {
    await api.put(`${base(ctx)}/seguros/usuarios/${u.id}`, { tipos: lerMarcados(checks) });
    toast(`Permissões de ${u.nome} salvas.`);
  }));
  return el('div', { class: 'cartao sub-cartao' },
    el('div', { class: 'linha entre' }, el('strong', {}, u.nome), el('span', { class: 'mudo' }, u.email)),
    el('div', { class: 'lista-marcar', style: 'margin-top:8px' }, checks),
    el('div', { class: 'linha', style: 'justify-content:flex-end;margin-top:8px' }, salvar));
}

// ===================== MASTER =====================

async function telaSegurosTipos(ctx) {
  const lista = el('div');
  async function carregar() {
    const tipos = await api.get('/master/seguros/tipos');
    const cols = ['Seguro', 'Descrição', 'Produto externo', '^Situação'];
    if (ctx.soMaster) cols.push('^Ações');
    limpar(lista, tabela(cols, tipos.map((t) => el('tr', {},
      td(el('span', { class: 'com-icone' }, icone(t.icone || 'seguro'), el('strong', {}, t.nome))),
      td(el('span', { class: 'mudo' }, t.descricao ?? '—')),
      td(t.produto_externo ? el('code', {}, t.produto_externo) : el('span', { class: 'mudo' }, '—')),
      td(t.ativo ? etiqueta('ativo', 'ok') : etiqueta('inativo', ''), 'centro'),
      ctx.soMaster ? el('td', { class: 'acoes' },
        botaoIcone('editar', 'Editar', async () => { if (await formTipo(t)) carregar(); }),
        botaoIcone('lixo', 'Excluir', async () => {
          if (!await confirmar(`Excluir ${t.nome}`, 'O seguro sai do catálogo e do portfólio das empresas. (Se houver contratações, desative em vez de excluir.)', 'Excluir')) return;
          await api.del(`/master/seguros/tipos/${t.id}`);
          toast('Tipo excluído.');
          carregar();
        }, 'perigo')) : null)), 'Nenhum tipo de seguro cadastrado.'));
  }
  limpar(ctx.conteudo, el('section', { class: 'cartao grande' },
    el('p', { class: 'mudo', style: 'margin:0 0 14px' }, 'Catálogo dos seguros oferecidos. O código do produto liga cada tipo ao produto da plataforma externa que emite as apólices.'),
    ctx.soMaster ? el('div', { class: 'linha', style: 'justify-content:flex-end;margin-bottom:14px' },
      el('button', { class: 'btn primario', onclick: async () => { if (await formTipo()) carregar(); } }, 'Novo tipo de seguro')) : null,
    lista));
  await carregar();
}

function formTipo(t) {
  return formModal(t ? `Editar ${t.nome}` : 'Novo tipo de seguro', () => [
    campo('Nome', { name: 'nome', required: true, maxlength: 80, value: t?.nome ?? '' }),
    area('Descrição', { name: 'descricao', maxlength: 300, rows: 2 }, t?.descricao ?? ''),
    escolha('Ícone', 'icone', Object.fromEntries(ICONES_SEG.map((k) => [k, ROTULO_ICONE[k] ?? k])), t?.icone ?? 'seguro'),
    campo('Código do produto na plataforma externa (opcional)', { name: 'produto_externo', maxlength: 80, value: t?.produto_externo ?? '' }),
    marcar('Ativo (pode ser habilitado nas empresas)', { name: 'ativo', checked: t ? !!t.ativo : true }),
  ], (d) => (t ? api.put(`/master/seguros/tipos/${t.id}`, d) : api.post('/master/seguros/tipos', d)), { rotulo: t ? 'Salvar' : 'Criar' });
}

async function telaSegurosEmpresas(ctx) {
  const empresas = await api.get('/master/empresas');
  const painel = el('div');
  const sel = escolha('Empresa', 'empresa', { '': 'Escolha a empresa…', ...Object.fromEntries(empresas.map((e) => [e.id, e.nome])) }, '');
  sel.querySelector('select').addEventListener('change', (ev) => carregar(ev.target.value));

  async function carregar(id) {
    if (!id) { limpar(painel, el('p', { class: 'mudo' }, 'Escolha uma empresa para liberar os seguros do portfólio dela.')); return; }
    const { tipos, habilitados } = await api.get(`/master/empresas/${id}/seguros`);
    if (!tipos.length) { limpar(painel, el('p', { class: 'mudo' }, 'Nenhum tipo de seguro no catálogo. Cadastre em “Tipos”.')); return; }
    const set = new Set(habilitados);
    const checks = tipos.map((t) => marcar(`${t.nome}${t.ativo ? '' : ' (inativo)'}`, { value: t.id, checked: set.has(t.id) }));
    const salvar = el('button', { class: 'btn primario' }, 'Salvar portfólio');
    salvar.addEventListener('click', () => acao(salvar, async () => {
      await api.put(`/master/empresas/${id}/seguros`, { tipos: lerMarcados(checks) });
      toast('Portfólio salvo.');
    }));
    limpar(painel, el('div', {}, el('div', { class: 'lista-marcar' }, checks),
      el('div', { class: 'linha', style: 'justify-content:flex-end;margin-top:12px' }, salvar)));
  }

  limpar(ctx.conteudo, el('section', { class: 'cartao grande' },
    el('p', { class: 'mudo', style: 'margin:0 0 12px' }, 'Escolha a empresa e marque os seguros que ela pode ver e contratar.'),
    el('div', { style: 'max-width:380px;margin-bottom:16px' }, sel),
    painel));
  carregar('');
}

async function telaSegurosContratacoesMaster(ctx) {
  const lista = el('div');
  const filtro = escolha(null, 'status', { '': 'Todos os status', ...STATUS_SEGURO }, '');
  filtro.addEventListener('change', carregar);
  async function carregar() {
    const cs = await api.get(`/master/seguros/contratacoes${filtro.value ? `?status=${filtro.value}` : ''}`);
    const cols = ['Empresa', 'Seguro', 'Veículo / Motorista', 'Solicitante', '^Status', 'Apólice', 'Data'];
    if (ctx.master) cols.push('^Ações');
    limpar(lista, tabela(cols, cs.map((c) => el('tr', {},
      td(el('strong', {}, c.empresa_nome)),
      td(el('span', { class: 'com-icone' }, icone(c.tipo_icone || 'seguro'), c.tipo_nome)),
      td(c.veiculo_placa ? placa(c.veiculo_placa) : (c.motorista_nome ?? '—')),
      td(c.usuario_nome ?? '—'),
      td(etiquetaStatus(c.status), 'centro'),
      td(c.apolice_numero ?? '—'),
      td(dataHora(c.criada_em)),
      ctx.master ? el('td', { class: 'acoes' }, botaoIcone('editar', 'Tratar', async () => { if (await formContratacao(c)) carregar(); })) : null)),
    'Nenhuma contratação registrada.'));
  }
  limpar(ctx.conteudo, el('section', { class: 'cartao grande' },
    el('div', { class: 'filtros', style: 'margin-bottom:14px' }, filtro),
    lista));
  await carregar();
}

function formContratacao(c) {
  return formModal(`Contratação · ${c.tipo_nome}`, () => [
    linhaDado('Empresa', c.empresa_nome),
    linhaDado('Solicitante', c.usuario_nome ?? '—'),
    linhaDado('Veículo / Motorista', c.veiculo_placa ? placa(c.veiculo_placa) : (c.motorista_nome ?? '—')),
    escolha('Status', 'status', STATUS_SEGURO, c.status),
    campo('Número da apólice', { name: 'apolice_numero', maxlength: 80, value: c.apolice_numero ?? '' }),
    campo('Referência na plataforma externa', { name: 'referencia_externa', maxlength: 120, value: c.referencia_externa ?? '' }),
    area('Observação', { name: 'observacao', maxlength: 500, rows: 2 }, c.observacao ?? ''),
  ], (d) => api.patch(`/master/seguros/contratacoes/${c.id}`, d), { rotulo: 'Salvar' });
}

export const TELAS_SEGUROS = { seguros: telaSeguros, 'seguros-contratacoes': telaSegurosContratacoes, 'seguros-usuarios': telaSegurosUsuarios };
export const TELAS_SEGUROS_MASTER = { 'seguros-tipos': telaSegurosTipos, 'seguros-empresas': telaSegurosEmpresas, 'seguros-contratacoes': telaSegurosContratacoesMaster };
