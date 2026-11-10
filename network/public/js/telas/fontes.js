import { api, qs } from '../api.js';
import { el, limpar, pode, cabecalho, painel, tabela, abas, etqDe, etq, rotulo, opcoes, dataHora, desde, toast, carregar, formulario, botao, faixa, modal, numero, paginacao } from '../ui.js';

export default async function fontes({ alvo, query }) {
  const lista = [pode('ddos.configurar') ? ['roteadores', 'Roteadores (flows)'] : null, pode('ddos.configurar') ? ['radius', 'RADIUS'] : null,
    pode('ddos.configurar') ? ['bgp', 'BGP'] : null, pode('avisos.configurar') ? ['avisos', 'Avisos'] : null].filter(Boolean);
  let aba = lista.some(([id]) => id === query.aba) ? query.aba : lista[0][0];
  const corpo = el('div');
  const barra = el('div');
  const trocar = (id) => { aba = id; barra.replaceChildren(abas(lista, aba, trocar)); TELAS[aba](); };
  limpar(alvo, cabecalho({ sobretitulo: 'Sistema', titulo: 'Fontes de tráfego e avisos',
    descricao: 'Roteadores que exportam flows, BRAS que enviam o accounting RADIUS, a ponte com o ExaBGP e os canais de aviso. Acesso aos roteadores e ao BRAS continua só de leitura.' }), barra, corpo);

  const TELAS = {
    roteadores: () => carregar(corpo, () => api.get('/trafego/fontes'), (f) => painel('Roteadores e BRAS que exportam flows', tabela([
      { titulo: 'Roteador', valor: (e) => el('div', {}, el('div', { class: 'forte' }, e.nome), el('div', { class: 'fraco' }, `${e.ip} · ${rotulo('papelExportador', e.papel)}`)) },
      { titulo: 'Formato', valor: (e) => e.formato ?? '—' },
      { titulo: 'Amostragem', valor: (e) => (e.taxa_amostragem > 1 ? `1:${numero(e.taxa_amostragem)}` : 'sem (ou informada no pacote)') },
      { titulo: 'Recebido', valor: (e) => el('div', {}, `${numero(e.pacotes)} pacotes · ${numero(e.fluxos)} flows`, e.erros || e.sem_template ? el('div', { class: 'fraco' },
        [e.erros ? `${numero(e.erros)} com erro` : null, e.sem_template ? `${numero(e.sem_template)} sem template` : null].filter(Boolean).join(' · ')) : null) },
      { titulo: 'Último pacote', valor: (e) => el('div', {}, etqDe('estadoIntegracao', e.estado), el('div', { class: 'fraco' }, e.ultimo_pacote ? desde(e.ultimo_pacote) : 'nunca')) },
    ], f.exportadores, { vazioTexto: 'Nenhum roteador cadastrado.', aoClicar: (e) => exportador(e, () => TELAS.roteadores()) }), {
      semCorpo: true, acoes: [botao('Cadastrar roteador', () => exportador(null, () => TELAS.roteadores()), { ic: 'mais', tipo: 'secundario pequeno' })],
      rodape: [el('div', { style: 'display:grid;gap:4px' },
        el('span', {}, 'Aponte o export de flows para este servidor nas portas UDP 2055 (NetFlow v5/v9), 4739 (IPFIX) ou 6343 (sFlow). Pacotes de IPs não cadastrados são descartados.'),
        el('span', {}, 'Papel "borda": tráfego de/para a internet, usado no Anti-DDoS. "BRAS" e "core": tráfego interno, usado nos módulos de assinantes e ataques internos.'),
        el('span', {}, 'Recomendado: active timeout de 60 s ou menos e inactive timeout de 15 s; com tempo maior, a detecção demora mais a perceber o ataque.'))] })),
    radius: () => carregar(corpo, () => api.get('/trafego/fontes'), (f) => painel('BRAS / NAS (contabilidade RADIUS)', tabela([
      { titulo: 'NAS', valor: (n) => el('div', {}, el('div', { class: 'forte' }, n.nome), el('div', { class: 'fraco' }, n.ip)) },
      { titulo: 'Recebido', valor: (n) => el('div', {}, `${numero(n.pacotes)} pacotes`, n.erros ? el('div', { class: 'fraco' }, `${numero(n.erros)} com erro${n.ultimo_erro ? `: ${n.ultimo_erro}` : ''}`) : null) },
      { titulo: 'Último pacote', valor: (n) => el('div', {}, etqDe('estadoIntegracao', n.estado), el('div', { class: 'fraco' }, n.ultimo_pacote ? desde(n.ultimo_pacote) : 'nunca')) },
    ], f.nas, { vazioTexto: 'Nenhum NAS cadastrado.', aoClicar: (n) => nas(n, () => TELAS.radius()) }), {
      semCorpo: true, acoes: [botao('Cadastrar NAS', () => nas(null, () => TELAS.radius()), { ic: 'mais', tipo: 'secundario pequeno' })],
      rodape: [el('div', { style: 'display:grid;gap:4px' },
        el('span', {}, 'No BRAS, inclua este servidor como servidor de accounting adicional (porta UDP 1813) com o mesmo segredo cadastrado aqui. A autenticação dos assinantes continua no seu RADIUS.'),
        el('span', {}, 'O Manager Network só responde o Accounting-Response exigido pelo protocolo: nada é alterado no BRAS. Sem acesso ao BRAS, use a API: POST /api/coletor/sessoes com token de escopo "sessoes".'))] })),
    bgp: () => carregar(corpo, () => Promise.all([api.get('/noc/coletores'), api.get('/ddos/bgp')]), ([tokens, bgp]) => el('div', { class: 'grade duas' },
      painel('Ponte com o ExaBGP', el('div', { style: 'display:grid;gap:10px' },
        el('p', {}, 'O Manager Network não acessa os roteadores. O ExaBGP do provedor roda o script scripts/exabgp-sincronizar.js, que lê os bloqueios ativos e anuncia ou retira as rotas na sessão BGP com o roteador de borda.'),
        el('code', { class: 'comando' }, 'process manager-network { run /usr/bin/node /opt/manager-network/scripts/exabgp-sincronizar.js; encoder text; }'),
        el('code', { class: 'comando' }, 'NETWORK_URL=https://seu-dominio/network  NETWORK_BGP_TOKEN=mnc_…'),
        el('p', { class: 'fraco' }, 'Se o Manager Network ficar fora do ar, os anúncios são mantidos; depois de 30 minutos sem resposta, o script retira todos por segurança.'),
        tabela([{ titulo: 'Token', valor: (t) => el('div', {}, el('div', { class: 'forte' }, t.nome), el('div', { class: 'fraco' }, `mnc_${t.prefixo}_… · ${t.escopos}`)) },
          { titulo: 'Último uso', valor: (t) => (t.revogado_em ? etq('Revogado', 'neutra') : t.ultimo_uso ? desde(t.ultimo_uso) : 'nunca') }],
        tokens.filter((t) => t.escopos.split(',').some((e) => e === 'bgp' || e === 'sessoes')), { vazioTexto: 'Nenhum token de BGP ou sessões.' })),
      { acoes: [pode('integracoes.editar') ? botao('Novo token', () => novoToken(() => TELAS.bgp()), { ic: 'mais', tipo: 'secundario pequeno' }) : null] }),
      painel(`Anúncios ativos (${bgp.anuncios.length})`, bgp.anuncios.length ? el('div', { style: 'display:grid;gap:6px' }, bgp.anuncios.map((a) => el('code', { class: 'comando' }, a.anunciar)))
        : el('p', { class: 'fraco' }, 'Nenhum bloqueio ativo.'), { rodape: [el('span', {}, `Blackhole: next-hop ${bgp.next_hop_blackhole} · community ${bgp.community_blackhole}. Ajuste em Anti-DDoS → Configuração.`)] }))),
    avisos: (pagina = 1) => carregar(corpo, () => Promise.all([api.get('/avisos/canais'), api.get(`/avisos/envios${qs({ pagina, por_pagina: 15 })}`)]), ([c, envios]) => el('div', {},
      painel('Canais de aviso', tabela([
        { titulo: 'Canal', valor: (x) => el('div', {}, el('div', { class: 'forte' }, x.nome), el('div', { class: 'fraco' }, `${{ telegram: 'Telegram', whatsapp: 'WhatsApp (API oficial)', webhook: 'Webhook' }[x.tipo]} · ${x.eventos.length} evento(s) · a partir de ${rotulo('severidade', x.severidade_min)}`)) },
        { titulo: 'Último envio', valor: (x) => el('div', {}, x.ultimo_envio ? desde(x.ultimo_envio) : 'nunca', x.ultimo_erro ? el('div', { class: 'fraco' }, x.ultimo_erro) : null) },
        { titulo: 'Situação', valor: (x) => (x.ativo ? etq('Ativo', 'ok') : etq('Desativado', 'neutra')) },
        { titulo: '', valor: (x) => el('button', { class: 'botao fantasma pequeno', onclick: async (e) => {
          e.stopPropagation();
          const r = await api.post(`/avisos/canais/${x.id}/testar`, {});
          toast(r.ok ? 'Mensagem de teste enviada.' : `Falhou: ${r.erro}`, !r.ok);
          TELAS.avisos();
        } }, 'Testar') },
      ], c.canais, { vazioTexto: 'Nenhum canal. Os avisos ficam só nas telas.', aoClicar: (x) => canal(x, c.eventos, () => TELAS.avisos()) }), {
        semCorpo: true, acoes: [botao('Novo canal', () => canal(null, c.eventos, () => TELAS.avisos()), { ic: 'mais', tipo: 'secundario pequeno' })],
        rodape: [el('span', {}, 'As mensagens saem como "Manager Network Alertas". Tokens ficam cifrados no servidor e nunca voltam para a tela. Falhas são repetidas até 5 vezes.')] }),
      painel('Últimos envios', el('div', {}, tabela([
        { titulo: 'Quando', valor: (e) => dataHora(e.criado_em, { segundos: true }) }, { titulo: 'Canal', valor: (e) => e.canal_nome },
        { titulo: 'Evento', valor: (e) => c.eventos[e.evento] ?? e.evento }, { titulo: 'Mensagem', valor: (e) => el('span', { class: 'fraco' }, e.texto.split('\n').slice(1, 3).join(' · ')) },
        { titulo: 'Situação', valor: (e) => el('div', {}, etq({ enviado: 'Enviado', pendente: 'Tentando de novo', falha: 'Falhou' }[e.status], { enviado: 'ok', pendente: 'aviso', falha: 'erro' }[e.status]),
          e.erro ? el('div', { class: 'fraco' }, `${e.erro}${e.erro_id ? ` · ID ${e.erro_id}` : ''}`) : null) },
      ], envios.itens, { vazioTexto: 'Nenhum aviso enviado ainda.' }), paginacao(envios, (p) => TELAS.avisos(p))), { semCorpo: true }))),
  };
  trocar(aba);
}

