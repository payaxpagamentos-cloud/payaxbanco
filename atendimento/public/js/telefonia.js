/**
 * Telefonia (o PABX dentro da ZOE): painel, supervisão, ramais, filas no telefone, URA, números,
 * campanhas, chamadas, agenda, relatórios e tarifas. As filas são as mesmas do WhatsApp; os
 * usuários e as permissões, os da ZOE.
 */
import { api, qs } from './api.js';
import { el, limpar, acao, dinheiro, dataHora, hora, duracao, minutos, inteiro, telefone, gb, barraUso, toast, campo, area, escolha, marcar, formModal, modal, confirmar,
  repetir, etiqueta, pessoa, situacao } from './ui.js';
import { cartao, indicador, tabela, td, botao, botaoIcone, acoesTopo } from './comum.js';
import { cartaoUtilizacao, cartaoSimultaneas, cartaoRamais, cartaoUsoMes, cartaoRecursos, painelChamadas, painelRelatorios, cartaoStatusLigacoes,
  indicadoresTelefonia, etiquetaChamada, DIRECOES, TIPOS_DESTINO } from './telefonia-comum.js';

const base = (ctx) => `/empresas/${ctx.empresaId}/telefonia`;
const pode = (ctx) => ctx.pode('telefonia.editar');

// ---------- Dashboard ----------
async function telaDashboard(ctx) {
  ctx.parar(repetir(async () => {
    const d = await api.get(`${base(ctx)}/dashboard`);
    limpar(ctx.conteudo, el('div', { class: 'grade-dash' },
      el('div', { class: 'c12' }, el('div', { class: 'grade' }, indicadoresTelefonia(d))),
      el('div', { class: 'c8' }, cartaoSimultaneas(d.simultaneas, d.em_curso)),
      el('div', { class: 'c4' }, cartaoStatusLigacoes(d.utilizacao.hoje, d.em_curso)),
      el('div', { class: 'c5' }, cartaoUtilizacao(d.utilizacao)),
      el('div', { class: 'c3' }, cartaoRamais(d.ramais)),
      el('div', { class: 'c4' }, cartaoUsoMes(d.uso_mes)),
      el('div', { class: 'c6' }, cartaoRecursos(d.recursos)),
      el('div', { class: 'c6' }, cartao('Limites', el('div', { class: 'coluna' },
        el('div', {}, el('div', { class: 'pequeno mudo' }, 'Ramais ativos'), barraUso(d.ramais.total, d.empresa.limite_ramais)),
        el('div', {}, el('div', { class: 'pequeno mudo' }, 'Chamadas simultâneas agora'), barraUso(d.em_curso, d.empresa.limite_canais)),
        el('div', {}, el('div', { class: 'pequeno mudo' }, 'Disco das gravações'), barraUso(d.disco.usado_bytes, d.disco.limite_bytes, { formato: (b) => gb(b).replace('GB', ''), sufixo: 'GB' })))))));
  }, 10_000));
}

async function telaSupervisao(ctx) {
  ctx.parar(repetir(async () => {
    const s = await api.get(`${base(ctx)}/supervisao`);
    const falando = s.agentes.filter((a) => a.falando_com);
    limpar(ctx.conteudo, el('div', { class: 'coluna' },
      el('div', { class: 'grade' },
        indicador('Chamadas agora', inteiro(s.em_curso), null, 'chamadas', 'azul'),
        indicador('Agentes falando', `${falando.length}/${s.agentes.length}`, null, 'headset', 'verde'),
        indicador('Agentes online', inteiro(s.agentes.filter((a) => a.online).length), null, 'pessoas', 'roxo'),
        indicador('Campanhas ativas', inteiro(s.campanhas.filter((c) => c.status === 'ativa').length), null, 'campanhas', 'laranja')),
      cartao('Campanhas', tabela(['Campanha', 'Status', 'Fila', '^Em curso', '^Pendentes', '^Atendidos', '^Sem sucesso', 'Progresso'], s.campanhas.map((c) => el('tr', {},
        td(c.nome), td(etiqueta(c.status, c.status === 'ativa' ? 'ok' : 'aviso')), td(c.fila ?? '—'), td(c.em_curso, 'centro num'), td(c.pendentes, 'centro num'),
        td(c.atendidos, 'centro num'), td(c.sem_sucesso, 'centro num'), el('td', { style: 'width:160px' }, barraUso(c.contatos - c.pendentes, c.contatos)))),
      'Nenhuma campanha ativa ou pausada.')),
      cartao('Agentes (ramais)', tabela(['Ramal', 'Pessoa', 'Situação', 'Falando com', '^Desde', '^Chamadas hoje'], s.agentes.map((a) => el('tr', {},
        td(a.numero, 'num'), td(pessoa(a.nome)),
        td(a.falando_com ? situacao('Em chamada', 'info') : a.online ? situacao('Livre', 'ok') : situacao('Offline', 'erro')),
        td(a.falando_com ? telefone(a.falando_com) : '—'), td(a.desde ? hora(a.desde) : '—', 'centro'), td(a.chamadas_hoje, 'centro num'))), 'Nenhum ramal ativo.'))));
  }, 5000));
}

