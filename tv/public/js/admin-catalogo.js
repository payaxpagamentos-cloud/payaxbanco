import { api, arte } from './api.js';
import { el, limpar, icone, toast, acao, modal, lerForm, duracao, dataHora, confirmar, etiquetaIdade, dataBR, QUALIDADES, LINHAS_QUALIDADE } from './ui.js';
import { cabeca, indicador, tabela, td, botao, campo, area, escolha, caixaSim, CLASSIFICACOES_OPCOES } from './admin-ui.js';
import { enviarVideo, enviarImagem, enviarLegenda } from './envio.js';

/**
 * Catálogo sob demanda: cadastro do título, envio dos arquivos (em pedaços),
 * temporadas, episódios, legendas e publicação.
 */

const SITUACOES = { rascunho: ['rascunho', ''], publicado: ['publicado', 'ok'], arquivado: ['arquivado', 'aviso'] };
const etiquetaSituacao = (s) => el('span', { class: `etiqueta ${SITUACOES[s]?.[1] ?? ''}` }, SITUACOES[s]?.[0] ?? s);

/** Campo de envio de vídeo com barra de progresso (o arquivo vai em pedaços). */
function campoVideo(rotulo, { midiaId = null, dica = null, aoEnviar }) {
  const barra = el('div', { class: 'barra-progresso oculto', style: 'margin-top:8px' }, el('span', { style: 'width:0' }));
  const estado = el('div', { class: 'mini apagado' }, midiaId ? `arquivo #${midiaId} no acervo` : 'nenhum arquivo enviado');
  const entrada = el('input', { type: 'file', accept: 'video/*' });
  const previa = el('button', {
    class: `btn pequeno vazio${midiaId ? '' : ' oculto'}`,
    onclick: async (e) => {
      e.preventDefault();
      await acao(e.currentTarget, async () => {
        const r = await api.get(`/admin/midias/${midiaId}/previa`);
        modal('Prévia do vídeo', () => el('video', { src: r.url, controls: true, autoplay: true, style: 'width:100%;border-radius:12px;background:#000' }), { largo: true });
      });
    },
  }, icone('tocar'), 'Ver');

  entrada.addEventListener('change', async () => {
    const arquivo = entrada.files[0];
    if (!arquivo) return;
    barra.classList.remove('oculto');
    entrada.disabled = true;
    estado.textContent = 'enviando…';
    try {
      const m = await enviarVideo(arquivo, {
        aoProgresso: (p, enviados, total) => {
          barra.firstChild.style.width = `${p}%`;
          estado.textContent = `enviando ${p}% (${(enviados / 1048576).toFixed(1)} de ${(total / 1048576).toFixed(1)} MB)`;
        },
      });
      midiaId = m.id;
      estado.textContent = `pronto: ${duracao(m.duracao_s)} · ${m.qualidade?.toUpperCase() ?? ''} · arquivo #${m.id}`;
      previa.classList.remove('oculto');
      await aoEnviar(m);
      toast('Vídeo enviado e ligado ao conteúdo.');
    } catch (err) {
      estado.textContent = err.message;
      toast(err.message, true);
    } finally {
      entrada.disabled = false;
      barra.classList.add('oculto');
    }
  });

  return el('div', { class: 'cartao fundo' },
    el('div', { class: 'linha entre' }, el('strong', {}, rotulo), previa),
    dica ? el('div', { class: 'mini apagado', style: 'margin:4px 0 8px' }, dica) : null,
    entrada, barra, estado);
}

