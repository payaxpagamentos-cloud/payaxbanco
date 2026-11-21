'use strict';

/**
 * Leitor de e-mail cru (MIME).
 *
 * O que chega no servidor não é texto: é um envelope com cabeçalhos dobrados em várias linhas, assunto
 * codificado em base64, corpo repartido em pedaços (texto, HTML, anexos) e acentuação em meia dúzia de
 * formatos diferentes. Este arquivo desembrulha tudo isso e devolve o que o CRM precisa mostrar: quem
 * mandou, para quem, assunto, o texto da mensagem e a lista de anexos.
 *
 * É um leitor deliberadamente conservador: diante de algo que não entende, prefere devolver o pedaço cru
 * a inventar conteúdo. Nada aqui executa HTML — o painel mostra o texto, e o original fica guardado.
 */

/** Junta as linhas dobradas e separa cabeçalho de corpo. */
function separar(bruto) {
  const texto = bruto.toString('binary');
  const corte = texto.search(/\r?\n\r?\n/);
  const cabecalho = corte === -1 ? texto : texto.slice(0, corte);
  const corpo = corte === -1 ? '' : texto.slice(corte).replace(/^\r?\n\r?\n/, '');
  const linhas = cabecalho.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/);
  const campos = [];
  for (const linha of linhas) {
    const i = linha.indexOf(':');
    if (i > 0) campos.push([linha.slice(0, i).trim().toLowerCase(), linha.slice(i + 1).trim()]);
  }
  return { campos, corpo };
}

const pegar = (campos, nome) => campos.find(([k]) => k === nome)?.[1] ?? '';

