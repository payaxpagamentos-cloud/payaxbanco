/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/

/** Central de multas: lista com resumo, cadastro com a notificação, detalhe com o cruzamento do rastreamento e a indicação do condutor. */
import { api } from './api.js';
import { el, limpar, toast, formModal, modal, confirmar, campo, area, escolha, marcar, etiqueta, placa, dinheiro, dataHora, data, kmh, centavos, reaisCampo, icone } from './ui.js';
import { cartao, indicador, tabela, td, botao, botaoIcone } from './comum.js';
import { linkGoogle, configPublica } from './mapa.js';

const TOM = { notificada: 'aviso', condutor_indicado: 'info', em_recurso: 'info', a_pagar: 'erro', paga: 'ok', cancelada: '' };
const GRAV = { leve: 'Leve', media: 'Média', grave: 'Grave', gravissima: 'Gravíssima' };
const meiaNoiteBrasilia = (iso) => { const d = new Date(iso); return d.getUTCHours() === 3 && d.getUTCMinutes() === 0; };
const quandoMulta = (m) => (m.ocorrida_em ? (m.sem_hora || meiaNoiteBrasilia(m.ocorrida_em) ? new Date(m.ocorrida_em).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : dataHora(m.ocorrida_em)) : '—');
const escHtml = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LOGO = '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="#04131F" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M19.07 4.93A10 10 0 0 0 6.99 3.34M4 6h.01M2.29 9.62A10 10 0 1 0 21.31 8.35M16.24 7.76A6 6 0 1 0 8.23 16.67M12 18h.01M17.99 11.66A6 6 0 0 1 15.77 16.67M14 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM13.41 10.59l5.66-5.66"/></svg>';

/**
 * Ficha da multa: uma página com a logo do Rastreador e os dados da infração, pronta para imprimir ou salvar em PDF
 * (Imprimir → Salvar como PDF). Abre numa aba nova.
 */
