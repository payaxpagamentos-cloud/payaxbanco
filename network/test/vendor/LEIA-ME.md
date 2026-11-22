# Material de terceiros usado SÓ nos testes

## jsqr.js

Leitor de QR Code **jsQR 1.4.0** (<https://github.com/cozmo/jsQR>), licença Apache-2.0,
baixado de `https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js`.

Por que está aqui dentro: o gerador de QR do sistema (`server/lib/qr.js`) é escrito do zero, e um QR
errado não dá erro em lugar nenhum — ele simplesmente não lê, e quem descobre é o cliente com o celular
na mão. A única prova que vale é um leitor independente ler o que foi gerado. Guardado no repositório
para que essa prova rode off-line, sempre, e não dependa de a rede estar de pé na hora do teste.

**Não é dependência do sistema.** Nada em `server/` ou `public/` usa este arquivo: ele só é carregado
pelo navegador dentro de `test/qr.test.js`.
