import { api, sessao, arte, BASE } from './api.js';
import { el, $, limpar, icone, toast, acao, marca, modal, lerForm, dataHora, hora, duracao, numero, atrasar, repetir,
  etiquetaIdade, CATEGORIAS_CANAL, dataBR, confirmar } from './ui.js';
import { cabeca, indicador, tabela, td, botao, campo, area, escolha, caixaSim, CLASSIFICACOES_OPCOES } from './admin-ui.js';
import { enviarImagem, lerTexto } from './envio.js';
import { telaCatalogo, telaTituloEditor } from './admin-catalogo.js';
import { TELAS_NEGOCIO } from './admin-negocio.js';

const raiz = $('#app');
let usuario = null;
let tela = 'painel';
let pararTela = null;
let contadores = {};

window.addEventListener('tv:sair', () => iniciar());

// ---------------------------------------------------------------- entrada da equipe

function telaLogin(mensagem) {
  const f = el('form', { class: 'form' },
    campo('E-mail', { name: 'email', type: 'email', required: true, autocomplete: 'username' }),
    campo('Senha', { name: 'senha', type: 'password', required: true, autocomplete: 'current-password' }),
    el('button', { class: 'btn primario grande bloco' }, 'Entrar no painel'));
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    acao(f.querySelector('button'), async () => {
      const r = await api.post('/auth/login', lerForm(f));
      if (r.usuario.perfil === 'assinante') throw new Error('Esta conta é de assinante. Use o app em /.');
      sessao.set({ token: r.token, usuario: r.usuario });
      iniciar();
    });
  });
  limpar(raiz, el('div', { class: 'entrada' }, el('div', { class: 'caixa' },
    marca('Operação'),
    el('h1', { style: 'margin:18px 0 4px' }, 'Painel da operação'),
    el('p', { class: 'mudo', style: 'margin:0 0 16px' }, 'Canais, grade, catálogo, assinantes e audiência.'),
    mensagem ? el('div', { class: 'aviso erro', style: 'margin-bottom:12px' }, mensagem) : null,
    f)));
}

async function iniciar() {
  pararTela?.();
  pararTela = null;
  const s = sessao.get();
  if (!s?.token) return telaLogin();
  try {
    const r = await api.get('/auth/me');
    if (r.usuario.perfil === 'assinante') {
      sessao.limpar();
      return telaLogin('Esta conta é de assinante. Use o app em /.');
    }
    usuario = r.usuario;
  } catch (err) {
    sessao.limpar();
    return telaLogin(err.status === 401 ? null : err.message);
  }
  try { tela = sessionStorage.getItem('playtechvip.admin.tela') || 'painel'; } catch { /* padrão */ }
  return ir(tela);
}

// ---------------------------------------------------------------- menu

const TELAS = {
  painel: ['Painel', telaPainel, 'conteudo'],
  assistindo: ['Assistindo agora', telaAssistindo, 'conteudo'],
  canais: ['Canais', telaCanais, 'conteudo'],
  grade: ['Grade (EPG)', telaGrade, 'conteudo'],
  catalogo: ['Catálogo', (c) => telaCatalogo(c, { ir, abrirTitulo }), 'conteudo'],
  home: ['Destaques e home', telaHome, 'conteudo'],
  ...TELAS_NEGOCIO,
};

const GRUPOS = [['Conteúdo', 'conteudo'], ['Negócio', 'negocio'], ['Plataforma', 'plataforma']];

function ir(novaTela, dados = null) {
  pararTela?.();
  pararTela = null;
  const def = TELAS[novaTela];
  if (!def || (def[3] && usuario.perfil !== def[3])) novaTela = 'painel';
  tela = novaTela;
  try { sessionStorage.setItem('playtechvip.admin.tela', tela); } catch { /* ignora */ }
  const principal = el('main');
  limpar(raiz, el('div', { class: 'painel' },
    el('nav', { class: 'menu' },
      marca('Operação'),
      GRUPOS.map(([nomeGrupo, chave]) => {
        const itens = Object.entries(TELAS).filter(([, t]) => t[2] === chave && (!t[3] || usuario.perfil === t[3]));
        if (!itens.length) return null;
        return [el('div', { class: 'grupo' }, nomeGrupo), itens.map(([k, [rotulo]]) => el('button', {
          class: k === tela ? 'on' : '',
          onclick: () => ir(k),
        }, rotulo, contadores[k] ? el('span', { class: 'contador' }, contadores[k]) : null))];
      }),
      el('div', { class: 'rodape' },
        el('div', {}, usuario.nome),
        el('div', { class: 'mini apagado' }, usuario.perfil === 'admin' ? 'Administrador' : 'Curadoria'),
        el('div', { class: 'linha', style: 'margin-top:8px;gap:6px' },
          el('a', { class: 'btn pequeno vazio', href: '../' }, 'Ver o app'),
          el('button', { class: 'btn pequeno vazio', onclick: () => { sessao.limpar(); iniciar(); } }, 'Sair')))),
    principal));
  Promise.resolve(TELAS[tela][1](principal, dados)).catch((err) => {
    limpar(principal, cabeca(TELAS[tela][0]), el('div', { class: 'aviso erro' }, err.message),
      el('button', { class: 'btn', style: 'margin-top:12px', onclick: () => ir(tela, dados) }, 'Tentar de novo'));
  });
}

const abrirTitulo = (id) => ir('titulo', id);
TELAS.titulo = ['Catálogo', (c, id) => telaTituloEditor(c, id, { voltar: () => ir('catalogo') }), 'oculto'];

// ---------------------------------------------------------------- Painel