// ---------- Campanhas ----------
async function telaCampanhas(ctx) {
  const lista = el('div');
  const filas = await api.get(`${base(ctx)}/filas`);
  const MODOS = { progressivo: 'Progressivo', preditivo: 'Preditivo', preview: 'Preview' };
  const corStatus = { rascunho: '', ativa: 'ok', pausada: 'aviso', encerrada: 'erro' };
  const formCampanha = (c) => formModal(c ? `Editar ${c.nome}` : 'Nova campanha', () => [
    campo('Nome', { name: 'nome', required: true, maxlength: 120, value: c?.nome ?? '' }),
    el('div', { class: 'duas' }, escolha('Modo de discagem', 'modo', MODOS, c?.modo ?? 'progressivo'),
      escolha('Fila que atende', 'fila_id', { '': 'Escolha…', ...Object.fromEntries(filas.map((f) => [f.id, f.nome])) }, c?.fila_id ?? '')),
    el('div', { class: 'duas' }, campo('Canais (ligações ao mesmo tempo)', { name: 'canais', type: 'number', min: 1, value: c?.canais ?? 1 }),
      campo('Tentativas por contato', { name: 'tentativas_max', type: 'number', min: 1, max: 10, value: c?.tentativas_max ?? 3 })),
    filas.length ? null : el('p', { class: 'aviso' }, 'Crie uma fila em Recursos PABX para atender as ligações da campanha.'),
  ], (d) => {
    const corpo = { ...d, fila_id: d.fila_id || null };
    return c ? api.patch(`${base(ctx)}/campanhas/${c.id}`, corpo) : api.post(`${base(ctx)}/campanhas`, corpo);
  });
  const importar = (c) => formModal(`Importar contatos · ${c.nome}`, () => [
    el('p', { class: 'pequeno mudo', style: 'margin:0' }, 'Um contato por linha: "nome;telefone" ou só o telefone (com DDD). Telefones repetidos são ignorados.'),
    area('Contatos', { name: 'linhas', required: true, rows: 10, placeholder: 'Maria Silva;11987654321\n1133224455' }),
  ], async (d) => {
    const r = await api.post(`${base(ctx)}/campanhas/${c.id}/contatos`, d);
    toast(`${r.importados} contato(s) importado(s)${r.ignorados ? `, ${r.ignorados} repetido(s)` : ''}${r.linhas_invalidas.length ? `, ${r.linhas_invalidas.length} linha(s) inválida(s)` : ''}.`);
    return r;
  }, { rotulo: 'Importar' });
  const verContatos = async (c) => {
    const contatos = await api.get(`${base(ctx)}/campanhas/${c.id}/contatos`);
    modal(`Contatos · ${c.nome}`, (fechar) => [
      tabela(['Nome', 'Telefone', 'Situação', '^Tentativas', 'Última'], contatos.map((x) => el('tr', {},
        td(x.nome ?? '—'), td(telefone(x.telefone), 'num'), td(etiqueta(x.status.replace('_', ' '), { atendido: 'ok', discando: 'info', pendente: '' }[x.status] ?? 'aviso')),
        td(x.tentativas, 'centro num'), td(dataHora(x.ultima_tentativa)))), 'Nenhum contato importado.'),
      contatos.length >= 1000 ? el('p', { class: 'pequeno mudo' }, 'Mostrando os 1.000 primeiros.') : null,
      el('div', { class: 'linha', style: 'justify-content:flex-end;margin-top:12px' }, el('button', { class: 'btn', onclick: () => fechar() }, 'Fechar')),
    ], { largo: true });
  };
  const mudar = async (c, status, texto) => {
    if (status === 'encerrada' && !await confirmar('Encerrar campanha', `Encerrar ${c.nome}? Não dá para reabrir depois.`, 'Encerrar')) return;
    await api.patch(`${base(ctx)}/campanhas/${c.id}`, { status });
    toast(texto);
    carregar();
  };

  async function carregar() {
    const campanhas = await api.get(`${base(ctx)}/campanhas`);
    limpar(lista, tabela(['Campanha', 'Modo', 'Fila', '^Canais', '^Contatos', 'Progresso', 'Status', '^Ações'], campanhas.map((c) => el('tr', {},
      td(c.nome), td(MODOS[c.modo]), td(c.fila ?? el('span', { class: 'mudo' }, 'sem fila')), td(c.canais, 'centro num'), td(inteiro(c.contatos), 'centro num'),
      el('td', { style: 'width:150px' }, barraUso(c.contatos - c.pendentes, c.contatos)), td(etiqueta(c.status, corStatus[c.status])),
      el('td', { class: 'acoes' },
        botao('Contatos', '', () => verContatos(c)),
        pode(ctx) && c.status !== 'encerrada' ? [
          botao('Importar', '', async () => { if (await importar(c)) carregar(); }),
          c.status === 'ativa' ? botao('Pausar', '', () => mudar(c, 'pausada', 'Campanha pausada.')) : botao('Ativar', 'primario', () => mudar(c, 'ativa', 'Campanha ativada.')),
          botaoIcone('editar', 'Editar', async () => { if (await formCampanha(c)) { toast('Campanha salva.'); carregar(); } }),
          c.status !== 'rascunho' ? botao('Encerrar', 'perigo', () => mudar(c, 'encerrada', 'Campanha encerrada.'))
            : botaoIcone('lixo', 'Excluir', async () => {
              if (!await confirmar('Excluir campanha', `Excluir ${c.nome} e os contatos importados?`, 'Excluir')) return;
              await api.del(`${base(ctx)}/campanhas/${c.id}`);
              toast('Campanha excluída.');
              carregar();
            }, 'perigo')] : null))), 'Nenhuma campanha. Crie uma, importe os contatos e ative.'));
  }
  limpar(ctx.conteudo, acoesTopo(el('p', { class: 'mudo', style: 'margin:0' }, 'O discador liga para os contatos e passa quem atende para a fila escolhida.'),
    pode(ctx) ? el('button', { class: 'btn primario', onclick: async () => { if (await formCampanha()) { toast('Campanha criada.'); carregar(); } } }, 'Nova campanha') : null),
  cartao(null, lista));
  await carregar();
}

