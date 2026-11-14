'use strict';

/**
 * Conformidade: as regras legais e normativas que o sistema segue, num catálogo só.
 *
 * Regra do projeto: nada no sistema fica fora das normas. Cada regra traz a norma de onde vem.
 *
 * Dois tipos de regra:
 *
 *  - AUTOMÁTICA: o próprio sistema verifica, toda vez que alguém abre a tela. Faz duas coisas:
 *      1. testa a trava: tenta o que a regra proíbe e espera ser barrado. Se alguém desligar a
 *         trava no código, a regra acusa na hora;
 *      2. varre os dados atrás do que escapou: um título antigo, uma configuração gravada antes
 *         da trava existir.
 *
 *  - ACOMPANHAMENTO: depende de alguém de fora (Bradesco, advogado, provedor). O sistema não tem
 *    como verificar sozinho; a equipe registra a situação, o responsável, o prazo e a observação.
 *    Cada mudança vai para a auditoria.
 *
 * Regra nova entra aqui, com teste em test/conformidade.test.js.
 */
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const datas = require('./datas');
const v = require('./validacao');
const boletos = require('./boletos');
const cnab = require('./cnab400');
const impressao = require('./impressao');
const backup = require('./backup');
const dois = require('./doisfatores');
const arquivosBanco = require('./arquivosBanco');
const repasses = require('./repasses');
const contaDestino = require('./contaDestino');
const pld = require('./pld');
const lgpd = require('./lgpd');

const GRUPOS = [
  { id: 'boleto', titulo: 'Boleto e cobrança' },
  { id: 'banco', titulo: 'Banco (Bradesco)' },
  { id: 'dados', titulo: 'Dados e segurança (LGPD)' },
  { id: 'regulatorio', titulo: 'Regulatório' },
  { id: 'pld', titulo: 'Prevenção à lavagem de dinheiro (PLD)' },
];

/** Situações de uma regra de acompanhamento, como a equipe as registra. */
const SITUACOES_ACOMPANHAMENTO = ['pendente', 'em_andamento', 'atendida', 'nao_se_aplica'];

// Títulos que ainda podem ser pagos: é neles que um erro chega ao pagador.
const EM_ABERTO = "situacao IN ('registrando', 'registrado')";

const ok = (detalhe) => ({ situacao: 'ok', detalhe });
const atencao = (detalhe) => ({ situacao: 'atencao', detalhe });
const fora = (detalhe) => ({ situacao: 'fora', detalhe });

/** A trava existe se o que a regra proíbe for recusado. */
const barra = (fn) => {
  try { fn(); return false; } catch { return true; }
};

const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

// Dados de exemplo para os testes que o sistema faz em si mesmo (não tocam no banco de dados).
const CONTA_EXEMPLO = Object.freeze({
  banco: '237', agencia: '3391', agencia_dv: '7', conta: '0006688', conta_dv: '4', carteira: '09',
  beneficiario_nome: 'PAY AX Brasil Ltda', beneficiario_documento: '12345678000195',
});
const BOLETO_EXEMPLO = Object.freeze({
  tipo: 'boleto', nosso_numero: '00000000001', nosso_numero_dv: '1', seu_numero: 'TESTE', valor_centavos: 10000,
  emissao: '2026-01-05', vencimento: '2026-01-20', juros_mes_ppm: 10000, multa_ppm: 20000, desconto_centavos: 0,
  dias_baixa: 60, especie: cnab.ESPECIE_PADRAO, pagador_nome: 'Pagador de Teste', pagador_documento: '12345678909',
  pagador_cep: '11700000', pagador_endereco: 'Rua de Teste', pagador_numero: '1',
  beneficiario_final_nome: 'Cliente de Teste Ltda', beneficiario_final_documento: '11222333000181',
  codigo_barras: '', linha_digitavel: '',
});
const CLIENTE_EXEMPLO = Object.freeze({ razao_social: 'Cliente de Teste Ltda', nome_fantasia: 'Cliente de Teste', cnpj: '11222333000181' });

/** Ficha de exemplo, gerada pelo mesmo código que gera a do pagador. */
const fichaExemplo = () => impressao.fichaCompensacao({
  boleto: BOLETO_EXEMPLO, conta: CONTA_EXEMPLO, cliente: CLIENTE_EXEMPLO, hoje: '2026-01-05',
});

/** Registro de detalhe de exemplo, gerado pelo mesmo código que gera a remessa. */
const remessaExemplo = () => cnab.gerarRemessa({ conta: CONTA_EXEMPLO, boletos: [BOLETO_EXEMPLO], sequencial: 1, hoje: '2026-01-05' });

/** Configurações de IXC gravadas (JSON não sensível). */
function configsIxc(db) {
  return db.prepare("SELECT cliente_id, config FROM integracoes WHERE escopo = 'ixc' AND config IS NOT NULL").all()
    .map((i) => { try { return { cliente_id: i.cliente_id, ...JSON.parse(i.config) }; } catch { return { cliente_id: i.cliente_id }; } });
}

