import { sessao } from './api.js';

export const usuarioAtual = () => sessao.get()?.usuario;
export const perfil = () => usuarioAtual()?.perfil;
export const ehAdmin = () => perfil() === 'admin';
/** Supervisor e administrador gerenciam a carteira (contratos, analistas) e veem todas as empresas. */
export const gestor = () => ['admin', 'supervisor'].includes(perfil());

const CHAVE_EMPRESA = 'bpo.empresa';
/** Empresa em atendimento (a última aberta), para manter o menu financeiro à mão. */
export const empresaAtual = {
  get() { try { return JSON.parse(sessionStorage.getItem(CHAVE_EMPRESA)); } catch { return null; } },
  set(e) { try { sessionStorage.setItem(CHAVE_EMPRESA, JSON.stringify(e)); } catch { /* ignora */ } },
  limpar() { try { sessionStorage.removeItem(CHAVE_EMPRESA); } catch { /* ignora */ } },
};

export function definirTitulo(t) {
  const el = document.querySelector('#titulo-pagina');
  if (el) el.textContent = t;
  document.title = `${t} · BPO Financeiro PAY AX`;
}
