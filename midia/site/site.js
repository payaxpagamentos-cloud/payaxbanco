/**
 * Site do Vai Mídia: menu em telas pequenas, números da rede e o formulário de contato.
 *
 * O formulário manda para a mesma API do painel (`POST /api/contato`), e o pedido entra no CRM como
 * lead com origem "site" — ninguém precisa copiar e-mail para planilha nenhuma.
 *
 * O site pode ser servido pelo próprio servidor (em /midia/site/) ou hospedado separado. Por isso o
 * endereço da API não é fixo: ele é descoberto na primeira vez que precisa, testando os caminhos
 * prováveis. Para fixar, basta pôr <body data-api="https://…/midia/api/"> no HTML.
 */

const CANDIDATOS = () => [
  // O endereço vem pronto quando é o próprio servidor que serve o site; os outros são a tentativa
  // para quem hospeda a pasta separada. Tudo vira URL absoluta, que é o que o fetch entende.
  document.body.dataset.api,
  '../api/',
  '/midia/api/',
  '/api/',
].filter(Boolean).map((x) => new URL(x, location.href).href);

let apiPromessa = null;

/** Devolve o endereço da API (ou null quando o site está hospedado sem o servidor por perto). */
function api() {
  apiPromessa ??= (async () => {
    for (const base of CANDIDATOS()) {
      try {
        const r = await fetch(new URL('publico', base), { headers: { Accept: 'application/json' } });
        if (r.ok) return base;
      } catch { /* tenta o próximo */ }
    }
    return null;
  })();
  return apiPromessa;
}

// ----------------------------------------------------------------- Menu em telas pequenas
const topo = document.querySelector('.topo');
const botaoMenu = document.querySelector('.menu-botao');
botaoMenu?.addEventListener('click', () => {
  const aberto = topo.classList.toggle('aberto');
  botaoMenu.setAttribute('aria-expanded', String(aberto));
  botaoMenu.setAttribute('aria-label', aberto ? 'Fechar o menu' : 'Abrir o menu');
});
for (const link of document.querySelectorAll('.menu a')) {
  link.addEventListener('click', () => topo.classList.remove('aberto'));
}

// ----------------------------------------------------------------- Atalhos que já marcam a intenção
for (const botao of document.querySelectorAll('[data-intencao]')) {
  botao.addEventListener('click', () => {
    const escolha = document.querySelector(`input[name=tipo][value="${botao.dataset.intencao}"]`);
    if (escolha) escolha.checked = true;
  });
}

document.getElementById('ano').textContent = String(new Date().getFullYear());

// ----------------------------------------------------------------- Números da rede (ao vivo)
const inteiro = (n) => Number(n ?? 0).toLocaleString('pt-BR');

(async () => {
  const base = await api();
  if (!base) return;
  try {
    const d = await fetch(new URL('publico/rede', base)).then((r) => (r.ok ? r.json() : null));
    // Rede ainda pequena demais para virar argumento de venda: melhor não mostrar número nenhum.
    if (!d || !d.telas) return;
    const caixa = document.getElementById('numeros');
    for (const [chave, valor] of Object.entries(d)) {
      const alvo = caixa.querySelector(`[data-numero="${chave}"]`);
      if (alvo) alvo.textContent = inteiro(valor);
    }
    caixa.hidden = false;
  } catch { /* sem números, o site segue igual */ }
})();

// ----------------------------------------------------------------- Formulário de contato
const form = document.getElementById('form-contato');
const resposta = document.getElementById('resposta');

const mostrar = (texto, erro = false) => {
  resposta.textContent = texto;
  resposta.classList.toggle('erro', erro);
  resposta.hidden = false;
};

form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const dados = Object.fromEntries(new FormData(form));
  if (!String(dados.nome ?? '').trim()) return mostrar('Diga o nome da empresa ou do condomínio.', true);
  if (!String(dados.email ?? '').trim() && !String(dados.telefone ?? '').trim()) {
    return mostrar('Deixe um e-mail ou um telefone para a gente responder.', true);
  }

  const botao = form.querySelector('button[type=submit]');
  botao.disabled = true;
  botao.textContent = 'Enviando…';
  try {
    const base = await api();
    if (!base) throw new Error('sem servidor');
    const r = await fetch(new URL('contato', base), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dados),
    });
    const corpo = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(corpo.erro ?? 'não deu certo');
    mostrar(corpo.mensagem ?? 'Recebemos o seu contato. A equipe responde em breve.');
    form.reset();
  } catch (err) {
    // Nunca deixar a pessoa sem saída: se o envio falhar, fica o caminho direto.
    mostrar(`${err.message === 'sem servidor' ? 'Não conseguimos enviar agora' : `Não deu certo: ${err.message}`}. `
      + 'Fale com a gente por contato@vaimidia.com.br ou (19) 0000-0000.', true);
  } finally {
    botao.disabled = false;
    botao.textContent = 'Enviar';
  }
});

// O link do painel acompanha onde o site está servido.
(async () => {
  const base = await api();
  if (!base) return;
  const painel = new URL('../', base).href;
  for (const link of document.querySelectorAll('[data-painel]')) link.href = painel;
})();