/** Campo de envio de arte com prévia. */
function campoArte(rotulo, { midiaId = null, deitada = false, aoEnviar }) {
  const previa = el('img', { class: `prev-arte${deitada ? ' deitada' : ''}`, src: arte(midiaId) ?? '', alt: '', style: midiaId ? '' : 'display:none' });
  const entrada = el('input', { type: 'file', accept: 'image/*' });
  entrada.addEventListener('change', async () => {
    if (!entrada.files[0]) return;
    entrada.disabled = true;
    try {
      const m = await enviarImagem(entrada.files[0]);
      previa.src = arte(m.id);
      previa.style.display = '';
      await aoEnviar(m);
      toast('Arte enviada.');
    } catch (err) { toast(err.message, true); } finally { entrada.disabled = false; }
  });
  return el('div', { class: 'cartao fundo' }, el('strong', {}, rotulo), el('div', { class: 'linha', style: 'margin-top:8px;align-items:flex-start' }, previa, entrada));
}

// ---------------------------------------------------------------- lista do catálogo

export async function telaCatalogo(c, { abrirTitulo }) {
  let filtros = { situacao: '', tipo: '', q: '' };
  const corpo = el('div');

  const formNovo = (generos) => modal('Novo título', (fechar) => {
    const escolhidos = new Set();
    const f = el('form', { class: 'form' },
      escolha('Tipo', 'tipo', [['filme', 'Filme'], ['serie', 'Série']], 'filme'),
      campo('Nome', { name: 'nome', required: true, maxlength: 160 }),
      area('Sinopse', { name: 'sinopse', rows: 3, maxlength: 4000 }),
      el('div', { class: 'tres' },
        campo('Ano', { name: 'ano', type: 'number', min: 1890, max: new Date().getFullYear() + 5 }),
        escolha('Classificação', 'classificacao', CLASSIFICACOES_OPCOES, 0),
        campo('País', { name: 'pais', value: 'Brasil', maxlength: 60 })),
      el('label', { class: 'campo' }, 'Gêneros', el('div', { class: 'linha' }, generos.map((g) => {
        const b = el('button', { type: 'button', class: 'btn pequeno vazio' }, g.nome);
        b.addEventListener('click', () => {
          if (escolhidos.has(g.id)) { escolhidos.delete(g.id); b.className = 'btn pequeno vazio'; } else { escolhidos.add(g.id); b.className = 'btn pequeno primario'; }
        });
        return b;
      }))),
      caixaSim('Produção original PLAY', 'original', false),
      el('div', { class: 'linha fim' },
        el('button', { type: 'button', class: 'btn vazio', onclick: () => fechar() }, 'Cancelar'),
        el('button', { class: 'btn primario' }, 'Criar e abrir')));
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const d = lerForm(f);
      acao(f.querySelector('button.primario'), async () => {
        const r = await api.post('/admin/titulos', {
          tipo: d.tipo,
          nome: d.nome,
          sinopse: d.sinopse || null,
          ano: d.ano ? Number(d.ano) : null,
          pais: d.pais || null,
          classificacao: Number(d.classificacao),
          original: Boolean(d.original),
          generos: [...escolhidos],
        });
        fechar(r.titulo.id);
      });
    });
    return f;
  });

  const carregar = async () => {
    const params = new URLSearchParams(Object.entries(filtros).filter(([, v]) => v));
    const { titulos, generos } = await api.get(`/admin/titulos?${params}`);
    const linhas = titulos.map((t) => el('tr', {},
      td(el('div', { class: 'linha firme', style: 'gap:10px' },
        el('div', { style: 'width:40px;height:60px;border-radius:7px;overflow:hidden;background:var(--bg-2);flex:none' },
          arte(t.capa) ? el('img', { src: arte(t.capa), alt: '', style: 'width:100%;height:100%;object-fit:cover' }) : null),
        el('div', { style: 'min-width:0' }, el('strong', { class: 'cortar' }, t.nome),
          el('div', { class: 'mini apagado' }, [t.tipo === 'filme' ? 'Filme' : 'Série', t.ano, t.generos].filter(Boolean).join(' · '))))),
      td(el('div', { class: 'linha', style: 'gap:5px' }, etiquetaSituacao(t.situacao), etiquetaIdade(t.classificacao),
        t.original ? el('span', { class: 'etiqueta ok' }, 'original') : null)),
      td(t.tipo === 'filme'
        ? (t.tem_video ? el('span', { class: 'etiqueta ok' }, 'vídeo pronto') : el('span', { class: 'etiqueta aviso' }, 'sem vídeo'))
        : el('span', {}, `${t.episodios_com_video}/${t.episodios_n} ep. com vídeo`)),
      td(dataHora(t.atualizado_em)),
      td(el('div', { class: 'linha', style: 'gap:6px' },
        botao('Abrir', 'vazio', async () => abrirTitulo(t.id)),
        t.situacao !== 'publicado'
          ? botao('Publicar', 'primario', async () => {
            await api.post(`/admin/titulos/${t.id}/situacao`, { situacao: 'publicado' });
            toast(`"${t.nome}" está no ar.`);
            carregar();
          })
          : botao('Tirar do ar', 'vazio', async () => {
            await api.post(`/admin/titulos/${t.id}/situacao`, { situacao: 'rascunho' });
            carregar();
          })), true)));

    limpar(corpo,
      el('div', { class: 'indicadores', style: 'margin-bottom:16px' },
        indicador('No ar', titulos.filter((t) => t.situacao === 'publicado').length, 'publicados', true),
        indicador('Rascunhos', titulos.filter((t) => t.situacao === 'rascunho').length, 'faltando vídeo ou capa'),
        indicador('Séries', titulos.filter((t) => t.tipo === 'serie').length),
        indicador('Filmes', titulos.filter((t) => t.tipo === 'filme').length)),
      tabela(['Título', 'Situação', 'Vídeo', 'Atualizado', '>Ações'], linhas, 'Nenhum título. Comece por "Novo título".'));
    return generos;
  };

  let generosCache = [];
  const busca = el('input', { type: 'search', placeholder: 'Buscar por nome', value: filtros.q });
  busca.addEventListener('input', () => { filtros.q = busca.value.trim(); carregar(); });

  limpar(c, cabeca('Catálogo',
    botao('Novo título', 'primario', async () => {
      const id = await formNovo(generosCache);
      if (id) abrirTitulo(id);
    }, 'mais')),
  el('div', { class: 'filtros' },
    escolha('Situação', 'situacao', [['', 'Todas'], ['publicado', 'Publicados'], ['rascunho', 'Rascunhos'], ['arquivado', 'Arquivados']], '',
      { onchange: (e) => { filtros.situacao = e.target.value; carregar(); } }),
    escolha('Tipo', 'tipo', [['', 'Todos'], ['filme', 'Filmes'], ['serie', 'Séries']], '',
      { onchange: (e) => { filtros.tipo = e.target.value; carregar(); } }),
    el('label', { class: 'campo' }, 'Buscar', busca)),
  corpo);
  generosCache = await carregar();
}

