import { api } from '../api.js';
import { el, limpar, icone, pode, cabecalho, painel, tabela, etqDe, dataHora, desde, dl, toast, carregar, formulario, botao, faixa, modal, confirmar } from '../ui.js';

export default async function integracoes({ alvo }) {
  const corpo = el('div');
  limpar(alvo, cabecalho({ sobretitulo: 'Fontes de dados', titulo: 'Integrações',
    descricao: 'Rastreador, ZOE Atende, monitoramento da rede e Downdetector. Credenciais ficam só no servidor (cifradas) e nunca voltam para a tela. Cada fonte mostra o último sucesso, o erro e o ID para diagnóstico.' }), corpo);
  const atualizar = () => carregar(corpo, () => api.get('/integracoes'), (d) => {
    const ra = d.integracoes.find((x) => x.tipo === 'rastreador');
    const dd = d.integracoes.find((x) => x.tipo === 'downdetector');
    const at = d.integracoes.find((x) => x.tipo === 'atendimento');
    return el('div', { class: 'grade duas' },
      cartao('Rastreador de Veículos', 'carro', ra, 'Posições, trajetos e dispositivos pela API de integração do rastreador (chave da empresa, cabeçalho X-Api-Key).', [
        pode('integracoes.editar') ? botao('Configurar', () => configurarRastreador(ra, atualizar), { tipo: 'secundario pequeno' }) : null,
        pode('integracoes.editar') && ra.credencial_configurada ? botao('Testar conexão', () => testar('rastreador', atualizar), { tipo: 'pequeno' }) : null]),
      cartao('ZOE Atende — custo do WhatsApp', 'dinheiro', at, 'O que a Meta cobra por mensagem, o que a régua deixou de gastar e os meses fechados, pela API de integração do ZOE Atende (chave da empresa, cabeçalho X-Api-Key).', [
        pode('integracoes.editar') ? botao('Configurar', () => configurarAtendimento(at, atualizar), { tipo: 'secundario pequeno' }) : null,
        pode('integracoes.editar') && at.credencial_configurada ? botao('Testar conexão', () => testar('atendimento', atualizar), { tipo: 'pequeno' }) : null,
        el('a', { class: 'botao fantasma pequeno', href: '#/custos' }, 'Ver a conta', icone('seta'))]),
      cartao('Downdetector', 'globo', dd, 'Contexto externo de serviços. Requer acesso autorizado à API; endpoints e campos vêm da documentação do seu contrato.', [
        pode('integracoes.editar') ? botao('Configurar', () => configurarDowndetector(dd, atualizar), { tipo: 'secundario pequeno' }) : null,
        pode('integracoes.editar') ? botao('Serviços acompanhados', () => servicos(atualizar), { tipo: 'secundario pequeno' }) : null,
        pode('integracoes.editar') && dd.credencial_configurada ? botao('Testar conexão', () => testar('downdetector', atualizar), { tipo: 'pequeno' }) : null,
        el('a', { class: 'botao fantasma pequeno', href: d.downdetector_site, target: '_blank', rel: 'noopener' }, 'Site oficial', icone('externo'))]),
      painel('Monitoramento da rede (coletor)', el('div', {},
        el('p', { class: 'fraco', style: 'margin-bottom:12px' }, 'A plataforma de monitoramento ou um agente dentro da rede do provedor envia amostras para POST /api/coletor/amostras com o token do coletor. Equipamentos privados não ficam expostos à internet.'),
        tabela([{ titulo: 'Coletor', valor: (c) => el('div', {}, el('div', { class: 'forte' }, c.nome), el('div', { class: 'fraco' }, `mnc_${c.prefixo}_…`)) },
          { titulo: 'Último envio', valor: (c) => (c.ultimo_uso ? `${dataHora(c.ultimo_uso)} (${desde(c.ultimo_uso)})` : 'Nunca') },
          { titulo: 'Situação', valor: (c) => (c.revogado_em ? etqDe('estadoIntegracao', 'desabilitada') : etqDe('estadoIntegracao', c.ultimo_uso ? 'conectada' : 'testando')) },
          { titulo: '', valor: (c) => (!c.revogado_em && pode('integracoes.editar') ? el('button', { class: 'botao fantasma pequeno', onclick: async () => {
            if (await confirmar('Revogar coletor', 'O token deixa de funcionar imediatamente.', 'Revogar')) { await api.post(`/noc/coletores/${c.id}/revogar`, {}); atualizar(); } } }, 'Revogar') : '') }],
        d.monitoramento.coletores, { vazioTexto: 'Nenhum coletor: sem coleta própria, não há disponibilidade medida nem incidentes automáticos.' }),
        d.monitoramento.amostras_24h.length ? el('p', { class: 'fraco', style: 'margin-top:10px' }, `Amostras em 24 h: ${d.monitoramento.amostras_24h.map((a) => `${a.fonte} ${a.n} (última ${dataHora(a.ultima)})`).join(' · ')}`) : null,
        pode('integracoes.editar') ? el('div', { class: 'form-acoes', style: 'justify-content:flex-start' }, botao('Novo token de coletor', () => novoColetor(atualizar), { tipo: 'secundario pequeno', ic: 'mais' })) : null),
      { rodape: [el('span', {}, 'Formato: { source_event_id, target_id, ponto?, metric, value, unit?, observed_at }. Veja network/README.md e scripts/coletor-exemplo.js.')] }),
      painel('Diagnóstico das coletas', tabela([
        { titulo: 'Fonte', valor: (s) => s.tipo }, { titulo: 'Início', valor: (s) => dataHora(s.iniciado_em, { segundos: true }) }, { titulo: 'Resultado', valor: (s) => etqDe('estadoIntegracao', s.resultado === 'ok' ? 'conectada' : s.resultado) },
        { titulo: 'Itens', valor: (s) => s.itens, classe: 'num' }, { titulo: 'Tempo', valor: (s) => `${s.duracao_ms ?? '—'} ms`, classe: 'num' },
        { titulo: 'Erro', valor: (s) => (s.erro ? el('span', { class: 'fraco' }, `${s.erro}${s.erro_id ? ` · ID ${s.erro_id}` : ''}`) : '—') },
      ], [...ra.sincronizacoes, ...dd.sincronizacoes, ...at.sincronizacoes].sort((a, b) => b.id - a.id).slice(0, 15), { vazioTexto: 'Nenhuma coleta executada ainda.' }), { semCorpo: true }));
  });
  atualizar();
}