// ---------- Pessoas / Ramais ----------
async function telaRamais(ctx) {
  const lista = el('div');
  const resumo = el('p', { class: 'mudo', style: 'margin:0' });
  const admin = pode(ctx);
  const formRamal = (r) => formModal(r ? `Ramal ${r.numero}` : 'Novo ramal', () => [
    r ? null : campo('Número do ramal', { name: 'numero', required: true, inputmode: 'numeric', pattern: '\\d{2,6}', placeholder: 'Ex.: 1001' }),
    campo('Nome da pessoa', { name: 'nome', required: true, maxlength: 120, value: r?.nome ?? '' }),
    campo('E-mail (opcional)', { name: 'email', type: 'email', value: r?.email ?? '' }),
    marcar('Gravar as chamadas deste ramal', { name: 'gravar', checked: r ? Boolean(r.gravar) : true }),
    r ? marcar('Ramal ativo', { name: 'ativo', checked: Boolean(r.ativo) }) : null,
  ], (d) => (r ? api.patch(`${base(ctx)}/ramais/${r.id}`, d) : api.post(`${base(ctx)}/ramais`, d)));
  const verSip = async (r) => {
    const s = await api.get(`${base(ctx)}/ramais/${r.id}/sip`);
    modal(`Configurar o telefone · ramal ${r.numero}`, (fechar) => [
      el('p', { class: 'mudo', style: 'margin-top:0' }, 'Use estes dados no telefone IP ou no aplicativo (softphone). O servidor SIP é informado pelo suporte.'),
      el('div', { class: 'chave' }, el('span', { class: 'mudo' }, 'Usuário SIP'), el('strong', { class: 'mono' }, s.usuario)),
      el('div', { class: 'chave' }, el('span', { class: 'mudo' }, 'Senha SIP'), el('strong', { class: 'mono' }, s.senha)),
      el('div', { class: 'linha entre', style: 'margin-top:14px' },
        botao('Gerar nova senha', 'perigo', async () => {
          if (!await confirmar('Nova senha SIP', 'O telefone com a senha atual deixa de funcionar até ser configurado de novo.', 'Gerar')) return;
          await api.patch(`${base(ctx)}/ramais/${r.id}`, { nova_senha_sip: true });
          fechar();
          verSip(r);
        }),
        el('button', { class: 'btn primario', onclick: () => fechar() }, 'Pronto')),
    ]);
  };

  async function carregar() {
    const ramais = await api.get(`${base(ctx)}/ramais`);
    const ativos = ramais.filter((r) => r.ativo);
    resumo.textContent = `${ativos.length} ramal(is) ativo(s) · ${ativos.filter((r) => r.online).length} online`;
    limpar(lista, tabela(['Ramal', 'Pessoa', 'Filas', 'Situação', 'Último registro', '^Gravação', '^Ações'], ramais.map((r) => el('tr', {},
      td(el('strong', { class: 'num' }, r.numero)), td(pessoa(r.nome, r.email)), td(r.filas ?? '—'),
      td(!r.ativo ? situacao('Desativado') : r.em_curso ? situacao('Em chamada', 'info') : r.online ? situacao('Online', 'ok') : situacao('Offline', 'erro')),
      td(r.registro_em ? [dataHora(r.registro_em), el('div', { class: 'pequeno mudo' }, [r.registro_ip, r.registro_agente].filter(Boolean).join(' · '))] : '—'),
      td(r.gravar ? 'sim' : 'não', 'centro'),
      el('td', { class: 'acoes' }, admin ? [
        botao('Telefone', '', () => verSip(r)),
        botaoIcone('editar', 'Editar', async () => { if (await formRamal(r)) { toast('Ramal salvo.'); carregar(); } }),
        botaoIcone('lixo', 'Excluir', async () => {
          if (!await confirmar('Excluir ramal', `Excluir o ramal ${r.numero} (${r.nome})? Se ele já tiver chamadas, fica só desativado para manter o histórico.`, 'Excluir')) return;
          const x = await api.del(`${base(ctx)}/ramais/${r.id}`);
          toast(x.desativado ? 'Ramal desativado (tem chamadas no histórico).' : 'Ramal excluído.');
          carregar();
        }, 'perigo')] : null))), 'Nenhum ramal cadastrado.'));
  }
  limpar(ctx.conteudo, acoesTopo(resumo, admin ? el('button', { class: 'btn primario', onclick: async () => { if (await formRamal()) { toast('Ramal criado.'); carregar(); } } }, 'Novo ramal') : null),
    cartao(null, lista));
  await carregar();
}