export async function fichaMulta(m, { placaTxt, origem, condutor } = {}) {
  const janela = window.open('', '_blank');
  if (!janela) return toast('Libere as janelas (pop-up) deste site para ver a multa.', true);
  const nome = (await configPublica().catch(() => null))?.nome ?? 'Rastreador';
  const linha = (rot, val) => (val ? `<tr><th>${escHtml(rot)}</th><td>${escHtml(val)}</td></tr>` : '');
  const pl = placa(placaTxt ?? m.placa ?? '');
  janela.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Multa ${escHtml(m.auto_infracao ?? '')} · ${escHtml(pl)}</title>
<style>
  *{box-sizing:border-box} body{margin:0;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0B1A2E;background:#EEF2F7}
  .folha{max-width:760px;margin:24px auto;background:#fff;border-radius:16px;box-shadow:0 10px 30px rgba(8,16,38,.12);overflow:hidden}
  .topo{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:20px 26px;background:#0B1528;color:#fff}
  .marca{display:flex;align-items:center;gap:12px;font-weight:800;font-size:20px}
  .marca span.ic{display:grid;place-items:center;width:46px;height:46px;border-radius:12px;background:linear-gradient(135deg,#34E1C2,#22B8A0)}
  .topo small{display:block;font-weight:500;font-size:12px;opacity:.75}
  .doc{text-align:right;font-size:12px;opacity:.85}
  .corpo{padding:24px 26px}
  .placa{display:inline-block;border:2px solid #0B1A2E;border-radius:6px;padding:4px 12px;font-weight:800;letter-spacing:2px;font-size:20px}
  h1{font-size:19px;line-height:1.35;margin:16px 0 6px}
  .valor{font-size:30px;font-weight:800;color:#B42318;margin:8px 0 18px}
  table{width:100%;border-collapse:collapse;font-size:14px} th{width:38%;text-align:left;color:#5B6576;font-weight:600;padding:9px 0;border-bottom:1px solid #E6EAF0}
  td{padding:9px 0;border-bottom:1px solid #E6EAF0;font-weight:600}
  .rodape{padding:14px 26px 22px;color:#6B7485;font-size:12px}
  .acoes{max-width:760px;margin:0 auto 30px;display:flex;justify-content:flex-end;gap:10px;padding:0 4px}
  button{border:0;border-radius:10px;padding:11px 18px;font-weight:700;font-size:14px;cursor:pointer;background:linear-gradient(135deg,#1D4ED8,#0E7490);color:#fff}
  button.sec{background:#fff;color:#0B1A2E;border:1px solid #D5DBE5}
  @media print{body{background:#fff}.folha{box-shadow:none;margin:0;border-radius:0}.acoes{display:none}.topo{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style></head><body>
<div class="folha">
  <div class="topo"><div class="marca"><span class="ic">${LOGO}</span><div>${escHtml(nome)}<small>Central de multas</small></div></div>
    <div class="doc">Ficha da multa<br>${escHtml(new Date().toLocaleString('pt-BR'))}</div></div>
  <div class="corpo">
    <span class="placa">${escHtml(pl)}</span>
    <h1>${escHtml(m.descricao ?? 'Infração de trânsito')}</h1>
    ${m.valor_centavos != null ? `<div class="valor">${escHtml(dinheiro(m.valor_centavos))}</div>` : ''}
    <table>
      ${linha('Data da infração', quandoMulta(m))}
      ${linha('Auto de infração', m.auto_infracao)}
      ${linha('Órgão / fonte', m.orgao)}
      ${linha('Código da infração', m.infracao_codigo)}
      ${linha('Gravidade', m.gravidade ? `${GRAV[m.gravidade]}${m.pontos ? ` · ${m.pontos} pontos` : ''}` : (m.pontos ? `${m.pontos} pontos` : ''))}
      ${linha('Local', [m.local_texto, m.municipio].filter(Boolean).join(' · '))}
      ${linha('Vencimento', m.vencimento ? data(m.vencimento) : '')}
      ${linha('Indicar o condutor até', m.prazo_indicacao ? data(m.prazo_indicacao) : '')}
      ${linha('Condutor', condutor)}
      ${linha('Linha digitável (para pagar)', m.linha_digitavel)}
      ${linha('Situação', m.situacao ? ({ notificada: 'Notificada', condutor_indicado: 'Condutor indicado', em_recurso: 'Em recurso', a_pagar: 'A pagar', paga: 'Paga', cancelada: 'Cancelada' }[m.situacao] ?? m.situacao) : '')}
    </table>
  </div>
  <div class="rodape">${escHtml(origem ?? 'Dados da Central de multas.')} Documento informativo; o auto de infração oficial é o do órgão autuador.</div>
</div>
<div class="acoes"><button class="sec" id="fechar">Fechar</button><button id="imprimir">Imprimir / salvar PDF</button></div>
</body></html>`);
  janela.document.close();
  // A política de segurança do painel bloqueia scripts escritos na página: os botões são ligados daqui.
  janela.document.getElementById('imprimir')?.addEventListener('click', () => { janela.focus(); janela.print(); });
  janela.document.getElementById('fechar')?.addEventListener('click', () => janela.close());
}

// ---------- Créditos (produto): saldo, preços de venda, recarga por PIX e extrato ----------
const reaisTxt = (c) => dinheiro(c ?? 0);
const NOMES_TIPO = { completa: 'Completa', renainf: 'Rápida', resumida: 'Simples' };

async function recarregar(ctx, aoTerminar) {
  const base = `/empresas/${ctx.empresaId}/multas/creditos`;
  modal('Adicionar crédito por PIX', (fechar) => {
    const corpo = el('div');
    const outro = campo('Outro valor (R$)', { name: 'outro', inputmode: 'decimal', placeholder: 'mínimo 10,00' });
    const gerar = async (centavosValor) => {
      if (!centavosValor || centavosValor < 1000) return toast('Escolha um valor a partir de R$ 10,00.', true);
      limpar(corpo, el('div', { class: 'carregando-linha' }));
      try {
        const c = await api.post(`${base}/pix`, { valor_centavos: centavosValor });
        const qr = el('div', { style: 'width:220px;margin:0 auto' });
        qr.innerHTML = c.qr_svg; // SVG gerado pelo próprio servidor a partir do código PIX
        const copia = el('textarea', { readonly: true, rows: 3, style: 'width:100%;font-family:monospace;font-size:12px' });
        copia.value = c.copia_cola;
        limpar(corpo,
          el('p', { style: 'margin:0 0 8px;text-align:center' }, 'Pague ', el('strong', {}, reaisTxt(c.valor_centavos)), ' pelo app do seu banco (PIX → ler QR code ou copia e cola).'),
          qr, el('label', { class: 'campo' }, 'PIX copia e cola', copia),
          el('div', { class: 'linha entre', style: 'gap:8px;flex-wrap:wrap;margin-top:8px' },
            botao('Copiar código', '', () => navigator.clipboard?.writeText(c.copia_cola).then(() => toast('Código PIX copiado.'), () => { copia.select(); toast('Selecione e copie o código.'); })),
            botao('Já paguei', 'primario', async () => {
              await api.post(`${base}/pix/${c.id}/informar`, {});
              toast('Pagamento informado. Assim que confirmado, o crédito entra na hora.');
              fechar(); aoTerminar?.();
            })),
          el('p', { class: 'pequeno mudo', style: 'margin:10px 0 0' }, `Identificador: ${c.txid}. O crédito entra assim que o pagamento é confirmado.`));
      } catch (err) { limpar(corpo, el('p', { class: 'aviso erro' }, err.message)); }
    };
    limpar(corpo,
      el('p', { class: 'mudo', style: 'margin:0 0 10px' }, 'Escolha o valor. O sistema gera o PIX com o valor certo.'),
      el('div', { class: 'linha', style: 'gap:8px;flex-wrap:wrap' }, [5000, 10000, 20000, 50000].map((v) => botao(reaisTxt(v), '', () => gerar(v)))),
      el('div', { class: 'linha', style: 'gap:8px;align-items:flex-end;margin-top:10px' }, outro, botao('Gerar PIX', 'primario', () => gerar(centavos(outro.querySelector('input').value)))));
    return [corpo];
  });
}

async function verExtrato(ctx) {
  const d = await api.get(`/empresas/${ctx.empresaId}/multas/creditos`);
  const TIPO = { recarga: ['Recarga', 'ok'], consulta: ['Consulta', ''], estorno: ['Estorno', 'info'], ajuste: ['Ajuste', 'aviso'] };
  modal('Extrato do crédito', () => [
    el('p', { style: 'margin:0 0 10px' }, 'Saldo atual: ', el('strong', {}, reaisTxt(d.saldo_centavos))),
    tabela(['Quando', 'Movimento', 'Descrição', '>Valor', '>Saldo'], d.extrato.map((x) => el('tr', {}, td(dataHora(x.criado_em)), td(etiqueta(TIPO[x.tipo]?.[0] ?? x.tipo, TIPO[x.tipo]?.[1] ?? '')),
      td(x.descricao ?? '—'), td(el('strong', { style: `color:${x.valor_centavos < 0 ? 'var(--erro)' : 'var(--ok)'}` }, `${x.valor_centavos < 0 ? '−' : '+'} ${reaisTxt(Math.abs(x.valor_centavos))}`), 'dir num'),
      td(reaisTxt(x.saldo_centavos), 'dir num'))), 'Nenhum movimento ainda.'),
    d.recargas.length ? el('h4', { style: 'margin:16px 0 6px' }, 'Recargas por PIX') : null,
    d.recargas.length ? tabela(['Quando', '>Valor', 'Situação'], d.recargas.map((x) => el('tr', {}, td(dataHora(x.criado_em)), td(reaisTxt(x.valor_centavos), 'dir num'),
      td(etiqueta({ pendente: 'aguardando pagamento', informado: 'pagamento informado', pago: 'creditado', cancelado: 'cancelado' }[x.status], x.status === 'pago' ? 'ok' : x.status === 'cancelado' ? '' : 'aviso'))))) : null,
  ], { largo: true });
}

/** Faixa do crédito no topo da central: saldo, preço de cada consulta, Adicionar crédito e Extrato. */
async function faixaCredito(ctx, alvo) {
  const d = await api.get(`/empresas/${ctx.empresaId}/multas/creditos`);
  const pode = !ctx.somenteLeitura;
  limpar(alvo, el('section', { class: 'cartao', style: 'display:flex;flex-wrap:wrap;gap:14px;align-items:center;justify-content:space-between;margin-bottom:14px' },
    el('div', {}, el('div', { class: 'pequeno mudo' }, 'Crédito para consultas'),
      el('div', { style: `font-size:28px;font-weight:800;color:${d.saldo_centavos > 0 ? 'var(--ok)' : 'var(--erro)'}` }, reaisTxt(d.saldo_centavos))),
    el('div', { class: 'linha', style: 'gap:6px;flex-wrap:wrap' }, Object.entries(d.precos).map(([t, v]) => etiqueta(`${NOMES_TIPO[t]}: ${reaisTxt(v)}`, ''))),
    el('div', { class: 'linha', style: 'gap:8px;flex-wrap:wrap' },
      botao('Extrato', '', () => verExtrato(ctx)),
      pode ? (d.pix ? botao([icone('carteira'), 'Adicionar crédito (PIX)'], 'primario', () => recarregar(ctx, () => faixaCredito(ctx, alvo)))
        : el('span', { class: 'pequeno mudo' }, 'Recarga por PIX: fale com o suporte.')) : null)));
  return d;
}

const INTERVALO = { 0: 'desligada', 1: 'todo dia', 7: 'uma vez por semana', 15: 'a cada 15 dias', 30: 'uma vez por mês' };
const prazoTexto = (dias, data_) => (dias === null || dias === undefined ? '—' : dias < 0 ? `venceu (${data(data_)})` : dias === 0 ? 'hoje' : `${dias} dia(s) · ${data(data_)}`);
const paraLocal = (iso) => { const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

/** Lê os arquivos escolhidos (PDF ou fotos) como data URL para enviar junto. */
const lerArquivos = (input) => Promise.all([...input.files].slice(0, 4).map((f) => new Promise((ok, falha) => {
  if (f.size > 4_000_000) return falha(new Error(`${f.name}: arquivo grande demais (máximo 4 MB).`));
  const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => falha(new Error(`Não foi possível ler ${f.name}.`)); r.readAsDataURL(f);
})));

async function abrirArquivo(caminho) {
  const janela = window.open('', '_blank');
  try {
    const b = await (await api.get(caminho, { bruto: true })).blob();
    const url = URL.createObjectURL(b);
    if (janela) janela.location = url; else location.href = url;
  } catch (err) { janela?.close(); toast(err.message, true); }
}

function formMulta(ctx, dados, m) {
  const arquivos = el('input', { type: 'file', name: 'arquivos_sel', accept: 'application/pdf,image/*', multiple: true });
  return formModal(m ? 'Editar multa' : 'Cadastrar multa', () => [
    el('div', { class: 'duas' },
      escolha('Veículo', 'placa', Object.fromEntries(dados.veiculos.map((v) => [v.placa, `${placa(v.placa)}${v.descricao ? ` · ${v.descricao}` : ''}`])), m?.placa ?? dados.veiculos[0]?.placa),
      campo('Data e hora da infração', { name: 'ocorrida_em', type: 'datetime-local', required: true, value: m ? paraLocal(m.ocorrida_em) : '' })),
    campo('Infração (descrição)', { name: 'descricao', required: true, maxlength: 300, value: m?.descricao ?? '', placeholder: 'Ex.: Velocidade superior à máxima permitida em até 20%' }),
    el('div', { class: 'tres' },
      campo('Nº do auto (AIT)', { name: 'auto_infracao', maxlength: 40, value: m?.auto_infracao ?? '' }),
      campo('Órgão autuador', { name: 'orgao', maxlength: 80, value: m?.orgao ?? '', placeholder: 'DETRAN-SP, DER, PRF…' }),
      campo('Código da infração', { name: 'infracao_codigo', maxlength: 20, value: m?.infracao_codigo ?? '' })),
    el('div', { class: 'tres' },
      escolha('Gravidade', 'gravidade', { '': '—', ...GRAV }, m?.gravidade ?? ''),
      campo('Valor (R$)', { name: 'valor', inputmode: 'decimal', value: reaisCampo(m?.valor_centavos) }),
      campo('Pontos', { name: 'pontos', type: 'number', min: 0, max: 40, value: m?.pontos ?? '', placeholder: 'pela gravidade' })),
    el('div', { class: 'duas' },
      campo('Local', { name: 'local_texto', maxlength: 200, value: m?.local_texto ?? '' }),
      campo('Município', { name: 'municipio', maxlength: 80, value: m?.municipio ?? '' })),
    el('div', { class: 'duas' },
      campo('Prazo para indicar o condutor', { name: 'prazo_indicacao', type: 'date', value: m?.prazo_indicacao ?? '' }),
      campo('Vencimento do pagamento', { name: 'vencimento', type: 'date', value: m?.vencimento ?? '' })),
    el('label', { class: 'campo' }, 'Notificação (PDF ou fotos, até 4 arquivos de 4 MB)', arquivos),
    area('Observação', { name: 'observacao', maxlength: 500, rows: 2 }, m?.observacao ?? ''),
  ], async (d) => {
    const corpo = { ...d, valor_centavos: centavos(d.valor) ?? null, ocorrida_em: d.ocorrida_em ? new Date(d.ocorrida_em).toISOString() : '', arquivos: await lerArquivos(arquivos) };
    delete corpo.valor; delete corpo.arquivos_sel;
    return m ? api.put(`/empresas/${ctx.empresaId}/multas/${m.id}`, corpo) : api.post(`/empresas/${ctx.empresaId}/multas`, corpo);
  }, { rotulo: m ? 'Salvar' : 'Cadastrar', largo: true });
}

/** Detalhe: dados da multa, a notificação, o cruzamento com o rastreamento e as ações (indicar condutor, situação). */
async function detalheMulta(ctx, dados, id, { master, gestor, aoMudar }) {
  const caminho = master ? `/master/multas/${id}` : `/empresas/${ctx.empresaId}/multas/${id}`;
  const m = await api.get(caminho);
  const c = m.cruzamento;
  const linha = (rot, val) => el('div', { class: 'linha entre', style: 'padding:6px 0;border-bottom:1px solid var(--border);gap:12px' }, el('span', { class: 'mudo pequeno' }, rot), el('strong', { style: 'text-align:right' }, val ?? '—'));
  const cruz = !c?.veiculo_cadastrado ? el('p', { class: 'mudo' }, 'A placa não está cadastrada como veículo rastreado.')
    : el('div', {},
      linha('Quem dirigia', c.condutor ? `${c.condutor.nome} (${c.condutor.origem})` : 'Sem motorista registrado no horário'),
      linha('Posição no horário', c.posicao ? el('a', { href: linkGoogle(c.posicao.lat, c.posicao.lng), target: '_blank', rel: 'noopener' }, `${c.posicao.lat.toFixed(5)}, ${c.posicao.lng.toFixed(5)} · ${c.posicao.diferenca_min} min de diferença`) : 'Sem posição até 15 min do horário'),
      linha('Velocidade no horário', c.posicao ? kmh(c.posicao.velocidade_kmh) : '—'),
      linha('Velocidade máxima (±3 min)', c.velocidade_max_kmh !== null ? kmh(c.velocidade_max_kmh) : '—'),
      linha('Ignição', c.posicao ? (c.posicao.ignicao === 1 ? 'ligada' : c.posicao.ignicao === 0 ? 'desligada' : '—') : '—'));
  modal(`Multa · ${placa(m.placa)}`, (fechar) => {
    const acoes = gestor && !master ? el('div', { class: 'linha', style: 'gap:8px;flex-wrap:wrap;margin-top:14px' },
      botao('Indicar condutor', 'primario', async () => {
        const r = await formModal('Indicar o condutor', () => [
          el('p', { class: 'mudo', style: 'margin:0' }, c?.condutor ? `No horário, quem dirigia era ${c.condutor.nome} (${c.condutor.origem}).` : 'Escolha o motorista que estava com o veículo.'),
          escolha('Motorista', 'motorista_id', { '': '— nenhum —', ...Object.fromEntries(dados.motoristas.map((x) => [x.id, x.nome])) }, m.motorista_id ?? c?.condutor?.motorista_id ?? ''),
        ], (d) => api.put(`/empresas/${ctx.empresaId}/multas/${m.id}`, { motorista_id: d.motorista_id || null, situacao: d.motorista_id ? 'condutor_indicado' : m.situacao }));
        if (r) { toast('Condutor indicado. A multa aparece no app dele em Minhas multas.'); fechar(); aoMudar(); }
      }),
      botao('Mudar situação', '', async () => {
        const r = await formModal('Situação da multa', () => [escolha('Situação', 'situacao', dados.situacoes, m.situacao)],
          (d) => api.put(`/empresas/${ctx.empresaId}/multas/${m.id}`, { situacao: d.situacao }));
        if (r) { toast('Situação atualizada.'); fechar(); aoMudar(); }
      }),
      botao([icone('multa'), 'Ver multa'], '', () => fichaMulta(m, { condutor: m.motorista, origem: m.fonte === 'consulta' ? 'Encontrada pela consulta de multas.' : 'Cadastrada na Central de multas.' })),
      botao('Editar', '', async () => { fechar(); if (await formMulta(ctx, dados, m)) { toast('Multa salva.'); aoMudar(); } }),
      botao('Excluir', 'perigo', async () => {
        if (!await confirmar('Excluir a multa', 'A multa e a notificação anexada são apagadas.', 'Excluir')) return;
        await api.del(`/empresas/${ctx.empresaId}/multas/${m.id}`); toast('Multa excluída.'); fechar(); aoMudar();
      })) : null;
    return [
      el('div', { class: 'linha', style: 'gap:6px;flex-wrap:wrap;margin-bottom:10px' }, etiqueta(dados.situacoes[m.situacao], TOM[m.situacao]),
        m.gravidade ? etiqueta(`${GRAV[m.gravidade]}${m.pontos ? ` · ${m.pontos} pontos` : ''}`, m.gravidade === 'gravissima' ? 'erro' : 'aviso') : null,
        etiqueta(m.fonte === 'consulta' ? 'consulta automática' : 'cadastrada', '')),
      el('h3', { style: 'margin:0 0 8px' }, m.descricao),
      master ? linha('Empresa', m.empresa) : null,
      linha(m.sem_hora ? 'Data' : 'Data e hora', quandoMulta(m)), linha('Local', [m.local_texto, m.municipio].filter(Boolean).join(' · ') || '—'),
      linha('Auto / órgão', [m.auto_infracao, m.orgao, m.infracao_codigo ? `código ${m.infracao_codigo}` : null].filter(Boolean).join(' · ') || '—'),
      linha('Valor', m.valor_centavos !== null ? dinheiro(m.valor_centavos) : '—'),
      linha('Indicar o condutor até', prazoTexto(m.dias_indicacao, m.prazo_indicacao)), linha('Vencimento', prazoTexto(m.dias_vencimento, m.vencimento)),
      linha('Condutor indicado', m.motorista ?? '—'),
      m.observacao ? linha('Observação', m.observacao) : null,
      el('h4', { style: 'margin:16px 0 6px' }, 'Notificação'),
      m.arquivos.length ? el('div', { class: 'linha', style: 'gap:8px;flex-wrap:wrap' }, m.arquivos.map((a, i) => botao([icone('multa'), a.tipo === 'application/pdf' ? `PDF ${i + 1}` : `Foto ${i + 1}`], '',
        () => abrirArquivo(master ? `/master/multas/arquivos/${a.id}` : `/empresas/${ctx.empresaId}/multas/arquivos/${a.id}`))))
        : el('p', { class: 'mudo pequeno', style: 'margin:0' }, 'Nenhum arquivo anexado.'),
      el('h4', { style: 'margin:16px 0 6px' }, 'No rastreamento, no horário da multa'), cruz,
      acoes,
    ];
  }, { largo: true });
}

async function telaMultas(ctx, { master = false } = {}) {
  const gestor = master || !ctx.somenteLeitura;
  const filtros = { situacao: '', empresa_id: '' };
  const corpo = el('div');
  async function carregar() {
    const q = new URLSearchParams(Object.entries(filtros).filter(([, x]) => x));
    const dados = await api.get(`${master ? '/master' : `/empresas/${ctx.empresaId}`}/multas${q.size ? `?${q}` : ''}`);
    const r = dados.resumo;
    const filtroSit = escolha(null, 'situacao', { '': 'Todas as situações', ...dados.situacoes }, filtros.situacao);
    filtroSit.addEventListener('change', () => { filtros.situacao = filtroSit.value; carregar(); });
    const filtroEmp = master ? escolha(null, 'empresa_id', { '': 'Todas as empresas', ...Object.fromEntries(dados.empresas.map((e) => [e.id, e.nome])) }, filtros.empresa_id) : null;
    filtroEmp?.addEventListener('change', () => { filtros.empresa_id = filtroEmp.value; carregar(); });
    limpar(corpo,
      el('div', { class: 'grade' },
        indicador('Em aberto', String(r.em_aberto), `${r.total} no total`, r.em_aberto ? 'aviso' : 'ok', 'multa'),
        indicador('Valor em aberto', dinheiro(r.valor_aberto_centavos), 'multas não pagas', r.valor_aberto_centavos ? 'erro' : '', 'carteira'),
        indicador('Indicar condutor', String(r.indicar_7_dias), 'prazo vence em até 7 dias', r.indicar_7_dias ? 'erro' : 'ok', 'motoristas'),
        indicador('Sem condutor', String(r.sem_condutor), 'multas em aberto sem motorista', r.sem_condutor ? 'aviso' : 'ok', 'usuarios')),
      cartao(null,
        el('div', { class: 'linha entre', style: 'gap:10px;flex-wrap:wrap;margin-bottom:12px' },
          el('div', { class: 'linha', style: 'gap:8px;flex-wrap:wrap' }, filtroEmp, filtroSit),
          el('div', { class: 'linha', style: 'gap:8px;flex-wrap:wrap' },
            !master && gestor && dados.consulta_automatica ? botao('Consultar agora', '', async () => {
              const x = await api.post(`/empresas/${ctx.empresaId}/multas/consultar`, {});
              toast(`${x.consultados} veículo(s) consultado(s), ${x.novas} multa(s) nova(s).`); carregar();
            }) : null,
            !master && gestor ? botao([icone('multa'), 'Cadastrar multa'], 'primario', async () => {
              if (!dados.veiculos.length) return toast('Cadastre um veículo primeiro.', true);
              if (await formMulta(ctx, dados)) { toast('Multa cadastrada.'); carregar(); }
            }) : null)),
        el('p', { class: 'pequeno mudo', style: 'margin:0 0 10px' }, dados.consulta_automatica
          ? (dados.automatica?.intervalo_dias ? `Consulta automática ligada (DETRAN-${dados.automatica.uf}): os veículos são consultados ${INTERVALO[dados.automatica.intervalo_dias]}.` : `Consulta ligada ao DETRAN-${dados.automatica?.uf ?? 'SP'} no modo manual: use "Consultar agora" ou a aba Consultar débitos.`)
          : 'Consulta automática (DETRAN/SENATRAN): aguardando a contratação do serviço de consulta. Por enquanto, cadastre as multas com a notificação.'),
        tabela(['Data', 'Placa', master ? 'Empresa' : null, 'Infração', '>Valor', 'Condutor', '^Situação', 'Indicar até', '^'].filter(Boolean), dados.multas.map((m) => el('tr', { style: 'cursor:pointer', onclick: () => detalheMulta(ctx, dados, m.id, { master, gestor, aoMudar: carregar }) },
          td(quandoMulta(m)), td(el('strong', {}, placa(m.placa))), master ? td(m.empresa) : null,
          td([m.descricao, el('div', { class: 'pequeno mudo' }, [m.auto_infracao, m.orgao, m.gravidade ? GRAV[m.gravidade] : null].filter(Boolean).join(' · '))]),
          td(m.valor_centavos !== null ? dinheiro(m.valor_centavos) : '—', 'dir num'), td(m.motorista ?? el('span', { class: 'mudo' }, 'sem condutor')),
          td(etiqueta(dados.situacoes[m.situacao], TOM[m.situacao]), 'centro'),
          td(m.situacao === 'notificada' ? prazoTexto(m.dias_indicacao, m.prazo_indicacao) : '—'),
          el('td', { class: 'acoes' }, botaoIcone('multa', 'Abrir a multa', (e) => { e?.stopPropagation?.(); detalheMulta(ctx, dados, m.id, { master, gestor, aoMudar: carregar }); }))))
          .filter(Boolean), 'Nenhuma multa por aqui.')));
  }
  const credito = el('div');
  limpar(ctx.conteudo, master ? null : credito, corpo);
  if (!master) faixaCredito(ctx, credito).catch(() => {});
  await carregar();
}

// ---------- Consultar multas (na hora) ----------
const TIPO_APONT = { ipva: 'IPVA', licenciamento: 'Licenciamento', dpvat: 'DPVAT', restricao: 'Restrição', roubo_furto: 'Roubo / furto', recall: 'Recall',
  gravame: 'Gravame (financiamento)', renajud: 'RENAJUD (judicial)', bloqueio: 'Bloqueio' };

const TIPOS_CONSULTA = { completa: 'Completa', renainf: 'Rápida (Renainf)', resumida: 'Simples (resumida)' };
function resultadoConsulta(r) {
  const nada = !r.multas.length && !r.apontamentos.length;
  return el('div', { class: 'coluna', style: 'gap:12px' },
    el('div', { class: 'linha entre', style: 'flex-wrap:wrap;gap:8px' },
      el('div', {}, el('strong', { style: 'font-size:20px' }, placa(r.placa)), el('div', { class: 'pequeno mudo' },
        `${TIPOS_CONSULTA[r.tipo ?? 'completa']} · consultado em ${dataHora(r.consultado_em)}${r.duracao_s != null ? ` · levou ${r.duracao_s} s` : ''}${r.veiculo_da_frota ? ' · veículo da frota' : ' · fora da frota'}`)),
      el('div', { class: 'linha', style: 'gap:6px;flex-wrap:wrap' }, r.homolog ? etiqueta('TESTE · dados de exemplo, sem cobrança', 'info') : null,
        r.custo ? etiqueta(`custo: R$ ${r.custo}`, '') : null,
        nada ? etiqueta('Nada consta', 'ok') : etiqueta(`${r.multas.length} multa(s) · ${r.apontamentos.length} apontamento(s)`, 'erro'),
      r.pdf ? el('a', { class: 'btn pequeno', href: r.pdf, target: '_blank', rel: 'noopener noreferrer' }, icone('multa'), 'PDF da consulta') : null)),
    nada ? el('div', { class: 'cartao', style: 'text-align:center;padding:22px' }, el('div', { style: 'font-size:34px' }, '✅'), el('strong', {}, 'Nenhuma multa e nenhum apontamento para esta placa.')) : null,
    r.multas.length ? cartao(`Multas (${r.multas.length})`, tabela(['Data', 'Infração', '>Valor', '^Central', '^'], r.multas.map((m) => el('tr', {},
      td(quandoMulta(m)), td([m.descricao, el('div', { class: 'pequeno mudo' }, [m.auto_infracao, m.orgao, m.gravidade ? GRAV[m.gravidade] : null].filter(Boolean).join(' · '))]),
      td(m.valor_centavos !== null ? dinheiro(m.valor_centavos) : '—', 'dir num'),
      td(m.nova ? etiqueta('nova · adicionada', 'aviso') : m.na_central ? etiqueta('já na central', 'ok') : etiqueta(r.homolog ? 'teste' : r.veiculo_da_frota ? 'não adicionada' : 'fora da frota', ''), 'centro'),
      el('td', { class: 'acoes' }, botao([icone('multa'), 'Ver multa'], '', () => fichaMulta(m, { placaTxt: r.placa, origem: `Consulta ${r.homolog ? 'de teste ' : ''}feita em ${dataHora(r.consultado_em)} (DETRAN / prefeitura / Renainf).` }))))))) : null,
    r.apontamentos.length ? cartao(r.resumida ? 'Resumo dos débitos (consulta simples, sem a lista das multas)' : `Apontamentos (${r.apontamentos.length})`, tabela(['Tipo', 'Descrição', '>Valor', 'Situação'], r.apontamentos.map((a) => el('tr', {},
      td(el('strong', {}, a.tipo === 'resumo' ? 'Resumo' : TIPO_APONT[a.tipo] ?? a.tipo)), td(a.descricao || '—'), td(a.valor_centavos !== null ? dinheiro(a.valor_centavos) : '—', 'dir num'), td(a.situacao ?? '—'))))) : null);
}

async function telaConsultar(ctx, { master = false } = {}) {
  const base = master ? '/master/multas' : `/empresas/${ctx.empresaId}/multas`;
  const podeConsultar = master || !ctx.somenteLeitura;
  const resultado = el('div');
  const historicoEl = el('div');
  const situacaoEl = el('div');
  async function carregar() {
    const d = await api.get(`${base}/consultas`);
    const a = d.automatica;
    limpar(situacaoEl, el('div', { class: `aviso-faixa ${d.ligada ? 'ok' : 'aviso'}`, style: 'padding:12px 14px;border-radius:12px;margin-bottom:14px;background:var(--surface-2)' },
      d.ligada
        ? el('div', {}, el('strong', {}, `● Consulta ligada${a.fornecedor === 'apibrasil' ? ' à API Brasil' : ''} (${a.uf})${a.homolog ? ' — EM TESTE, dados de exemplo e sem cobrança' : ''}. `),
          a.intervalo_dias ? `Automática ${INTERVALO[a.intervalo_dias]}, de madrugada, em ${a.veiculos} carro(s) escolhido(s)${a.ultima ? ` (última em ${dataHora(a.ultima)})` : ''}; e consulta na hora quando quiser, abaixo.`
            : 'Consulte um veículo quando quiser abaixo; as multas dos veículos da frota entram na central.')
        : el('div', {}, el('strong', {}, '● Consulta aguardando o serviço. '), 'Quando o serviço de consulta (DETRAN) for ligado no servidor, a consulta passa a funcionar.')));
    const temLixo = d.consultas.some((c) => c.erro || c.status === 'erro');
    limpar(historicoEl, cartao('Consultas feitas',
      podeConsultar ? el('div', { class: 'linha', style: 'justify-content:flex-end;margin:-6px 0 8px' }, botao('Limpar erros e testes', temLixo ? 'perigo' : '', async () => {
        if (!await confirmar('Limpar o histórico', 'Apaga as consultas com erro e as de teste. As que deram certo ficam.', 'Limpar')) return;
        const x = await api.del(`${base}/consultas/limpar`);
        toast(`${x.apagadas} consulta(s) apagada(s).`); carregar();
      })) : null,
      tabela(['Quando', 'Placa', master ? 'Empresa' : null, '^Multas', '^Apontamentos', '^Novas', 'Por', '^'].filter(Boolean),
      d.consultas.map((c) => el('tr', {}, td(dataHora(c.criado_em)), td(el('strong', {}, placa(c.placa))), master ? td(c.empresa ?? '—') : null,
        td(c.status === 'consultando' ? etiqueta('consultando…', 'aviso') : c.erro ? etiqueta('erro', 'erro') : String(c.multas), 'centro'), td(c.erro || c.status === 'consultando' ? '—' : String(c.apontamentos), 'centro'), td(String(c.novas), 'centro'), td(c.usuario ?? 'automática'),
        el('td', { class: 'acoes' }, c.status === 'consultando' ? null : c.erro ? el('span', { class: 'pequeno mudo', title: c.erro }, 'falhou') : botaoIcone('olho', 'Ver o resultado', async () => {
          const x = await api.get(`${base}/consultas/${c.id}`);
          modal(`Consulta · ${placa(x.placa)}`, () => [resultadoConsulta(x.resultado)], { largo: true });
        })))), 'Nenhuma consulta feita ainda.')));
    return d;
  }
  const credito = el('div');
  const d = await (async () => { limpar(ctx.conteudo, master ? null : credito, situacaoEl); return carregar(); })();
  const cred = master ? null : await faixaCredito(ctx, credito).catch(() => null);
  const preco = (t, custo) => (cred ? reaisTxt(cred.precos[t]) : custo);
  const selVeic = escolha('Veículo da frota', 'veiculo', { '': '— digitar a placa —', ...Object.fromEntries((d.veiculos ?? []).map((v) => [v.id, `${placa(v.placa)}${v.descricao ? ` · ${v.descricao}` : ''}`])) }, '');
  const selTipo = escolha('Tipo de consulta', 'tipo', { completa: `Completa — multas, IPVA, licenciamento e restrições (${preco('completa', 'R$ 8,00')})`, renainf: `Rápida — só multas do Renainf (${preco('renainf', 'R$ 3,45')})`,
    resumida: `Simples — só se tem débito e o total (${preco('resumida', 'R$ 3,78')})` }, (() => { try { return localStorage.getItem('rastreador.multas.tipo') || 'completa'; } catch { return 'completa'; } })());
  selTipo.querySelector('select').addEventListener('change', (e) => { try { localStorage.setItem('rastreador.multas.tipo', e.target.value); } catch { /* sem armazenamento */ } });
  const inPlaca = campo('Placa', { name: 'placa', maxlength: 8, placeholder: 'ABC1D23', style: 'text-transform:uppercase' });
  const inRenavam = campo('RENAVAM (opcional, alguns estados exigem)', { name: 'renavam', inputmode: 'numeric', maxlength: 11 });
  selVeic.querySelector('select')?.addEventListener('change', (e) => {
    const v = (d.veiculos ?? []).find((x) => String(x.id) === e.target.value);
    inPlaca.querySelector('input').value = v ? placa(v.placa) : '';
    inRenavam.querySelector('input').value = v?.renavam ?? '';
  });
  const botaoConsultar = el('button', { class: 'btn primario', type: 'submit', disabled: !podeConsultar }, icone('lupa'), 'Consultar');
  async function consultar(forcar = false) {
    const placaTxt = inPlaca.querySelector('input').value.trim();
    if (!placaTxt) return toast('Informe a placa.', true);
    botaoConsultar.disabled = true;
    const texto = el('p', { class: 'mudo' }, `Consultando ${placaTxt.toUpperCase()} no DETRAN, na prefeitura e no Renainf…`);
    limpar(resultado, el('div', { class: 'carregando-linha' }), texto,
      el('p', { class: 'pequeno mudo', style: 'margin:0' }, 'Pode levar alguns minutos (o DETRAN às vezes demora). Pode sair desta tela: o resultado fica guardado em "Consultas feitas".'));
    try {
      const ini = await api.post(`${base}/consultar-placa`, { placa: placaTxt, renavam: inRenavam.querySelector('input').value, forcar, tipo: selTipo.querySelector('select').value });
      const t0 = Date.now();
      let c;
      if (ini.guardada) {
        // Já consultada nas últimas 24 h: mostra na hora, sem esperar nem pagar de novo.
        c = await api.get(`${base}/consultas/${ini.id}`);
        const horas = Math.max(1, Math.round((Date.now() - Date.parse(ini.consultado_em)) / 3_600_000));
        limpar(resultado,
          el('div', { class: 'linha entre', style: 'gap:10px;flex-wrap:wrap;padding:10px 14px;border-radius:12px;background:var(--surface-2);margin-bottom:10px' },
            el('span', { class: 'pequeno' }, `⚡ Resultado guardado da consulta de ${dataHora(ini.consultado_em)} (há ${horas < 2 ? 'menos de 2' : horas} h) — aberto na hora, sem custo.`),
            botao([icone('lupa'), 'Consultar de novo agora'], '', () => consultar(true))),
          resultadoConsulta(c.resultado));
        return;
      }
      for (;;) {
        await new Promise((ok) => { setTimeout(ok, 1500); });
        if (!resultado.isConnected) return; // saiu da tela: o resultado fica no histórico
        c = await api.get(`${base}/consultas/${ini.id}`);
        if (c.status !== 'consultando') break;
        texto.textContent = `Consultando ${ini.placa} no DETRAN, na prefeitura e no Renainf… ${Math.round((Date.now() - t0) / 1000)} s`;
        if (Date.now() - t0 > 330_000) throw new Error('A consulta está demorando mais que o normal. O resultado aparece em "Consultas feitas" quando chegar.');
      }
      if (c.status === 'erro') throw new Error(c.erro);
      limpar(resultado, resultadoConsulta(c.resultado));
      if (c.resultado.novas) toast(`${c.resultado.novas} multa(s) nova(s) adicionada(s) à central.`);
    } catch (err) {
      limpar(resultado, el('p', { class: 'aviso erro' }, err.message));
    } finally { botaoConsultar.disabled = !podeConsultar; carregar(); if (!master) faixaCredito(ctx, credito).catch(() => {}); }
  }
  const form = el('form', { class: 'form', onsubmit: (e) => { e.preventDefault(); consultar(false); } },
    master ? null : selVeic,
    el('div', { class: 'duas' }, inPlaca, inRenavam),
    selTipo,
    el('div', { class: 'linha', style: 'justify-content:flex-end' }, botaoConsultar));
  // Consulta automática: o gestor escolhe os carros, a frequência e o tipo; roda de madrugada.
  const autoEl = el('div');
  async function desenharAuto() {
    if (master) return;
    const a = await api.get(`${base}/automatica`);
    const checks = a.veiculos.map((v) => marcar(`${placa(v.placa)}${v.descricao ? ` · ${v.descricao}` : ''}${v.multas_consulta_em ? ` — última consulta ${dataHora(v.multas_consulta_em)}` : ''}`, { value: v.id, checked: Boolean(v.multas_auto) }));
    const selDias = escolha('Frequência', 'dias', { 0: 'Desligada', 7: 'Semanal', 15: 'Quinzenal', 30: 'Mensal' }, a.dias);
    const selT = escolha('Tipo de consulta', 'tipo', { completa: `Completa (R$ ${(a.precos.completa / 100).toFixed(2).replace('.', ',')})`, renainf: `Rápida — Renainf (R$ ${(a.precos.renainf / 100).toFixed(2).replace('.', ',')})`,
      resumida: `Simples — resumida (R$ ${(a.precos.resumida / 100).toFixed(2).replace('.', ',')})` }, a.tipo);
    const estimativa = el('p', { class: 'pequeno', style: 'margin:8px 0 0' });
    const calcular = () => {
      const n = checks.filter((c) => c.querySelector('input').checked).length;
      const dias = Number(selDias.querySelector('select').value);
      const preco = a.precos[selT.querySelector('select').value];
      const porMes = dias ? 30 / dias : 0;
      estimativa.textContent = dias && n ? `≈ ${Math.round(n * porMes)} consulta(s) por mês · custo estimado ${dinheiro(Math.round(n * porMes * preco))}/mês (de madrugada, entre 1h e 5h).` : dias ? 'Marque os carros que serão consultados.' : 'Desligada: só a consulta na hora, quando alguém pedir.';
    };
    [...checks.map((c) => c.querySelector('input')), selDias.querySelector('select'), selT.querySelector('select')].forEach((x) => x.addEventListener('change', calcular));
    const todos = el('button', { type: 'button', class: 'btn pequeno', onclick: () => { const marcar_ = !checks.every((c) => c.querySelector('input').checked); checks.forEach((c) => { c.querySelector('input').checked = marcar_; }); calcular(); } }, 'Marcar / desmarcar todos');
    calcular();
    limpar(autoEl, cartao('Consulta automática',
      el('p', { class: 'mudo', style: 'margin:0 0 12px' }, 'Escolha os carros que o sistema consulta sozinho, de madrugada. As multas novas entram na central e geram aviso.'),
      el('div', { class: 'duas' }, selDias, selT),
      el('div', { class: 'linha entre', style: 'margin:10px 0 6px;flex-wrap:wrap;gap:8px' }, el('strong', { class: 'pequeno' }, `Carros (${a.veiculos.length})`), podeConsultar ? todos : null),
      a.veiculos.length ? el('div', { class: 'lista-marcar' }, checks) : el('p', { class: 'mudo' }, 'Nenhum veículo ativo.'),
      estimativa,
      podeConsultar ? el('div', { class: 'linha', style: 'justify-content:flex-end;margin-top:10px' }, botao('Salvar', 'primario', async () => {
        const r2 = await api.put(`${base}/automatica`, { dias: Number(selDias.querySelector('select').value), tipo: selT.querySelector('select').value,
          veiculos: checks.filter((c) => c.querySelector('input').checked).map((c) => Number(c.querySelector('input').value)) });
        toast(r2.dias ? `Consulta automática salva: ${r2.marcados} carro(s), ${INTERVALO[r2.dias]}.` : 'Consulta automática desligada.');
        carregar(); desenharAuto();
      })) : null));
  }
  desenharAuto();
  ctx.conteudo.append(
    cartao('Consultar débitos', el('p', { class: 'mudo', style: 'margin:0 0 12px' }, 'Veja na hora se um veículo tem multas ou outros débitos e apontamentos (IPVA, licenciamento, restrição, roubo/furto). As multas dos veículos da frota entram sozinhas na central.'), form),
    resultado, autoEl, historicoEl);
}

// ---------- Master: créditos e preços (o produto) ----------
async function telaCreditosMaster(ctx) {
  const corpo = el('div');
  const reaisEm = (c) => (c === null || c === undefined ? '' : (c / 100).toFixed(2).replace('.', ','));
  async function carregar() {
    const d = await api.get('/master/multas/creditos');
    const abertas = d.recargas.filter((x) => ['pendente', 'informado'].includes(x.status));
    const cfgForm = el('form', { class: 'form', onsubmit: async (e) => {
      e.preventDefault();
      const f = e.target;
      await api.put('/master/multas/creditos/config', { pix_chave: f.pix_chave.value, pix_nome: f.pix_nome.value, pix_cidade: f.pix_cidade.value,
        precos: { completa: centavos(f.p_completa.value), renainf: centavos(f.p_renainf.value), resumida: centavos(f.p_resumida.value) } });
      toast('Configuração salva.'); carregar();
    } },
      el('div', { class: 'tres' },
        campo('Chave PIX que recebe as recargas', { name: 'pix_chave', maxlength: 77, value: d.config.pix_chave ?? '', placeholder: 'CNPJ, e-mail, telefone ou chave aleatória' }),
        campo('Nome do recebedor', { name: 'pix_nome', maxlength: 25, value: d.config.pix_nome ?? '' }),
        campo('Cidade', { name: 'pix_cidade', maxlength: 15, value: d.config.pix_cidade ?? 'SAO PAULO' })),
      el('div', { class: 'tres' },
        campo('Preço de venda padrão — Completa (R$)', { name: 'p_completa', inputmode: 'decimal', value: reaisEm(d.config.precos.completa) }),
        campo('Rápida — Renainf (R$)', { name: 'p_renainf', inputmode: 'decimal', value: reaisEm(d.config.precos.renainf) }),
        campo('Simples — resumida (R$)', { name: 'p_resumida', inputmode: 'decimal', value: reaisEm(d.config.precos.resumida) })),
      el('p', { class: 'pequeno mudo', style: 'margin:0' }, 'Custo na API Brasil: Completa R$ 8,00 · Rápida R$ 3,45 · Simples R$ 3,78. O preço de venda é o que sai do crédito da empresa.'),
      el('div', { class: 'linha', style: 'justify-content:flex-end' }, el('button', { class: 'btn primario' }, 'Salvar')));
    limpar(corpo,
      abertas.length ? cartao(`Recargas para confirmar (${abertas.length})`, tabela(['Quando', 'Empresa', '>Valor', 'Identificador', 'Situação', '^'], abertas.map((x) => el('tr', {},
        td(dataHora(x.criado_em)), td(el('strong', {}, x.empresa)), td(dinheiro(x.valor_centavos), 'dir num'), td(el('span', { class: 'mono pequeno' }, x.txid)),
        td(etiqueta(x.status === 'informado' ? 'cliente informou que pagou' : 'aguardando pagamento', x.status === 'informado' ? 'aviso' : '')),
        el('td', { class: 'acoes' },
          botao('Confirmar pagamento', 'primario', async () => {
            if (!await confirmar('Confirmar recarga', `Confira no extrato do banco o PIX de ${dinheiro(x.valor_centavos)} (${x.txid}) de ${x.empresa}. O crédito entra na hora.`, 'Confirmar')) return;
            await api.post(`/master/multas/creditos/pix/${x.id}/confirmar`, {}); toast('Crédito liberado.'); carregar();
          }),
          botao('Cancelar', '', async () => { await api.post(`/master/multas/creditos/pix/${x.id}/cancelar`, {}); toast('Recarga cancelada.'); carregar(); })))))) : null,
      cartao('Empresas: crédito e preços', tabela(['Empresa', '>Crédito', 'Completa', 'Rápida', 'Simples', '^'], d.empresas.map((e) => el('tr', {},
        td(el('strong', {}, e.nome)), td(el('strong', { style: `color:${e.saldo_centavos > 0 ? 'var(--ok)' : 'var(--text-3)'}` }, dinheiro(e.saldo_centavos)), 'dir num'),
        ...['completa', 'renainf', 'resumida'].map((t) => td([dinheiro(e.precos[t]), e[`multas_preco_${t}`] === null ? el('div', { class: 'pequeno mudo' }, 'padrão') : null])),
        el('td', { class: 'acoes' },
          botao('Preços', '', async () => {
            const r = await formModal(`Preços de venda · ${e.nome}`, () => [
              el('p', { class: 'mudo', style: 'margin:0' }, 'Deixe em branco para usar o preço padrão.'),
              el('div', { class: 'tres' }, ...['completa', 'renainf', 'resumida'].map((t) => campo(`${NOMES_TIPO[t]} (R$)`, { name: t, inputmode: 'decimal', value: reaisEm(e[`multas_preco_${t}`]), placeholder: reaisEm(d.config.precos[t]) }))),
            ], (f) => api.put(`/master/multas/creditos/empresas/${e.id}/precos`, { completa: centavos(f.completa) ?? null, renainf: centavos(f.renainf) ?? null, resumida: centavos(f.resumida) ?? null }));
            if (r) { toast('Preços salvos.'); carregar(); }
          }),
          botao('Lançar crédito', '', async () => {
            const r = await formModal(`Lançar crédito · ${e.nome}`, () => [
              el('p', { class: 'mudo', style: 'margin:0' }, 'Use valor negativo para descontar (ex.: -10,00).'),
              campo('Valor (R$)', { name: 'valor', inputmode: 'decimal', required: true }), campo('Descrição', { name: 'descricao', maxlength: 120, placeholder: 'Ex.: cortesia, pagamento em dinheiro…' }),
            ], (f) => api.post(`/master/multas/creditos/empresas/${e.id}/ajuste`, { valor_centavos: String(f.valor).trim().startsWith('-') ? -centavos(String(f.valor).replace('-', '')) : centavos(f.valor), descricao: f.descricao || undefined }));
            if (r) { toast('Crédito lançado.'); carregar(); }
          })))), 'Nenhuma empresa.')),
      cartao('Recarga por PIX e preços padrão', cfgForm),
      cartao('Últimas recargas', tabela(['Quando', 'Empresa', '>Valor', 'Situação'], d.recargas.slice(0, 20).map((x) => el('tr', {}, td(dataHora(x.criado_em)), td(x.empresa), td(dinheiro(x.valor_centavos), 'dir num'),
        td(etiqueta({ pendente: 'aguardando', informado: 'informado', pago: 'creditado', cancelado: 'cancelado' }[x.status], x.status === 'pago' ? 'ok' : x.status === 'cancelado' ? '' : 'aviso')))), 'Nenhuma recarga ainda.')));
  }
  limpar(ctx.conteudo, corpo);
  await carregar();
}

export const TELAS_MULTAS = { multas: (ctx) => telaMultas(ctx), 'multas-consultar': (ctx) => telaConsultar(ctx) };
export const TELAS_MULTAS_MASTER = { multas: (ctx) => telaMultas(ctx, { master: true }), 'multas-consultar': (ctx) => telaConsultar(ctx, { master: true }), 'multas-creditos': telaCreditosMaster };
