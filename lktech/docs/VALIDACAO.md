# Validação do pacote

Ambiente utilizado: Node.js 24.22.3, SQLite nativo e Chrome.

## Automatizada

- `npm run check`: sintaxe dos 12 arquivos JavaScript verificada.
- `npm test`: 3 testes aprovados, incluindo um fluxo integrado com banco real temporário.
- Login válido e inválido; painel e arquivos de dados protegidos contra acesso público.
- Bloqueio de escrita sem token CSRF e de origem diferente.
- Salvar rascunho não altera o site público; a prévia mostra as edições; publicar altera a versão pública.
- Edição com revisão antiga é recusada para evitar sobrescrever outra sessão.
- Preço editado e registros de contato persistem em uma segunda conexão ao banco.
- Upload PNG aceito; conteúdo SVG ativo recusado; imagem enviada é servida corretamente.
- Consulta de CEP com disponibilidade configurada, confirmação manual e entrada inválida.
- Formulário com consentimento, atualização de situação e exportação CSV.
- Título de busca publicado é escapado e entregue no HTML pelo servidor.
- Troca de senha invalida a sessão anterior.

## Navegador

- Página pública, logo e imagem do banner carregados.
- Carrossel avançou e atualizou seu indicador.
- Layout conferido em quadros de 360, 390, 768, 1024 e 1440 px.
- Menu de celular abriu e navegou para os planos.
- Botão de plano abriu o formulário de contato.
- A interface de login foi renderizada. Autenticação e edição administrativa foram verificadas pela integração da API; o login do painel não foi automatizado no navegador.

## Limites da entrega

O projeto foi executado localmente; não foi instalado no domínio final nem conectado a um ERP. Contatos, preços, condições, cobertura e links externos reais devem ser preenchidos pela empresa no painel antes da publicação. O pacote não inclui a conta nem o banco usados nos testes.