async function telaPainel(c) {
  const corpo = el('div', { class: 'coluna' });
  limpar(c, cabeca('Painel', el('span', { class: 'pequeno mudo' }, 'Atualiza sozinho')), corpo);
  pararTela = repetir(async () => {
    const p = await api.get('/admin/painel');
    contadores = {
      faturas: p.receita?.vencidas_n || 0,
      canais: p.canais_com_falha.length,
      catalogo: p.conteudo.titulos_rascunho,
    };
    limpar(corpo,
      el('div', { class: 'indicadores' },
        indicador('Assistindo agora', p.audiencia.telas_agora, `${p.audiencia.sessoes_hoje} sessões hoje`, true),
        indicador('Minutos assistidos hoje', numero(p.audiencia.minutos_hoje)),
        indicador('Assinantes ativos', numero(p.assinantes.ativos), p.assinantes.novos_no_mes !== undefined ? `${p.assinantes.novos_no_mes} novos no mês` : null),
        p.receita ? indicador('Receita recorrente (MRR)', (p.receita.mrr_centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
          `recebido no mês ${(p.receita.recebido_no_mes_centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`) : null,
        p.receita ? indicador('A receber', (p.receita.a_receber_centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
          `${p.receita.faturas_abertas} fatura(s) · ${p.receita.vencidas_n} vencida(s)`) : null,
        indicador('Canais no ar', `${p.conteudo.canais - p.conteudo.canais_fora_do_ar}/${p.conteudo.canais}`,
          p.conteudo.canais_fora_do_ar ? `${p.conteudo.canais_fora_do_ar} com falha de sinal` : 'todos respondendo'),
        indicador('Catálogo publicado', numero(p.conteudo.titulos_publicados), `${p.conteudo.episodios} episódios · ${p.conteudo.titulos_rascunho} rascunho(s)`),
        indicador('Programas na grade', numero(p.conteudo.programas_na_grade), 'daqui para a frente')),
      p.canais_com_falha.length ? el('div', { class: 'cartao' },
        el('h3', {}, 'Canais fora do ar'),
        el('div', { class: 'coluna' }, p.canais_com_falha.map((x) => el('div', { class: 'linha entre' },
          el('div', {}, el('strong', {}, `${x.numero} · ${x.nome}`), el('div', { class: 'pequeno mudo' }, x.sinal_detalhe ?? 'sem detalhe')),
          el('div', { class: 'linha' }, el('span', { class: 'mini apagado' }, dataHora(x.sinal_em)),
            botao('Abrir canais', 'vazio', async () => ir('canais'))))))) : null,
      p.enviando.length ? el('div', { class: 'cartao' }, el('h3', {}, 'Envios em andamento'),
        el('div', { class: 'coluna' }, p.enviando.map((m) => el('div', { class: 'envio' },
          el('div', { class: 'meio' }, el('strong', { class: 'cortar' }, m.nome_original),
            el('div', { class: 'barra-progresso', style: 'margin-top:6px' }, el('span', { style: `width:${Math.round((m.recebido / m.tamanho) * 100)}%` }))),
          el('span', { class: 'etiqueta aviso' }, `${Math.round((m.recebido / m.tamanho) * 100)}%`))))) : null);
    // Atualiza os contadores do menu sem redesenhar a tela toda.
    for (const b of document.querySelectorAll('.menu button')) {
      const chave = Object.entries(TELAS).find(([, t]) => t[0] === b.textContent.replace(/\d+$/, '').trim())?.[0];
      if (chave && contadores[chave]) {
        if (!b.querySelector('.contador')) b.append(el('span', { class: 'contador' }, contadores[chave]));
        else b.querySelector('.contador').textContent = contadores[chave];
      } else b.querySelector('.contador')?.remove();
    }
  }, 15_000);
}

async function telaAssistindo(c) {
  const corpo = el('div');
  limpar(c, cabeca('Assistindo agora', el('span', { class: 'pequeno mudo' }, 'Atualiza a cada 10 segundos')), corpo);
  pararTela = repetir(async () => {
    const { telas } = await api.get('/admin/assistindo');
    limpar(corpo,
      el('div', { class: 'indicadores', style: 'margin-bottom:16px' },
        indicador('Telas abertas', telas.length, null, true),
        indicador('Ao vivo', telas.filter((t) => t.tipo === 'canal').length, 'canais'),
        indicador('Sob demanda', telas.filter((t) => t.tipo !== 'canal').length, 'filmes e episódios')),
      tabela(['Assinante', 'Perfil', 'O que está assistindo', 'Aparelho', 'Desde', '>Tempo'],
        telas.map((t) => el('tr', {},
          td(t.assinante), td(t.perfil),
          td(el('div', {}, el('strong', {}, t.o_que), el('div', { class: 'mini apagado' }, t.tipo === 'canal' ? 'ao vivo' : 'sob demanda'))),
          td(t.dispositivo ?? '—'), td(hora(t.iniciada_em)), td(duracao(t.segundos), true))),
        'Ninguém assistindo neste instante.'));
  }, 10_000);
}

// ---------------------------------------------------------------- Canais

async function telaCanais(c) {
  const { canais, relay_ligado: relayLigado } = await api.get('/admin/canais');
  const planos = usuario.perfil === 'admin' ? (await api.get('/admin/planos')).planos : [];

  const formCanal = (canal = null) => modal(canal ? `Canal ${canal.nome}` : 'Novo canal', (fechar) => {
    let logoId = canal?.logo_midia_id ?? null;
    const campoHls = campo('Endereço do sinal (.m3u8)', { name: 'url_hls', value: canal?.url_hls ?? '', placeholder: 'https://origem.emissora.com.br/canal/index.m3u8' },
      'Lista HLS que a emissora (ou a afiliada) fornece por contrato, ou o sinal do seu encoder. Deixe em branco enquanto o sinal não chega: o canal fica cadastrado e desligado.');
    const campoEmbed = campo('Endereço do player oficial da emissora', { name: 'url_embed', value: canal?.url_embed ?? '', placeholder: 'https://www.youtube.com/watch?v=… (transmissão ao vivo do canal verificado)' },
      'Cole o endereço da transmissão ao vivo oficial e pública da emissora. A PLAY TECH VIP abre o player dela, com os anúncios dela — não há transmissão.');
    const trocarFonte = (fonte) => {
      campoHls.classList.toggle('oculto', fonte !== 'hls');
      campoEmbed.classList.toggle('oculto', fonte !== 'embed');
    };
    const previa = el('img', { class: 'prev-arte deitada', src: arte(logoId) ?? '', alt: '', style: logoId ? '' : 'display:none' });
    const entradaLogo = el('input', { type: 'file', accept: 'image/*' });
    entradaLogo.addEventListener('change', async () => {
      if (!entradaLogo.files[0]) return;
      try {
        const m = await enviarImagem(entradaLogo.files[0]);
        logoId = m.id;
        previa.src = arte(m.id);
        previa.style.display = '';
        toast('Logo enviada.');
      } catch (err) { toast(err.message, true); }
    });

    const f = el('form', { class: 'form' },
      el('div', { class: 'duas' },
        campo('Nome do canal', { name: 'nome', required: true, maxlength: 80, value: canal?.nome ?? '' }),
        campo('Número', { name: 'numero', type: 'number', required: true, min: 1, max: 9999, value: canal?.numero ?? '' })),
      el('div', { class: 'duas' },
        escolha('Categoria', 'categoria', Object.entries(CATEGORIAS_CANAL), canal?.categoria ?? 'aberta'),
        campo('Região (opcional)', { name: 'regiao', maxlength: 60, value: canal?.regiao ?? '' })),
      escolha('Como este canal chega', 'fonte', [
        ['hls', 'Sinal próprio ou contratado (.m3u8) — tocamos no nosso player'],
        ['embed', 'Player oficial da emissora — abrimos o player dela, sem transmitir'],
      ], canal?.fonte ?? 'hls', { onchange: (e) => trocarFonte(e.target.value) }),
      campoHls,
      campoEmbed,
      area('Observação da operação (de quem pedir o sinal, contrato, contato da afiliada)', { name: 'observacao', maxlength: 1000, rows: 2 }),
      el('div', { class: 'duas' },
        escolha('Classificação', 'classificacao', CLASSIFICACOES_OPCOES, canal?.classificacao ?? 0),
        escolha('Plano mínimo', 'plano_minimo_id', [['', 'Todos os planos'], ...planos.map((p) => [p.id, p.nome])], canal?.plano_minimo_id ?? '')),
      area('Descrição', { name: 'descricao', maxlength: 500, rows: 2 }, canal?.descricao ?? ''),
      el('label', { class: 'campo' }, 'Logo do canal', entradaLogo),
      previa,
      el('div', { class: 'duas' },
        caixaSim('Transmitir pelos nossos servidores (recomendado)', 'relay', canal ? Boolean(canal.relay) : true),
        caixaSim('Canal no ar para os assinantes', 'ativo', canal ? Boolean(canal.ativo) : true)),
      campo('Ordem na lista', { name: 'ordem', type: 'number', min: 0, max: 9999, value: canal?.ordem ?? 0 }),
      !relayLigado ? el('div', { class: 'aviso atencao' }, 'A transmissão pelos nossos servidores está desligada no servidor (TV_RELAY=0): os canais tocam direto na origem.') : null,
      el('div', { class: 'linha fim' },
        el('button', { type: 'button', class: 'btn vazio', onclick: () => fechar() }, 'Cancelar'),
        el('button', { class: 'btn primario' }, canal ? 'Salvar canal' : 'Criar canal')));

    f.querySelector('textarea[name=descricao]').value = canal?.descricao ?? '';
    f.querySelector('textarea[name=observacao]').value = canal?.observacao ?? '';
    trocarFonte(canal?.fonte ?? 'hls');
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const d = lerForm(f);
      const corpo = {
        nome: d.nome,
        numero: Number(d.numero),
        categoria: d.categoria,
        regiao: d.regiao || null,
        fonte: d.fonte,
        url_hls: d.url_hls || null,
        url_embed: d.url_embed || null,
        observacao: d.observacao || null,
        classificacao: Number(d.classificacao),
        plano_minimo_id: d.plano_minimo_id ? Number(d.plano_minimo_id) : null,
        descricao: d.descricao || null,
        logo_midia_id: logoId,
        relay: Boolean(d.relay),
        ativo: Boolean(d.ativo),
        ordem: Number(d.ordem || 0),
      };
      acao(f.querySelector('button.primario'), async () => {
        if (canal) await api.patch(`/admin/canais/${canal.id}`, corpo);
        else await api.post('/admin/canais', corpo);
        fechar('salvo');
      });
    });
    return f;
  });

  const linhas = canais.map((x) => el('tr', {},
    td(el('div', { class: 'linha firme', style: 'gap:9px' },
      el('span', { class: 'logo', style: 'width:34px;height:34px;border-radius:7px;overflow:hidden;display:grid;place-items:center;background:var(--bg-2)' },
        arte(x.logo_midia_id) ? el('img', { src: arte(x.logo_midia_id), alt: '', style: 'width:100%;height:100%;object-fit:contain;padding:3px' }) : String(x.numero)),
      el('div', {}, el('strong', {}, x.nome), el('div', { class: 'mini apagado' }, `canal ${x.numero} · ${CATEGORIAS_CANAL[x.categoria] ?? x.categoria}`)))),
    td(el('div', {}, el('div', { class: 'linha', style: 'gap:5px' },
      x.ativo ? el('span', { class: 'etiqueta ok' }, 'no ar') : el('span', { class: 'etiqueta' }, 'fora'),
      // Só faz sentido falar em transmissão depois que o sinal existe.
      (x.fonte === 'embed' ? !x.url_embed : !x.url_hls)
        ? el('span', { class: 'etiqueta aviso' }, 'aguardando sinal')
        : x.fonte === 'embed' ? el('span', { class: 'etiqueta info', title: 'Abre o player oficial da emissora' }, 'player da emissora')
          : x.relay ? el('span', { class: 'etiqueta info' }, 'nossa transmissão') : el('span', { class: 'etiqueta' }, 'direto'),
      x.sinal_status === 'falha' ? el('span', { class: 'etiqueta erro', title: x.sinal_detalhe ?? '' }, 'sinal com falha')
        : x.sinal_status === 'ok' ? el('span', { class: 'etiqueta ok' }, 'sinal ok') : null),
    el('div', { class: 'mini apagado', style: 'margin-top:3px' }, x.sinal_em ? `conferido ${dataHora(x.sinal_em)}` : 'sinal ainda não conferido'))),
    td(el('div', {}, el('strong', { class: 'pequeno' }, x.agora?.titulo ?? '—'),
      el('div', { class: 'mini apagado' }, `${x.programas_futuros} programa(s) na grade`),
      x.observacao ? el('div', { class: 'mini apagado duas-linhas', style: 'margin-top:4px;max-width:420px' }, x.observacao) : null)),
    td(el('div', { class: 'linha', style: 'gap:6px' },
      botao('Testar sinal', 'vazio', async () => {
        const r = await api.post(`/admin/canais/${x.id}/testar`);
        toast(r.status === 'ok' ? `${x.nome}: sinal respondendo.` : `${x.nome}: ${r.detalhe}`, r.status !== 'ok');
        ir('canais');
      }),
      botao('Prévia', 'vazio', async () => {
        const r = await api.get(`/admin/canais/${x.id}/previa`);
        previaCanal(x, r);
      }),
      botao('Editar', 'vazio', async () => { if (await formCanal(x)) ir('canais'); }),
      botao('Grade', 'vazio', async () => ir('grade', x.id)),
      usuario.perfil === 'admin' ? botao('Excluir', 'perigo', async () => {
        if (!await confirmar('Excluir canal', `Apagar "${x.nome}" e toda a grade dele?`, 'Excluir', true)) return;
        await api.del(`/admin/canais/${x.id}`);
        toast('Canal excluído.');
        ir('canais');
      }) : null), true)));

  limpar(c, cabeca('Canais ao vivo',
    botao('Importar TV aberta', 'vazio', async () => {
      const r = await api.post('/admin/canais/importar-abertos');
      await modal('TV aberta cadastrada', (fechar) => [
        el('p', {}, `${r.criados} canal(is) cadastrado(s)${r.ja_existiam ? ` · ${r.ja_existiam} já existia(m)` : ''}.`),
        el('div', { class: 'aviso atencao' }, r.proximo_passo),
        el('p', { class: 'pequeno mudo' }, r.aviso),
        el('div', { class: 'linha fim' }, el('button', { class: 'btn primario', onclick: () => fechar(true) }, 'Entendi')),
      ]);
      ir('canais');
    }, 'tv'),
    botao('Buscar canais (lista pública)', 'vazio', async () => {
      if (await escolherDaListaPublica()) ir('canais');
    }, 'busca'),
    botao('Buscar logos das emissoras', 'vazio', async () => {
      const forcar = await modal('Logos das emissoras', (fechar) => [
        el('p', { class: 'mudo' }, 'A busca usa a lista pública de canais (iptv-org), que traz o logo oficial da maioria das emissoras. Quem tiver o material da emissora pode enviar a imagem no cadastro de cada canal.'),
        el('div', { class: 'linha fim', style: 'margin-top:14px' },
          el('button', { class: 'btn vazio', onclick: () => fechar('cancelar') }, 'Cancelar'),
          el('button', { class: 'btn vazio', onclick: () => fechar(false) }, 'Só os que não têm'),
          el('button', { class: 'btn primario', onclick: () => fechar(true) }, 'Substituir todos')),
      ]);
      if (forcar === 'cancelar' || forcar === null || forcar === undefined) return;
      toast('Procurando os logos na lista pública…');
      const r = await api.post('/admin/canais/logos', { forcar });
      await modal('Logos das emissoras', (fechar) => [
        el('p', {}, `${r.com_logo.length} canal(is) com logo novo.`),
        r.com_logo.length ? el('div', { class: 'coluna', style: 'gap:4px;margin:10px 0' },
          r.com_logo.slice(0, 20).map((x) => el('div', { class: 'mini' }, `${x.canal} — ${x.origem}`))) : null,
        r.sem_logo.length ? el('div', { class: 'aviso atencao' },
          `Sem logo na lista pública: ${r.sem_logo.join(', ')}. Envie a imagem oficial da emissora no cadastro de cada um.`) : null,
        r.falharam.length ? el('div', { class: 'aviso erro' },
          r.falharam.map((x) => `${x.canal}: ${x.erro}`).join(' · ')) : null,
        el('div', { class: 'linha fim' }, el('button', { class: 'btn primario', onclick: () => fechar(true) }, 'Fechar')),
      ]);
      ir('canais');
    }, 'imagem'),
    botao('Testar todos os sinais', 'vazio', async () => {
      toast('Testando os sinais…');
      for (const x of canais) await api.post(`/admin/canais/${x.id}/testar`);
      ir('canais');
    }),
    botao('Novo canal', 'primario', async () => { if (await formCanal()) ir('canais'); }, 'mais')),
  tabela(['Canal', 'Situação', 'No ar agora', '>Ações'], linhas, 'Nenhum canal cadastrado. Comece pelo botão "Novo canal".'));
}

