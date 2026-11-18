'use strict';

/*
 * Link permanente do boleto, para o pagador abrir sem senha. A assinatura amarra o link ao boleto e ao nosso
 * número: não dá para adivinhar o link de outro boleto trocando o número. Com ".pdf" no fim, o link abre o
 * arquivo PDF; sem, abre a página.
 */
const config = require('../config');
const { assinar } = require('./cripto');

const assinatura = (id, nossoNumero) => assinar(`ficha:${id}:${nossoNumero}`).slice(0, 32);
const caminho = (boleto, { pdf = false } = {}) => `${config.basePath}/api/publico/boleto/${boleto.id}/${assinatura(boleto.id, boleto.nosso_numero)}${pdf ? '.pdf' : ''}`;
/** Endereço completo (null se o sistema não sabe o próprio endereço público). */
const url = (boleto, opcoes) => (config.urlPublica ? `${config.urlPublica}${caminho(boleto, opcoes)}` : null);

module.exports = { assinatura, caminho, url };
