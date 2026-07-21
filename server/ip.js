'use strict';

const os = require('os');

/**
 * Best-effort LAN IPv4 address (skips internal/loopback and virtual
 * adapters where possible). Falls back to 127.0.0.1 if nothing found.
 */
function getLanIp() {
  const interfaces = os.networkInterfaces();
  const candidates = [];

  for (const name of Object.keys(interfaces)) {
    const lowerName = name.toLowerCase();
    const isLikelyVirtual = /vether|vmnet|vbox|docker|veth|utun|awdl|llw/.test(lowerName);
    if (isLikelyVirtual) continue;

    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        candidates.push(iface.address);
      }
    }
  }

  if (candidates.length === 0) return '127.0.0.1';

  const preferred = candidates.find((ip) => ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.'));
  return preferred || candidates[0];
}

module.exports = { getLanIp };
