import { api } from '../api.js';
import { el, limpar, dinheiro, emReais, dataBr, icone, indicador, modal, toast, acao, lerForm, etiqueta, confirmar, RAIZ, hojeLocal } from '../ui.js';

/**
 * Gestão da vitrine: o que passa na TV da loja e no terminal de autoatendimento quando nenhum cliente está comprando.
 * Ofertas, mais vendidos e mais lucrativos entram sozinhos; vídeos e imagens a administração sobe aqui.
 */
const TIPOS_ACEITOS = 'video/mp4,video/webm,image/jpeg,image/png,image/webp';
const mb = (bytes) => (bytes < 1024 * 1024
  ? `${Math.max(1, Math.round(bytes / 1024))} KB`
  : `${(bytes / 1024 / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`);

export default async function vitrine({ alvo, definirTitulo }) {
  definirTitulo('Vitrine', 'Ofertas, produtos e vídeos na TV e no terminal de autoatendimento');
  const enderecoTv = `${location.origin}${RAIZ}/vitrine/`;

  async function desenhar() {
    const [cfg, resumo, midias, produtos] = await Promise.all([
      api.get('/admin/config'), api.get('/vitrine/gestao/resumo'), api.get('/vitrine/gestao/midias'), api.get('/produtos?situacao=ativos&limite=1000'),
    ]);
    const ofertas = produtos.filter((p) => p.em_oferta);
    const { contagem: c, sem_foto: semFoto } = resumo;
    const avisoFoto = (n) => (n ? `${n} sem foto — cadastre a foto para ficar mais bonito` : 'todos com foto');

    limpar(alvo,
      el('div', { class: 'linha entre' },
        el('p', { class: 'mudo', style: 'margin: 0; max-width: 64ch' },
          `Tudo passa sozinho, intercalado. Mais vendidos e mais lucrativos são escolhidos pelas vendas dos últimos ${resumo.dias_ranking} dias; o lucro nunca aparece para o cliente — na tela, o mais lucrativo vira "Destaque da casa".`),
        el('div', { class: 'linha' },
          el('a', { class: 'btn', href: `${RAIZ}/vitrine/`, target: '_blank', rel: 'noopener' }, icone('tv'), 'Abrir a vitrine'),
          el('button', { class: 'btn primario', onclick: escolherArquivo }, icone('enviar'), 'Enviar vídeo ou imagem'))),

      el('div', { class: 'grade' },
        indicador({ simbolo: 'etiqueta', cor: 'vermelho', rotulo: 'Ofertas', valor: String(c.ofertas), nota: cfg.vitrine_ofertas ? 'marcadas à mão' : 'desligado' }),
        indicador({ simbolo: 'pdv', rotulo: 'Mais vendidos', valor: String(c.vendidos), nota: cfg.vitrine_mais_vendidos ? avisoFoto(semFoto.vendidos) : 'desligado' }),
        indicador({ simbolo: 'financeiro', cor: 'ambar', rotulo: 'Mais lucrativos', valor: String(c.lucrativos), nota: cfg.vitrine_mais_lucrativos ? avisoFoto(semFoto.lucrativos) : 'desligado' }),
        indicador({ simbolo: 'tv', cor: 'azul', rotulo: 'Vídeos e imagens', valor: String(c.midias), nota: cfg.vitrine_midias ? `${midias.length} enviado(s)` : 'desligado' })),

      el('div', { class: 'grade', style: 'grid-template-columns: repeat(auto-fit, minmax(330px, 1fr)); align-items: start' },
        cartaoConfig(cfg),
        cartaoTv()),

      cartaoMidias(midias, cfg),
      cartaoOfertas(ofertas, produtos));
  }

  /* ---------- o que passa e por quanto tempo ---------- */
  function cartaoConfig(cfg) {
    const chave = (nome, rotulo, ajuda) => el('label', { class: 'marcador vt-opcao' },
      el('input', { type: 'checkbox', name: nome, checked: cfg[nome] }),
      el('span', {}, el('div', { class: 'destaque' }, rotulo), el('div', { class: 'pequeno mudo' }, ajuda)));
    return el('section', { class: 'cartao' },
      el('h2', {}, 'O que passa na vitrine'),
      el('form', { class: 'form', onsubmit: async (e) => {
        e.preventDefault();
        const f = e.target;
        const d = {
          vitrine_ofertas: f.vitrine_ofertas.checked, vitrine_mais_vendidos: f.vitrine_mais_vendidos.checked,
          vitrine_mais_lucrativos: f.vitrine_mais_lucrativos.checked, vitrine_midias: f.vitrine_midias.checked, vitrine_tablet: f.vitrine_tablet.checked,
          vitrine_qtd_produtos: Number(f.vitrine_qtd_produtos.value), vitrine_segundos_produto: Number(f.vitrine_segundos_produto.value),
          vitrine_tablet_ocioso: Number(f.vitrine_tablet_ocioso.value),
        };
        await acao(f.querySelector('button[type=submit]'), async () => {
          await api.patch('/admin/config', d);
          toast('Vitrine atualizada. A TV pega a mudança no fim da volta atual.', 'ok');
          await desenhar();
        });
      } },
      chave('vitrine_ofertas', 'Ofertas', 'Produtos com preço de oferta em vigor'),
      chave('vitrine_mais_vendidos', 'Mais vendidos', 'Escolhidos sozinhos pelo faturamento'),
      chave('vitrine_mais_lucrativos', 'Mais lucrativos', 'Escolhidos sozinhos pelo lucro — aparece como "Destaque da casa"'),
      chave('vitrine_midias', 'Vídeos e imagens', 'Os arquivos enviados abaixo'),
      el('div', { class: 'duas' },
        el('label', { class: 'campo' }, 'Produtos de cada lista', el('input', { name: 'vitrine_qtd_produtos', type: 'number', min: 1, max: 30, value: cfg.vitrine_qtd_produtos })),
        el('label', { class: 'campo' }, 'Segundos por produto', el('input', { name: 'vitrine_segundos_produto', type: 'number', min: 3, max: 60, value: cfg.vitrine_segundos_produto }))),
      el('hr', { class: 'divisor' }),
      chave('vitrine_tablet', 'Mostrar também no terminal de autoatendimento', 'Quando nenhum cliente está comprando. Some assim que o cliente toca na tela ou passa um produto no leitor.'),
      el('label', { class: 'campo' }, 'Segundos sem cliente até aparecer no terminal', el('input', { name: 'vitrine_tablet_ocioso', type: 'number', min: 10, max: 600, value: cfg.vitrine_tablet_ocioso })),
      el('div', { class: 'linha fim' }, el('button', { class: 'btn primario', type: 'submit' }, icone('check'), 'Salvar'))));
  }

  function cartaoTv() {
    return el('section', { class: 'cartao' },
      el('h2', {}, 'Como ligar na TV'),
      el('ol', { class: 'passos' },
        el('li', {}, 'Na TV (Smart TV, TV Box ou computador ligado nela), abra o navegador.'),
        el('li', {}, 'Digite o endereço abaixo.'),
        el('li', {}, 'Toque em "Tela cheia". Pronto: passa sozinho e se atualiza a cada volta.')),
      el('div', { class: 'endereco-tv' },
        el('code', {}, enderecoTv),
        el('button', { class: 'btn pequeno', type: 'button', onclick: async () => {
          try { await navigator.clipboard.writeText(enderecoTv); toast('Endereço copiado.', 'ok'); } catch { toast('Copie o endereço manualmente.'); }
        } }, icone('copiar'), 'Copiar')),
      el('p', { class: 'pequeno mudo' }, 'A vitrine não pede login: mostra só nome, foto e preço — o que já está na prateleira. Vídeos tocam sem som.'));
  }

  /* ---------- vídeos e imagens ---------- */
  function escolherArquivo() {
    const entrada = el('input', { type: 'file', accept: TIPOS_ACEITOS });
    entrada.addEventListener('change', () => entrada.files[0] && enviar(entrada.files[0]));
    entrada.click();
  }

  function enviar(arquivo) {
    const titulo = arquivo.name.replace(/\.[^.]+$/, '').slice(0, 80);
    const barra = el('span');
    const texto = el('p', { class: 'mudo' }, `${arquivo.name} · ${mb(arquivo.size)}`);
    modal('Enviando para a vitrine', (fechar) => {
      api.enviarComProgresso(`/vitrine/gestao/midias?titulo=${encodeURIComponent(titulo)}`, arquivo, (p) => {
        barra.style.width = `${Math.round(p * 100)}%`;
        texto.textContent = `${arquivo.name} · ${mb(arquivo.size)} · ${Math.round(p * 100)}%`;
      }).then(async () => {
        fechar();
        toast('Arquivo na vitrine.', 'ok');
        await desenhar();
      }).catch((err) => {
        fechar();
        toast(err.message, 'erro');
      });
      return [texto, el('div', { class: 'barra-envio' }, barra)];
    });
  }

  function cartaoMidias(midias, cfg) {
    const mover = (i, delta) => async () => {
      const ids = midias.map((m) => m.id);
      [ids[i], ids[i + delta]] = [ids[i + delta], ids[i]];
      await api.post('/vitrine/gestao/midias/ordem', { ids });
      await desenhar();
    };
    const linha = (m, i) => el('div', { class: `midia${m.ativa ? '' : ' desligada'}` },
      el('div', { class: 'miniatura-midia' }, m.tipo === 'video'
        ? el('video', { src: `${RAIZ}/vitrine-midia/${m.arquivo}#t=1`, muted: true, preload: 'metadata' })
        : el('img', { src: `${RAIZ}/vitrine-midia/${m.arquivo}`, alt: '' })),
      el('div', { class: 'crescer' },
        el('div', { class: 'destaque' }, m.titulo || (m.tipo === 'video' ? 'Vídeo sem título' : 'Imagem sem título')),
        el('div', { class: 'pequeno mudo' }, `${m.tipo === 'video' ? 'Vídeo · toca até o fim' : `Imagem · ${m.duracao_seg} s na tela`} · ${mb(m.tamanho_bytes)}`)),
      m.ativa ? etiqueta('passando', 'ok') : etiqueta('pausado'),
      el('div', { class: 'linha', style: 'gap: 4px' },
        el('button', { class: 'btn icone fantasma', title: 'Subir', disabled: i === 0, onclick: mover(i, -1) }, icone('seta-cima')),
        el('button', { class: 'btn icone fantasma', title: 'Descer', disabled: i === midias.length - 1, onclick: mover(i, 1) }, icone('seta-baixo')),
        el('button', { class: 'btn icone fantasma', title: 'Editar', onclick: () => editarMidia(m) }, icone('editar')),
        el('button', { class: 'btn icone fantasma', title: 'Apagar', onclick: async () => {
          if (!await confirmar('Apagar da vitrine?', `"${m.titulo || 'sem título'}" sai da vitrine e o arquivo é apagado do servidor.`, 'Apagar', true)) return;
          await api.delete(`/vitrine/gestao/midias/${m.id}`);
          toast('Apagado.', 'ok');
          await desenhar();
        } }, icone('lixeira'))));
    return el('section', { class: 'cartao' },
      el('div', { class: 'linha entre' }, el('h2', {}, 'Vídeos e imagens'),
        cfg.vitrine_midias ? null : etiqueta('desligado na configuração', 'aviso')),
      midias.length
        ? el('div', { class: 'coluna', style: 'gap: 8px' }, midias.map(linha))
        : el('div', { class: 'vazio' }, 'Nenhum arquivo ainda. Envie um vídeo (MP4 ou WebM, até 80 MB) ou uma imagem (JPEG, PNG ou WebP, até 8 MB) — de preferência deitado, no formato da TV (16:9).'));
  }

  function editarMidia(m) {
    modal('Editar', (fechar) => el('form', { class: 'form', onsubmit: async (e) => {
      e.preventDefault();
      const d = lerForm(e.target);
      await acao(e.target.querySelector('button[type=submit]'), async () => {
        await api.patch(`/vitrine/gestao/midias/${m.id}`, { titulo: d.titulo, ativa: e.target.ativa.checked, ...(m.tipo === 'imagem' ? { duracao_seg: Number(d.duracao_seg) } : {}) });
        fechar();
        await desenhar();
      });
    } },
    el('label', { class: 'campo' }, 'Título (só para vocês)', el('input', { name: 'titulo', value: m.titulo, maxlength: 80, autofocus: true })),
    m.tipo === 'imagem' ? el('label', { class: 'campo' }, 'Segundos na tela', el('input', { name: 'duracao_seg', type: 'number', min: 3, max: 120, value: m.duracao_seg })) : null,
    el('label', { class: 'marcador' }, el('input', { type: 'checkbox', name: 'ativa', checked: !!m.ativa }), 'Passando na vitrine'),
    el('div', { class: 'linha fim' },
      el('button', { class: 'btn fantasma', type: 'button', onclick: () => fechar() }, 'Voltar'),
      el('button', { class: 'btn primario', type: 'submit' }, 'Salvar'))));
  }

  /* ---------- ofertas ---------- */
  function cartaoOfertas(ofertas, produtos) {
    const encerrar = (p) => async () => {
      if (!await confirmar('Encerrar a oferta?', `${p.nome} volta para ${dinheiro(p.preco_centavos)} no terminal na hora.`, 'Encerrar')) return;
      await api.patch(`/produtos/${p.id}`, { oferta_preco: '' });
      toast('Oferta encerrada.', 'ok');
      await desenhar();
    };
    return el('section', { class: 'cartao' },
      el('div', { class: 'linha entre' },
        el('h2', {}, 'Ofertas em vigor'),
        el('button', { class: 'btn pequeno primario', onclick: () => novaOferta(produtos) }, icone('mais'), 'Nova oferta')),
      ofertas.length
        ? el('div', { class: 'coluna', style: 'gap: 8px' }, ofertas.map((p) => el('div', { class: 'midia' },
          el('div', { class: 'crescer' },
            el('div', { class: 'destaque' }, p.nome),
            el('div', { class: 'pequeno mudo' }, p.oferta_ate ? `até ${dataBr(p.oferta_ate)}` : 'sem data para acabar')),
          el('span', { class: 'direita' }, el('s', { class: 'mudo pequeno' }, dinheiro(p.preco_centavos)), ' ', el('strong', { class: 'positivo' }, dinheiro(p.preco_vigente_centavos))),
          el('button', { class: 'btn pequeno', onclick: encerrar(p) }, 'Encerrar'))))
        : el('div', { class: 'vazio' }, 'Nenhuma oferta agora. O preço da oferta vale no terminal e o produto ganha destaque na vitrine.'));
  }

  function novaOferta(produtos) {
    const porNome = new Map(produtos.map((p) => [p.nome, p]));
    const aviso = el('p', { class: 'pequeno mudo' }, 'Escolha o produto.');
    const nome = el('input', { name: 'produto', list: 'lista-produtos-oferta', required: true, autofocus: true, placeholder: 'comece a digitar o nome', autocomplete: 'off',
      oninput: () => {
        const p = porNome.get(nome.value);
        aviso.textContent = p ? `Preço normal: ${dinheiro(p.preco_centavos)}${p.em_oferta ? ` · já em oferta por ${dinheiro(p.preco_vigente_centavos)}` : ''}` : 'Escolha o produto na lista.';
      } });
    modal('Nova oferta', (fechar) => el('form', { class: 'form', onsubmit: async (e) => {
      e.preventDefault();
      const p = porNome.get(nome.value);
      if (!p) return toast('Escolha um produto da lista.', 'erro');
      const d = lerForm(e.target);
      await acao(e.target.querySelector('button[type=submit]'), async () => {
        await api.patch(`/produtos/${p.id}`, { oferta_preco: d.oferta_preco, oferta_ate: d.oferta_ate });
        fechar();
        toast(`${p.nome} em oferta.`, 'ok');
        await desenhar();
      });
      return undefined;
    } },
    el('label', { class: 'campo' }, 'Produto', nome),
    el('datalist', { id: 'lista-produtos-oferta' }, produtos.map((p) => el('option', { value: p.nome }))),
    aviso,
    el('div', { class: 'duas' },
      el('label', { class: 'campo' }, 'Preço da oferta (R$)', el('input', { name: 'oferta_preco', inputmode: 'decimal', required: true, placeholder: 'ex.: 9,90' })),
      el('label', { class: 'campo' }, 'Vale até (opcional)', el('input', { name: 'oferta_ate', type: 'date', min: hojeLocal() }))),
    el('div', { class: 'linha fim' },
      el('button', { class: 'btn fantasma', type: 'button', onclick: () => fechar() }, 'Voltar'),
      el('button', { class: 'btn primario', type: 'submit' }, 'Colocar em oferta'))));
  }

  await desenhar();
}
