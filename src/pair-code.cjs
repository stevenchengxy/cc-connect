'use strict';

const { randomBytes, scrypt } = require('node:crypto');
const { promisify } = require('node:util');

// 32 symbols, excluding 0, 1, I and O. Each generated symbol has five bits.
const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const canonical = /^[2-9A-HJ-NP-Z]{12}$/;
const derive = promisify(scrypt);

function makePairCode() {
  return Array.from(randomBytes(12), byte => alphabet[byte & 31]).join('');
}

function normalizePairCode(value) {
  if (typeof value !== 'string' || value.length > 64 || !/^[a-zA-Z2-9\s-]+$/.test(value)) return null;
  const compact = value.replace(/[\s-]/g, '').toUpperCase();
  return canonical.test(compact) ? compact : null;
}

function formatPairCode(code) {
  return code.match(/.{4}/g).join('-');
}

function pairSecret(code) {
  // Both endpoints derive the registration proof and encryption keys locally.
  // The mailbox only receives the existing opaque room ID and role proofs.
  return derive(code, 'CC Connect / account pairing / v2', 32, {
    N: 65536, r: 8, p: 1, maxmem: 96 * 1024 * 1024
  });
}

module.exports = { makePairCode, normalizePairCode, formatPairCode, pairSecret };