function exportador(e, depois) {
  return formulario(e ? `Editar ${e.nome}` : 'Cadastrar roteador', [
    { nome: 'nome', rotulo: 'Nome', obrigatorio: true, valor: e?.nome, placeholder: 'Borda 01 (Huawei NE40)' },
    { nome: 'ip', rotulo: 'IP de origem dos flows', obrigatorio: true, valor: e?.ip, placeholder: '10.0.0.1', ajuda: 'O endereço que o roteador usa como origem do export.' },
    { nome: 'papel', rotulo: 'Papel', tipo: 'select', vazio: false, valor: e?.papel ?? 'borda', opcoes: opcoes('papelExportador') },
    { nome: 'taxa_amostragem', rotulo: 'Amostragem (1 em N)', tipo: 'number', valor: e?.taxa_amostragem ?? 1, ajuda: 'Usada só se o roteador não informar no pacote.' },
    { nome: 'observacao', rotulo: 'Observação', valor: e?.observacao, inteiro: true },
    e ? { nome: 'ativo', rotulo: 'Aceitar flows deste roteador', tipo: 'checkbox', valor: e.ativo, inteiro: true } : null,
  ], { largo: true, enviar: async (d) => {
    const corpo = { ...d, taxa_amostragem: Number(d.taxa_amostragem) || 1 };
    await (e ? api.patch(`/trafego/exportadores/${e.id}`, corpo) : api.post('/trafego/exportadores', corpo));
    toast('Roteador salvo. O coletor passa a aceitar os flows em até 10 s.');
    depois();
  } });
}