// ---------- Chamadas ----------
async function telaChamadas(ctx) {
  await painelChamadas(ctx.conteudo, `${base(ctx)}/chamadas`);
}

// ---------- CRM ----------
async function telaCrm(ctx) {
  const lista = el('div');
  const busca = el('input', { placeholder: 'Nome, telefone, empresa ou e-mail' });
  const formContato = (c) => formModal(c ? `Editar ${c.nome}` : 'Novo contato', () => [
    campo('Nome', { name: 'nome', required: true, maxlength: 120, value: c?.nome ?? '' }),
    el('div', { class: 'duas' }, campo('Telefone (com DDD)', { name: 'telefone', required: true, type: 'tel', value: c?.telefone ?? '' }),
      campo('E-mail', { name: 'email', type: 'email', value: c?.email ?? '' })),
    campo('Empresa do contato', { name: 'organizacao', maxlength: 120, value: c?.organizacao ?? '' }),
    area('Observações', { name: 'observacoes', maxlength: 2000 }, c?.observacoes ?? ''),
  ], (d) => (c ? api.put(`${base(ctx)}/contatos/${c.id}`, d) : api.post(`${base(ctx)}/contatos`, d)));
  const abrir = async (id) => {
    const c = await api.get(`${base(ctx)}/contatos/${id}`);
    modal(c.nome, (fechar) => [
      el('div', { class: 'chave' }, el('span', { class: 'mudo' }, 'Telefone'), el('strong', {}, telefone(c.telefone))),
      c.email ? el('div', { class: 'chave' }, el('span', { class: 'mudo' }, 'E-mail'), el('strong', {}, c.email)) : null,
      c.organizacao ? el('div', { class: 'chave' }, el('span', { class: 'mudo' }, 'Empresa'), el('strong', {}, c.organizacao)) : null,
      c.observacoes ? el('p', { style: 'white-space:pre-wrap' }, c.observacoes) : null,
      el('h3', { style: 'margin-top:14px' }, 'Chamadas com este contato'),
      tabela(['Quando', 'Direção', 'Ramal', 'Status', '>Duração'], c.chamadas.map((x) => el('tr', {},
        td(dataHora(x.inicio)), td(DIRECOES[x.direcao]), td(x.ramal ? `${x.ramal} · ${x.ramal_nome}` : '—'), td(etiquetaChamada(x.status)), td(duracao(x.duracao_s), 'dir num'))),
      'Nenhuma chamada ainda.'),
      el('div', { class: 'linha entre', style: 'margin-top:14px' },
        pode(ctx) ? el('div', { class: 'linha' },
          botao('Editar', '', async () => { fechar(); if (await formContato(c)) { toast('Contato salvo.'); carregar(); } }),
          botao('Excluir', 'perigo', async () => {
            if (!await confirmar('Excluir contato', `Excluir ${c.nome}? As chamadas continuam no histórico.`, 'Excluir')) return;
            await api.del(`${base(ctx)}/contatos/${c.id}`);
            fechar();
            toast('Contato excluído.');
            carregar();
          })) : el('span'),
        el('button', { class: 'btn primario', onclick: () => fechar() }, 'Fechar')),
    ], { largo: true });
  };
  async function carregar() {
    const contatos = await api.get(`${base(ctx)}/contatos${qs({ busca: busca.value })}`);
    limpar(lista, tabela(['Nome', 'Telefone', 'Empresa', 'E-mail', '^Chamadas', 'Última chamada'], contatos.map((c) => el('tr', { class: 'clicavel', onclick: () => abrir(c.id) },
      td(c.nome), td(telefone(c.telefone), 'num'), td(c.organizacao ?? '—'), td(c.email ?? '—'), td(inteiro(c.chamadas), 'centro num'), td(dataHora(c.ultima_chamada)))),
    'Nenhum contato. Os contatos aparecem com o nome na lista de chamadas.'));
  }
  busca.addEventListener('input', () => { clearTimeout(busca.timer); busca.timer = setTimeout(carregar, 300); });
  limpar(ctx.conteudo, el('div', { class: 'filtros livre' }, el('label', { class: 'campo' }, 'Buscar', busca),
    pode(ctx) ? el('button', { class: 'btn primario', onclick: async () => { if (await formContato()) { toast('Contato criado.'); carregar(); } } }, 'Novo contato') : null),
  cartao(null, lista));
  await carregar();
}