/** Texto em outra codificação vira texto em português legível (acento no lugar). */
function paraTexto(bytes, charset) {
  const nome = String(charset || 'utf-8').toLowerCase().replace(/^"|"$/g, '');
  try {
    return new TextDecoder(nome === 'us-ascii' ? 'utf-8' : nome, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252', { fatal: false }).decode(bytes);
  }
}

/** quoted-printable: "=C3=A1" vira "á", e "=" no fim da linha é só emenda. */
function deQuotedPrintable(texto) {
  const limpo = texto.replace(/=\r?\n/g, '');
  const saida = [];
  for (let i = 0; i < limpo.length; i++) {
    if (limpo[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(limpo.slice(i + 1, i + 3))) {
      saida.push(parseInt(limpo.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      saida.push(limpo.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(saida);
}

/**
 * Cabeçalho com acento escrito direto (sem codificar). O formato antigo só previa ASCII, mas metade dos
 * programas de e-mail de hoje manda os bytes crus — e é por isso que assunto com acento aparece como
 * "mÃ­dia" em sistema que não trata isso. Aqui os bytes voltam a ser texto.
 */
function texto8bits(valor) {
  const s = String(valor ?? '');
  if (!/[\u0080-\u00ff]/.test(s)) return s;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(s, 'latin1'));
  } catch {
    return new TextDecoder('windows-1252', { fatal: false }).decode(Buffer.from(s, 'latin1'));
  }
}

/** Cabeçalho codificado (=?UTF-8?B?...?=) vira o texto que a pessoa escreveu. */
function decodificarCabecalho(valor) {
  // Espaço entre duas palavras codificadas não conta: é emenda, não espaço de verdade.
  return texto8bits(valor).replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (todo, charset, tipo, dado) => {
      try {
        const bytes = tipo.toLowerCase() === 'b' ? Buffer.from(dado, 'base64') : deQuotedPrintable(dado.replace(/_/g, ' '));
        return paraTexto(bytes, charset);
      } catch {
        return todo;
      }
    });
}

/** Content-Type: "text/plain; charset=utf-8; name=x" vira { tipo, charset, nome, boundary }. */
function lerTipo(valor) {
  const [bruto, ...resto] = String(valor || 'text/plain').split(';');
  const p = {};
  for (const parte of resto) {
    const i = parte.indexOf('=');
    if (i > 0) p[parte.slice(0, i).trim().toLowerCase()] = parte.slice(i + 1).trim().replace(/^"|"$/g, '');
  }
  return { tipo: bruto.trim().toLowerCase(), charset: p.charset, nome: p.name, boundary: p.boundary };
}

/** Decodifica o corpo de um pedaço conforme o Content-Transfer-Encoding. */
function corpoEmBytes(corpo, codificacao) {
  const c = String(codificacao || '7bit').toLowerCase().trim();
  if (c === 'base64') return Buffer.from(corpo.replace(/\s+/g, ''), 'base64');
  if (c === 'quoted-printable') return deQuotedPrintable(corpo);
  return Buffer.from(corpo, 'binary');
}

/** Percorre a mensagem (e as partes dentro das partes) juntando texto, HTML e anexos. */
function percorrer(campos, corpo, achados, profundidade = 0) {
  if (profundidade > 8) return;
  const ct = lerTipo(pegar(campos, 'content-type'));
  const disposicao = pegar(campos, 'content-disposition');
  const codificacao = pegar(campos, 'content-transfer-encoding');

  if (ct.tipo.startsWith('multipart/') && ct.boundary) {
    const marca = `--${ct.boundary}`;
    const pedacos = [];
    let atual = null;
    for (const linha of corpo.split(/\r?\n/)) {
      const limpa = linha.replace(/\s+$/, '');
      if (limpa === marca) { if (atual) pedacos.push(atual.join('\n')); atual = []; continue; }
      if (limpa === `${marca}--`) { if (atual) pedacos.push(atual.join('\n')); atual = null; break; }
      if (atual) atual.push(linha);
    }
    if (atual) pedacos.push(atual.join('\n'));
    for (const pedaco of pedacos) {
      const parte = separar(Buffer.from(pedaco, 'binary'));
      percorrer(parte.campos, parte.corpo, achados, profundidade + 1);
    }
    return;
  }

  const nomeAnexo = decodificarCabecalho(/filename\*?=/.test(disposicao)
    ? (disposicao.match(/filename\*?="?([^";]+)"?/i)?.[1] ?? '')
    : (ct.nome ?? ''));
  const anexo = /attachment/i.test(disposicao) || (nomeAnexo && !ct.tipo.startsWith('text/'));
  const bytes = corpoEmBytes(corpo, codificacao);

  if (anexo) {
    achados.anexos.push({ nome: nomeAnexo || 'anexo', mime: ct.tipo, tamanho: bytes.length, conteudo: bytes });
    return;
  }
  if (ct.tipo === 'text/html') achados.html.push(paraTexto(bytes, ct.charset));
  else if (ct.tipo.startsWith('text/') || !ct.tipo) achados.texto.push(paraTexto(bytes, ct.charset));
  else if (bytes.length) achados.anexos.push({ nome: nomeAnexo || 'anexo', mime: ct.tipo, tamanho: bytes.length, conteudo: bytes });
}

/** HTML vira texto de leitura: sem script, sem estilo, com as quebras de linha onde faz sentido. */
function htmlParaTexto(html) {
  return String(html)
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|tr|h[1-6]|li|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_t, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** "Fulano <fulano@exemplo.com>" vira { nome, email }. */
function lerEndereco(valor) {
  const texto = decodificarCabecalho(valor).trim();
  const comNome = texto.match(/^(.*?)<([^>]+)>\s*$/);
  const email = (comNome ? comNome[2] : texto).trim().toLowerCase();
  const nome = comNome ? comNome[1].trim().replace(/^"|"$/g, '') : '';
  return { nome, email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '' };
}

/** Todos os endereços de um cabeçalho com lista (To, Cc). */
const lerEnderecos = (valor) => decodificarCabecalho(valor)
  .split(/,(?![^<]*>)/).map((p) => lerEndereco(p).email).filter(Boolean);

/** Lê a mensagem inteira. Devolve o que o CRM mostra e guarda. */
function ler(bruto) {
  const { campos, corpo } = separar(Buffer.isBuffer(bruto) ? bruto : Buffer.from(String(bruto), 'utf8'));
  const achados = { texto: [], html: [], anexos: [] };
  percorrer(campos, corpo, achados);

  const textoPuro = achados.texto.join('\n').trim();
  const html = achados.html.join('\n');
  const de = lerEndereco(pegar(campos, 'from'));
  const data = pegar(campos, 'date');
  const quando = data && !Number.isNaN(Date.parse(data)) ? new Date(data).toISOString() : null;

  return {
    de: de.email,
    de_nome: de.nome,
    para: lerEnderecos(pegar(campos, 'to')),
    cc: lerEnderecos(pegar(campos, 'cc')),
    assunto: decodificarCabecalho(pegar(campos, 'subject')).trim(),
    texto: textoPuro || htmlParaTexto(html),
    tinhaHtml: Boolean(html),
    message_id: (pegar(campos, 'message-id').match(/<([^>]+)>/)?.[1] ?? '').trim() || null,
    em_resposta_a: (pegar(campos, 'in-reply-to').match(/<([^>]+)>/)?.[1] ?? '').trim() || null,
    referencias: [...pegar(campos, 'references').matchAll(/<([^>]+)>/g)].map((m) => m[1]),
    data: quando,
    anexos: achados.anexos,
    cabecalhos: campos,
  };
}

module.exports = { ler, lerEndereco, lerEnderecos, decodificarCabecalho, htmlParaTexto, deQuotedPrintable, paraTexto, texto8bits };
