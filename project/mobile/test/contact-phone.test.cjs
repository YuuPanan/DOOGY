const { test } = require('node:test');
const { strict: assert } = require('node:assert');
const { contactDialUrl } = require('../.test-dist/contactPhone.js');
test('dialing preserves an explicit prefix and local number without guessing the country', () => {
  assert.equal(contactDialUrl('+86 (138) 0000-0000'), 'tel:+8613800000000');
  assert.equal(contactDialUrl('020-12345678'), 'tel:02012345678');
  assert.equal(contactDialUrl('110'), 'tel:110');
});
test('dialing refuses service codes, URL parameters and ambiguous extensions', () => {
  for (const phone of ['*21*13800000000#', 'tel:+8613800000000', '13800000000?body=x', '123 ext 45', '+86+123456', '1', '123456789012345678901', '']) assert.throws(() => contactDialUrl(phone));
});