// ---------- Terminação ----------
async function telaTerminacao(ctx) {
  const t = await api.get(`${base(ctx)}/terminacao`);
  const mes = Object.fromEntries(t.mes.map((x) => [x.tipo_destino, x]));
  limpar(ctx.conteudo, el('div', { class: 'coluna' },
    el('div', { class: 'grade' },
      indicador('Rota de saída', t.rota ? t.rota.nome : 'Sem rota', t.rota ? (t.rota.ativa ? 'ativa' : 'inativa') : 'fale com o suporte para ligar para fora', 'terminacao', 'azul'),
      indicador('Chamadas simultâneas', inteiro(t.limite_canais), 'limite contratado', 'chamadas', 'roxo'),
      indicador('Tarifação', `${t.cadencia.inicial_s}/${t.cadencia.passo_s}`, `mínimo de ${t.cadencia.inicial_s} s e depois a cada ${t.cadencia.passo_s} s`, 'relogio', 'laranja')),
    cartao('Tarifas e consumo do mês', tabela(['Destino', '>Preço por minuto', '>Ligações no mês', '>Minutos tarifados', '>Gasto no mês'],
      ['fixo', 'movel', 'internacional'].map((k) => el('tr', {}, td(TIPOS_DESTINO[k]), td(dinheiro(t.tarifas[k]), 'dir num'), td(inteiro(mes[k]?.chamadas), 'dir num'),
        td(minutos(mes[k]?.tarifado_s), 'dir num'), td(dinheiro(mes[k]?.custo_centavos), 'dir num'))))),
    el('p', { class: 'pequeno mudo' }, 'Chamadas recebidas e entre ramais não são cobradas. Só as ligações realizadas e atendidas entram na tarifação.')));
}

// ---------- Números entrantes ----------
async function telaNumeros(ctx) {
  const lista = el('div');
  const destinos = async () => {
    const [ramais, filas, uras] = await Promise.all([api.get(`${base(ctx)}/ramais`), api.get(`${base(ctx)}/filas`), api.get(`${base(ctx)}/uras`)]);
    return { ramal: ramais.filter((r) => r.ativo).map((r) => [r.id, `${r.numero} · ${r.nome}`]), fila: filas.map((f) => [f.id, f.nome]), ura: uras.map((u) => [u.id, u.nome]) };
  };
  const ROTULO = { ramal: 'Ramal', fila: 'Fila', ura: 'URA' };
  const formDestino = async (n) => {
    const opcoes = await destinos();
    return formModal(`Número ${telefone(n.numero)}`, (f) => {
      const tipo = escolha('Quando alguém ligar, enviar para', 'destino_tipo', { '': 'Sem destino (a chamada não é atendida)', ...ROTULO }, n.destino_tipo ?? '');
      const alvo = el('label', { class: 'campo' }, 'Destino', el('select', { name: 'destino_id' }));
      const preencher = () => {
        const t = f.querySelector('[name=destino_tipo]').value;
        const s = alvo.querySelector('select');
        limpar(s, (opcoes[t] ?? []).map(([id, nome]) => el('option', { value: id }, nome)));
        if (t === n.destino_tipo) s.value = String(n.destino_id);
        alvo.classList.toggle('oculto', !t);
      };
      tipo.querySelector('select').addEventListener('change', preencher);
      queueMicrotask(preencher);
      return [campo('Descrição', { name: 'descricao', maxlength: 120, value: n.descricao ?? '' }), tipo, alvo];
    }, (d) => api.patch(`${base(ctx)}/numeros/${n.id}`, { descricao: d.descricao, destino_tipo: d.destino_tipo || null, destino_id: d.destino_tipo ? d.destino_id : null }));
  };
  async function carregar() {
    const numeros = await api.get(`${base(ctx)}/numeros`);
    limpar(lista, tabela(['Número', 'Descrição', 'Destino', '^Chamadas recebidas', '^Ações'], numeros.map((n) => el('tr', {},
      td(el('strong', { class: 'num' }, telefone(n.numero))), td(n.descricao ?? '—'),
      td(n.destino_tipo ? `${ROTULO[n.destino_tipo]}: ${n.destino_nome ?? '—'}` : etiqueta('sem destino', 'aviso')), td(inteiro(n.chamadas), 'centro num'),
      el('td', { class: 'acoes' }, pode(ctx) ? botaoIcone('editar', 'Configurar destino', async () => { if (await formDestino(n)) { toast('Destino salvo.'); carregar(); } }) : null))),
    'Nenhum número contratado. Fale com o suporte para receber chamadas de fora.'));
  }
  limpar(ctx.conteudo, acoesTopo(el('p', { class: 'mudo', style: 'margin:0' }, 'Os números que recebem ligações de fora e para onde cada um envia as chamadas.')), cartao(null, lista));
  await carregar();
}

