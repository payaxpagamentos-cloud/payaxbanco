// ===== Templating seguro =====
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(s);

/** Template literal que escapa interpolações (exceto raw() e arrays de raw). */
export function html(strings, ...vals) {
  const conv = (v) => {
    if (v instanceof Raw) return v.s;
    if (Array.isArray(v)) return v.map(conv).join('');
    if (v === false || v === null || v === undefined) return '';
    return esc(v);
  };
  return raw(strings.reduce((acc, s, i) => acc + s + (i < vals.length ? conv(vals[i]) : ''), ''));
}

export const $ = (sel, raiz = document) => raiz.querySelector(sel);
export const $$ = (sel, raiz = document) => [...raiz.querySelectorAll(sel)];

// ===== Formatação =====
const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const moeda = (centavos) => BRL.format((Number(centavos) || 0) / 100);
export const moedaSinal = (c) => html`<span class="num ${c < 0 ? 'neg' : c > 0 ? 'pos' : ''}">${c > 0 ? '+' : ''}${moeda(c)}</span>`;
export const numero = (n) => new Intl.NumberFormat('pt-BR').format(Number(n) || 0);
export const pct = (taxa) => `${(Number(taxa) * 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;

const utc = (s) => (s && !/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? new Date(s.replace(' ', 'T') + 'Z') : new Date(s));
export const dataHora = (s) => (s ? utc(s).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
export const data = (s) => {
  if (!s) return '—';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s.split('-').reverse().join('/');
  return utc(s).toLocaleDateString('pt-BR');
};

export function documento(d) {
  const s = String(d ?? '').replace(/\D/g, '');
  if (s.length === 11) return s.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (s.length === 14) return s.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return d ?? '—';
}
export function telefone(t) {
  const s = String(t ?? '').replace(/\D/g, '');
  if (s.length === 11) return s.replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3');
  if (s.length === 10) return s.replace(/(\d{2})(\d{4})(\d{4})/, '($1) $2-$3');
  return t || '—';
}
export const cep = (c) => (c ? String(c).replace(/(\d{5})(\d{3})/, '$1-$2') : '—');
export const iniciais = (nome) => String(nome ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase();

export const TIPO_CONTA = { corrente: 'Corrente', poupanca: 'Poupança', pagamento: 'Pagamento', salario: 'Salário' };
export const TIPO_TRANSACAO = {
  deposito: 'Depósito', saque: 'Saque', transferencia_enviada: 'Transferência enviada', transferencia_recebida: 'Transferência recebida',
  pix_enviado: 'PIX enviado', pix_recebido: 'PIX recebido', emprestimo_credito: 'Crédito de empréstimo', emprestimo_parcela: 'Parcela de empréstimo',
  estorno: 'Estorno', tarifa: 'Tarifa',
};
const CLASSE_STATUS = { ativo: 'ok', ativa: 'ok', quitado: 'ok', paga: 'ok', inativo: '', encerrada: '', cancelado: '', bloqueado: 'danger', bloqueada: 'danger', aberta: 'warn', vencida: 'danger' };
export const status = (s) => html`<span class="badge ${CLASSE_STATUS[s] ?? 'info'}">${s ? s[0].toUpperCase() + s.slice(1) : '—'}</span>`;
export const conta = (c) => `${c.agencia ?? '0001'} / ${c.numero}-${c.digito}`;

// ===== Entrada de moeda =====
/** Converte texto "1.234,56" em centavos inteiros. */
export function centavos(texto) {
  const s = String(texto ?? '').replace(/[^\d,.-]/g, '');
  if (!s) return 0;
  const normal = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  return Math.round(Number(normal) * 100) || 0;
}
export function mascaraMoeda(input) {
  input.addEventListener('focus', () => input.select());
  input.addEventListener('input', () => {
    const dig = input.value.replace(/\D/g, '').replace(/^0+/, '');
    const n = Number(dig || '0');
    input.value = (n / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  });
}
export const valorMoedaInput = (c) => ((Number(c) || 0) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function mascaraDocumento(input) {
  input.addEventListener('input', () => {
    const d = input.value.replace(/\D/g, '').slice(0, 14);
    input.value = d.length <= 11
      ? d.replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d{1,2})$/, '$1-$2')
      : d.replace(/(\d{2})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1/$2').replace(/(\d{4})(\d{1,2})$/, '$1-$2');
  });
}

// ===== Toast / Modal =====
export function toast(msg, tipo = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${tipo === 'erro' ? 'erro' : ''}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), tipo === 'erro' ? 6000 : 3500);
}

/**
 * Abre um modal. `corpo` é html; `aoEnviar(form, fechar)` é chamado no submit.
 * Retorna { el, fechar }.
 */
export function modal({ titulo, corpo, rodape, grande = false, aoEnviar, rotuloEnviar = 'Salvar', aoAbrir }) {
  const root = $('#modal-root');
  const fundo = document.createElement('div');
  fundo.className = 'modal-fundo';
  const temForm = Boolean(aoEnviar);
  fundo.innerHTML = String(html`
    <div class="modal ${grande ? 'grande' : ''}" role="dialog" aria-modal="true" aria-label="${titulo}">
      ${raw(temForm ? '<form novalidate>' : '<div>')}
        <div class="modal-head"><h2>${titulo}</h2><button type="button" class="fechar" aria-label="Fechar">×</button></div>
        <div class="modal-body"><div class="erro-form hidden"></div>${corpo}</div>
        ${rodape ?? (temForm ? html`<div class="modal-foot"><button type="button" class="btn" data-cancelar>Cancelar</button><button class="btn primario" type="submit">${rotuloEnviar}</button></div>` : '')}
      ${raw(temForm ? '</form>' : '</div>')}
    </div>`);
  root.append(fundo);
  const fechar = () => { fundo.remove(); document.removeEventListener('keydown', tecla); };
  const tecla = (e) => { if (e.key === 'Escape') fechar(); };
  document.addEventListener('keydown', tecla);
  fundo.addEventListener('mousedown', (e) => { if (e.target === fundo) fechar(); });
  $$('.fechar, [data-cancelar]', fundo).forEach((b) => b.addEventListener('click', fechar));
  const form = $('form', fundo);
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const erro = $('.erro-form', fundo);
      const botao = $('button[type=submit]', form);
      erro.classList.add('hidden');
      botao.disabled = true;
      try {
        await aoEnviar(form, fechar);
      } catch (err) {
        erro.textContent = err.message;
        erro.classList.remove('hidden');
      } finally {
        botao.disabled = false;
      }
    });
  }
  $$('input.moeda', fundo).forEach(mascaraMoeda);
  $$('input[data-doc]', fundo).forEach(mascaraDocumento);
  aoAbrir?.(fundo);
  setTimeout(() => {
    if (!fundo.contains(document.activeElement)) $('input:not([type=hidden]):not([readonly]), select, textarea', fundo)?.focus();
  }, 30);
  return { el: fundo, fechar };
}

export function confirmar(titulo, mensagem, rotulo = 'Confirmar') {
  return new Promise((resolve) => {
    const { el, fechar } = modal({
      titulo,
      corpo: html`<p style="margin:0">${mensagem}</p>`,
      rodape: html`<div class="modal-foot"><button class="btn" data-nao>Cancelar</button><button class="btn primario" data-sim>${rotulo}</button></div>`,
    });
    $('[data-nao]', el).onclick = () => { fechar(); resolve(false); };
    $('[data-sim]', el).onclick = () => { fechar(); resolve(true); };
  });
}

export const dadosForm = (form) => Object.fromEntries(new FormData(form).entries());

export function paginacao({ total, pagina, limite }, aoMudar) {
  const paginas = Math.max(1, Math.ceil(total / limite));
  const el = document.createElement('div');
  el.className = 'paginacao';
  el.innerHTML = String(html`<span>${numero(total)} registro(s) · página ${pagina} de ${paginas}</span>
    <div class="row"><button class="btn sm" data-p="-1" ${raw(pagina <= 1 ? 'disabled' : '')}>‹ Anterior</button>
    <button class="btn sm" data-p="1" ${raw(pagina >= paginas ? 'disabled' : '')}>Próxima ›</button></div>`);
  $$('[data-p]', el).forEach((b) => b.addEventListener('click', () => aoMudar(pagina + Number(b.dataset.p))));
  return el;
}

export function debounce(fn, ms = 300) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export const carregando = () => html`<div class="carregando">Carregando…</div>`;

// ===== Ícones (traço simples, herdam a cor) =====
const P = {
  painel: 'M3 13h8V3H3zm10 8h8V11h-8zM3 21h8v-6H3zm10-18v6h8V3z',
  clientes: 'M16 11a4 4 0 1 0-8 0M4 21a8 8 0 0 1 16 0M12 7a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  contas: 'M3 10h18M5 6h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zm2 10h4',
  operacoes: 'M7 7h13l-4-4M17 17H4l4 4',
  pix: 'M12 2l4 4-4 4-4-4zm0 12l4 4-4 4-4-4zM2 12l4-4 4 4-4 4zm12 0l4-4 4 4-4 4z',
  emprestimos: 'M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
  transacoes: 'M4 6h16M4 12h16M4 18h10',
  relatorios: 'M9 17v-6m4 6V7m4 10v-3M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
  usuarios: 'M12 15a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0 0c-4 0-7 2-7 5h14c0-3-3-5-7-5zM19.4 10.6 21 9m-4-4 1.6-1.6',
  auditoria: 'M9 12l2 2 4-4M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  sair: 'M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3',
  mais: 'M12 5v14M5 12h14',
  menu: 'M3 6h18M3 12h18M3 18h18',
  baixar: 'M12 3v12m0 0l-4-4m4 4l4-4M4 21h16',
  chave: 'M15 7a4 4 0 1 1-3.9 5H3v3h3v3h3v-3h2.1A4 4 0 0 1 15 7z',
  banco: 'M3 21h18M5 21V10m14 11V10M9 21v-7m6 7v-7M2 10l10-6 10 6z',
  qr: 'M3 3h7v7H3zm11 0h7v7h-7zM3 14h7v7H3zm11 0h3v3h-3zm4 4h3v3h-3z',
  lua: 'M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z',
};
export const icone = (nome) => raw(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${P[nome] ?? ''}"/></svg>`);