/**
 * Catálogo aberto de canais (projeto iptv-org): a operação busca pelo nome, marca o que
 * interessa e importa. Entram desligados, para testar o sinal antes de pôr no ar.
 */
function escolherDaListaPublica() {
  return modal('Buscar canais em lista pública', async (fechar) => {
    const escolhidos = new Set();
    const lista = el('div', { class: 'coluna', style: 'max-height:46vh;overflow:auto;gap:6px' }, el('p', { class: 'mudo' }, 'Carregando a lista…'));
    const busca = el('input', { type: 'search', placeholder: 'Filtrar por nome' });
    const contador = el('span', { class: 'pequeno mudo' }, '');
    const importar = el('button', { class: 'btn primario', disabled: true }, 'Importar selecionados');

    let canais = [];
    const pintar = () => {
      const termo = busca.value.trim().toLowerCase();
      const visiveis = canais.filter((c) => !termo || c.nome.toLowerCase().includes(termo));
      limpar(lista, visiveis.length ? visiveis.slice(0, 200).map((c) => {
        const caixa = el('input', { type: 'checkbox', disabled: c.ja_cadastrado, ...(escolhidos.has(c.id) ? { checked: true } : {}) });
        caixa.addEventListener('change', () => {
          if (caixa.checked) escolhidos.add(c.id); else escolhidos.delete(c.id);
          contador.textContent = `${escolhidos.size} selecionado(s)`;
          importar.disabled = escolhidos.size === 0;
        });
        return el('label', { class: 'cartao fundo linha', style: 'gap:10px;cursor:pointer;padding:10px' },
          caixa,
          el('div', { style: 'flex:1;min-width:0' },
            el('div', { class: 'linha firme', style: 'gap:6px' },
              el('strong', { class: 'cortar' }, c.nome),
              c.qualidade ? el('span', { class: 'etiqueta' }, c.qualidade) : null,
              el('span', { class: 'etiqueta info' }, CATEGORIAS_CANAL[c.categoria] ?? c.categoria),
              c.ja_cadastrado ? el('span', { class: 'etiqueta ok' }, 'já cadastrado') : null,
              (c.avisos ?? []).includes('Not 24/7') ? el('span', { class: 'etiqueta aviso' }, 'não é 24h') : null),
            el('div', { class: 'mini apagado cortar' }, c.url)));
      }) : el('p', { class: 'mudo' }, 'Nenhum canal com esse nome.'));
    };
    busca.addEventListener('input', pintar);

    importar.addEventListener('click', () => acao(importar, async () => {
      const r = await api.post('/admin/canais/importar-lista-publica', { ids: [...escolhidos] });
      toast(`${r.criados} canal(is) importado(s).`);
      await modal('Canais importados', (f2) => [
        el('div', { class: 'aviso atencao' }, r.proximo_passo),
        el('div', { class: 'linha fim' }, el('button', { class: 'btn primario', onclick: () => f2(true) }, 'Entendi')),
      ]);
      fechar('importado');
    }));

    api.get('/admin/canais/lista-publica?pais=BR&limite=400').then((r) => {
      canais = r.canais;
      pintar();
    }).catch((err) => limpar(lista, el('div', { class: 'aviso erro' }, err.message)));

    return [
      el('p', { class: 'mudo' }, 'Catálogo aberto de canais (projeto iptv-org), já com o melhor sinal de cada um. '
        + 'Confira o direito de transmitir cada canal antes de ligar: a lista é pública, mas a decisão é de vocês.'),
      el('label', { class: 'campo' }, 'Buscar', busca),
      lista,
      el('div', { class: 'linha entre', style: 'margin-top:12px' },
        contador,
        el('div', { class: 'linha' }, el('button', { class: 'btn vazio', onclick: () => fechar() }, 'Cancelar'), importar)),
    ];
  }, { largo: true });
}

