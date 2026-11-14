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

const GRUPOS = [
  { id: 'boleto', titulo: 'Boleto e cobrança' },
  { id: 'banco', titulo: 'Banco (Bradesco)' },
  { id: 'dados', titulo: 'Dados e segurança (LGPD)' },
  { id: 'regulatorio', titulo: 'Regulatório' },
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
    id: 'lgpd-aviso',
    grupo: 'dados',
    tipo: 'acompanhamento',
    titulo: 'Aviso de privacidade ao pagador',
    norma: 'LGPD (Lei 13.709/2018), art. 9º',
    exige: 'O pagador tem direito a saber quais dados dele são tratados, para quê e por quem.',
    responsavel: 'Jurídico (texto) e tecnologia (publicação)',
  },
  {
    id: 'lgpd-retencao',
    grupo: 'dados',
    tipo: 'acompanhamento',
    titulo: 'Retenção de dados e pedidos do titular',
    norma: 'LGPD (Lei 13.709/2018), arts. 15, 16 e 18',
    exige: 'Política de quanto tempo cada dado fica guardado e um canal para o titular pedir acesso, correção ou exclusão.',
    responsavel: 'Jurídico',
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
      return ok('Todo valor creditado antes de hoje já foi repassado. O de hoje sai na rodada seguinte (a cada 15 minutos).');
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
    titulo: 'Sem "banco", "bank" ou "agência" para o cliente',
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
      const proibido = /internet\s*bank|\bbank\b|ag[êe]ncia/i;
      const achados = arquivos.filter((a) => proibido.test(fs.readFileSync(a, 'utf8'))).map((a) => path.relative(raiz, a));
      if (achados.length) return fora(`Termo de instituição financeira nas telas do cliente: ${achados.join(', ')}.`);
      return ok(`Nenhuma das ${arquivos.length} telas da Área do Cliente usa "banco/bank" como nome nem "agência".`);
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
    id: 'pld',
    grupo: 'regulatorio',
    tipo: 'acompanhamento',
    titulo: 'Prevenção à lavagem de dinheiro',
    norma: 'Lei 9.613/1998',
    exige: 'Conhecer o cliente, monitorar operações fora do padrão e comunicar ao COAF quando couber.',
    responsavel: 'Jurídico e compliance',
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
