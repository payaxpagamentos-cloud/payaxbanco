import { api } from '../api.js';
import { html, $, $$, modal, toast, mascaraDocumento, mascaraMoeda, centavos, dadosForm, icone, moeda, documento, telefone } from '../../../js/ui.js';

const UFS = 'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' ');
const ETAPAS = ['Seus dados', 'Endereço', 'Sua conta', 'Revisão'];

/** Assistente "Abra sua conta": coleta os dados em etapas e envia a proposta para análise da PAY AX. */
export function abrirConta() {
  const dados = { tipo: 'PF', tipo_conta: 'corrente', renda_mensal_centavos: 0 };
  let etapa = 0;
  const { el, fechar } = modal({
    titulo: 'Abra sua conta PAY AX',
    grande: true,
    corpo: html`<div class="assistente">
      <ol class="etapas">${ETAPAS.map((e, i) => html`<li data-etapa="${i}"><span>${i + 1}</span>${e}</li>`)}</ol>
      <div class="erro-form hidden" id="erro-ab"></div>
      <form id="form-ab" novalidate></form>
    </div>`,
    rodape: html`<div class="modal-foot"><button type="button" class="btn" id="ab-voltar">Voltar</button><button type="button" class="btn primario" id="ab-avancar">Continuar</button></div>`,
  });
  const form = $('#form-ab', el);
  const erro = $('#erro-ab', el);
  const voltar = $('#ab-voltar', el);
  const avancar = $('#ab-avancar', el);
  const pj = () => dados.tipo === 'PJ';
  const falhar = (msg) => { erro.textContent = msg; erro.classList.remove('hidden'); el.querySelector('.modal').scrollTop = 0; return false; };

  const telas = [
    () => html`<div class="form">
      <div class="c12"><div class="opcoes">
        <label class="opcao"><input type="radio" name="tipo" value="PF" ${dados.tipo === 'PF' ? 'checked' : ''}><span>${icone('perfil')}<strong>Para você</strong><small>Conta pessoa física</small></span></label>
        <label class="opcao"><input type="radio" name="tipo" value="PJ" ${dados.tipo === 'PJ' ? 'checked' : ''}><span>${icone('contas')}<strong>Para sua empresa</strong><small>Conta pessoa jurídica</small></span></label>
      </div></div>
      <div class="c6"><label for="ab-doc">${pj() ? 'CNPJ' : 'CPF'}</label><input id="ab-doc" name="documento" data-doc inputmode="numeric" value="${dados.documento ? documento(dados.documento) : ''}"></div>
      <div class="c6"><label for="ab-nasc">${pj() ? 'Data de fundação' : 'Data de nascimento'}</label><input id="ab-nasc" type="date" name="data_nascimento" value="${dados.data_nascimento ?? ''}"></div>
      <div class="c12"><label for="ab-nome">${pj() ? 'Razão social' : 'Nome completo'}</label><input id="ab-nome" name="nome" autocomplete="name" value="${dados.nome ?? ''}"></div>
      <div class="c6"><label for="ab-email">E-mail</label><input id="ab-email" type="email" name="email" autocomplete="email" value="${dados.email ?? ''}"></div>
      <div class="c6"><label for="ab-tel">Celular com DDD</label><input id="ab-tel" name="telefone" inputmode="tel" autocomplete="tel" placeholder="(11) 90000-0000" value="${dados.telefone ? telefone(dados.telefone) : ''}"></div>
    </div>`,
    () => html`<div class="form">
      <div class="c4"><label for="ab-cep">CEP</label><input id="ab-cep" name="cep" inputmode="numeric" placeholder="00000-000" value="${dados.cep ?? ''}"></div>
      <div class="c8"><label for="ab-log">Endereço</label><input id="ab-log" name="logradouro" autocomplete="address-line1" value="${dados.logradouro ?? ''}"></div>
      <div class="c3"><label for="ab-num">Número</label><input id="ab-num" name="numero" value="${dados.numero ?? ''}"></div>
      <div class="c4"><label for="ab-comp">Complemento</label><input id="ab-comp" name="complemento" value="${dados.complemento ?? ''}"></div>
      <div class="c5"><label for="ab-bairro">Bairro</label><input id="ab-bairro" name="bairro" value="${dados.bairro ?? ''}"></div>
      <div class="c8"><label for="ab-cidade">Cidade</label><input id="ab-cidade" name="cidade" value="${dados.cidade ?? ''}"></div>
      <div class="c4"><label for="ab-uf">UF</label><select id="ab-uf" name="uf"><option value="">Selecione</option>${UFS.map((u) => html`<option ${dados.uf === u ? 'selected' : ''}>${u}</option>`)}</select></div>
      <div class="c6"><label for="ab-renda">${pj() ? 'Faturamento mensal' : 'Renda mensal'}</label><input id="ab-renda" name="renda" class="moeda" inputmode="numeric" value="${(dados.renda_mensal_centavos / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}"></div>
    </div>`,
    () => html`<div class="form">
      <div class="c12"><div class="opcoes">
        <label class="opcao"><input type="radio" name="tipo_conta" value="corrente" ${dados.tipo_conta === 'corrente' ? 'checked' : ''}><span>${icone('contas')}<strong>Conta corrente</strong><small>PIX, pagamentos, transferências e acesso a crédito.</small></span></label>
        ${pj() ? '' : html`<label class="opcao"><input type="radio" name="tipo_conta" value="pagamento" ${dados.tipo_conta === 'pagamento' ? 'checked' : ''}><span>${icone('pix')}<strong>Conta de pagamento</strong><small>Simples, para o dia a dia: PIX e pagamento de contas.</small></span></label>`}
      </div></div>
      <div class="c12 aceites">
        <label class="check"><input type="checkbox" name="aceite_termos" ${dados.aceite_termos ? 'checked' : ''}> Li e aceito os <strong>termos de abertura e manutenção de conta</strong> e a tabela de tarifas da PAY AX.</label>
        <label class="check"><input type="checkbox" name="aceite_privacidade" ${dados.aceite_privacidade ? 'checked' : ''}> Autorizo a PAY AX a tratar meus dados pessoais para análise cadastral e prevenção a fraudes, conforme a <strong>Política de Privacidade</strong> e a LGPD.</label>
      </div>
    </div>`,
    () => html`<div class="revisao">
      <div><h3>${pj() ? 'Empresa' : 'Você'}</h3><p>${dados.nome}<br>${pj() ? 'CNPJ' : 'CPF'} ${documento(dados.documento)}<br>${dados.email} · ${telefone(dados.telefone)}</p></div>
      <div><h3>Endereço</h3><p>${dados.logradouro}, ${dados.numero}${dados.complemento ? ` · ${dados.complemento}` : ''}<br>${dados.bairro} · ${dados.cidade}/${dados.uf}<br>CEP ${dados.cep}</p></div>
      <div><h3>Conta</h3><p>${dados.tipo_conta === 'corrente' ? 'Conta corrente' : 'Conta de pagamento'}<br>${pj() ? 'Faturamento' : 'Renda'} mensal: ${moeda(dados.renda_mensal_centavos)}</p></div>
      <p class="ajuda" style="grid-column:1/-1">Ao enviar, sua proposta passa por análise da PAY AX. Você recebe um protocolo para acompanhar a situação.</p>
    </div>`,
  ];

  function coletar() {
    const d = dadosForm(form);
    if (etapa === 0) Object.assign(dados, { tipo: d.tipo ?? dados.tipo, documento: (d.documento ?? '').replace(/\D/g, ''), data_nascimento: d.data_nascimento, nome: (d.nome ?? '').trim(), email: (d.email ?? '').trim(), telefone: (d.telefone ?? '').replace(/\D/g, '') });
    if (etapa === 1) Object.assign(dados, { cep: (d.cep ?? '').replace(/\D/g, ''), logradouro: d.logradouro?.trim(), numero: d.numero?.trim(), complemento: d.complemento?.trim(), bairro: d.bairro?.trim(), cidade: d.cidade?.trim(), uf: d.uf, renda_mensal_centavos: centavos(d.renda) });
    if (etapa === 2) Object.assign(dados, { tipo_conta: pj() ? 'corrente' : (d.tipo_conta ?? 'corrente'), aceite_termos: Boolean(d.aceite_termos), aceite_privacidade: Boolean(d.aceite_privacidade) });
  }

  function validar() {
    if (etapa === 0) {
      if (dados.documento.length !== (pj() ? 14 : 11)) return falhar(`Informe o ${pj() ? 'CNPJ' : 'CPF'} completo.`);
      if (!dados.data_nascimento) return falhar(pj() ? 'Informe a data de fundação.' : 'Informe sua data de nascimento.');
      if (dados.nome.length < 3) return falhar(pj() ? 'Informe a razão social.' : 'Informe seu nome completo.');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(dados.email)) return falhar('Informe um e-mail válido.');
      if (dados.telefone.length < 10) return falhar('Informe o celular com DDD.');
    }
    if (etapa === 1) {
      if (dados.cep.length !== 8) return falhar('Informe o CEP com 8 números.');
      if (!dados.logradouro || !dados.numero || !dados.bairro || !dados.cidade || !dados.uf) return falhar('Preencha o endereço completo.');
    }
    if (etapa === 2 && (!dados.aceite_termos || !dados.aceite_privacidade)) return falhar('Para continuar, aceite os termos e autorize o uso dos dados.');
    return true;
  }

  function desenhar() {
    erro.classList.add('hidden');
    form.innerHTML = String(telas[etapa]());
    $$('.etapas li', el).forEach((li) => {
      const i = Number(li.dataset.etapa);
      li.classList.toggle('atual', i === etapa);
      li.classList.toggle('feita', i < etapa);
    });
    voltar.hidden = etapa === 0;
    avancar.textContent = etapa === ETAPAS.length - 1 ? 'Enviar proposta' : 'Continuar';
    $$('[data-doc]', form).forEach(mascaraDocumento);
    $$('input.moeda', form).forEach(mascaraMoeda);
    $$('input[name="tipo"]', form).forEach((r) => r.addEventListener('change', () => { coletar(); dados.tipo = r.value; desenhar(); }));
    setTimeout(() => form.querySelector('input:not([type=radio]):not([type=checkbox]), select')?.focus(), 30);
  }

  voltar.onclick = () => { coletar(); etapa--; desenhar(); };
  avancar.onclick = async () => {
    if (etapa < ETAPAS.length - 1) {
      coletar();
      if (!validar()) return;
      etapa++;
      desenhar();
      return;
    }
    avancar.disabled = true;
    try {
      const r = await api.post('/abertura', dados);
      sucesso(r);
    } catch (e) {
      falhar(e.message);
    } finally {
      avancar.disabled = false;
    }
  };

  function sucesso(r) {
    $('.etapas', el).hidden = true;
    form.innerHTML = String(html`<div class="sucesso" style="padding:12px 0">
      <div class="ok">${icone('check')}</div>
      <h2>Proposta enviada!</h2>
      <p class="muted" style="max-width:460px;margin:8px auto 18px">Obrigado, ${r.nome.split(' ')[0]}. Vamos analisar seus dados e avisar pelo e-mail e celular informados.</p>
      <div class="protocolo"><span>Seu protocolo</span><strong id="ab-prot">${r.protocolo}</strong></div>
      <ol class="proximos">
        <li><strong>Análise</strong> dos seus dados pela equipe PAY AX.</li>
        <li><strong>Aprovação</strong> e envio da senha provisória por um canal seguro.</li>
        <li><strong>Primeiro acesso</strong> no Internet Banking: você cria sua senha e sua senha de transação.</li>
      </ol></div>`);
    $('.modal-foot', el).innerHTML = String(html`<button type="button" class="btn" id="ab-copiar">Copiar protocolo</button><button type="button" class="btn primario" id="ab-ok">Concluir</button>`);
    $('#ab-ok', el).onclick = fechar;
    $('#ab-copiar', el).onclick = async () => {
      try { await navigator.clipboard.writeText(r.protocolo); toast('Protocolo copiado.'); } catch { toast(`Anote seu protocolo: ${r.protocolo}`); }
    };
  }

  desenhar();
}

/** Consulta da situação da proposta pelo protocolo e documento. */
export function acompanharProposta() {
  modal({
    titulo: 'Acompanhe sua proposta',
    rotuloEnviar: 'Consultar',
    corpo: html`<div class="form">
      <div class="c12"><label for="cp-prot">Protocolo</label><input id="cp-prot" name="protocolo" placeholder="AB00000000000000" style="text-transform:uppercase"></div>
      <div class="c12"><label for="cp-doc">CPF ou CNPJ</label><input id="cp-doc" name="documento" data-doc inputmode="numeric"></div>
      <div class="c12" id="cp-resultado"></div></div>`,
    aoEnviar: async (f) => {
      const d = dadosForm(f);
      const r = await api.post('/abertura/consulta', d);
      const cls = { em_analise: 'warn', aprovada: 'ok', recusada: 'danger' }[r.status];
      $('#cp-resultado', f).innerHTML = String(html`<div class="card card-body" style="box-shadow:none">
        <span class="badge ${cls}">${r.status_texto}</span><p style="margin:8px 0 0">${r.mensagem}</p></div>`);
    },
  });
}
