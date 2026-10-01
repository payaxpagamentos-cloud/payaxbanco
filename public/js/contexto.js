import { sessao } from './api.js';

export const usuarioAtual = () => sessao.get()?.usuario;
export const pode = (...perfis) => perfis.includes(usuarioAtual()?.perfil);

export function definirTitulo(t) {
  const el = document.querySelector('#titulo-pagina');
  if (el) el.textContent = t;
  document.title = `${t} · Banqueiro PAY AX`;
}