// ---------- Filas de atendimento e URA ----------
/**
 * As duas vivem na mesma função porque a URA aponta para filas e a fila aponta para ramais:
 * editar uma sem ver a outra leva a destino quebrado. `so` escolhe o que a tela mostra.
 */

async function telaRecursos(ctx, so = null) {
  const corpo = el('div', { class: 'coluna' });
  limpar(ctx.conteudo, corpo);
  const ESTRATEGIAS = { todos: 'Tocar todos', sequencial: 'Em sequência', aleatorio: 'Aleatório', menos_chamadas: 'Quem atendeu menos' };

  async function carregar() {
    const [filas, uras, ramais] = await Promise.all([api.get(`${base(ctx)}/filas`), api.get(`${base(ctx)}/uras`), api.get(`${base(ctx)}/ramais`)]);
    const ativos = ramais.filter((r) => r.ativo);
    const formFila = (f) => formModal(`Fila ${f.nome} no telefone`, () => [
      el('p', { class: 'pequeno mudo', style: 'margin:0 0 8px' }, 'É a mesma fila do WhatsApp. Nome, horário e quem atende ficam na tela Filas; aqui, os ramais que tocam e como.'),
      el('div', { class: 'duas' }, escolha('Como distribuir', 'estrategia', ESTRATEGIAS, f?.estrategia ?? 'todos'),
        campo('Espera máxima (segundos)', { name: 'espera_maxima_s', type: 'number', min: 10, max: 3600, value: f?.espera_maxima_s ?? 120 })),
      el('fieldset', {}, el('legend', {}, 'Ramais da fila'), ativos.length ? el('div', { class: 'grade', style: 'gap:6px' }, ativos.map((r) =>
        marcar(`${r.numero} · ${r.nome}`, { name: `r_${r.id}`, checked: Boolean(f?.ramais.some((m) => m.id === r.id)) }))) : el('p', { class: 'mudo' }, 'Cadastre ramais primeiro.')),
    ], (d) => {
      const corpo2 = { estrategia: d.estrategia, espera_maxima_s: d.espera_maxima_s, ramais: ativos.filter((r) => d[`r_${r.id}`]).map((r) => r.id) };
      return api.put(`${base(ctx)}/filas/${f.id}`, corpo2);
    }, { largo: true });

    const opcoesDestino = { ...Object.fromEntries(ativos.map((r) => [`ramal:${r.id}`, `Ramal ${r.numero} · ${r.nome}`])),
      ...Object.fromEntries(filas.map((f) => [`fila:${f.id}`, `Fila ${f.nome}`])), ...Object.fromEntries(uras.map((u) => [`ura:${u.id}`, `URA ${u.nome}`])) };
    const formUra = (u) => formModal(u ? `URA ${u.nome}` : 'Nova URA', (form) => {
      const linhas = el('div', { class: 'coluna', style: 'gap:8px' });
      const addLinha = (o = {}) => linhas.append(el('div', { class: 'duas opcao-ura' },
        escolha(null, 'digito', Object.fromEntries(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '*', '#'].map((x) => [x, `Tecla ${x}`])), o.digito ?? String(linhas.children.length + 1)),
        el('div', { class: 'linha', style: 'flex-wrap:nowrap' }, escolha(null, 'destino', opcoesDestino, o.destino_tipo ? `${o.destino_tipo}:${o.destino_id}` : Object.keys(opcoesDestino)[0]),
          el('button', { type: 'button', class: 'icone-btn perigo', title: 'Remover', onclick: (e) => e.currentTarget.closest('.opcao-ura').remove() }, '✕'))));
      for (const o of u?.opcoes ?? []) addLinha(o);
      form.lerOpcoes = () => [...linhas.querySelectorAll('.opcao-ura')].map((l) => {
        const [tipo, id] = l.querySelector('[name=destino]').value.split(':');
        return { digito: l.querySelector('[name=digito]').value, destino_tipo: tipo, destino_id: Number(id) };
      });
      return [
        campo('Nome', { name: 'nome', required: true, maxlength: 80, value: u?.nome ?? '' }),
        area('Mensagem falada (texto para voz)', { name: 'mensagem', required: true, maxlength: 1000, rows: 3 }, u?.mensagem ?? ''),
        el('fieldset', {}, el('legend', {}, 'Opções do menu'), linhas,
          Object.keys(opcoesDestino).length ? el('div', {}, el('button', { type: 'button', class: 'btn pequeno', onclick: () => addLinha() }, 'Adicionar opção'))
            : el('p', { class: 'mudo' }, 'Cadastre ramais ou filas para usar como destino.')),
      ];
    }, (d, form) => {
      const corpo2 = { nome: d.nome, mensagem: d.mensagem, opcoes: form.lerOpcoes() };
      return u ? api.put(`${base(ctx)}/uras/${u.id}`, corpo2) : api.post(`${base(ctx)}/uras`, corpo2);
    }, { largo: true });
    const nomeDestino = (o) => opcoesDestino[`${o.destino_tipo}:${o.destino_id}`] ?? `${o.destino_tipo} ${o.destino_id}`;
    const excluir = (tipo, x) => async () => {
      if (!await confirmar(`Excluir ${tipo === 'filas' ? 'fila' : 'URA'}`, `Excluir ${x.nome}? Os números e opções de URA que apontam para ela ficam sem destino.`, 'Excluir')) return;
      await api.del(`${base(ctx)}/${tipo}/${x.id}`);
      toast('Excluído.');
      carregar();
    };

    const cartaoFilas = () =>
      cartao('Filas no telefone', tabela(['Fila', 'Distribuição', '^Espera máx.', 'Ramais', '^Ações'], filas.map((f) => el('tr', {},
        td(f.nome), td(ESTRATEGIAS[f.estrategia]), td(`${f.espera_maxima_s} s`, 'centro num'), td(f.ramais.map((r) => r.numero).join(', ') || '—'),
        el('td', { class: 'acoes' }, pode(ctx) ? [botaoIcone('editar', 'Ramais da fila', async () => { if (await formFila(f)) { toast('Fila salva.'); carregar(); } })] : null))),
        'Nenhuma fila. Crie as filas na tela Filas: a mesma fila atende WhatsApp e telefone.'),
      el('p', { class: 'pequeno mudo', style: 'margin:10px 0 0' }, 'O nome da fila é o mesmo no Asterisk: é por ele que a ligação transferida pela ZOE cai na fila certa.'));

    const cartaoUras = () =>
      cartao('URAs (menu de atendimento)', tabela(['URA', 'Tipo', 'Mensagem', 'Opções', '^Ações'], uras.map((u) => el('tr', {},
        td(u.nome),
        td(u.tipo === 'inteligente'
          ? el('span', { class: 'etiqueta ok' }, 'inteligente')
          : el('span', { class: 'etiqueta' }, 'clássica')),
        td(el('span', { class: 'pequeno' }, u.mensagem)), td(u.opcoes.map((o) => el('div', { class: 'pequeno' }, `${o.digito} → ${nomeDestino(o)}`))),
        el('td', { class: 'acoes' }, pode(ctx) ? [
          botaoIcone('robo', 'Inteligência da URA', () => inteligenciaUra(ctx, u, filas, carregar)),
          botaoIcone('editar', 'Editar', async () => { if (await formUra(u)) { toast('URA salva.'); carregar(); } }),
          botaoIcone('lixo', 'Excluir', excluir('uras', u), 'perigo')] : null))),
        'Nenhuma URA. A URA fala uma mensagem e envia a chamada conforme a tecla.'),
      pode(ctx) ? el('div', { style: 'margin-top:12px' }, botao('Nova URA', 'primario', async () => { if (await formUra()) { toast('URA criada.'); carregar(); } })) : null);

    limpar(corpo, so === 'uras' ? cartaoUras() : so === 'filas' ? cartaoFilas() : [cartaoFilas(), cartaoUras()]);
  }
  await carregar();
}

