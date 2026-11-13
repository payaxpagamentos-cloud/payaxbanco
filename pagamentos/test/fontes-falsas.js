'use strict';

/** ViaCEP, BrasilAPI e gateway da API Brasil de mentira, para os testes de consulta de CEP e CNPJ. */
const http = require('node:http');

function criarFontes({ apiBrasilToken = 'token-bom', apiBrasilFora = false } = {}) {
  const chamadas = [];
  const CEPS = {
    11704000: { cep: '11704-000', logradouro: 'Rua Martins Fontes', bairro: 'Tupi', localidade: 'Praia Grande', uf: 'SP', ibge: '3541000' },
  };
  const CNPJS = {
    19131243000197: {
      cnpj: '19131243000197', razao_social: 'OPEN KNOWLEDGE BRASIL', nome_fantasia: 'REDE PELO CONHECIMENTO LIVRE',
      descricao_situacao_cadastral: 'ATIVA', data_inicio_atividade: '2013-10-03',
      descricao_tipo_de_logradouro: 'AVENIDA', logradouro: 'PAULISTA 37', numero: '37', complemento: 'ANDAR 4',
      bairro: 'BELA VISTA', municipio: 'SAO PAULO', uf: 'SP', cep: '01311902', ddd_telefone_1: '1123851939',
      qsa: [{ nome_socio: 'FULANO DE TAL', cnpj_cpf_do_socio: '***682847**' }],
    },
  };

  const servidor = http.createServer((req, res) => {
    let corpo = '';
    req.on('data', (c) => { corpo += c; });
    req.on('end', () => {
      const dados = corpo ? JSON.parse(corpo) : {};
      chamadas.push({ url: req.url, metodo: req.method, dados, autorizacao: req.headers.authorization ?? null, ua: req.headers['user-agent'] });
      res.setHeader('Content-Type', 'application/json');
      const responder = (status, json) => { res.statusCode = status; res.end(JSON.stringify(json)); };

      // ViaCEP: /viacep/<cep>/json/
      let m = /^\/viacep\/(\d{8})\/json\/?$/.exec(req.url);
      if (m) return CEPS[m[1]] ? responder(200, CEPS[m[1]]) : responder(200, { erro: true });

      // BrasilAPI: /brasilapi/cnpj/v1/<cnpj>
      m = /^\/brasilapi\/cnpj\/v1\/(\d{14})$/.exec(req.url);
      if (m) return CNPJS[m[1]] ? responder(200, CNPJS[m[1]]) : responder(404, { message: 'CNPJ não encontrado' });

      // API Brasil: POST /apibrasil/cep e /apibrasil/cnpj
      if (req.url.startsWith('/apibrasil/')) {
        if (apiBrasilFora) return responder(503, { error: true, message: 'fora do ar' });
        if (req.headers.authorization !== `Bearer ${apiBrasilToken}`) return responder(401, { error: true, message: 'Token inválido ou expirado.' });
        if (req.url.endsWith('/cep')) {
          const c = String(dados.cep ?? '').replace(/\D/g, '');
          return CEPS[c]
            ? responder(200, { error: false, data: { cep: c, logradouro: CEPS[c].logradouro, bairro: CEPS[c].bairro, cidade: CEPS[c].localidade, uf: CEPS[c].uf } })
            : responder(200, { error: true, message: 'CEP não localizado' });
        }
        if (req.url.endsWith('/cnpj')) {
          const c = String(dados.cnpj ?? '').replace(/\D/g, '');
          if (!CNPJS[c]) return responder(200, { error: true, message: 'CNPJ não localizado' });
          const f = CNPJS[c];
          return responder(200, { error: false, data: {
            cnpj: f.cnpj, razao_social: f.razao_social, situacao_cadastral: 'ATIVA',
            estabelecimento: { nome_fantasia: f.nome_fantasia, tipo_logradouro: 'AVENIDA', logradouro: 'PAULISTA', numero: '37',
              bairro: f.bairro, cidade: { nome: 'SAO PAULO' }, estado: { sigla: 'SP' }, cep: f.cep, ddd1: '11', telefone1: '23851939' },
          } });
        }
      }
      responder(404, { message: 'rota desconhecida' });
    });
  });

  return {
    chamadas,
    async iniciar() {
      servidor.listen(0, '127.0.0.1');
      await new Promise((r) => servidor.once('listening', r));
      const base = `http://127.0.0.1:${servidor.address().port}`;
      // Aponta as fontes para o servidor falso (config é lido a cada chamada).
      const config = require('../server/config');
      config.dados.urlViaCep = `${base}/viacep`;
      config.dados.urlBrasilApi = `${base}/brasilapi`;
      config.dados.urlApiBrasil = `${base}/apibrasil`;
      return base;
    },
    fechar: () => new Promise((r) => servidor.close(r)),
  };
}

module.exports = { criarFontes };