function cartao(titulo, ic, x, texto, acoes) {
  return painel(titulo, el('div', {},
    el('p', { class: 'fraco', style: 'margin-bottom:12px' }, texto),
    dl([['Estado', etqDe('estadoIntegracao', x.estado)], ['Habilitada', x.habilitada ? 'Sim' : 'Não'], ['Credencial', x.credencial_configurada ? 'Configurada (oculta)' : 'Não informada'],
      ['Endereço', x.config?.url_base ?? '—'], ['Último sucesso', x.ultimo_sucesso ? `${dataHora(x.ultimo_sucesso)} (${desde(x.ultimo_sucesso)})` : 'Nunca'],
      ['Última tentativa', x.ultima_tentativa ? dataHora(x.ultima_tentativa) : '—'], x.proxima_tentativa ? ['Próxima tentativa', dataHora(x.proxima_tentativa)] : null,
      x.ultimo_erro ? ['Último erro', `${x.ultimo_erro}${x.erro_id ? ` · ID ${x.erro_id}` : ''}`] : null]),
    el('div', { class: 'form-acoes', style: 'justify-content:flex-start' }, acoes)), { acoes: [icone(ic)] });
}

async function testar(tipo, depois) {
  const r = await api.post(`/integracoes/${tipo}/testar`, {});
  const RESUMO = {
    rastreador: (x) => `Conectado: ${x.veiculos} veículo(s) na fonte, ${x.posicoes_novas} posição(ões) nova(s).`,
    downdetector: (x) => `Conectado: ${x.coletados} serviço(s) coletado(s).`,
    atendimento: (x) => `Conectado: ${x.meses} mês(es) de conta lido(s).`,
  };
  if (r.ok) toast(RESUMO[tipo]?.(r.resultado) ?? 'Conectado.');
  else toast(`${r.erro}${r.erro_id ? ` (ID ${r.erro_id})` : ''}`, true);
  depois();
}

