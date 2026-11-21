'use strict';

const v = require('./validacao');

const UFS = ['AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO'];

const cep = (x) => { const t = v.digitos(x); if (!t) return null; v.exigir(t.length === 8, 'CEP inválido (8 dígitos).'); return t; };
const uf = (x) => { const t = String(x ?? '').trim().toUpperCase(); if (!t) return null; v.exigir(UFS.includes(t), 'UF inválida.'); return t; };

/**
 * Campos do endereço, usados pelo assinante e pelo endereço de instalação do contrato.
 * `chaveNumero` existe porque no contrato o número da casa é `numero_endereco`: `numero` lá é o número do contrato.
 */
function endereco(b, atual = {}, chaveNumero = 'numero') {
  const val = (k, f) => (b[k] !== undefined ? f(b[k]) : atual[k] ?? null);
  return {
    cep: val('cep', cep),
    logradouro: val('logradouro', (x) => v.opcional(x, 'o logradouro', 160)),
    [chaveNumero]: val(chaveNumero, (x) => v.opcional(x, 'o número', 20)),
    complemento: val('complemento', (x) => v.opcional(x, 'o complemento', 80)),
    bairro: val('bairro', (x) => v.opcional(x, 'o bairro', 80)),
    cidade: val('cidade', (x) => v.opcional(x, 'a cidade', 80)),
    uf: val('uf', uf),
    latitude: b.latitude !== undefined && b.latitude !== '' ? v.coordenadas(b.latitude, b.longitude ?? atual.longitude)[0] : atual.latitude ?? null,
    longitude: b.longitude !== undefined && b.longitude !== '' ? v.coordenadas(b.latitude ?? atual.latitude, b.longitude)[1] : atual.longitude ?? null,
  };
}

/** Endereço em uma linha, para listas e mapas. Em branco quando nada foi informado. */
function emLinha(x, chaveNumero = 'numero') {
  const rua = [x.logradouro, x[chaveNumero]].filter(Boolean).join(', ');
  return [rua, x.complemento, x.bairro, [x.cidade, x.uf].filter(Boolean).join('/')].filter(Boolean).join(' · ') || null;
}

module.exports = { UFS, cep, uf, endereco, emLinha };
