/*
 * PAY AX — formulário "Abra sua conta" (payax.com.br/abrir-conta).
 * Envia para /api/publico/abertura. A busca do CNPJ e do CEP usa só fontes públicas e gratuitas.
 * A conta não abre sozinha: o pedido vai para a análise da equipe PAY AX.
 */
(() => {
  'use strict';
  const form = document.querySelector('[data-abertura]');
  if (!form) return;
  const $ = (nome) => form.elements.namedItem(nome);
  const so = (x) => String(x ?? '').replace(/\D/g, '');
  const erroBox = form.querySelector('[data-erro]');
  const MAX = 8 * 1024 * 1024;

  // ------------------------------------------------------------------ máscaras
  const mascaras = {
    cnpj: (d) => d.slice(0, 14).replace(/^(\d{2})(\d)/, '$1.$2').replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d)/, '.$1/$2').replace(/(\d{4})(\d)/, '$1-$2'),
    cpf: (d) => d.slice(0, 11).replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d{1,2})$/, '$1-$2'),
    cep: (d) => d.slice(0, 8).replace(/(\d{5})(\d)/, '$1-$2'),
    telefone: (d) => {
      d = d.slice(0, 11);
      if (d.length <= 2) return d.length ? `(${d}` : '';
      if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
      if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
      return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
    },
  };
  form.querySelectorAll('[data-mascara]').forEach((i) => {
    i.addEventListener('input', () => { i.value = mascaras[i.dataset.mascara](so(i.value)); });
  });

  // Campo corrigido: some o destaque de erro.
  form.addEventListener('input', (e) => e.target.closest?.('.campo')?.classList.remove('invalido'));
  form.addEventListener('change', (e) => e.target.closest?.('.campo')?.classList.remove('invalido'));

  // ------------------------------------------------------------------ busca de CNPJ e CEP
  async function buscar(caminho) {
    const r = await fetch(`/api/publico/abertura/${caminho}`, { credentials: 'same-origin' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.erro || 'Não foi possível consultar agora.');
    return d;
  }
  const preencher = (prefixo, dados, campos) => {
    for (const c of campos) {
      const i = $(`${prefixo}.${c}`);
      if (i && dados[c] && !i.value) {
        i.value = i.dataset.mascara ? mascaras[i.dataset.mascara](so(dados[c])) : dados[c];
        i.closest('.campo')?.classList.remove('invalido');
      }
    }
  };
  const infoCnpj = form.querySelector('[data-cnpj-info]');
  let ultimoCnpj = '';
  async function buscarCnpj() {
    const cnpj = so($('empresa.cnpj').value);
    if (cnpj.length !== 14 || cnpj === ultimoCnpj) return;
    ultimoCnpj = cnpj;
    infoCnpj.textContent = 'Consultando a Receita…';
    try {
      const d = await buscar(`cnpj/${cnpj}`);
      preencher('empresa', d, ['razao_social', 'nome_fantasia', 'email', 'telefone', 'cep', 'endereco', 'numero', 'complemento', 'bairro', 'cidade', 'uf']);
      infoCnpj.textContent = d.situacao ? `Situação na Receita: ${d.situacao}` : 'Dados preenchidos pela Receita. Confira.';
    } catch (e) {
      infoCnpj.textContent = `${e.message} Preencha os dados à mão.`;
    }
  }
  form.querySelector('[data-buscar-cnpj]').addEventListener('click', () => { ultimoCnpj = ''; buscarCnpj(); });
  $('empresa.cnpj').addEventListener('blur', buscarCnpj);
  // Chave PIX do tipo CNPJ (a mais comum): já vem com o CNPJ da empresa.
  $('empresa.cnpj').addEventListener('blur', () => {
    if ($('destino.pix_tipo').value === 'cnpj' && !$('destino.pix_chave').value && $('empresa.cnpj').value) {
      $('destino.pix_chave').value = $('empresa.cnpj').value;
      $('destino.pix_chave').closest('.campo').classList.remove('invalido');
    }
  });
  $('empresa.cep').addEventListener('blur', async () => {
    const cep = so($('empresa.cep').value);
    if (cep.length !== 8) return;
    try { preencher('empresa', await buscar(`cep/${cep}`), ['endereco', 'bairro', 'cidade', 'uf']); } catch { /* preenche à mão */ }
  });

  // ------------------------------------------------------------------ responsável financeiro = legal
  const mesmo = form.querySelector('[data-mesmo-responsavel]');
  const copiar = () => {
    if (!mesmo.checked) return;
    for (const c of ['nome', 'email', 'telefone']) $(`financeiro.${c}`).value = $(`representante.${c}`).value;
  };
  mesmo.addEventListener('change', () => {
    for (const c of ['nome', 'email', 'telefone']) $(`financeiro.${c}`).readOnly = mesmo.checked;
    copiar();
  });
  ['nome', 'email', 'telefone'].forEach((c) => $(`representante.${c}`).addEventListener('input', copiar));

  // ------------------------------------------------------------------ conta ou PIX
  const banco = form.querySelector('[data-banco]');
  banco.addEventListener('change', () => { form.querySelector('[data-outro-banco]').hidden = banco.value !== 'outro'; });
  $('destino.pix_tipo').addEventListener('change', () => {
    const chave = $('destino.pix_chave');
    if ($('destino.pix_tipo').value === 'cnpj' && !chave.value) { chave.value = $('empresa.cnpj').value; chave.closest('.campo').classList.remove('invalido'); }
  });

  // ------------------------------------------------------------------ documentos
  const documentos = {};
  form.querySelectorAll('[data-arquivo]').forEach((caixa) => {
    const input = caixa.querySelector('input');
    const nome = caixa.querySelector('[data-nome]');
    const original = nome.textContent;
    input.addEventListener('change', () => {
      const f = input.files[0];
      caixa.classList.remove('ok', 'invalido');
      delete documentos[caixa.dataset.arquivo];
      if (!f) { nome.textContent = original; return; }
      if (!['application/pdf', 'image/jpeg', 'image/png'].includes(f.type)) {
        caixa.classList.add('invalido'); nome.textContent = 'Envie em PDF, JPG ou PNG.'; input.value = ''; return;
      }
      if (f.size > MAX) { caixa.classList.add('invalido'); nome.textContent = 'O arquivo passa de 8 MB.'; input.value = ''; return; }
      documentos[caixa.dataset.arquivo] = f;
      caixa.classList.add('ok');
      nome.textContent = `${f.name} · ${(f.size / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
    });
  });
  const lerArquivo = (f) => new Promise((ok, falha) => {
    const r = new FileReader();
    r.onload = () => ok({ nome: f.name, conteudo: r.result });
    r.onerror = () => falha(new Error('Não foi possível ler o arquivo.'));
    r.readAsDataURL(f);
  });

  // ------------------------------------------------------------------ envio
  const valor = (nome) => String($(nome)?.value ?? '').trim();
  function mostrarErro(msg) {
    erroBox.textContent = msg;
    erroBox.hidden = false;
    erroBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function conferir() {
    form.querySelectorAll('.invalido').forEach((x) => x.classList.remove('invalido'));
    const visiveis = [...form.querySelectorAll('input[required], select[required]')].filter((i) => i.type !== 'file' && i.type !== 'checkbox' && !i.closest('[hidden]'));
    const obrig = [...visiveis];
    // Conta bancária e chave PIX: as duas obrigatórias.
    obrig.push($('destino.banco'), $('destino.agencia'), $('destino.conta'), $('destino.conta_dv'), $('destino.pix_chave'));
    if (banco.value === 'outro') obrig.push($('destino.banco_outro'), $('destino.ispb'));
    const faltando = obrig.filter((i) => !String(i.value).trim());
    faltando.forEach((i) => i.closest('.campo')?.classList.add('invalido'));
    if (faltando.length) { faltando[0].focus(); return 'Preencha os campos marcados.'; }
    const emails = ['empresa.email', 'representante.email', 'financeiro.email'].map($).filter((i) => !i.checkValidity());
    if (emails.length) { emails[0].closest('.campo').classList.add('invalido'); emails[0].focus(); return 'Confira o e-mail informado.'; }
    if (!documentos.contrato_social) { form.querySelector('[data-arquivo="contrato_social"]').classList.add('invalido'); return 'Anexe o contrato social da empresa.'; }
    if (!$('aceite').checked) return 'Marque a declaração no fim do formulário.';
    return null;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    erroBox.hidden = true;
    const problema = conferir();
    if (problema) return mostrarErro(problema);
    const botao = form.querySelector('[data-enviar]');
    botao.disabled = true;
    botao.textContent = 'Enviando…';
    try {
      const docs = {};
      for (const [tipo, f] of Object.entries(documentos)) docs[tipo] = await lerArquivo(f);
      const corpo = {
        site: valor('site'),
        aceite: true,
        empresa: Object.fromEntries(['cnpj', 'razao_social', 'nome_fantasia', 'email', 'telefone', 'cep', 'endereco', 'numero', 'complemento', 'bairro', 'cidade', 'uf']
          .map((c) => [c, valor(`empresa.${c}`)])),
        representante: { nome: valor('representante.nome'), cpf: valor('representante.cpf'), cargo: valor('representante.cargo'),
          email: valor('representante.email'), telefone: valor('representante.telefone') },
        financeiro: { nome: valor('financeiro.nome'), email: valor('financeiro.email'), telefone: valor('financeiro.telefone') },
        destino: { banco: banco.value === 'outro' ? valor('destino.banco_outro') : banco.value, ispb: banco.value === 'outro' ? valor('destino.ispb') : '',
          tipo: valor('destino.tipo'), agencia: valor('destino.agencia'), agencia_dv: valor('destino.agencia_dv'),
          conta: valor('destino.conta'), conta_dv: valor('destino.conta_dv'),
          pix_tipo: valor('destino.pix_tipo'), pix_chave: valor('destino.pix_chave') },
        documentos: docs,
      };
      let r;
      try {
        r = await fetch('/api/publico/abertura', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo), credentials: 'same-origin' });
      } catch {
        throw new Error('Sem conexão com a PAY AX. Verifique a internet e tente de novo.');
      }
      const d = await r.json().catch(() => ({}));
      if (r.status === 413) throw new Error('Os arquivos ficaram grandes demais. Envie arquivos menores (até 8 MB cada).');
      if (!r.ok) throw new Error(d.erro || 'Não foi possível enviar agora. Tente novamente.');
      form.hidden = true;
      const ok = document.querySelector('[data-enviado]');
      ok.querySelector('[data-protocolo]').textContent = d.protocolo;
      ok.hidden = false;
      ok.focus();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      mostrarErro(err.message);
    } finally {
      botao.disabled = false;
      botao.textContent = 'Enviar pedido de abertura';
    }
  });

  // Rolagem: sombra no topo fixo, como na página inicial.
  const header = document.querySelector('.header');
  const rolar = () => header.classList.toggle('rolou', window.scrollY > 4);
  window.addEventListener('scroll', rolar, { passive: true });
  rolar();
})();