// ---------- Relatórios ----------
async function telaRelatorios(ctx) {
  await painelRelatorios(ctx.conteudo, `${base(ctx)}/relatorios`);
}

// ---------- Configurações da telefonia ----------
async function telaConfiguracoes(ctx) {
  const c = await api.get(`${base(ctx)}/configuracoes`);
  const admin = pode(ctx);
  const f = el('form', { class: 'form' },
    marcar('Gravar as chamadas (cada ramal também pode ligar ou desligar)', { name: 'gravar_chamadas', checked: c.empresa.gravar_chamadas, disabled: !admin }),
    admin ? el('div', {}, el('button', { class: 'btn primario' }, 'Salvar')) : null);
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    acao(f.querySelector('button'), async () => {
      await api.patch(`${base(ctx)}/configuracoes`, { gravar_chamadas: f.querySelector('[name=gravar_chamadas]').checked });
      toast('Configurações salvas.');
    });
  });
  const limites = cartao('Plano de telefonia', ...[['Ramais', inteiro(c.limites.ramais)], ['Chamadas simultâneas', inteiro(c.limites.canais)],
    ['Disco das gravações', `${inteiro(c.limites.disco_mb)} MB`], ['Texto para voz (TTS) por mês', inteiro(c.limites.tts)], ['Voz para texto (STT) por mês', inteiro(c.limites.stt)]]
    .map(([r, v]) => el('div', { class: 'chave' }, el('span', { class: 'mudo' }, r), el('strong', {}, v))),
  el('p', { class: 'pequeno mudo' }, 'Para mudar o plano, fale com o suporte da plataforma.'));
  limpar(ctx.conteudo, el('div', { class: 'grade-2' }, cartao('Gravação', f,
    el('p', { class: 'pequeno mudo' }, 'Quem atende e o ramal de cada pessoa ficam em Usuários.')), limites));
}