// ---------------------------------------------------------------- editor do título

export async function telaTituloEditor(c, id, { voltar }) {
  const dados = await api.get(`/admin/titulos/${id}`);
  const t = dados.titulo;
  const { generos } = await api.get('/admin/titulos');
  let aba = t.tipo === 'serie' ? 'episodios' : 'ficha';
  const painel = el('div');

  const recarregar = () => telaTituloEditor(c, id, { voltar });
  const salvar = async (corpo) => {
    await api.patch(`/admin/titulos/${id}`, corpo);
    toast('Salvo.');
  };

  // ---- Ficha
  const fichaEl = () => {
    const escolhidos = new Set(dados.generos);
    const f = el('form', { class: 'form' },
      el('div', { class: 'duas' },
        campo('Nome', { name: 'nome', required: true, maxlength: 160, value: t.nome }),
        campo('Nome original', { name: 'nome_original', maxlength: 160, value: t.nome_original ?? '' })),
      area('Sinopse', { name: 'sinopse', rows: 4, maxlength: 4000 }),
      el('div', { class: 'tres' },
        campo('Ano', { name: 'ano', type: 'number', min: 1890, max: new Date().getFullYear() + 5, value: t.ano ?? '' }),
        escolha('Classificação', 'classificacao', CLASSIFICACOES_OPCOES, t.classificacao),
        campo('País', { name: 'pais', maxlength: 60, value: t.pais ?? '' })),
      t.tipo === 'filme' ? campo('Duração (minutos)', { name: 'duracao_min', type: 'number', min: 0, max: 1440, value: t.duracao_s ? Math.round(t.duracao_s / 60) : '' }) : null,
      campo('Direção', { name: 'direcao', maxlength: 500, value: t.direcao ?? '' }),
      area('Elenco', { name: 'elenco', rows: 2, maxlength: 2000 }),
      campo('Estreia (opcional)', { name: 'estreia', type: 'date', value: t.estreia ?? '' }),
      el('label', { class: 'campo' }, 'Gêneros', el('div', { class: 'linha' }, generos.map((g) => {
        const ligado = escolhidos.has(g.id);
        const b = el('button', { type: 'button', class: `btn pequeno ${ligado ? 'primario' : 'vazio'}` }, g.nome);
        b.addEventListener('click', () => {
          if (escolhidos.has(g.id)) { escolhidos.delete(g.id); b.className = 'btn pequeno vazio'; } else { escolhidos.add(g.id); b.className = 'btn pequeno primario'; }
        });
        return b;
      }))),
      caixaSim('Produção original PLAY', 'original', Boolean(t.original)),
      el('div', { class: 'linha fim' }, el('button', { class: 'btn primario' }, 'Salvar ficha')));
    f.querySelector('textarea[name=sinopse]').value = t.sinopse ?? '';
    f.querySelector('textarea[name=elenco]').value = t.elenco ?? '';
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const d = lerForm(f);
      acao(f.querySelector('button'), async () => {
        await salvar({
          nome: d.nome,
          nome_original: d.nome_original || null,
          sinopse: d.sinopse || null,
          ano: d.ano ? Number(d.ano) : null,
          classificacao: Number(d.classificacao),
          pais: d.pais || null,
          ...(t.tipo === 'filme' ? { duracao_s: d.duracao_min ? Number(d.duracao_min) * 60 : null } : {}),
          direcao: d.direcao || null,
          elenco: d.elenco || null,
          estreia: d.estreia || null,
          original: Boolean(d.original),
          generos: [...escolhidos],
        });
        recarregar();
      });
    });
    return f;
  };

  // ---- Arquivos
  const arquivosEl = () => el('div', { class: 'coluna' },
    el('div', { class: 'grade', style: 'grid-template-columns:repeat(auto-fit,minmax(280px,1fr))' },
      campoArte('Capa (em pé, 2:3)', { midiaId: t.capa_midia_id, aoEnviar: (m) => salvar({ capa_midia_id: m.id }) }),
      campoArte('Banner (deitado, 16:9)', { midiaId: t.banner_midia_id, deitada: true, aoEnviar: (m) => salvar({ banner_midia_id: m.id }) })),
    t.tipo === 'filme'
      ? campoVideo('Vídeo do filme', { midiaId: t.video_midia_id, dica: 'MP4 (H.264/AAC), WebM ou MKV. O arquivo vai em pedaços e pode ser grande.', aoEnviar: (m) => salvar({ video_midia_id: m.id }) })
      : el('div', { class: 'aviso' }, 'Em séries, o vídeo é enviado em cada episódio, na aba "Temporadas e episódios".'),
    campoVideo('Trailer (opcional)', { midiaId: t.trailer_midia_id, aoEnviar: (m) => salvar({ trailer_midia_id: m.id }) }),
    versoesEl());

  /**
   * Versões em outras qualidades. O arquivo principal já entra como uma delas (pela altura);
   * aqui a operação sobe as demais, e o assinante escolhe no player até o limite do plano.
   */
  const versoesEl = () => {
    const lista = (dados.versoes ?? []).filter((v) => (t.tipo === 'filme' ? v.titulo_id === t.id : true));
    const escolhaQualidade = el('select', { class: 'entrada' },
      Object.entries(QUALIDADES).reverse().map(([valor, rotulo]) => el('option', { value: valor }, `${rotulo} (${LINHAS_QUALIDADE[valor] ?? ''})`)));
    const alvoEpisodio = t.tipo === 'filme' ? null : el('select', { class: 'entrada' },
      (dados.temporadas ?? []).flatMap((tm) => tm.episodios.map((ep) => el('option', { value: String(ep.id) }, `T${tm.numero} E${ep.numero} · ${ep.nome}`))));

    const envio = campoVideo('Enviar outra qualidade', {
      dica: 'O mesmo conteúdo, no mesmo tempo, em outra resolução. O player troca sem perder a cena.',
      aoEnviar: async (m) => {
        await api.post('/admin/versoes', {
          ...(t.tipo === 'filme' ? { titulo_id: t.id } : { episodio_id: Number(alvoEpisodio?.value) }),
          midia_id: m.id,
          qualidade: escolhaQualidade.value,
        });
        recarregar();
      },
    });

    return el('div', { class: 'cartao fundo' },
      el('strong', {}, 'Versões em 4K, Full HD, HD e SD'),
      el('div', { class: 'mini apagado', style: 'margin:4px 0 10px' },
        'O plano do assinante limita até onde ele pode subir: Essencial vai até HD, Família até Full HD, Cinema 4K até 4K.'),
      lista.length
        ? tabela(['Qualidade', 'Arquivo', 'Resolução', '>Ações'], lista.map((vz) => el('tr', {},
          td(el('span', { class: `etiqueta qualidade${vz.qualidade === '4k' ? ' ultra' : ''}` }, QUALIDADES[vz.qualidade] ?? vz.qualidade)),
          td(el('span', { class: 'mini' }, `${vz.nome_original ?? `#${vz.midia_id}`}${vz.episodio_id ? ` · episódio #${vz.episodio_id}` : ''}`)),
          td(vz.largura && vz.altura ? `${vz.largura}×${vz.altura}` : '—'),
          td(botao('Remover', 'perigo', async () => { await api.del(`/admin/versoes/${vz.id}`); recarregar(); }), true))))
        : el('div', { class: 'mini apagado' }, 'Nenhuma versão extra: o player usa só o arquivo principal.'),
      el('div', { class: 'linha', style: 'margin:12px 0 6px;gap:8px' },
        el('label', { class: 'campo', style: 'margin:0' }, 'Qualidade do próximo envio', escolhaQualidade),
        alvoEpisodio ? el('label', { class: 'campo', style: 'margin:0' }, 'Episódio', alvoEpisodio) : null),
      envio);
  };

  // ---- Temporadas e episódios
  const formEpisodio = (temporada, ep = null) => modal(ep ? `Episódio ${ep.numero}` : `Novo episódio · ${temporada.nome ?? `Temporada ${temporada.numero}`}`, (fechar) => {
    let videoId = ep?.video_midia_id ?? null;
    let thumbId = ep?.thumb_midia_id ?? null;
    const f = el('form', { class: 'form' },
      el('div', { class: 'duas' },
        campo('Número', { name: 'numero', type: 'number', min: 1, required: true, value: ep?.numero ?? '' }),
        campo('Duração (minutos)', { name: 'duracao_min', type: 'number', min: 0, max: 600, value: ep?.duracao_s ? Math.round(ep.duracao_s / 60) : '' })),
      campo('Nome do episódio', { name: 'nome', required: true, maxlength: 160, value: ep?.nome ?? '' }),
      area('Sinopse', { name: 'sinopse', rows: 3, maxlength: 2000 }),
      campo('Estreia (opcional)', { name: 'estreia', type: 'date', value: ep?.estreia ?? '' }),
      campoVideo('Vídeo do episódio', { midiaId: videoId, aoEnviar: async (m) => { videoId = m.id; } }),
      campoArte('Miniatura (16:9)', { midiaId: thumbId, deitada: true, aoEnviar: async (m) => { thumbId = m.id; } }),
      caixaSim('Publicar este episódio', 'publicado', ep ? ep.situacao === 'publicado' : false),
      el('div', { class: 'linha entre' },
        ep ? botao('Excluir episódio', 'perigo', async () => {
          if (!await confirmar('Excluir episódio', `Apagar "${ep.nome}"?`, 'Excluir', true)) return;
          await api.del(`/admin/episodios/${ep.id}`);
          fechar('apagado');
        }) : el('span'),
        el('div', { class: 'linha' },
          el('button', { type: 'button', class: 'btn vazio', onclick: () => fechar() }, 'Cancelar'),
          el('button', { class: 'btn primario' }, 'Salvar episódio'))));
    f.querySelector('textarea[name=sinopse]').value = ep?.sinopse ?? '';
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const d = lerForm(f);
      const corpo = {
        numero: Number(d.numero),
        nome: d.nome,
        sinopse: d.sinopse || null,
        duracao_s: d.duracao_min ? Number(d.duracao_min) * 60 : null,
        estreia: d.estreia || null,
        video_midia_id: videoId,
        thumb_midia_id: thumbId,
        situacao: d.publicado ? 'publicado' : 'rascunho',
      };
      acao(f.querySelector('button.primario'), async () => {
        if (ep) await api.patch(`/admin/episodios/${ep.id}`, corpo);
        else await api.post(`/admin/temporadas/${temporada.id}/episodios`, corpo);
        fechar('salvo');
      });
    });
    return f;
  }, { largo: true });

  const episodiosEl = () => el('div', { class: 'coluna' },
    dados.temporadas.map((tm) => el('div', { class: 'cartao' },
      el('div', { class: 'linha entre' },
        el('div', {}, el('h3', { style: 'margin:0' }, tm.nome ?? `Temporada ${tm.numero}`),
          el('div', { class: 'mini apagado' }, `${tm.episodios.length} episódio(s) · ${tm.episodios.filter((e) => e.situacao === 'publicado').length} publicado(s)`)),
        el('div', { class: 'linha' },
          botao('Novo episódio', 'primario', async () => { if (await formEpisodio(tm)) recarregar(); }, 'mais'))),
      el('div', { class: 'coluna', style: 'margin-top:12px;gap:6px' }, tm.episodios.length
        ? tm.episodios.map((ep) => el('button', {
          class: 'cartao fundo linha entre',
          style: 'text-align:left;cursor:pointer',
          onclick: async () => { if (await formEpisodio(tm, ep)) recarregar(); },
        },
        el('div', { class: 'linha firme', style: 'gap:12px;min-width:0' },
          el('span', { class: 'num apagado', style: 'min-width:28px' }, ep.numero),
          el('div', { style: 'min-width:0' }, el('div', { class: 'cortar' }, ep.nome),
            el('div', { class: 'mini apagado' }, [duracao(ep.duracao_s), ep.estreia ? dataBR(ep.estreia) : null].filter(Boolean).join(' · ')))),
        el('div', { class: 'linha', style: 'gap:6px' },
          ep.video_midia_id ? el('span', { class: 'etiqueta ok' }, 'vídeo') : el('span', { class: 'etiqueta aviso' }, 'sem vídeo'),
          etiquetaSituacao(ep.situacao))))
        : el('p', { class: 'mudo', style: 'margin:0' }, 'Nenhum episódio nesta temporada.')))),
    botao('Nova temporada', 'vazio', async () => {
      await api.post(`/admin/titulos/${id}/temporadas`, {});
      recarregar();
    }, 'mais'));

  // ---- Legendas
  const legendasEl = () => {
    const entrada = el('input', { type: 'file', accept: '.vtt,text/vtt' });
    const alvo = el('select', { name: 'alvo' },
      el('option', { value: `titulo:${id}` }, t.tipo === 'filme' ? 'O filme' : 'A série inteira'),
      dados.temporadas.flatMap((tm) => tm.episodios.map((ep) => el('option', { value: `episodio:${ep.id}` }, `T${tm.numero} E${ep.numero} · ${ep.nome}`))));
    const idioma = el('input', { value: 'pt-BR', maxlength: 10 });
    const rotulo = el('input', { value: 'Português', maxlength: 60 });
    const b = el('button', { class: 'btn primario' }, 'Enviar legenda');
    b.addEventListener('click', () => acao(b, async () => {
      if (!entrada.files[0]) throw new Error('Escolha o arquivo .vtt.');
      const m = await enviarLegenda(entrada.files[0], { idioma: idioma.value, rotulo: rotulo.value });
      const [tipo, alvoId] = alvo.value.split(':');
      await api.post('/admin/legendas', { midia_id: m.id, [`${tipo}_id`]: Number(alvoId), idioma: idioma.value, rotulo: rotulo.value });
      toast('Legenda ligada ao conteúdo.');
      recarregar();
    }));
    return el('div', { class: 'coluna' },
      el('div', { class: 'cartao' },
        el('h3', {}, 'Enviar legenda (WebVTT)'),
        el('div', { class: 'form' },
          el('label', { class: 'campo' }, 'Arquivo .vtt', entrada),
          el('div', { class: 'tres' },
            el('label', { class: 'campo' }, 'De qual conteúdo', alvo),
            el('label', { class: 'campo' }, 'Idioma', idioma),
            el('label', { class: 'campo' }, 'Como aparece no player', rotulo)),
          el('div', { class: 'linha fim' }, b))),
      tabela(['Idioma', 'Rótulo', 'Conteúdo', '>Ações'], dados.legendas.map((l) => el('tr', {},
        td(l.idioma), td(l.rotulo),
        td(l.episodio_id ? `episódio #${l.episodio_id}` : 'título inteiro'),
        td(botao('Excluir', 'perigo', async () => { await api.del(`/admin/legendas/${l.id}`); recarregar(); }), true))),
      'Nenhuma legenda enviada.'));
  };

  const ABAS = [
    ['ficha', 'Ficha'],
    ['arquivos', 'Arquivos e artes'],
    ...(t.tipo === 'serie' ? [['episodios', 'Temporadas e episódios']] : []),
    ['legendas', 'Legendas'],
  ];

  const pintarPainel = () => limpar(painel, aba === 'ficha' ? fichaEl() : aba === 'arquivos' ? arquivosEl() : aba === 'episodios' ? episodiosEl() : legendasEl());

  const abasEl = el('div', { class: 'abas' }, ABAS.map(([k, rotulo]) => {
    const b = el('button', { class: k === aba ? 'on' : '' }, rotulo);
    b.addEventListener('click', () => {
      aba = k;
      for (const outro of abasEl.children) outro.classList.toggle('on', outro === b);
      pintarPainel();
    });
    return b;
  }));
  pintarPainel();

  limpar(c,
    el('button', { class: 'btn pequeno vazio', style: 'margin-bottom:12px', onclick: voltar }, icone('voltar'), 'Voltar ao catálogo'),
    cabeca(t.nome,
      etiquetaSituacao(t.situacao),
      t.situacao !== 'publicado'
        ? botao('Publicar', 'primario', async () => {
          await api.post(`/admin/titulos/${id}/situacao`, { situacao: 'publicado' });
          toast('No ar!');
          recarregar();
        })
        : botao('Tirar do ar', 'vazio', async () => {
          await api.post(`/admin/titulos/${id}/situacao`, { situacao: 'rascunho' });
          recarregar();
        })),
    el('div', { class: 'pequeno mudo', style: 'margin:-8px 0 16px' },
      `${t.tipo === 'filme' ? 'Filme' : 'Série'} · atualizado em ${dataHora(t.atualizado_em)}${t.publicado_em ? ` · publicado em ${dataHora(t.publicado_em)}` : ''}`),
    abasEl, painel);
}
