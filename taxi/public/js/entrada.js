import { api, sessao } from './api.js';
import { el, marca, lerForm, toast, acao } from './ui.js';

const campo = (rotulo, attrs) => el('label', { class: 'campo' }, rotulo, el('input', attrs));

/**
 * Tela de entrada (login e cadastro). `perfis` são os perfis aceitos neste app;
 * `cadastro` é 'passageiro', 'motorista' ou null (a central não tem cadastro aberto).
 */
export function telaEntrada(raiz, { titulo, perfis, cadastro, aoEntrar }) {
  let modo = 'entrar';
  const corpo = el('div');
  const abas = cadastro ? el('div', { class: 'abas', role: 'tablist' }) : null;

  const concluir = (r) => {
    if (!perfis.includes(r.usuario.perfil)) {
      throw new Error(r.usuario.perfil === 'passageiro' ? 'Esta conta é de passageiro: use o app do passageiro.'
        : r.usuario.perfil === 'motorista' ? 'Esta conta é de motorista: use o app do motorista.' : 'Esta conta é da central: use o painel da central.');
    }
    sessao.set(r);
    aoEntrar(r.usuario);
  };

  const formEntrar = () => {
    const f = el('form', { class: 'form' },
      campo('E-mail', { name: 'email', type: 'email', autocomplete: 'username', required: true }),
      campo('Senha', { name: 'senha', type: 'password', autocomplete: 'current-password', required: true }),
      el('button', { class: 'btn primario grande' }, 'Entrar'));
    f.addEventListener('submit', (e) => { e.preventDefault(); acao(f.querySelector('button'), async () => concluir(await api.post('/auth/login', lerForm(f)))); });
    return f;
  };

  const formCadastro = () => {
    const basicos = [
      campo('Nome completo', { name: 'nome', required: true, autocomplete: 'name', maxlength: 120 }),
      campo('Celular com DDD', { name: 'telefone', type: 'tel', required: true, autocomplete: 'tel', placeholder: '(11) 99999-0000' }),
      campo('E-mail', { name: 'email', type: 'email', required: true, autocomplete: 'email' }),
      campo('Senha (mínimo 8 caracteres)', { name: 'senha', type: 'password', required: true, minlength: 8, autocomplete: 'new-password' }),
    ];
    const extras = cadastro === 'motorista' ? [
      el('h3', { style: 'margin-top:8px' }, 'Documentos'),
      el('div', { class: 'duas' }, campo('CPF', { name: 'cpf', required: true, inputmode: 'numeric' }), campo('Nº da CNH', { name: 'cnh', required: true, inputmode: 'numeric' })),
      el('div', { class: 'duas' }, campo('Validade da CNH', { name: 'cnh_validade', type: 'date', required: true }), campo('Chave PIX (repasses)', { name: 'chave_pix' })),
      el('h3', { style: 'margin-top:8px' }, 'Veículo'),
      el('div', { class: 'duas' }, campo('Placa', { name: 'placa', required: true, placeholder: 'ABC1D23' }), campo('Ano', { name: 'ano', type: 'number', required: true, min: 1990 })),
      el('div', { class: 'duas' }, campo('Marca e modelo', { name: 'marca_modelo', required: true }), campo('Cor', { name: 'cor', required: true })),
      el('label', { class: 'campo' }, 'Categoria', el('select', { name: 'categoria' }, el('option', { value: 'comum' }, 'Táxi comum'), el('option', { value: 'executivo' }, 'Executivo'))),
      el('p', { class: 'pequeno mudo' }, 'Seu cadastro passa pela análise da central antes de você receber corridas.'),
    ] : [];
    const f = el('form', { class: 'form' }, basicos, extras, el('button', { class: 'btn primario grande' }, 'Criar conta'));
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const d = lerForm(f);
      acao(f.querySelector('button'), async () => {
        if (cadastro === 'motorista') {
          const { placa, ano, marca_modelo, cor, categoria, ...resto } = d;
          concluir(await api.post('/auth/cadastro-motorista', { ...resto, veiculo: { placa, ano: Number(ano), marca_modelo, cor, categoria } }));
        } else {
          concluir(await api.post('/auth/cadastro', d));
        }
        toast('Conta criada!');
      });
    });
    return f;
  };

  const desenhar = () => {
    if (abas) {
      abas.replaceChildren(
        el('button', { class: modo === 'entrar' ? 'on' : '', type: 'button', onclick: () => { modo = 'entrar'; desenhar(); } }, 'Entrar'),
        el('button', { class: modo === 'cadastro' ? 'on' : '', type: 'button', onclick: () => { modo = 'cadastro'; desenhar(); } }, 'Criar conta'));
    }
    corpo.replaceChildren(modo === 'entrar' ? formEntrar() : formCadastro());
  };
  desenhar();
  raiz.replaceChildren(el('div', { class: 'entrada' }, el('div', { class: 'cartao' },
    marca(), el('h1', { style: 'margin-top:16px' }, titulo), abas ?? el('div', { style: 'height:12px' }), corpo)));
}
