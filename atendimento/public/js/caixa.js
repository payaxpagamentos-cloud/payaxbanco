/**
 * Caixa de entrada: a tela em que a equipe trabalha. À esquerda as conversas, no meio a conversa
 * aberta e à direita o que o atendente precisa saber — com destaque para o resumo que a atendente
 * virtual deixou ao transferir.
 */
import {api, qs, BASE, sessao} from './api.js';
import {
  el, $, limpar, icone, acao, toast, modal, formModal, confirmar, perguntar, campo, area, escolha, marcar,
  inteiro, dataHora, hora, desde, espera, iniciais, telefone as formatarTelefone, estrelas, etiquetaEstado,
  etiquetaMensagem, ESTADOS, AUTORES, TIPOS_MENSAGEM, PRIORIDADES, RESOLVIDA_POR, repetir,
} from './ui.js';
import {botao, botaoIcone, campoBusca, seletor, vazio} from './comum.js';

const CAIXAS = {
  minhas: 'Minhas conversas', aguardando: 'Na fila', bot: 'Com a atendente virtual', abertas: 'Todas em aberto', encerradas: 'Encerradas',
};

export async function telaCaixa(ctx) {
  const estado = {
    caixa: ctx.usuario.perfil === 'atendente' ? 'minhas' : 'abertas',
    fila_id: '', busca: '', selecionada: Number(new URLSearchParams(location.hash.split('?')[1] ?? '').get('conversa')) || null,
  };
  const filas = (await api.get(`/empresas/${ctx.empresaId}/filas`)).itens;
  const etiquetasDaEmpresa = (await api.get(`/empresas/${ctx.empresaId}/etiquetas`)).itens;
  const rapidas = (await api.get(`/empresas/${ctx.empresaId}/respostas-rapidas`)).itens.filter((x) => x.ativa);

  const listaEl = el('div', { class: 'lista-conversas' });
  const contadores = el('div', { class: 'abas-caixa' });
  const chatEl = el('div', { class: 'chat' });
  const lateralEl = el('aside', { class: 'painel-conversa' });

  const esquerda = el('div', { class: 'coluna-lista' },
    el('div', { class: 'topo-lista' },
      contadores,
      el('div', { class: 'filtros-lista' },
        campoBusca(estado.busca, (t) => { estado.busca = t; carregarLista(); }, 'Nome, telefone ou documento'),
        filas.length > 1 ? seletor('Fila', { '': 'Todas', ...Object.fromEntries(filas.map((f) => [f.id, f.nome])) }, estado.fila_id, (v) => { estado.fila_id = v; carregarLista(); }) : null)),
    listaEl);

  limpar(ctx.conteudo, el('div', { class: 'caixa' }, esquerda, el('div', { class: 'coluna-chat' }, chatEl), lateralEl));

  // ---------- Lista ----------
  function desenharAbas(total) {
    limpar(contadores, Object.entries(CAIXAS).map(([k, rotulo]) => el('button', {
      class: `aba${estado.caixa === k ? ' on' : ''}`, type: 'button',
      onclick: () => { estado.caixa = k; carregarLista(); },
    }, rotulo, estado.caixa === k && total !== null ? el('span', { class: 'conta' }, inteiro(total)) : null)));
  }

  async function carregarLista({ silencioso = false } = {}) {
    const r = await api.get(`/empresas/${ctx.empresaId}/conversas${qs({ caixa: estado.caixa, fila_id: estado.fila_id, busca: estado.busca, por_pagina: 60 })}`);
    desenharAbas(r.total);
    if (!r.itens.length) {
      limpar(listaEl, vazio('Nenhuma conversa aqui.', estado.caixa === 'minhas' ? 'Fique disponível para receber conversas da fila.' : null));
    } else {
      limpar(listaEl, r.itens.map((c) => itemLista(c)));
    }
    // Abre a primeira automaticamente na primeira carga.
    if (!silencioso && !estado.selecionada && r.itens.length) abrir(r.itens[0].id);
    else if (estado.selecionada && !r.itens.some((c) => c.id === estado.selecionada) && !silencioso) { /* mantém aberta mesmo fora do filtro */ }
    return r;
  }

  const itemLista = (c) => {
    const ultima = c.ultima_mensagem;
    const previa = ultima ? (ultima.tipo === 'texto' || ultima.tipo === 'botao' ? ultima.texto : `📎 ${TIPOS_MENSAGEM[ultima.tipo] ?? ultima.tipo}`) : 'sem mensagens';
    return el('button', {
      class: `item-conversa${c.id === estado.selecionada ? ' on' : ''}${c.prioridade === 'alta' ? ' alta' : ''}`,
      type: 'button', onclick: () => abrir(c.id),
    },
    el('span', { class: 'avatar-contato' }, iniciais(c.nome)),
    el('span', { class: 'meio' },
      el('span', { class: 'linha-nome' }, el('strong', {}, c.nome), el('small', {}, desde(c.ultima_mensagem_em ?? c.aberta_em))),
      el('span', { class: 'previa' }, ultima?.autor === 'cliente' ? '' : '↩ ', previa ?? ''),
      el('span', { class: 'linha-tags' },
        etiquetaEstado(c.estado),
        c.fila_nome ? el('span', { class: 'etiqueta' }, c.fila_nome) : null,
        c.estado === 'aguardando' ? espera(c.espera_s) : null,
        c.estado === 'humano' && c.atendente_nome ? el('span', { class: 'pequeno mudo' }, c.atendente_nome) : null,
        c.csat_nota ? estrelas(c.csat_nota) : null)));
  };

  // ---------- Conversa aberta ----------
  let paradaAtual = null;

  async function abrir(id) {
    estado.selecionada = id;
    for (const b of listaEl.querySelectorAll('.item-conversa')) b.classList.remove('on');
    paradaAtual?.();
    const pintar = async () => {
      const d = await api.get(`/empresas/${ctx.empresaId}/conversas/${id}`);
      if (estado.selecionada !== id) return;
      desenharChat(d);
      desenharLateral(d);
    };
    await pintar();
    // A conversa aberta atualiza sozinha: mensagem nova do cliente aparece sem recarregar.
    paradaAtual = repetir(pintar, 6000);
    ctx.parar(() => { paradaAtual?.(); pararLista?.(); });
  }

  function desenharChat(d) {
    const minha = d.atendente_id === ctx.usuario.id;
    const posso = !ctx.somenteLeitura && d.estado !== 'encerrada' && (ctx.master || ctx.soAdmin || minha || !d.atendente_id);

    const cabecalho = el('div', { class: 'cabecalho-chat' },
      el('span', { class: 'avatar-contato grande' }, iniciais(d.nome)),
      el('div', { class: 'quem-chat' },
        el('strong', {}, d.nome),
        el('div', { class: 'pequeno mudo' }, formatarTelefone(d.telefone.replace(/^55/, '')),
          d.contato?.documento ? ` · ${d.contato.documento}` : '', d.fila_nome ? ` · ${d.fila_nome}` : '')),
      el('div', { class: 'linha', style: 'gap:6px;margin-left:auto' },
        etiquetaEstado(d.estado),
        d.estado !== 'encerrada' && !d.janela_aberta ? el('span', { class: 'etiqueta aviso', title: 'Passaram-se mais de 24 h desde a última mensagem do cliente: o WhatsApp só aceita template aprovado.' }, 'Janela fechada') : null,
        ...acoesConversa(d, { minha, posso })));

    const mensagens = el('div', { class: 'mensagens' }, d.mensagens.map((m) => bolha(m, d)));
    const rodape = posso ? compositor(d) : el('div', { class: 'compositor fechado' },
      el('p', { class: 'mudo', style: 'margin:0' }, d.estado === 'encerrada'
        ? `Atendimento encerrado${d.resolvida_por ? ` · ${RESOLVIDA_POR[d.resolvida_por]}` : ''}. Para falar com o cliente, abra uma conversa nova em Contatos.`
        : ctx.somenteLeitura ? 'Seu perfil só consulta.' : `Esta conversa está com ${d.atendente_nome ?? 'outro atendente'}.`),
      d.estado === 'aguardando' && posso === false && !ctx.somenteLeitura ? botao('Assumir', 'primario', () => assumir(d.id)) : null);

    limpar(chatEl, cabecalho, mensagens, rodape);
    mensagens.scrollTop = mensagens.scrollHeight;
  }

  function acoesConversa(d, { minha, posso }) {
    if (ctx.somenteLeitura || d.estado === 'encerrada') return [];
    const itens = [];
    if (d.estado === 'aguardando' || (!minha && !d.atendente_id)) itens.push(botao('Assumir', 'primario pequeno', () => assumir(d.id)));
    if (posso) {
      itens.push(botaoIcone('transferir', 'Transferir', () => transferir(d)));
      if (d.estado === 'humano') itens.push(botaoIcone('voltar', 'Devolver para a fila', () => devolver(d)));
      if (d.estado !== 'bot') itens.push(botaoIcone('robo', 'Devolver para a atendente virtual', () => voltarParaIa(d)));
      itens.push(botaoIcone('encerrar', 'Encerrar atendimento', () => encerrar(d), 'perigo'));
    }
    return itens;
  }

  // ---------- Bolhas ----------
  function bolha(m, d) {
    if (m.tipo === 'sistema') return el('div', { class: 'aviso-sistema' }, icone('ok'), el('span', {}, m.texto), el('small', {}, hora(m.criada_em)));
    const lado = m.direcao === 'entrada' ? 'cliente' : m.autor;
    const autor = m.autor === 'atendente' ? (m.usuario_nome ?? 'Atendente') : AUTORES[m.autor];
    return el('div', { class: `bolha ${lado}` },
      el('div', { class: 'corpo-bolha' },
        m.direcao === 'saida' ? el('div', { class: 'autor-bolha' }, m.autor === 'ia' ? icone('robo') : icone('pessoa'), autor) : null,
        anexo(m),
        m.texto ? el('p', {}, m.texto) : null,
        el('div', { class: 'pe-bolha' },
          el('small', {}, hora(m.criada_em)),
          m.direcao === 'saida' ? etiquetaMensagem(m.status) : null,
          m.status === 'falhou' ? botao('Reenviar', '', () => reenviar(m.id)) : null),
        m.erro ? el('small', { class: 'erro-bolha', title: m.erro }, m.erro.slice(0, 120)) : null));
  }

  function anexo(m) {
    if (!m.midia_arquivo) return m.tipo === 'texto' || m.tipo === 'botao' || m.tipo === 'template' ? null : el('em', { class: 'mudo' }, TIPOS_MENSAGEM[m.tipo] ?? m.tipo);
    const url = `${BASE}/api/empresas/${ctx.empresaId}/mensagens/${m.id}/midia`;
    const comSessao = `${url}?inline=1`;
    if (m.tipo === 'imagem' || m.tipo === 'figurinha') {
      const img = el('img', { class: 'midia-imagem', alt: m.midia_nome ?? 'imagem enviada pelo cliente', loading: 'lazy' });
      // A imagem precisa do token: busca com fetch e usa blob.
      carregarComSessao(comSessao).then((b) => { if (b) img.src = b; }).catch(() => {});
      img.addEventListener('click', () => modal(m.midia_nome ?? 'Imagem', el('img', { src: img.src, style: 'max-width:100%;border-radius:10px' }), { largo: true }));
      return img;
    }
    if (m.tipo === 'audio') {
      const audio = el('audio', { controls: true, class: 'midia-audio' });
      carregarComSessao(comSessao).then((b) => { if (b) audio.src = b; }).catch(() => {});
      return audio;
    }
    if (m.tipo === 'video') {
      const video = el('video', { controls: true, class: 'midia-video' });
      carregarComSessao(comSessao).then((b) => { if (b) video.src = b; }).catch(() => {});
      return video;
    }
    return el('button', { class: 'anexo', type: 'button', onclick: (e) => acao(e.currentTarget, async () => {
      const { baixar } = await import('./api.js');
      await baixar(`/empresas/${ctx.empresaId}/mensagens/${m.id}/midia`, m.midia_nome ?? 'arquivo');
    }) }, icone('anexo'), el('span', {}, m.midia_nome ?? 'arquivo'), m.midia_bytes ? el('small', {}, `${Math.round(m.midia_bytes / 1024)} KB`) : null);
  }

  const cacheMidia = new Map();
  async function carregarComSessao(url) {
    if (cacheMidia.has(url)) return cacheMidia.get(url);
    const s = sessao.get();
    const resp = await fetch(url, { headers: s?.token ? { Authorization: `Bearer ${s.token}` } : {} });
    if (!resp.ok) return null;
    const blob = URL.createObjectURL(await resp.blob());
    cacheMidia.set(url, blob);
    return blob;
  }

  // ---------- Compositor ----------
  function compositor(d) {
    if (!d.janela_aberta) {
      return el('div', { class: 'compositor fechado' },
        el('div', {},
          el('strong', {}, 'Janela de 24 horas fechada.'),
          el('p', { class: 'mudo pequeno', style: 'margin:4px 0 0' },
            'O WhatsApp só permite mensagem livre nas 24 h seguintes à última mensagem do cliente. Para falar agora, use um template aprovado pela Meta.')),
        botao('Enviar template', 'primario', () => enviarTemplate(d)));
    }
    const texto = el('textarea', { rows: 2, placeholder: 'Escreva a resposta… (/ para as respostas rápidas)', maxlength: 4096 });
    const enviar = el('button', { class: 'btn primario', type: 'button', title: 'Enviar (Enter)' }, icone('enviar'), 'Enviar');
    const mandar = () => acao(enviar, async () => {
      const t = texto.value.trim();
      if (!t) return;
      await api.post(`/empresas/${ctx.empresaId}/conversas/${d.id}/mensagens`, { texto: t });
      texto.value = '';
      await abrir(d.id);
      carregarLista({ silencioso: true });
    });
    enviar.addEventListener('click', mandar);
    texto.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); mandar(); }
      if (e.key === '/' && texto.value === '') { e.preventDefault(); escolherRapida(texto); }
    });
    return el('div', { class: 'compositor' },
      el('div', { class: 'linha-compositor' }, texto, enviar),
      el('div', { class: 'linha', style: 'gap:8px;flex-wrap:wrap' },
        rapidas.length ? el('button', { class: 'btn pequeno', type: 'button', onclick: () => escolherRapida(texto) }, icone('raio'), 'Respostas rápidas') : null,
        el('button', { class: 'btn pequeno', type: 'button', onclick: () => enviarTemplate(d) }, 'Template'),
        el('span', { class: 'pequeno mudo', style: 'margin-left:auto' }, 'Enter envia · Shift+Enter quebra a linha')));
  }

  function escolherRapida(texto) {
    if (!rapidas.length) return toast('Nenhuma resposta rápida cadastrada.', true);
    return modal('Respostas rápidas', (fechar) => el('div', { class: 'lista-rapidas' }, rapidas.map((rr) => el('button', {
      class: 'item-rapida', type: 'button', onclick: () => { fechar(); texto.value = rr.texto; texto.focus(); },
    }, el('strong', {}, `/${rr.atalho}`), el('span', {}, rr.titulo), el('small', { class: 'mudo' }, rr.texto.slice(0, 120))))), { largo: true });
  }

  const enviarTemplate = (d) => formModal('Enviar template aprovado', () => [
    el('p', { class: 'mudo pequeno', style: 'margin:0 0 8px' },
      'O nome e o idioma são os cadastrados no Gerenciador do WhatsApp da Meta. Os parâmetros preenchem as variáveis do corpo, na ordem ({{1}}, {{2}}…).'),
    campo('Nome do template', { name: 'template', required: true, placeholder: 'aviso_fatura' }),
    campo('Idioma', { name: 'idioma', value: 'pt_BR' }),
    campo('Parâmetros (separados por |)', { name: 'parametros', placeholder: 'João | 10/12/2026 | R$ 129,90' }),
  ], async (dados) => {
    await api.post(`/empresas/${ctx.empresaId}/conversas/${d.id}/mensagens`, {
      template: dados.template, idioma: dados.idioma || 'pt_BR',
      parametros: dados.parametros ? dados.parametros.split('|').map((x) => x.trim()).filter(Boolean) : [],
    });
    toast('Template na fila de envio.');
    await abrir(d.id);
  }, { rotulo: 'Enviar' });

  // ---------- Ações ----------
  const recarregar = async (id) => { await abrir(id); await carregarLista({ silencioso: true }); };

  const assumir = async (id) => { await api.post(`/empresas/${ctx.empresaId}/conversas/${id}/assumir`); toast('Conversa assumida.'); await recarregar(id); };

  const reenviar = async (mid) => { await api.post(`/empresas/${ctx.empresaId}/mensagens/${mid}/reenviar`); toast('Mensagem na fila de envio.'); await abrir(estado.selecionada); };

  const transferir = (d) => formModal('Transferir atendimento', () => [
    escolha('Para a fila', 'fila_id', { '': '— escolha —', ...Object.fromEntries(filas.filter((f) => f.ativa).map((f) => [f.id, `${f.nome}${f.dentro_horario ? '' : ' (fora do horário)'}`])) }, d.fila_id ?? ''),
    campo('Ou direto para o atendente (opcional)', { name: 'atendente_id', list: 'atendentes-lista', placeholder: 'deixe vazio para a fila' }),
    area('Motivo', { name: 'motivo', rows: 2, maxlength: 300, placeholder: 'o que a próxima pessoa precisa saber' }),
    marcar('Avisar o cliente da transferência', { name: 'avisar_cliente' }),
  ], async (dados) => {
    const corpo = dados.atendente_id ? { atendente_id: Number(dados.atendente_id), motivo: dados.motivo } : { fila_id: Number(dados.fila_id), motivo: dados.motivo, avisar_cliente: dados.avisar_cliente };
    if (!corpo.fila_id && !corpo.atendente_id) throw new Error('Escolha a fila ou o atendente.');
    const r = await api.post(`/empresas/${ctx.empresaId}/conversas/${d.id}/transferir`, corpo);
    toast(r.atendente ? `Transferida para ${r.atendente}.` : `Transferida para a fila ${r.fila}.`);
    await recarregar(d.id);
  }, { rotulo: 'Transferir' });

  const devolver = async (d) => {
    const motivo = await perguntar('Devolver para a fila', 'Motivo (aparece no histórico)', { obrigatorio: false });
    if (motivo === null) return;
    await api.post(`/empresas/${ctx.empresaId}/conversas/${d.id}/devolver`, { motivo });
    toast('Conversa devolvida para a fila.');
    await recarregar(d.id);
  };

  const voltarParaIa = async (d) => {
    if (!await confirmar('Devolver para a atendente virtual', 'A atendente virtual volta a responder este cliente. Use quando o pedido for simples e ela puder resolver.', 'Devolver')) return;
    await api.post(`/empresas/${ctx.empresaId}/conversas/${d.id}/voltar-ia`);
    toast('A atendente virtual assumiu de volta.');
    await recarregar(d.id);
  };

  const encerrar = (d) => formModal('Encerrar atendimento', () => [
    campo('Assunto (para o relatório)', { name: 'assunto', value: d.assunto ?? '', maxlength: 160 }),
    area('Resumo do que foi feito', { name: 'resumo', rows: 3, maxlength: 2000 }, d.resumo ?? ''),
    area('Mensagem de despedida (vazio usa a padrão da empresa)', { name: 'mensagem', rows: 2, maxlength: 1000 }),
    marcar('Avisar o cliente', { name: 'avisar_cliente', checked: true }),
    marcar('Pedir avaliação (nota de 1 a 5)', { name: 'pedir_csat', checked: true }),
  ], async (dados) => {
    await api.post(`/empresas/${ctx.empresaId}/conversas/${d.id}/encerrar`, dados);
    toast('Atendimento encerrado.');
    await recarregar(d.id);
  }, { rotulo: 'Encerrar' });

  // ---------- Painel lateral ----------
  function desenharLateral(d) {
    const bloco = (titulo, ...filhos) => el('div', { class: 'bloco-lateral' }, el('h3', {}, titulo), ...filhos);
    const dado = (rotulo, valor) => el('div', { class: 'dado' }, el('small', {}, rotulo), el('span', {}, valor ?? '—'));

    limpar(lateralEl,
      // O resumo da atendente virtual é a primeira coisa que o atendente deve ler.
      d.resumo ? el('div', { class: 'resumo-ia' },
        el('h3', {}, icone('robo'), 'A atendente virtual passou assim'),
        el('p', {}, d.resumo),
        d.motivo_transferencia ? el('p', { class: 'motivo' }, el('strong', {}, 'Motivo: '), d.motivo_transferencia) : null) : null,

      bloco('Contato',
        dado('Nome', d.contato?.nome ?? d.contato?.nome_perfil),
        dado('WhatsApp', formatarTelefone(d.telefone.replace(/^55/, ''))),
        dado('CPF/CNPJ', d.contato?.documento),
        dado('E-mail', d.contato?.email),
        dado('Código no sistema', d.contato?.codigo_externo),
        d.contato?.observacoes ? el('p', { class: 'pequeno', style: 'margin:8px 0 0' }, d.contato.observacoes) : null,
        ctx.somenteLeitura ? null : botao('Editar contato', '', () => editarContato(d))),

      bloco('Atendimento',
        dado('Aberta', dataHora(d.aberta_em)),
        dado('Estado', ESTADOS[d.estado]?.[0] ?? d.estado),
        d.fila_nome ? dado('Fila', d.fila_nome) : null,
        d.atendente_nome ? dado('Atendente', d.atendente_nome) : null,
        d.transferida_em ? dado('Transferida', dataHora(d.transferida_em)) : null,
        d.encerrada_em ? dado('Encerrada', `${dataHora(d.encerrada_em)}${d.resolvida_por ? ` · ${RESOLVIDA_POR[d.resolvida_por]}` : ''}`) : null,
        dado('Mensagens da IA', inteiro(d.mensagens_ia)),
        d.csat_nota ? el('div', { class: 'dado' }, el('small', {}, 'Avaliação'), estrelas(d.csat_nota)) : null,
        d.csat_comentario ? el('p', { class: 'pequeno', style: 'margin:4px 0 0' }, `"${d.csat_comentario}"`) : null,
        ctx.somenteLeitura || d.estado === 'encerrada' ? null : el('label', { class: 'campo' }, 'Prioridade',
          (() => {
            const s = escolha(null, 'prioridade', PRIORIDADES, d.prioridade);
            s.addEventListener('change', () => acao(s, async () => {
              await api.patch(`/empresas/${ctx.empresaId}/conversas/${d.id}`, { prioridade: s.value });
              carregarLista({ silencioso: true });
            }));
            return s;
          })())),

      etiquetasDaEmpresa.length ? bloco('Etiquetas', el('div', { class: 'etiquetas-escolha' }, etiquetasDaEmpresa.map((e) => {
        const marcada = d.etiquetas.some((x) => x.id === e.id);
        const trocar = (ev) => acao(ev.currentTarget, async () => {
          const ids = marcada ? d.etiquetas.filter((x) => x.id !== e.id).map((x) => x.id) : [...d.etiquetas.map((x) => x.id), e.id];
          await api.put(`/empresas/${ctx.empresaId}/conversas/${d.id}/etiquetas`, { etiquetas: ids });
          await abrir(d.id);
        });
        return el('button', { class: `tag-escolha ${e.cor}${marcada ? ' on' : ''}`, type: 'button', disabled: ctx.somenteLeitura, onclick: trocar }, e.nome);
      }))) : null,

      d.chamados.length ? bloco('Chamados', d.chamados.map((ch) => el('div', { class: 'dado' }, el('small', {}, ch.protocolo), el('span', {}, ch.assunto)))) : null,

      bloco('Notas internas',
        d.notas.length ? el('div', { class: 'notas' }, d.notas.map((n) => el('div', { class: 'nota-item' },
          el('p', {}, n.texto), el('small', {}, `${n.usuario_nome ?? 'equipe'} · ${dataHora(n.criada_em)}`)))) : el('p', { class: 'mudo pequeno', style: 'margin:0' }, 'Nenhuma nota.'),
        ctx.somenteLeitura ? null : botao('Adicionar nota', '', async () => {
          const texto = await perguntar('Nota interna', 'O cliente não vê esta nota');
          if (!texto) return;
          await api.post(`/empresas/${ctx.empresaId}/conversas/${d.id}/notas`, { texto });
          await abrir(d.id);
        })),

      d.eventos_ia.length ? bloco('O que a atendente virtual fez', el('ol', { class: 'passos-ia' }, d.eventos_ia.map((ev) => el('li', {},
        el('strong', {}, ev.tipo === 'ferramenta' ? ev.nome : ev.tipo === 'resposta' ? 'respondeu' : `${ev.tipo}${ev.nome ? `: ${ev.nome}` : ''}`),
        ev.detalhe ? el('div', { class: 'pequeno mudo' }, String(ev.detalhe).slice(0, 160)) : null,
        ev.ms ? el('small', {}, `${inteiro(ev.ms)} ms`) : null)))) : null);
  }

  const editarContato = (d) => formModal('Editar contato', () => [
    campo('Nome', { name: 'nome', value: d.contato?.nome ?? '', maxlength: 160 }),
    campo('CPF/CNPJ', { name: 'documento', value: d.contato?.documento ?? '', inputmode: 'numeric' }),
    campo('E-mail', { name: 'email', value: d.contato?.email ?? '', type: 'email' }),
    campo('Código no sistema da empresa', { name: 'codigo_externo', value: d.contato?.codigo_externo ?? '', maxlength: 80 }),
    area('Observações', { name: 'observacoes', rows: 3, maxlength: 2000 }, d.contato?.observacoes ?? ''),
    marcar('Bloqueado (não recebe nem é atendido)', { name: 'bloqueado', checked: Boolean(d.contato?.bloqueado) }),
    marcar('Aceita mensagens ativas', { name: 'aceita_ativo', checked: d.contato?.aceita_ativo !== 0 }),
  ], async (dados) => {
    await api.patch(`/empresas/${ctx.empresaId}/contatos/${d.contato.id}`, dados);
    toast('Contato atualizado.');
    await abrir(d.id);
  });

  // Datalist dos atendentes para a transferência direta.
  const equipe = (await api.get(`/empresas/${ctx.empresaId}/usuarios`)).itens.filter((u) => u.ativo && ['atendente', 'cliente'].includes(u.perfil));
  document.body.append(el('datalist', { id: 'atendentes-lista' }, equipe.map((u) => el('option', { value: u.id }, `${u.nome}${u.disponivel ? '' : ' (indisponível)'}`))));

  await carregarLista();
  // A lista se atualiza sozinha: conversa nova na fila aparece sem recarregar a página.
  const pararLista = repetir(() => carregarLista({ silencioso: true }), 10_000);
  ctx.parar(() => { pararLista(); paradaAtual?.(); $('#atendentes-lista')?.remove(); });
}

export { CAIXAS };