/** Prévia do sinal dentro do painel (não gasta tela do plano). */
function previaCanal(canal, fonte) {
  if (fonte.tipo === 'embed') {
    return modal(`Prévia · ${canal.nome}`, () => [
      el('iframe', {
        src: fonte.url,
        allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen',
        allowfullscreen: true,
        style: 'width:100%;aspect-ratio:16/9;border:0;border-radius:12px;background:#000',
        title: canal.nome,
      }),
      el('p', { class: 'pequeno mudo', style: 'margin-top:10px' }, 'Este canal abre o player oficial da emissora. A PLAY TECH VIP não transmite o sinal: a transmissão, e os anúncios, são da emissora.'),
    ], { largo: true });
  }
  return modal(`Prévia · ${canal.nome}`, () => {
    const video = el('video', { controls: true, autoplay: true, playsinline: true, style: 'width:100%;border-radius:12px;background:#000;aspect-ratio:16/9' });
    const aviso = el('div', { class: 'pequeno mudo' }, fonte.nossos_servidores ? 'Sinal passando pelos servidores da PLAY.' : 'Tocando direto na origem da emissora.');
    (async () => {
      if (video.canPlayType('application/vnd.apple.mpegurl')) { video.src = fonte.url; return; }
      try {
        const mod = await import(`${BASE}/vendor/hls/hls.mjs`);
        const Hls = mod.default ?? mod.Hls;
        if (!Hls?.isSupported()) { video.src = fonte.url; return; }
        const hls = new Hls({ enableWorker: true });
        hls.on(Hls.Events.ERROR, (_e, info) => { if (info.fatal) limpar(aviso, el('span', { class: 'etiqueta erro' }, `Falha: ${info.details}`)); });
        hls.loadSource(fonte.url);
        hls.attachMedia(video);
      } catch { video.src = fonte.url; }
    })();
    return [video, el('div', { class: 'linha entre', style: 'margin-top:10px' }, aviso,
      el('code', { class: 'mini apagado cortar', style: 'max-width:50%' }, canal.url_hls ?? ''))];
  }, { largo: true });
}