function nas(n, depois) {
  return formulario(n ? `Editar ${n.nome}` : 'Cadastrar NAS', [
    { nome: 'nome', rotulo: 'Nome', obrigatorio: true, valor: n?.nome, placeholder: 'BRAS Centro' },
    { nome: 'ip', rotulo: 'IP de origem do accounting', obrigatorio: true, valor: n?.ip },
    { nome: 'segredo', rotulo: n ? 'Novo segredo RADIUS (vazio mantém)' : 'Segredo RADIUS', tipo: 'password', obrigatorio: !n, autocomplete: 'new-password' },
    n ? { nome: 'ativo', rotulo: 'Aceitar accounting deste NAS', tipo: 'checkbox', valor: n.ativo, inteiro: true } : null,
  ], { largo: true, enviar: async (d) => {
    await (n ? api.patch(`/trafego/nas/${n.id}`, { ...d, segredo: d.segredo || undefined }) : api.post('/trafego/nas', d));
    toast('NAS salvo.');
    depois();
  } });
}

function novoToken(depois) {
  return formulario('Novo token', [
    { nome: 'nome', rotulo: 'Nome', obrigatorio: true, placeholder: 'ExaBGP borda 01', inteiro: true },
    { nome: 'escopo', rotulo: 'Uso', tipo: 'select', vazio: false, opcoes: [['bgp', 'ExaBGP: ler os bloqueios ativos'], ['sessoes', 'Enviar sessões de assinantes (API)']], inteiro: true },
  ], { rotuloEnviar: 'Gerar token', enviar: async (d) => {
    const r = await api.post('/noc/coletores', { nome: d.nome, escopos: [d.escopo] });
    await modal('Token gerado', (fechar) => [faixa(r.aviso, ''), el('input', { type: 'text', readonly: true, value: r.token, onfocus: (e) => e.target.select(), 'aria-label': 'Token' }),
      el('div', { class: 'form-acoes' }, el('button', { class: 'botao', onclick: async () => { try { await navigator.clipboard.writeText(r.token); toast('Copiado.'); } catch { /* sem área de transferência */ } fechar(); } }, 'Copiar e fechar'))]);
    depois();
  } });
}