// ---------------------------------------------------------------- Catálogo
const REGRAS = [
  // ------------------------------------------------ Boleto e cobrança
  {
    id: 'multa-cdc',
    grupo: 'boleto',
    tipo: 'automatica',
    titulo: 'Multa por atraso de no máximo 2%',
    norma: 'Código de Defesa do Consumidor (Lei 8.078/1990), art. 52, § 1º',
    exige: 'Em relação de consumo, a multa de mora não pode passar de 2% do valor.',
    verificar(db) {
      const teto = boletos.LIMITES_ENCARGOS.multa;
      if (!barra(() => boletos.encargos({ multa: teto + 0.01 }))) return fora('A trava da emissão não está barrando multa acima de 2%.');
      const titulos = db.prepare(`SELECT COUNT(*) AS n FROM boletos WHERE ${EM_ABERTO} AND multa_ppm > ?`).get(teto * 10000).n;
      const ixc = configsIxc(db).filter((c) => Number(c.multa) > teto).length;
      if (titulos || ixc) {
        return fora([
          titulos ? `${plural(titulos, 'boleto em aberto', 'boletos em aberto')} com multa acima de 2%` : null,
          ixc ? `${plural(ixc, 'configuração de IXC', 'configurações de IXC')} com multa acima de 2%` : null,
        ].filter(Boolean).join(' · ') + '. Emitidos ou gravados antes da trava: baixe e reemita, ou corrija a configuração.');
      }
      return ok('A emissão e a configuração do IXC recusam multa acima de 2%. Nenhum boleto em aberto acima do teto.');
    },
  },
  {
    id: 'juros-mora',
    grupo: 'boleto',
    tipo: 'automatica',
    titulo: 'Juros de mora de no máximo 1% ao mês',
    norma: 'Teto adotado pela PAY AX para cobrança de consumidor',
    exige: 'Juros de no máximo 1% ao mês, proporcionais aos dias de atraso. Outro teto, só com parecer jurídico.',
    verificar(db) {
      const teto = boletos.LIMITES_ENCARGOS.juros_mes;
      if (!barra(() => boletos.encargos({ juros_mes: teto + 0.01 }))) return fora('A trava da emissão não está barrando juros acima de 1% ao mês.');
      const titulos = db.prepare(`SELECT COUNT(*) AS n FROM boletos WHERE ${EM_ABERTO} AND juros_mes_ppm > ?`).get(teto * 10000).n;
      const ixc = configsIxc(db).filter((c) => Number(c.juros_mes) > teto).length;
      if (titulos || ixc) {
        return fora([
          titulos ? `${plural(titulos, 'boleto em aberto', 'boletos em aberto')} com juros acima de 1% ao mês` : null,
          ixc ? `${plural(ixc, 'configuração de IXC', 'configurações de IXC')} com juros acima de 1% ao mês` : null,
        ].filter(Boolean).join(' · ') + '.');
      }
      return ok('A emissão e a configuração do IXC recusam juros acima de 1% ao mês. Nenhum boleto em aberto acima do teto.');
    },
  },
  {
    id: 'especie-servico',
    grupo: 'boleto',
    tipo: 'automatica',
    titulo: 'Espécie do título: duplicata de serviço',
    norma: 'Lei 5.474/1968 (duplicatas) e manual CNAB 400 do Bradesco',
    exige: 'Quem presta serviço emite duplicata de serviço, não duplicata mercantil.',
    verificar(db) {
      if (cnab.especieDe({}).cnab400 !== '12') return fora('A espécie padrão não é mais duplicata de serviço (código 12).');
      const antigos = db.prepare(`SELECT COUNT(*) AS n FROM boletos WHERE ${EM_ABERTO} AND especie <> ?`).get(cnab.ESPECIE_PADRAO).n;
      if (antigos) {
        return atencao(`${plural(antigos, 'boleto em aberto foi registrado', 'boletos em aberto foram registrados')} como duplicata mercantil, antes da correção. `
          + 'Mantêm a espécie com que foram registrados no banco e saem desta lista quando forem pagos ou baixados.');
      }
      return ok('Todo boleto novo sai como duplicata de serviço (DS, código 12 no CNAB 400).');
    },
  },
  {
    id: 'beneficiario-final',
    grupo: 'boleto',
    tipo: 'automatica',
    titulo: 'Beneficiário final identificado',
    norma: 'Circulares BCB 3.598/2012, 3.656/2013 e 3.956/2019',
    exige: 'Boleto emitido em nome de terceiro identifica o beneficiário final (nome e CPF/CNPJ), no papel e no registro do banco.',
    async verificar(db) {
      const linha = remessaExemplo().conteudo.split('\r\n')[1];
      if (linha.slice(334, 349) !== '011222333000181' || linha.slice(351, 394).trim() !== 'CLIENTE DE TESTE LTDA') {
        return fora('A remessa não está levando o beneficiário final nas posições 335-394.');
      }
      if (!(await fichaExemplo()).includes(impressao.ROTULO_BENEFICIARIO_FINAL)) return fora('O boleto impresso não está mostrando o beneficiário final.');
      const sem = db.prepare(`SELECT COUNT(*) AS n FROM boletos WHERE ${EM_ABERTO} AND (beneficiario_final_documento IS NULL OR beneficiario_final_documento = '')`).get().n;
      if (sem) return fora(`${plural(sem, 'boleto em aberto está', 'boletos em aberto estão')} sem beneficiário final.`);
      return ok('Todo boleto leva o cliente como beneficiário final: impresso e registrado no banco (posições 335-394 do CNAB e campos da API).');
    },
  },
  {
    id: 'nomenclatura',
    grupo: 'boleto',
    tipo: 'automatica',
    titulo: 'Nomes das partes no boleto',
    norma: 'Circulares BCB 3.598/2012, 3.656/2013 e 3.956/2019',
    exige: 'Beneficiário (antigo cedente), Pagador (antigo sacado) e Beneficiário final (antigo sacador/avalista).',
    async verificar() {
      const html = await fichaExemplo();
      const antigos = ['Cedente', 'Sacado', 'Sacador'].filter((t) => html.includes(t));
      if (antigos.length) return fora(`O boleto ainda usa ${antigos.join(', ')}.`);
      const faltam = ['Beneficiário', 'Pagador', impressao.ROTULO_BENEFICIARIO_FINAL].filter((t) => !html.includes(t));
      if (faltam.length) return fora(`O boleto não mostra: ${faltam.join(', ')}.`);
      return ok('O boleto usa Beneficiário, Pagador e Beneficiário final, sem os nomes antigos.');
    },
  },
  {
    id: 'pagador-identificado',
    grupo: 'boleto',
    tipo: 'automatica',
    titulo: 'Pagador identificado por CPF ou CNPJ',
    norma: 'Circular BCB 3.598/2012 e manual CNAB 400 do Bradesco (preenchimento obrigatório)',
    exige: 'Todo boleto registrado identifica o pagador por CPF ou CNPJ válido.',
    verificar(db) {
      if (!barra(() => v.documento('00000000000'))) return fora('A emissão não está recusando CPF/CNPJ inválido.');
      const lista = db.prepare(`SELECT pagador_documento FROM boletos WHERE ${EM_ABERTO}`).all();
      const ruins = lista.filter((b) => !b.pagador_documento || barra(() => v.documento(b.pagador_documento))).length;
      if (ruins) return fora(`${plural(ruins, 'boleto em aberto', 'boletos em aberto')} sem CPF/CNPJ válido do pagador.`);
      return ok('A emissão recusa CPF/CNPJ inválido. Todos os boletos em aberto têm o pagador identificado.');
    },
  },
  {
    id: 'beneficiario-identificado',
    grupo: 'boleto',
    tipo: 'automatica',
    titulo: 'Beneficiário identificado',
    norma: 'Circular BCB 3.598/2012',
    exige: 'O boleto traz o nome e o CNPJ de quem recebe — a PAY AX, dona do convênio.',
    verificar(db) {
      const contas = db.prepare('SELECT apelido, beneficiario_nome, beneficiario_documento FROM contas_bancarias WHERE ativa = 1').all();
      if (!contas.length) return atencao('Nenhuma conta bancária ativa cadastrada.');
      const ruins = contas.filter((c) => !String(c.beneficiario_nome ?? '').trim() || barra(() => v.documento(c.beneficiario_documento)));
      if (ruins.length) return fora(`Conta sem nome ou CNPJ válido do beneficiário: ${ruins.map((c) => c.apelido).join(', ')}.`);
      return ok(`Nome e CNPJ do beneficiário cadastrados em ${plural(contas.length, 'conta ativa', 'contas ativas')}.`);
    },
  },
  {
    id: 'sem-tarifa-bancaria',
    grupo: 'boleto',
    tipo: 'automatica',
    titulo: 'Boleto sem "tarifa bancária"',
    norma: 'FEBRABAN, Comunicado FB-170/2005 (citado no manual CNAB 400 do Bradesco)',
    exige: 'O boleto não pode usar as expressões "taxa bancária" ou "tarifa bancária".',
    async verificar() {
      if (/taxa banc[aá]ria|tarifa banc[aá]ria/i.test(await fichaExemplo())) return fora('O boleto está usando "taxa bancária" ou "tarifa bancária".');
      return ok('O boleto não usa essas expressões.');
    },
  },
  {
    id: 'registro',
    grupo: 'boleto',
    tipo: 'automatica',
    titulo: 'Todo boleto registrado no banco',
    norma: 'Nova Plataforma de Cobrança (FEBRABAN) e Circular BCB 3.598/2012',
    exige: 'Só boleto registrado é aceito para pagamento: boleto que não chegou ao banco não pode ficar com o pagador.',
    verificar(db) {
      const falhas = db.prepare("SELECT COUNT(*) AS n FROM boletos WHERE situacao = 'falha'").get().n;
      const semConfirmacao = config.banco.modo === 'cnab' ? arquivosBanco.situacao(db).nao_confirmados : 0;
      if (semConfirmacao) return fora(`${plural(semConfirmacao, 'título foi', 'títulos foram')} na remessa há mais de 2 dias sem confirmação do banco.`);
      if (falhas) return atencao(`${plural(falhas, 'boleto não foi registrado', 'boletos não foram registrados')} (falha no banco). Não envie ao pagador; reemita.`);
      return ok('Todos os boletos emitidos foram aceitos pelo banco.');
    },
  },
  {
    id: 'cnab-layout',
    grupo: 'banco',
    tipo: 'automatica',
    titulo: 'Arquivo de remessa no layout do banco',
    norma: 'Manual CNAB 400 do Bradesco (versão de março de 2023)',
    exige: 'Registros de exatamente 400 posições, com cada campo na posição do manual.',
    verificar() {
      const r = remessaExemplo();
      const linhas = r.conteudo.split('\r\n').filter(Boolean);
      if (!r.conteudo.endsWith('\r\n') || linhas.some((l) => l.length !== 400)) return fora('O gerador de remessa produziu registro fora de 400 posições.');
      const d = linhas[1];
      const erradas = [
        d.slice(147, 149) !== '12' ? 'espécie (148-149)' : null,
        d.slice(65, 70) !== '20200' ? 'multa (66-70)' : null,
        d.slice(218, 220) !== '01' ? 'tipo de inscrição do pagador (219-220)' : null,
      ].filter(Boolean);
      if (erradas.length) return fora(`Campos fora da posição do manual: ${erradas.join(', ')}.`);
      return ok('Remessa de teste gerada agora: registros de 400 posições, campos nas posições do manual.');
    },
  },

  // ------------------------------------------------ Banco (Bradesco) — acompanhamento
  {
    id: 'bradesco-beneficiario-final',
    grupo: 'banco',
    tipo: 'acompanhamento',
    titulo: 'Convênio habilitado para beneficiário final',
    norma: 'Manual CNAB 400 do Bradesco, págs. 19 e 21',
    exige: 'O banco só aceita o beneficiário final se o convênio estiver cadastrado para isso (condição "S" ou "A"), por pedido na agência.',
    responsavel: 'Bradesco (gerente da conta)',
  },
  {
    id: 'bradesco-modelo-ficha',
    grupo: 'banco',
    tipo: 'acompanhamento',
    titulo: 'Modelo de boleto aprovado pelo banco',
    norma: 'Homologação da cobrança com emissão pelo beneficiário',
    exige: 'Como a PAY AX imprime os próprios boletos, o Bradesco aprova o modelo e os nomes dos campos na homologação.',
    responsavel: 'Bradesco (gerente da conta)',
  },
  {
    id: 'bradesco-especie-api',
    grupo: 'banco',
    tipo: 'acompanhamento',
    titulo: 'Código da duplicata de serviço na API',
    norma: 'Documentação da API de cobrança do Bradesco',
    exige: 'Confirmar o código da espécie "duplicata de serviço" na API (o do CNAB 400 já está conferido).',
    responsavel: 'Bradesco (suporte da API)',
  },

  // ------------------------------------------------ Dados e segurança
  {
    id: 'credenciais-cifradas',
    grupo: 'dados',
    tipo: 'automatica',
    titulo: 'Credenciais guardadas cifradas',
    norma: 'LGPD (Lei 13.709/2018), art. 46',
    exige: 'Senhas e chaves de acesso protegidas contra acesso indevido.',
    verificar() {
      if (config.producao) return ok('Credenciais do banco e dos IXC cifradas (AES-256-GCM) com chave própria de produção.');
      return atencao('Ambiente de demonstração: a chave de cifra é derivada do segredo do servidor. Em produção, o sistema só inicia com chave própria.');
    },
  },
  {
    id: 'duas-etapas',
    grupo: 'dados',
    tipo: 'automatica',
    titulo: 'Duas etapas obrigatórias para a equipe',
    norma: 'LGPD (Lei 13.709/2018), art. 46',
    exige: 'Acesso de quem mexe em dinheiro e dados de terceiros protegido além da senha.',
    verificar(db) {
      const sem = db.prepare('SELECT COUNT(*) AS n FROM usuarios WHERE ativo = 1 AND totp_ativo = 0').get().n;
      if (!dois.exigidaEquipe(db)) return atencao(`Duas etapas não é obrigatória para a equipe. ${plural(sem, 'pessoa ativa está', 'pessoas ativas estão')} sem. Ligue em Segurança e usuários.`);
      return ok(sem ? `Obrigatória. ${plural(sem, 'pessoa ainda vai', 'pessoas ainda vão')} configurar no próximo acesso.` : 'Obrigatória, e toda a equipe ativa já usa.');
    },
  },
  {
    id: 'backup',
    grupo: 'dados',
    tipo: 'automatica',
    titulo: 'Backup em dia e conferido',
    norma: 'LGPD (Lei 13.709/2018), art. 46, e guarda dos registros financeiros',
    exige: 'Cópia de segurança regular do razão dos clientes, conferida, e guardada fora do servidor.',
    verificar(db) {
      const b = backup.situacao(db);
      if (!b.ultimo) return fora('Nenhum backup gerado ainda.');
      if (!b.ultimo.confere) return fora(`O último backup não conferiu: ${b.ultimo.divergencia}`);
      if (b.atrasado) return atencao(`O último backup foi há ${b.horas_desde} h.`);
      return atencao(`Último backup há ${b.horas_desde} h, conferido. Falta a cópia fora do servidor: hoje ele fica no mesmo disco.`);
    },
  },
  {
    id: 'lgpd-encarregado',
    grupo: 'dados',
    tipo: 'automatica',
    titulo: 'Encarregado de dados designado e divulgado',
    norma: 'LGPD (Lei 13.709/2018), art. 41, § 1º',
    exige: 'Indicar o encarregado e divulgar publicamente a identidade e o contato dele.',
    verificar(db) {
      const e = lgpd.encarregado(db);
      if (!e.nome || !e.email) return fora('Encarregado não cadastrado. Cadastre em LGPD → Encarregado: o nome e o e-mail vão para o aviso de privacidade.');
      return ok(`${e.nome} (${e.email}), publicado no aviso de privacidade.`);
    },
  },
  {
    id: 'lgpd-aviso',
    grupo: 'dados',
    tipo: 'automatica',
    titulo: 'Aviso de privacidade publicado e ligado ao boleto',
    norma: 'LGPD (Lei 13.709/2018), arts. 9º e 18',
    exige: 'Informar ao titular, de forma clara e ostensiva, finalidade, forma e duração do tratamento, quem é o controlador, com quem os dados são compartilhados e os direitos do art. 18.',
    async verificar() {
      const raiz = path.join(__dirname, '..', '..');
      const ficha = await fichaExemplo();
      if (!ficha.includes('/privacidade')) return fora('O boleto não traz o link do aviso de privacidade.');
      const entrada = fs.readFileSync(path.join(raiz, 'cliente', 'js', 'app.js'), 'utf8');
      if (!entrada.includes('privacidade')) return fora('A Área do Cliente não traz o link do aviso de privacidade.');
      const faltam = lgpd.INVENTARIO.filter((x) => !x.finalidade || !x.base_legal || !x.retencao || !x.compartilhamento?.length).map((x) => x.titulo);
      if (faltam.length) return fora(`Inventário incompleto: ${faltam.join(', ')}.`);
      return ok(`Página pública /privacidade com ${lgpd.INVENTARIO.length} grupos de dados, os direitos do art. 18 e o formulário do titular; ligada no boleto e na Área do Cliente.`);
    },
  },
  {
    id: 'lgpd-pedidos',
    grupo: 'dados',
    tipo: 'automatica',
    titulo: 'Pedidos dos titulares respondidos no prazo',
    norma: 'LGPD (Lei 13.709/2018), arts. 18 e 19, II (15 dias)',
    exige: 'Atender os pedidos do titular sem custo; a declaração completa sai em até 15 dias do pedido.',
    verificar(db) {
      const r = lgpd.resumo(db).pedidos;
      if (r.vencidos) return fora(`${plural(r.vencidos, 'pedido passou', 'pedidos passaram')} do prazo de 15 dias sem resposta.`);
      return ok(r.abertos ? `${plural(r.abertos, 'pedido aberto', 'pedidos abertos')}, dentro do prazo.` : `Nenhum pedido aberto (${r.total} no total).`);
    },
  },
  {
    id: 'lgpd-incidentes',
    grupo: 'dados',
    tipo: 'automatica',
    titulo: 'Incidentes comunicados à ANPD no prazo',
    norma: 'LGPD (Lei 13.709/2018), art. 48; Resolução CD/ANPD nº 15/2024 (3 dias úteis)',
    exige: 'Incidente que possa causar risco ou dano relevante é comunicado à ANPD e aos titulares em 3 dias úteis da descoberta.',
    verificar(db) {
      const r = lgpd.resumo(db).incidentes;
      if (r.atrasados) return fora(`${plural(r.atrasados, 'incidente está', 'incidentes estão')} sem comunicação à ANPD depois do prazo.`);
      return ok(r.abertos ? `${plural(r.abertos, 'incidente aberto', 'incidentes abertos')}, dentro do prazo.` : 'Nenhum incidente aberto.');
    },
  },
  {
    id: 'lgpd-retencao',
    grupo: 'dados',
    tipo: 'automatica',
    titulo: 'Dados anonimizados ao fim do prazo de guarda',
    norma: 'LGPD (Lei 13.709/2018), arts. 15 e 16; Marco Civil da Internet, art. 15',
    exige: 'Eliminar ou anonimizar quando a finalidade acaba, guardando só o que a lei manda (registros financeiros: 5 anos; IP de acesso: 6 meses).',
    verificar(db) {
      const r = lgpd.resumo(db).retencao;
      if (r.pendente) return fora(`${plural(r.pendente, 'título passou', 'títulos passaram')} do prazo de guarda sem ser anonimizado.`);
      if (!r.ultima) return atencao('A retenção ainda não rodou neste servidor. Ela roda sozinha todo dia, ou em LGPD → Retenção.');
      const horas = (Date.now() - Date.parse(r.ultima.em)) / 3_600_000;
      if (horas > 50) return atencao(`A retenção não roda há ${Math.round(horas)} horas.`);
      return ok(`Rodou há ${Math.max(1, Math.round(horas))} hora(s). Guarda de ${r.anos} anos para registros financeiros; IP de acesso apagado depois de 6 meses.`);
    },
  },
  {
    id: 'lgpd-revisao-juridica',
    grupo: 'dados',
    tipo: 'acompanhamento',
    titulo: 'Aviso de privacidade revisado e papéis com os provedores',
    norma: 'LGPD (Lei 13.709/2018), arts. 9º, 37 e 39',
    exige: 'Revisar o texto do aviso (é minuta técnica fiel ao sistema) e definir no contrato com cada provedor quem é controlador e quem é operador dos dados dos assinantes.',
    responsavel: 'Jurídico',
  },
  {
    id: 'lgpd-operadores',
    grupo: 'dados',
    tipo: 'acompanhamento',
    titulo: 'Contratos com quem trata dados para a PAY AX',
    norma: 'LGPD (Lei 13.709/2018), art. 39',
    exige: 'Banco, hospedagem do sistema e serviços de consulta (CEP/CNPJ) tratam dados seguindo instruções da PAY AX: cláusulas de proteção de dados nos contratos.',
    responsavel: 'Jurídico',
  },
  {
    id: 'lgpd-ripd',
    grupo: 'dados',
    tipo: 'acompanhamento',
    titulo: 'Relatório de impacto à proteção de dados',
    norma: 'LGPD (Lei 13.709/2018), art. 38',
    exige: 'A ANPD pode pedir o relatório de impacto. Recomendável para o tratamento de dados financeiros e de PLD.',
    responsavel: 'Encarregado',
  },

  // ------------------------------------------------ Regulatório
  {
    id: 'repasse-imediato',
    grupo: 'regulatorio',
    tipo: 'automatica',
    titulo: 'Nenhum dinheiro de cliente parado na conta da PAY AX',
    norma: 'Modelo de operação da PAY AX — sem conta de pagamento pré-paga (Lei 12.865/2013)',
    exige: 'O valor recebido segue para o cliente assim que o banco credita, já sem a tarifa. Sem saldo guardado, saque, mínimo ou aprovação.',
    verificar(db) {
      const lista = repasses.parados(db);
      if (lista.length) {
        const total = lista.reduce((s, x) => s + x.valor_centavos, 0);
        const semPix = lista.filter((x) => !x.pix_chave).length;
        return fora(`${plural(lista.length, 'cliente tem', 'clientes têm')} dinheiro creditado antes de hoje e ainda não repassado `
          + `(R$ ${(total / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}): ${lista.map((x) => x.cliente).join(', ')}.`
          + (semPix ? ` ${plural(semPix, 'deles está', 'deles estão')} sem chave PIX.` : ' Veja os repasses com falha.'));
      }
      const retidos = repasses.retidosPorOrdem(db);
      const extra = retidos.length
        ? ` Retido por ordem legal (não é dinheiro parado): ${retidos.map((x) => `${x.cliente}, R$ ${(x.valor_centavos / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`).join('; ')}.`
        : '';
      return ok(`Todo valor creditado antes de hoje já foi repassado. O de hoje sai na rodada seguinte (a cada 15 minutos).${extra}`);
    },
  },
  {
    id: 'split-pelo-banco',
    grupo: 'regulatorio',
    tipo: 'automatica',
    titulo: 'Dinheiro do cliente pelo próprio banco, sempre que possível',
    norma: 'Cuidado de empresa de tecnologia: quanto menos dinheiro de terceiros passa pela PAY AX, menor a exposição regulatória',
    exige: 'Cliente com conta Bradesco recebe pelo rateio de crédito do banco (o dinheiro não passa pela PAY AX). Os demais recebem por PIX na hora.',
    verificar(db) {
      const ativos = db.prepare("SELECT * FROM clientes WHERE situacao = 'ativo'").all();
      const conta = db.prepare('SELECT * FROM contas_bancarias WHERE ativa = 1 ORDER BY padrao DESC, id LIMIT 1').get();
      const meios = ativos.map((c) => contaDestino.meioDeEntrega(c, conta, { modo: config.banco.modo }));
      const pelBanco = meios.filter((m) => m === 'rateio').length;
      const bradescoSemRateio = ativos.filter((c, i) => c.destino_banco === contaDestino.BRADESCO && meios[i] !== 'rateio').length;
      if (bradescoSemRateio) {
        return atencao(`${plural(bradescoSemRateio, 'cliente tem', 'clientes têm')} conta Bradesco e ainda ${bradescoSemRateio === 1 ? 'recebe' : 'recebem'} por PIX da PAY AX. `
          + (conta?.rateio_contratado ? 'Confira o modo do banco (o rateio vale no arquivo CNAB).' : 'Contrate o rateio de crédito no convênio e marque em Contas e preços.'));
      }
      return ok(`${plural(pelBanco, 'cliente recebe', 'clientes recebem')} direto do banco; ${plural(ativos.length - pelBanco, 'recebe', 'recebem')} por PIX na hora.`);
    },
  },
  {
    id: 'recebimento-terceiros',
    grupo: 'regulatorio',
    tipo: 'acompanhamento',
    titulo: 'Recebimento em nome dos clientes',
    norma: 'Lei 12.865/2013 e regulamentação do Banco Central sobre arranjos de pagamento (a confirmar com o jurídico)',
    exige: 'O dinheiro passa pela conta da PAY AX entre o crédito do banco e o PIX ao cliente (minutos, ou até o crédito do dia útil seguinte). Confirmar o enquadramento desse arranjo.',
    responsavel: 'Jurídico',
  },
  {
    id: 'contabil-terceiros',
    grupo: 'regulatorio',
    tipo: 'acompanhamento',
    titulo: 'Contabilização dos valores dos clientes',
    norma: 'Legislação contábil e tributária (a confirmar com o contador)',
    exige: 'Só a tarifa é receita da PAY AX; o resto é valor de terceiros em trânsito. Registrar assim, para não pagar imposto sobre dinheiro que não é da PAY AX.',
    responsavel: 'Contador',
  },
  {
    id: 'termos-instituicao-financeira',
    grupo: 'regulatorio',
    tipo: 'automatica',
    titulo: 'Sem nome de banco e sem "agência" da PAY AX para o cliente',
    norma: 'Resolução Conjunta CMN/BCB nº 17/2025',
    exige: 'Não usar termos que sugiram atividade para a qual a PAY AX não tem autorização, como "banco", "bank" ou "agência". A Área do Cliente usa o código do cliente, não agência e conta.',
    verificar() {
      // Telas e marca que o cliente vê. O boleto fica de fora: lá a agência é a do Bradesco, e é obrigatória.
      const raiz = path.join(__dirname, '..', '..');
      const telas = path.join(raiz, 'cliente', 'js', 'telas');
      const arquivos = [
        path.join(raiz, 'cliente', 'index.html'),
        path.join(raiz, 'cliente', 'js', 'app.js'),
        path.join(raiz, 'comum', 'componentes.js'),
        ...fs.readdirSync(telas).filter((f) => f.endsWith('.js')).map((f) => path.join(telas, f)),
      ];
      // "bank" em qualquer forma é nome de banco. "Agência" só é problema quando é a NOSSA: mostrar a
      // agência da conta do cliente em outro banco é legítimo. Por isso a segunda checagem olha o
      // cartão, onde fica o código do cliente.
      const proibido = /internet\s*bank|\bbank\b/i;
      const achados = arquivos.filter((a) => proibido.test(fs.readFileSync(a, 'utf8'))).map((a) => path.relative(raiz, a));
      if (achados.length) return fora(`Termo de instituição financeira nas telas do cliente: ${achados.join(', ')}.`);
      const cartao = fs.readFileSync(path.join(raiz, 'comum', 'componentes.js'), 'utf8');
      if (/'Agência'|'Conta PAY AX'/.test(cartao) || !cartao.includes('Código do cliente')) {
        return fora('O cartão da Área do Cliente apresenta o número da PAY AX como agência ou conta, e não como código do cliente.');
      }
      return ok(`Nenhuma das ${arquivos.length} telas da Área do Cliente usa "bank" no nome, e o número da PAY AX aparece como código do cliente.`);
    },
  },
  {
    id: 'nome-marca-dominio',
    grupo: 'regulatorio',
    tipo: 'acompanhamento',
    titulo: 'Razão social, marca registrada e domínio',
    norma: 'Resolução Conjunta CMN/BCB nº 17/2025',
    exige: 'O que fica fora do sistema e o sistema não confere: razão social, marca no INPI, domínio de internet e nome do repositório. Confirmar com o jurídico o alcance da norma para a PAY AX.',
    responsavel: 'Jurídico',
  },
  {
    id: 'pld-monitoramento',
    grupo: 'pld',
    tipo: 'automatica',
    titulo: 'Monitoramento de operações atípicas rodando',
    norma: 'Lei 9.613/1998, art. 11, I',
    exige: 'Dar especial atenção às operações que possam indicar lavagem de dinheiro: as regras de PLD rodam de hora em hora.',
    verificar(db) {
      const r = pld.resumo(db);
      if (!r.ultimo_monitoramento) return atencao('O monitoramento ainda não rodou neste servidor. Ele roda sozinho de hora em hora, ou em PLD → Analisar agora.');
      const horas = (Date.now() - Date.parse(r.ultimo_monitoramento)) / 3_600_000;
      if (horas > 26) return fora(`O monitoramento não roda há ${Math.round(horas)} horas.`);
      return ok(`Rodou há ${horas < 1 ? 'menos de 1 hora' : `${Math.round(horas)} hora(s)`}: ${pld.REGRAS.length} regras de operação atípica.`);
    },
  },
  {
    id: 'pld-prazos',
    grupo: 'pld',
    tipo: 'automatica',
    titulo: 'Alertas analisados e comunicações ao Coaf no prazo',
    norma: 'Lei 9.613/1998, art. 11, II (24 horas)',
    exige: 'Decidida a comunicação, ela vai ao Coaf em 24 horas, sem dar ciência ao cliente. Alerta não fica sem análise além do prazo da política interna.',
    verificar(db) {
      const a = pld.atrasos(db);
      if (a.comunicacao) return fora(`${plural(a.comunicacao, 'comunicação ao Coaf passou', 'comunicações ao Coaf passaram')} das 24 horas sem o protocolo registrado.`);
      if (a.analise) return atencao(`${plural(a.analise, 'alerta está', 'alertas estão')} sem análise além do prazo da política interna.`);
      return ok('Nenhuma comunicação atrasada e nenhum alerta além do prazo de análise.');
    },
  },
  {
    id: 'pld-conheca-cliente',
    grupo: 'pld',
    tipo: 'automatica',
    titulo: 'Conheça seu cliente: sócios, representantes e revisão',
    norma: 'Lei 9.613/1998, art. 10, I e § 1º',
    exige: 'Identificar cada cliente e manter o cadastro atualizado; para empresa, quem a representa e os proprietários.',
    verificar(db) {
      const ativos = pld.listarKyc(db).filter((k) => k.situacao === 'ativo');
      const pend = ativos.filter((k) => !k.completo);
      if (pend.length) return fora(`${plural(pend.length, 'cliente ativo está', 'clientes ativos estão')} com o cadastro de PLD incompleto ou vencido: ${pend.slice(0, 5).map((k) => k.cliente).join(', ')}${pend.length > 5 ? '…' : ''}. Complete em PLD → Clientes.`);
      return ok(ativos.length ? `Os ${ativos.length} clientes ativos têm sócios, representantes e revisão em dia.` : 'Nenhum cliente ativo.');
    },
  },
  {
    id: 'pld-nao-ocorrencia',
    grupo: 'pld',
    tipo: 'automatica',
    titulo: 'Declaração de não ocorrência do ano anterior',
    norma: 'Lei 9.613/1998, art. 11, III',
    exige: 'Sem nenhuma comunicação ao Coaf no ano, declarar a não ocorrência, na periodicidade da regulamentação (confirmar o prazo com o jurídico).',
    verificar(db) {
      const ano = Number(datas.dataLocal(config.fusoPadrao).slice(0, 4)) - 1;
      const operou = db.prepare("SELECT COUNT(*) AS n FROM boletos WHERE substr(emissao, 1, 4) = ?").get(String(ano)).n;
      if (!operou) return ok(`Sem operação em ${ano}: não há o que declarar.`);
      if (pld.comunicacoesNoAno(db, ano)) return ok(`Houve comunicação ao Coaf em ${ano}: a declaração de não ocorrência não se aplica.`);
      const d = pld.declaracoes(db).find((x) => x.ano === ano);
      if (d) return ok(`Declaração de ${ano} enviada em ${d.enviado_em} (protocolo ${d.protocolo}).`);
      return atencao(`Registre a declaração de não ocorrência de ${ano} (PLD → Comunicações), depois de enviá-la no SISCOAF.`);
    },
  },
  {
    id: 'pld-enquadramento',
    grupo: 'pld',
    tipo: 'acompanhamento',
    titulo: 'Enquadramento da PAY AX na lei de lavagem de dinheiro',
    norma: 'Lei 9.613/1998, art. 9º, I ("intermediação de recursos financeiros de terceiros")',
    exige: 'Confirmar que a PAY AX é pessoa obrigada e qual órgão a supervisiona (sem regulador próprio, o Coaf). O sistema já cumpre os arts. 10 e 11 como se fosse.',
    responsavel: 'Jurídico',
  },
  {
    id: 'pld-cadastro-coaf',
    grupo: 'pld',
    tipo: 'acompanhamento',
    titulo: 'Cadastro da PAY AX no Coaf (SISCOAF)',
    norma: 'Lei 9.613/1998, art. 10, IV',
    exige: 'Cadastrar-se e manter o cadastro atualizado no Coaf, na falta de órgão regulador próprio. É pelo SISCOAF que as comunicações são feitas.',
    responsavel: 'Compliance',
  },
  {
    id: 'pld-politica',
    grupo: 'pld',
    tipo: 'acompanhamento',
    titulo: 'Política de PLD aprovada e equipe treinada',
    norma: 'Lei 9.613/1998, art. 10, III',
    exige: 'Políticas, procedimentos e controles internos compatíveis com o porte. Os limites das regras do sistema (PLD → Parâmetros) devem sair dessa política.',
    responsavel: 'Diretoria e compliance',
  },
  {
    id: 'pld-sancoes',
    grupo: 'pld',
    tipo: 'acompanhamento',
    titulo: 'Lista de sanções do Conselho de Segurança da ONU',
    norma: 'Lei 13.810/2019 (indisponibilidade de ativos)',
    exige: 'Conferir clientes contra a lista de sanções e cumprir a indisponibilidade sem demora. O sistema tem a suspensão de repasse por ordem legal; a conferência da lista ainda é manual.',
    responsavel: 'Compliance',
  },
  {
    id: 'contrato-clientes',
    grupo: 'regulatorio',
    tipo: 'acompanhamento',
    titulo: 'Contrato com os clientes',
    norma: 'Código Civil e transparência das tarifas',
    exige: 'Tarifas, prazo de repasse, retenção e responsabilidades de cada parte por escrito.',
    responsavel: 'Jurídico e comercial',
  },
  {
    id: 'anatel-provedor',
    grupo: 'regulatorio',
    tipo: 'acompanhamento',
    titulo: 'Documento de cobrança de telecom',
    norma: 'Regulamento de direitos do consumidor de telecomunicações (Anatel)',
    exige: 'O provedor entrega ao assinante o documento de cobrança que a Anatel exige; o boleto não substitui a fatura detalhada.',
    responsavel: 'Cada provedor cliente',
  },
];

const POR_ID = new Map(REGRAS.map((r) => [r.id, r]));

/** Verifica uma regra automática sem deixar um erro dela derrubar a tela inteira. */
async function rodar(regra, db) {
  try {
    return await regra.verificar(db);
  } catch (err) {
    return fora(`A verificação falhou: ${err.message}`);
  }
}

/**
 * Todas as regras, já verificadas. Automáticas rodam agora; as de acompanhamento trazem o que a
 * equipe registrou (ou "pendente", se ninguém registrou nada ainda).
 */
async function verificar(db) {
  const registros = new Map(db.prepare(`SELECT ca.*, u.nome AS atualizado_por_nome FROM conformidade_acompanhamento ca
    LEFT JOIN usuarios u ON u.id = ca.atualizado_por`).all().map((r) => [r.regra, r]));
  const hoje = datas.dataLocal(config.fusoPadrao);

  const regras = await Promise.all(REGRAS.map(async (r) => {
    const base = { id: r.id, grupo: r.grupo, tipo: r.tipo, titulo: r.titulo, norma: r.norma, exige: r.exige };
    if (r.tipo === 'automatica') return { ...base, ...(await rodar(r, db)) };
    const reg = registros.get(r.id);
    const situacao = reg?.situacao === 'atendida' ? 'ok' : (reg?.situacao ?? 'pendente');
    return {
      ...base,
      situacao,
      situacao_registrada: reg?.situacao ?? 'pendente',
      responsavel: reg?.responsavel ?? r.responsavel ?? null,
      prazo: reg?.prazo ?? null,
      prazo_vencido: Boolean(reg?.prazo && reg.prazo < hoje && !['atendida', 'nao_se_aplica'].includes(reg.situacao)),
      observacao: reg?.observacao ?? null,
      atualizado_em: reg?.atualizado_em ?? null,
      atualizado_por: reg?.atualizado_por_nome ?? null,
    };
  }));

  const conta = (s) => regras.filter((r) => r.situacao === s).length;
  return {
    verificado_em: new Date().toISOString(),
    resumo: {
      total: regras.length,
      ok: conta('ok'),
      atencao: conta('atencao'),
      fora: conta('fora'),
      pendente: conta('pendente'),
      em_andamento: conta('em_andamento'),
      nao_se_aplica: conta('nao_se_aplica'),
      prazos_vencidos: regras.filter((r) => r.prazo_vencido).length,
    },
    grupos: GRUPOS.map((g) => ({ ...g, regras: regras.filter((r) => r.grupo === g.id) })),
  };
}

/** Grava a situação de uma regra de acompanhamento. Devolve o antes e o depois, para a auditoria. */
function registrar(db, id, dados, usuario) {
  const regra = POR_ID.get(id);
  if (!regra) return null;
  if (regra.tipo !== 'acompanhamento') {
    const { ErroNegocio } = require('./erros');
    throw new ErroNegocio('Esta regra é verificada pelo próprio sistema: não dá para mudar a situação dela à mão.', 409);
  }
  const depois = {
    situacao: v.opcao(dados.situacao, 'a situação', SITUACOES_ACOMPANHAMENTO),
    responsavel: v.opcional(dados.responsavel, 'o responsável', 80),
    prazo: v.dataOpcional(dados.prazo, 'o prazo'),
    observacao: v.opcional(dados.observacao, 'a observação', 1000),
  };
  const antes = db.prepare('SELECT situacao, responsavel, prazo, observacao FROM conformidade_acompanhamento WHERE regra = ?').get(id) ?? null;
  db.prepare(`INSERT INTO conformidade_acompanhamento (regra, situacao, responsavel, prazo, observacao, atualizado_em, atualizado_por)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(regra) DO UPDATE SET situacao = excluded.situacao, responsavel = excluded.responsavel, prazo = excluded.prazo,
      observacao = excluded.observacao, atualizado_em = excluded.atualizado_em, atualizado_por = excluded.atualizado_por`)
    .run(id, depois.situacao, depois.responsavel, depois.prazo, depois.observacao, new Date().toISOString(), usuario?.id ?? null);
  return { antes, depois };
}

/** Para o painel: quantas regras automáticas estão fora agora. */
async function foraDaRegra(db) {
  const out = await Promise.all(REGRAS.filter((r) => r.tipo === 'automatica').map((r) => rodar(r, db)));
  return out.filter((x) => x.situacao === 'fora').length;
}

module.exports = { REGRAS, GRUPOS, SITUACOES_ACOMPANHAMENTO, verificar, registrar, foraDaRegra };