function configurarRastreador(x, depois) {
  return formulario('Rastreador de Veículos', [
    { nome: 'url_base', rotulo: 'Endereço do rastreador', obrigatorio: true, valor: x.config?.url_base, inteiro: true, placeholder: 'https://seu-dominio/rastreador',
      ajuda: 'Inclua o caminho de publicação (ex.: /rastreador). No mesmo servidor, use http://127.0.0.1:3400/rastreador com NETWORK_CONECTOR_REDE_INTERNA=1.' },
    { nome: 'segredo', rotulo: x.credencial_configurada ? 'Nova chave de API (deixe vazio para manter)' : 'Chave de API da empresa no rastreador', tipo: 'password', inteiro: true,
      obrigatorio: !x.credencial_configurada, ajuda: 'No rastreador: Configurações → Integrações → Nova chave (rst_…).', autocomplete: 'new-password' },
    { nome: 'intervalo_s', rotulo: 'Intervalo da coleta (segundos)', tipo: 'number', valor: x.config?.intervalo_s ?? 60 },
    { nome: 'habilitada', rotulo: 'Coleta habilitada', tipo: 'checkbox', valor: x.estado === 'nao_configurada' ? true : x.habilitada },
  ], { enviar: async (d) => {
    await api.put('/integracoes/rastreador', { config: { url_base: d.url_base, intervalo_s: d.intervalo_s }, segredo: d.segredo || undefined, habilitada: d.habilitada });
    toast('Configuração salva.');
    depois();
  } });
}

function configurarAtendimento(x, depois) {
  return formulario('ZOE Atende — custo do WhatsApp', [
    { nome: 'url_base', rotulo: 'Endereço do ZOE Atende', obrigatorio: true, valor: x.config?.url_base, inteiro: true, placeholder: 'https://seu-dominio/atendimento',
      ajuda: 'Inclua o caminho de publicação (ex.: /atendimento). No mesmo servidor, use http://127.0.0.1:3600 com NETWORK_CONECTOR_REDE_INTERNA=1.' },
    { nome: 'segredo', rotulo: x.credencial_configurada ? 'Nova chave de API (deixe vazio para manter)' : 'Chave de API da empresa no ZOE Atende', tipo: 'password', inteiro: true,
      obrigatorio: !x.credencial_configurada, ajuda: 'No ZOE Atende: Integrações → Nova chave (atd_…).', autocomplete: 'new-password' },
    { nome: 'intervalo_s', rotulo: 'Intervalo da leitura (segundos)', tipo: 'number', valor: x.config?.intervalo_s ?? 900,
      ajuda: 'A conta muda devagar: 15 minutos é o suficiente.' },
    { nome: 'meses', rotulo: 'Meses de histórico', tipo: 'number', valor: x.config?.meses ?? 12 },
    { nome: 'habilitada', rotulo: 'Leitura habilitada', tipo: 'checkbox', valor: x.estado === 'nao_configurada' ? true : x.habilitada },
  ], { enviar: async (d) => {
    await api.put('/integracoes/atendimento', {
      config: { url_base: d.url_base, intervalo_s: d.intervalo_s, meses: d.meses },
      segredo: d.segredo || undefined, habilitada: d.habilitada,
    });
    toast('Configuração salva.');
    depois();
  } });
}