function canal(x, eventos, depois) {
  const tipo = x?.tipo;
  const campos = [
    { nome: 'nome', rotulo: 'Nome', obrigatorio: true, valor: x?.nome, placeholder: 'Grupo NOC no Telegram' },
    !x ? { nome: 'tipo', rotulo: 'Tipo', tipo: 'select', vazio: false, opcoes: [['telegram', 'Telegram (bot)'], ['whatsapp', 'WhatsApp (API oficial da Meta)'], ['webhook', 'Webhook (outro gateway)']] } : null,
    { tipo: 'secao', rotulo: 'Telegram' },
    { nome: 'chats', rotulo: 'IDs dos chats ou grupos', valor: x?.config?.chats?.join(', '), placeholder: '-1001234567890', ajuda: 'Separe por vírgula. Adicione o bot ao grupo antes.' },
    { tipo: 'secao', rotulo: 'WhatsApp' },
    { nome: 'numero_id', rotulo: 'Phone Number ID', valor: x?.config?.numero_id },
    { nome: 'destinatarios', rotulo: 'Destinatários (DDI+DDD+número)', valor: x?.config?.destinatarios?.join(', '), placeholder: '5513999990000' },
    { nome: 'modelo', rotulo: 'Modelo aprovado (opcional)', valor: x?.config?.modelo, ajuda: 'Fora da janela de 24 h a Meta só entrega mensagens de modelo. O texto do aviso vai como parâmetro {{1}}.' },
    { tipo: 'secao', rotulo: 'Webhook' },
    { nome: 'url', rotulo: 'Endereço (https)', valor: x?.config?.url, placeholder: 'https://gateway.exemplo.com.br/enviar', ajuda: 'Recebe POST JSON. Com segredo, vai o cabeçalho X-Assinatura (HMAC-SHA256).' },
    { tipo: 'secao', rotulo: 'Credencial e eventos' },
    { nome: 'segredo', rotulo: x ? 'Novo token / segredo (vazio mantém)' : 'Token do bot / token da API / segredo do webhook', tipo: 'password', autocomplete: 'new-password', inteiro: true },
    { nome: 'severidade_min', rotulo: 'Avisar a partir da severidade', tipo: 'select', vazio: false, valor: x?.severidade_min ?? 'baixa', opcoes: [['baixa', 'Baixa'], ['media', 'Média'], ['alta', 'Alta'], ['critica', 'Crítica']] },
    ...Object.entries(eventos).filter(([k]) => k !== 'teste').map(([k, r]) => ({ nome: `ev_${k}`, rotulo: r, tipo: 'checkbox', valor: x ? x.eventos.includes(k) : true })),
    x ? { nome: 'ativo', rotulo: 'Canal ativo', tipo: 'checkbox', valor: x.ativo, inteiro: true } : null,
  ];
  return formulario(x ? `Editar ${x.nome}` : 'Novo canal de aviso', campos, { largo: true, enviar: async (d) => {
    const t = tipo ?? d.tipo;
    const config = t === 'telegram' ? { chats: d.chats } : t === 'whatsapp' ? { numero_id: d.numero_id, destinatarios: d.destinatarios, modelo: d.modelo } : { url: d.url };
    const corpo = { nome: d.nome, config, severidade_min: d.severidade_min, eventos: Object.keys(eventos).filter((k) => d[`ev_${k}`]),
      ...(d.segredo ? { segredo: d.segredo } : {}), ...(x ? { ativo: d.ativo } : { tipo: t }) };
    await (x ? api.patch(`/avisos/canais/${x.id}`, corpo) : api.post('/avisos/canais', corpo));
    toast('Canal salvo. Use "Testar" para conferir.');
    depois();
  } });
}