// ---------------------------------------------------------------- Grade (EPG)

async function telaGrade(c, canalIdPedido) {
  const { canais } = await api.get('/admin/canais');
  if (!canais.length) return limpar(c, cabeca('Grade de programação'), el('div', { class: 'cartao vazio' }, 'Cadastre um canal antes de montar a grade.'));
  let canalId = canalIdPedido ?? canais[0].id;
  const lista = el('div', { class: 'coluna' });

  const formPrograma = (canal, programa = null) => modal(programa ? 'Editar programa' : `Novo programa · ${canal.nome}`, (fechar) => {
    const paraCampo = (iso) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
    const f = el('form', { class: 'form' },
      campo('Nome do programa', { name: 'titulo', required: true, maxlength: 200, value: programa?.titulo ?? '' }),
      campo('Subtítulo (episódio, capítulo)', { name: 'subtitulo', maxlength: 200, value: programa?.subtitulo ?? '' }),
      el('div', { class: 'duas' },
        campo('Início', { name: 'inicio', type: 'datetime-local', required: true, value: paraCampo(programa?.inicio) }),
        campo('Fim', { name: 'fim', type: 'datetime-local', required: true, value: paraCampo(programa?.fim) })),
      el('div', { class: 'duas' },
        escolha('Classificação', 'classificacao', CLASSIFICACOES_OPCOES, programa?.classificacao ?? 0),
        campo('Categoria', { name: 'categoria', maxlength: 60, value: programa?.categoria ?? '' })),
      area('Descrição', { name: 'descricao', rows: 3, maxlength: 2000 }),
      caixaSim('Transmissão ao vivo', 'ao_vivo', Boolean(programa?.ao_vivo)),
      el('div', { class: 'linha entre' },
        programa ? botao('Excluir', 'perigo', async () => { await api.del(`/admin/programas/${programa.id}`); fechar('apagado'); }) : el('span'),
        el('div', { class: 'linha' },
          el('button', { type: 'button', class: 'btn vazio', onclick: () => fechar() }, 'Cancelar'),
          el('button', { class: 'btn primario' }, 'Salvar'))));
    f.querySelector('textarea[name=descricao]').value = programa?.descricao ?? '';
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const d = lerForm(f);
      const corpo = {
        titulo: d.titulo,
        subtitulo: d.subtitulo || null,
        descricao: d.descricao || null,
        inicio: new Date(d.inicio).toISOString(),
        fim: new Date(d.fim).toISOString(),
        categoria: d.categoria || null,
        classificacao: Number(d.classificacao),
        ao_vivo: Boolean(d.ao_vivo),
      };
      acao(f.querySelector('button.primario'), async () => {
        if (programa) await api.patch(`/admin/programas/${programa.id}`, corpo);
        else await api.post(`/admin/canais/${canal.id}/programas`, corpo);
        fechar('salvo');
      });
    });
    return f;
  });

  const importarXmltv = (canal) => modal('Importar grade (XMLTV)', (fechar) => {
    const entrada = el('input', { type: 'file', accept: '.xml,.xmltv,text/xml,application/xml' });
    const soEsteCanal = el('input', { type: 'checkbox', checked: true });
    const b = el('button', { class: 'btn primario' }, 'Importar');
    b.addEventListener('click', () => acao(b, async () => {
      if (!entrada.files[0]) throw new Error('Escolha o arquivo XMLTV.');
      const xml = await lerTexto(entrada.files[0]);
      const r = await api.post(`/admin/epg/xmltv${soEsteCanal.checked ? `?canal_id=${canal.id}` : ''}`, xml, { tipo: 'application/xml' });
      toast(`${r.importados} programa(s) importados em ${r.canais} canal(is).`);
      fechar('importado');
    }));
    return [
      el('p', { class: 'mudo' }, 'XMLTV é o formato que as emissoras e os agregadores publicam a programação. O arquivo substitui a grade do período que ele cobre.'),
      el('label', { class: 'campo' }, 'Arquivo XMLTV', entrada),
      el('label', { class: 'campo linha-campo' }, soEsteCanal, `Tudo para o canal ${canal.nome} (desmarque se o arquivo tiver vários canais identificados pelo número ou pelo endereço do canal)`),
      el('div', { class: 'linha fim' }, el('button', { class: 'btn vazio', onclick: () => fechar() }, 'Cancelar'), b),
    ];
  });

  const desenhar = async () => {
    const canal = canais.find((x) => x.id === Number(canalId)) ?? canais[0];
    const { programas } = await api.get(`/admin/canais/${canal.id}/programas`);
    const porDia = programas.reduce((mapa, p) => {
      const dia = new Date(p.inicio).toLocaleDateString('en-CA');
      (mapa[dia] ??= []).push(p);
      return mapa;
    }, {});
    limpar(lista, Object.keys(porDia).length
      ? Object.entries(porDia).map(([dia, itens]) => el('div', { class: 'cartao' },
        el('h3', {}, dataBR(dia)),
        el('div', { class: 'coluna', style: 'gap:6px' }, itens.map((p) => {
          const noAr = p.andamento !== null && p.andamento !== undefined;
          return el('button', {
            class: 'cartao fundo linha entre',
            style: `text-align:left;cursor:pointer;${noAr ? 'border-color:var(--vivo)' : ''}`,
            onclick: async () => { if (await formPrograma(canal, p)) desenhar(); },
          },
          el('div', { class: 'linha firme', style: 'gap:12px;min-width:0' },
            el('strong', { class: 'num', style: 'min-width:104px' }, `${hora(p.inicio)}–${hora(p.fim)}`),
            el('div', { style: 'min-width:0' }, el('div', { class: 'cortar' }, p.titulo),
              p.subtitulo ? el('div', { class: 'mini apagado cortar' }, p.subtitulo) : null)),
          el('div', { class: 'linha', style: 'gap:6px' },
            noAr ? el('span', { class: 'etiqueta vivo' }, 'NO AR') : null,
            p.ao_vivo ? el('span', { class: 'etiqueta info' }, 'ao vivo') : null,
            etiquetaIdade(p.classificacao)));
        }))))
      : el('div', { class: 'cartao vazio' }, 'Sem grade publicada para este canal. Cadastre na mão ou importe um XMLTV.'));
  };

  const seletor = el('select', { onchange: (e) => { canalId = Number(e.target.value); desenhar(); } },
    canais.map((x) => el('option', { value: x.id, ...(x.id === Number(canalId) ? { selected: true } : {}) }, `${x.numero} · ${x.nome}`)));

  limpar(c, cabeca('Grade de programação',
    botao('Importar XMLTV', 'vazio', async () => { if (await importarXmltv(canais.find((x) => x.id === Number(canalId)))) desenhar(); }),
    botao('Limpar grade antiga', 'vazio', async () => {
      const r = await api.post('/admin/epg/limpar', { dias: 7 });
      toast(`${r.removidos} programa(s) antigos removidos.`);
      desenhar();
    }),
    botao('Novo programa', 'primario', async () => { if (await formPrograma(canais.find((x) => x.id === Number(canalId)))) desenhar(); }, 'mais')),
  el('div', { class: 'filtros' }, el('label', { class: 'campo' }, 'Canal', seletor)),
  lista);
  return desenhar();
}