function configurarDowndetector(x, depois) {
  const c = x.config ?? {};
  return formulario('Downdetector (acesso autorizado)', [
    { nome: 'url_base', rotulo: 'Endereço base da API', obrigatorio: true, valor: c.url_base, inteiro: true, ajuda: 'Da documentação do seu acesso (https://downdetectorapi.com/v2/docs/).' },
    { nome: 'caminho', rotulo: 'Caminho da consulta por serviço', obrigatorio: true, valor: c.caminho, inteiro: true, ajuda: 'Use {servico} e, se houver, {regiao}.' },
    { nome: 'cabecalho_auth', rotulo: 'Cabeçalho de autenticação', valor: c.cabecalho_auth ?? 'Authorization' }, { nome: 'prefixo_auth', rotulo: 'Prefixo', valor: c.prefixo_auth ?? 'Bearer' },
    { nome: 'segredo', rotulo: x.credencial_configurada ? 'Nova credencial (vazio mantém)' : 'Credencial', tipo: 'password', obrigatorio: !x.credencial_configurada, inteiro: true, autocomplete: 'new-password' },
    { nome: 'campo_relatos', rotulo: 'Campo do volume de relatos', obrigatorio: true, valor: c.campo_relatos, ajuda: 'Caminho no JSON, ex.: data.0.reports' },
    { nome: 'campo_baseline', rotulo: 'Campo da referência (baseline)', valor: c.campo_baseline },
    { nome: 'campo_periodo_inicio', rotulo: 'Campo do início do período', valor: c.campo_periodo_inicio }, { nome: 'campo_periodo_fim', rotulo: 'Campo do fim do período', valor: c.campo_periodo_fim },
    { nome: 'fator_indicio', rotulo: 'Indício quando relatos ≥ referência ×', tipo: 'decimal', valor: c.fator_indicio ?? 2 },
    { nome: 'intervalo_s', rotulo: 'Intervalo (segundos)', tipo: 'number', valor: c.intervalo_s ?? 300, ajuda: 'Respeite o limite do contrato; 429 pausa conforme Retry-After.' },
    { nome: 'habilitada', rotulo: 'Coleta habilitada', tipo: 'checkbox', valor: x.estado === 'nao_configurada' ? true : x.habilitada },
  ], { largo: true, antes: faixa('Sem acesso contratado, deixe esta integração não configurada. Não há scraping nem iframe do site.', 'info'), enviar: async (d) => {
    const { segredo, habilitada, ...cfg } = d;
    await api.put('/integracoes/downdetector', { config: { ...cfg, fator_indicio: String(cfg.fator_indicio).replace(',', '.') }, segredo: segredo || undefined, habilitada });
    toast('Configuração salva.');
    depois();
  } });
}

async function servicos(depois) {
  const s = await api.get('/noc/servicos-externos');
  return formulario('Serviços acompanhados', [
    { nome: 'nome', rotulo: 'Nome exibido', obrigatorio: true }, { nome: 'referencia', rotulo: 'Identificador do serviço na fonte', obrigatorio: true },
    { nome: 'regiao', rotulo: 'Região (se disponível no contrato)' },
  ], { rotuloEnviar: 'Adicionar', antes: el('div', { style: 'margin-bottom:12px' }, tabela([{ titulo: 'Serviço', valor: (x) => x.nome }, { titulo: 'Identificador', valor: (x) => x.referencia },
    { titulo: 'Região', valor: (x) => x.regiao ?? '—' }, { titulo: '', valor: (x) => el('button', { class: 'botao fantasma pequeno', onclick: async () => { await api.post(`/noc/servicos-externos/${x.id}/remover`, {}); toast('Removido.'); } }, 'Remover') }],
  s.servicos, { vazioTexto: 'Nenhum serviço.' })), enviar: async (d) => { await api.post('/noc/servicos-externos', d); toast('Serviço adicionado.'); depois(); } });
}

function novoColetor(depois) {
  return formulario('Novo token de coletor', [{ nome: 'nome', rotulo: 'Nome do coletor', obrigatorio: true, inteiro: true, placeholder: 'Agente POP Centro / Zabbix' }], { rotuloEnviar: 'Gerar token', enviar: async (d) => {
    const r = await api.post('/noc/coletores', d);
    await modal('Token do coletor', (fechar) => [faixa(r.aviso, ''), el('input', { type: 'text', readonly: true, value: r.token, onfocus: (e) => e.target.select(), 'aria-label': 'Token' }),
      el('div', { class: 'form-acoes' }, el('button', { class: 'botao', onclick: async () => { try { await navigator.clipboard.writeText(r.token); toast('Copiado.'); } catch { /* sem área de transferência */ } fechar(); } }, 'Copiar e fechar'))]);
    depois();
  } });
}
