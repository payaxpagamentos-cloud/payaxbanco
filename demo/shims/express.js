'use strict';

/* Subconjunto do Router do Express suficiente para as rotas do Banqueiro rodarem no navegador. */
function compilar(caminho, prefixo) {
  const nomes = [];
  const corpo = caminho.replace(/[.]/g, '\\.').replace(/:(\w+)/g, (_, n) => { nomes.push(n); return '([^/]+?)'; });
  if (prefixo) return { re: caminho === '/' ? /^/ : new RegExp(`^${corpo}(?=/|$)`), nomes };
  return { re: new RegExp(`^${corpo}/?$`), nomes };
}

function Router() {
  const pilha = [];
  function router(req, res, fim) {
    let i = 0;
    const caminhoBase = req.path;
    const proximo = (err) => {
      req.path = caminhoBase;
      if (err) return fim(err);
      while (i < pilha.length) {
        const camada = pilha[i++];
        if (camada.metodo && camada.metodo !== req.method) continue;
        const m = camada.re.exec(req.path);
        if (!m) continue;
        if (camada.metodo) {
          req.params = Object.fromEntries(camada.nomes.map((n, k) => [n, decodeURIComponent(m[k + 1])]));
        } else {
          req.path = req.path.slice(m[0].length) || '/';
        }
        return executar(camada.handlers, 0);
      }
      return fim();
    };
    const executar = (handlers, j) => {
      const h = handlers[j];
      const seguir = (err) => (err ? proximo(err) : j + 1 < handlers.length ? executar(handlers, j + 1) : proximo());
      try {
        const r = h(req, res, seguir);
        if (r && typeof r.catch === 'function') r.catch(seguir);
      } catch (err) {
        seguir(err);
      }
    };
    proximo();
  }
  const rota = (metodo) => (caminho, ...handlers) => { pilha.push({ metodo, ...compilar(caminho, false), handlers }); return router; };
  router.get = rota('GET');
  router.post = rota('POST');
  router.put = rota('PUT');
  router.patch = rota('PATCH');
  router.delete = rota('DELETE');
  router.use = (...args) => {
    const caminho = typeof args[0] === 'string' ? args.shift() : '/';
    pilha.push({ metodo: null, ...compilar(caminho, true), handlers: args });
    return router;
  };
  return router;
}

module.exports = { Router };
