'use strict';
module.exports = {
  randomUUID: () => globalThis.crypto.randomUUID(),
  randomBytes: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
};
