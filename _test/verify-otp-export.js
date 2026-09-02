const assert = require('assert');
const totp = require('../utils/totp.js');
const exporter = require('../utils/otp-export.js');

const tokens = [{
  issuer: 'Example',
  accountName: 'alice@example.com',
  secret: 'JBSWY3DPEHPK3PXP',
  algorithm: 'SHA1',
  digits: 6,
  period: 30,
}];

const txt = exporter.toUriLines(tokens);
assert.strictEqual(exporter.parseImportText(txt)[0].secret, tokens[0].secret);
const json = exporter.toJson(tokens);
assert.strictEqual(exporter.parseImportText(json)[0].accountName, tokens[0].accountName);
const migration = exporter.toGoogleMigration(tokens);
const imported = exporter.parseImportText(migration);
assert.strictEqual(imported.length, 1);
assert.strictEqual(imported[0].issuer, tokens[0].issuer);
assert.strictEqual(imported[0].accountName, tokens[0].accountName);
assert.strictEqual(imported[0].secret, tokens[0].secret);
assert.strictEqual(totp.code(imported[0], 0), totp.code(tokens[0], 0));
console.log('OTP export/import round-trip passed (TXT/JSON/Google)');