/**
 * A inteligência da URA.
 *
 * A URA clássica pergunta a mesma coisa para todo mundo. A inteligente consulta o IXC pelo
 * número que ligou e abre pelo motivo mais provável daquela pessoa. Aqui o provedor escolhe
 * quais situações ela reconhece e escreve, com as palavras da empresa, o que ela fala em cada uma.
 */
async function inteligenciaUra(ctx, u, filas, depois) {
  const d = await api.get(`${base(ctx)}/uras/${u.id}/inteligencia`);
  const campos = new Map();
  let tipo = d.ura.tipo;

  const bloco = (si) => {
    const liga = el('input', { type: 'checkbox', checked: si.ativa, name: `a_${si.chave}` });
    const fala = el('textarea', { rows: 2, maxlength: 600, name: `f_${si.chave}` });
    fala.value = si.fala;
    campos.set(si.chave, { liga, fala });
    return el('div', { class: 'situacao-ura' },
      el('label', { class: 'marcar' }, liga, el('strong', {}, si.nome)),
      el('p', { class: 'pequeno mudo', style: 'margin:2px 0 6px' },
        `${si.explicacao} ${d.acoes[si.acao] ?? ''}.`
        + (si.antes_de_confirmar ? ' Esta pode ser dita antes de confirmar a identidade: é informação da rede, não do contrato.' : '')),
      fala);
  };

  const selTipo = escolha('Como esta URA atende', 'tipo', {
    classica: 'Clássica — fala a mensagem e espera a tecla, igual para todos',
    inteligente: 'Inteligente — consulta o IXC e abre pelo motivo de quem ligou',
  }, tipo);
  const selFila = escolha('Fila de quem pede atendente', 'fila_padrao_id',
    { '': '— escolha —', ...Object.fromEntries(filas.map((f) => [f.id, f.nome])) }, d.ura.fila_padrao_id ?? '');

  const avisoTipo = el('p', { class: 'pequeno mudo' });
  const pintar = () => {
    tipo = selTipo.querySelector('select').value;
    limpar(avisoTipo, tipo === 'inteligente'
      ? 'Antes de a identidade ser confirmada, a URA nunca diz nome, valor, vencimento nem que o contrato está bloqueado — Bina se falsifica.'
      : 'A URA clássica ignora as situações abaixo.');
  };
  selTipo.querySelector('select').addEventListener('change', pintar);
  queueMicrotask(pintar);

  return formModal(`Inteligência da URA ${u.nome}`, () => [
    selTipo, avisoTipo, selFila,
    el('div', { class: 'duas' },
      campo('Tecla que sempre leva a uma pessoa', { name: 'tecla_atendente', value: d.ura.tecla_atendente, maxlength: 1 }),
      campo('Tentativas antes de transferir', { name: 'max_tentativas', type: 'number', min: 1, max: 5, value: d.ura.max_tentativas })),
    el('fieldset', {}, el('legend', {}, 'O que ela reconhece, da mais urgente para a menos'),
      el('div', { class: 'coluna', style: 'gap:10px' }, d.situacoes.map(bloco))),
  ], async () => {
    const corpo = {
      tipo, fila_padrao_id: selFila.querySelector('select').value || null,
      tecla_atendente: document.querySelector('[name=tecla_atendente]').value,
      max_tentativas: Number(document.querySelector('[name=max_tentativas]').value),
      situacoes: Object.fromEntries([...campos.entries()].map(([k, x]) => [k, { ativa: x.liga.checked, fala: x.fala.value }])),
    };
    await api.put(`${base(ctx)}/uras/${u.id}/inteligencia`, corpo);
    toast('Inteligência salva.');
    await depois();
  }, { largo: true });
}

// ---------- A tela Telefonia, com abas ----------
const ABAS = {
  painel: ['Painel', telaDashboard],
  supervisao: ['Supervisão', telaSupervisao],
  ramais: ['Ramais', telaRamais],
  filas: ['Filas e URA', (ctx) => telaRecursos(ctx)],
  numeros: ['Números', telaNumeros],
  campanhas: ['Campanhas', telaCampanhas],
  chamadas: ['Chamadas', telaChamadas],
  agenda: ['Agenda', telaCrm],
  relatorios: ['Relatórios', telaRelatorios],
  tarifas: ['Rota e tarifas', telaTerminacao],
  configuracoes: ['Configurações', telaConfiguracoes],
};

export async function telaTelefonia(ctx) {
  const abas = el('div', { class: 'abas' });
  const corpo = el('div');
  limpar(ctx.conteudo, abas, corpo);
  let paradas = [];
  // Cada aba desenha num conteúdo próprio e para os relógios dela ao trocar de aba.
  const sub = { ...ctx, conteudo: corpo, parar: (fn) => { paradas.push(fn); } };
  ctx.parar(() => { for (const p of paradas) p(); });
  const st = await api.get(`${base(ctx)}`).catch(() => null);
  if (!st?.ativa) {
    limpar(corpo, cartao('Telefonia', el('p', { class: 'mudo' }, 'A telefonia não está ligada para esta empresa. Fale com o suporte da plataforma para ativar ramais, filas no telefone e URA.')));
    return;
  }
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
