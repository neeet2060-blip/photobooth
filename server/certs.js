'use strict';

const fs = require('fs');
const path = require('path');
const selfsigned = require('selfsigned');
const { getLanIp } = require('./ip');

const CERTS_DIR = path.join(__dirname, '..', 'certs');
const KEY_FILE = path.join(CERTS_DIR, 'key.pem');
const CERT_FILE = path.join(CERTS_DIR, 'cert.pem');

/**
 * Returns { key, cert } PEM strings, generating and caching a self-signed
 * certificate on first run. The cert includes the current LAN IP and
 * localhost as subject alternative names so browsers on other devices on
 * the LAN can (after accepting the warning) trust the connection.
 */
function getOrCreateCerts() {
  if (fs.existsSync(KEY_FILE) && fs.existsSync(CERT_FILE)) {
    return {
      key: fs.readFileSync(KEY_FILE, 'utf8'),
      cert: fs.readFileSync(CERT_FILE, 'utf8'),
    };
  }

  const lanIp = getLanIp();
  const attrs = [{ name: 'commonName', value: lanIp }];
  const altNames = [
    { type: 2, value: 'localhost' }, // DNS
    // photobooth.local (mDNS/Bonjour, 2026-08-10) — lets LAN devices use a
    // name that survives DHCP re-assigning the IP, instead of re-typing it.
    { type: 2, value: 'photobooth.local' }, // DNS
    { type: 7, ip: '127.0.0.1' }, // IP
    { type: 7, ip: lanIp }, // IP
  ];

  const pems = selfsigned.generate(attrs, {
    keySize: 2048,
    days: 3650,
    algorithm: 'sha256',
    extensions: [
      {
        name: 'subjectAltName',
        altNames,
      },
      {
        name: 'basicConstraints',
        cA: false,
      },
      {
        name: 'keyUsage',
        keyCertSign: false,
        digitalSignature: true,
        nonRepudiation: true,
        keyEncipherment: true,
        dataEncipherment: true,
      },
    ],
  });

  if (!fs.existsSync(CERTS_DIR)) {
    fs.mkdirSync(CERTS_DIR, { recursive: true });
  }
  fs.writeFileSync(KEY_FILE, pems.private, 'utf8');
  fs.writeFileSync(CERT_FILE, pems.cert, 'utf8');

  return { key: pems.private, cert: pems.cert };
}

module.exports = { getOrCreateCerts, CERTS_DIR };
