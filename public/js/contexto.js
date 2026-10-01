import { sessao } from './api.js';

export const usuarioAtual = () => sessao.get()?.usuario;
export const ehAdmin = () => usuarioAtual()?.perfil === 'admin';
/** Alçada do usuário para uma permissão (ex.: 'contas.limite'), definida pelo administrador na tela Alçadas. */
export const pode = (chave) => ehAdmin() || Boolean(sessao.get()?.permissoes?.[chave]?.permitido);
/** Teto de valor da alçada, em centavos (null = sem teto). */
export const tetoAlcada = (chave) => (ehAdmin() ? null : sessao.get()?.permissoes?.[chave]?.limite_centavos ?? null);
/** Atributo para desabilitar um botão quando o usuário não tem a alçada. */
export const semAlcada = (chave) => (pode(chave) ? '' : 'disabled');

export function definirTitulo(t) {
  const el = document.querySelector('#titulo-pagina');
  if (el) el.textContent = t;
  document.title = `${t} · Banqueiro PAY AX`;
}