// ---------------------------------------------------------------- Destaques e fileiras

async function telaHome(c) {
  const [{ destaques, fileiras }, { titulos }, { canais }] = await Promise.all([
    api.get('/admin/home'), api.get('/admin/titulos'), api.get('/admin/canais'),
  ]);
  const generos = (await api.get('/tv/generos').catch(() => ({ generos: [] }))).generos ?? [];

  const formDestaque = (d = null) => modal(d ? 'Editar destaque' : 'Novo destaque', (fechar) => {
    const f = el('form', { class: 'form' },
      d ? null : escolha('Título do catálogo', 'titulo_id', [['', '— nenhum —'], ...titulos.map((t) => [t.id, `${t.nome} (${t.tipo})`])], ''),
      d ? null : escolha('…ou canal ao vivo', 'canal_id', [['', '— nenhum —'], ...canais.map((x) => [x.id, `${x.numero} · ${x.nome}`])], ''),
      campo('Chamada (linha de cima)', { name: 'chamada', maxlength: 120, value: d?.chamada ?? '', placeholder: 'Estreia da semana' }),
      area('Descrição', { name: 'descricao', rows: 2, maxlength: 500 }),
      el('div', { class: 'duas' },
        campo('Ordem', { name: 'ordem', type: 'number', min: 0, max: 999, value: d?.ordem ?? 1 }),
        caixaSim('Ativo', 'ativo', d ? Boolean(d.ativo) : true)),
      el('div', { class: 'linha fim' },
        el('button', { type: 'button', class: 'btn vazio', onclick: () => fechar() }, 'Cancelar'),
        el('button', { class: 'btn primario' }, 'Salvar')));
    f.querySelector('textarea[name=descricao]').value = d?.descricao ?? '';
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const dados = lerForm(f);
      const corpo = {
        chamada: dados.chamada || null,
        descricao: dados.descricao || null,
        ordem: Number(dados.ordem || 0),
        ativo: Boolean(dados.ativo),
        ...(d ? {} : { titulo_id: dados.titulo_id ? Number(dados.titulo_id) : null, canal_id: dados.canal_id ? Number(dados.canal_id) : null }),
      };
      acao(f.querySelector('button.primario'), async () => {
        if (d) await api.patch(`/admin/destaques/${d.id}`, corpo);
        else await api.post('/admin/destaques', corpo);
        fechar('salvo');
      });
    });
    return f;
  });

  const formFileira = (fl = null) => modal(fl ? `Fileira ${fl.nome}` : 'Nova fileira', (fechar) => {
    const f = el('form', { class: 'form' },
      campo('Nome na home', { name: 'nome', required: true, maxlength: 80, value: fl?.nome ?? '' }),
      escolha('O que mostra', 'tipo', [['em_alta', 'Em alta (mais assistidos)'], ['novidades', 'Novidades'], ['originais', 'Originais PLAY TECH VIP'],
        ['filmes', 'Filmes'], ['series', 'Séries'], ['canais', 'Canais ao vivo'], ['genero', 'Um gênero'], ['manual', 'Escolha manual']], fl?.tipo ?? 'em_alta'),
      escolha('Gênero (só para o tipo "um gênero")', 'genero_id', [['', '—'], ...generos.map((g) => [g.id, g.nome])], fl?.genero_id ?? ''),
      el('div', { class: 'duas' },
        campo('Quantos itens', { name: 'limite', type: 'number', min: 1, max: 60, value: fl?.limite ?? 20 }),
        campo('Ordem', { name: 'ordem', type: 'number', min: 0, max: 999, value: fl?.ordem ?? 1 })),
      caixaSim('Fileira ativa', 'ativa', fl ? Boolean(fl.ativa) : true),
      el('div', { class: 'linha fim' },
        el('button', { type: 'button', class: 'btn vazio', onclick: () => fechar() }, 'Cancelar'),
        el('button', { class: 'btn primario' }, 'Salvar')));
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const d = lerForm(f);
      const corpo = { nome: d.nome, tipo: d.tipo, genero_id: d.genero_id ? Number(d.genero_id) : null, limite: Number(d.limite), ordem: Number(d.ordem), ativa: Boolean(d.ativa) };
      acao(f.querySelector('button.primario'), async () => {
        if (fl) await api.patch(`/admin/fileiras/${fl.id}`, corpo);
        else await api.post('/admin/fileiras', corpo);
        fechar('salvo');
      });
    });
    return f;
  });

  /** Escolha manual dos títulos de uma fileira. */
  const itensDaFileira = (fl) => modal(`Itens de "${fl.nome}"`, async (fechar) => {
    const atual = (await api.get(`/admin/fileiras/${fl.id}/itens`)).itens.map((x) => x.titulo_id);
    const escolhidos = new Set(atual);
    const lista = el('div', { class: 'coluna', style: 'max-height:50vh;overflow:auto' },
      titulos.map((t) => el('label', { class: 'cartao fundo linha', style: 'gap:10px;cursor:pointer' },
        el('input', { type: 'checkbox', ...(escolhidos.has(t.id) ? { checked: true } : {}), onchange: (e) => (e.target.checked ? escolhidos.add(t.id) : escolhidos.delete(t.id)) }),
        el('div', {}, el('strong', {}, t.nome), el('div', { class: 'mini apagado' }, `${t.tipo} · ${t.situacao}`)))));
    const b = el('button', { class: 'btn primario' }, 'Salvar itens');
    b.addEventListener('click', () => acao(b, async () => {
      await api.put(`/admin/fileiras/${fl.id}/itens`, { titulos: [...escolhidos] });
      fechar('salvo');
    }));
    return [lista, el('div', { class: 'linha fim', style: 'margin-top:12px' }, el('button', { class: 'btn vazio', onclick: () => fechar() }, 'Cancelar'), b)];
  }, { largo: true });

  limpar(c, cabeca('Destaques e home',
    botao('Nova fileira', 'vazio', async () => { if (await formFileira()) ir('home'); }),
    botao('Novo destaque', 'primario', async () => { if (await formDestaque()) ir('home'); }, 'mais')),
  el('h2', {}, 'Destaques do topo'),
  tabela(['Ordem', 'O que mostra', 'Chamada', 'Situação', '>Ações'], destaques.map((d) => el('tr', {},
    td(d.ordem),
    td(d.titulo_nome ? el('span', {}, el('strong', {}, d.titulo_nome), el('div', { class: 'mini apagado' }, 'título do catálogo'))
      : el('span', {}, el('strong', {}, d.canal_nome), el('div', { class: 'mini apagado' }, 'canal ao vivo'))),
    td(d.chamada ?? '—'),
    td(d.ativo ? el('span', { class: 'etiqueta ok' }, 'ativo') : el('span', { class: 'etiqueta' }, 'desligado')),
    td(el('div', { class: 'linha', style: 'gap:6px' },
      botao('Editar', 'vazio', async () => { if (await formDestaque(d)) ir('home'); }),
      botao('Excluir', 'perigo', async () => { await api.del(`/admin/destaques/${d.id}`); ir('home'); })), true))),
  'Nenhum destaque: a home abre direto nas fileiras.'),
  el('h2', { style: 'margin-top:26px' }, 'Fileiras da home'),
  tabela(['Ordem', 'Nome', 'Conteúdo', 'Itens', 'Situação', '>Ações'], fileiras.map((fl) => el('tr', {},
    td(fl.ordem), td(el('strong', {}, fl.nome)),
    td(fl.tipo === 'genero' ? `gênero · ${fl.genero_nome ?? '—'}` : fl.tipo.replace('_', ' ')),
    td(fl.tipo === 'manual' ? `${fl.itens_n} escolhidos` : `até ${fl.limite}`),
    td(fl.ativa ? el('span', { class: 'etiqueta ok' }, 'ativa') : el('span', { class: 'etiqueta' }, 'desligada')),
    td(el('div', { class: 'linha', style: 'gap:6px' },
      fl.tipo === 'manual' ? botao('Escolher itens', 'vazio', async () => { if (await itensDaFileira(fl)) ir('home'); }) : null,
      botao('Editar', 'vazio', async () => { if (await formFileira(fl)) ir('home'); }),
      botao('Excluir', 'perigo', async () => { await api.del(`/admin/fileiras/${fl.id}`); ir('home'); })), true)))));
}

iniciar();
