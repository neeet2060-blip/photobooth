'use strict';

/**
 * Minimal IPP client — enough to ask a printer what it can do and to hand it
 * a JPEG.
 *
 * Why this exists (2026-08-13): the event printer is a Canon SELPHY CP1500,
 * for which Canon ships no Windows 11 driver at all. Windows falls back to
 * its generic "IPP Class Driver", which mis-reports the printer as
 * Letter/A4 + grayscale — printing through it would produce a stretched
 * black-and-white photo on paper the printer does not even hold. The printer
 * itself, asked directly, advertises exactly what we need:
 *
 *     document-format-supported : image/urf, image/jpeg, image/pwg-raster
 *     media-ready               : jpn_hagaki_100x148mm
 *     print-color-mode          : color
 *     URF                       : SRGB24, RS300  (sRGB, 300dpi)
 *
 * composePrintSheet already produces a 1200x1800 300dpi JPEG, so talking IPP
 * directly skips the broken driver layer entirely and sends the printer
 * precisely the bytes it asked for.
 *
 * Dependency-free (node:http + node:net) on purpose: the event PC installs
 * packages over whatever hotspot the venue provides, and an npm install on
 * event morning is its own failure mode.
 */

const http = require('http');
const net = require('net');
const os = require('os');

const DEFAULT_PORT = 631;
const DEFAULT_PATH = '/ipp/print';

// IPP delimiter and value tags (RFC 8010 §3.5).
const TAG = {
  OPERATION_GROUP: 0x01,
  JOB_GROUP: 0x02,
  END: 0x03,
  INTEGER: 0x21,
  KEYWORD: 0x44,
  URI: 0x45,
  CHARSET: 0x47,
  LANGUAGE: 0x48,
  MIME: 0x49,
  NAME: 0x42,
};

const OP = {
  PRINT_JOB: 0x0002,
  GET_PRINTER_ATTRIBUTES: 0x000b,
};

// IPP calls anything in 0x0000-0x00ff a success ("successful-ok",
// "...-ignored-or-substituted-attributes", "...-conflicting-attributes").
// The substituted/conflicting variants still print, so they count as success.
function isSuccess(statusCode) {
  return statusCode >= 0x0000 && statusCode <= 0x00ff;
}

// ---- encoding --------------------------------------------------------------

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}

function stringAttribute(tag, name, value) {
  const n = Buffer.from(name, 'utf8');
  const v = Buffer.from(value, 'utf8');
  return Buffer.concat([Buffer.from([tag]), u16(n.length), n, u16(v.length), v]);
}

function integerAttribute(name, value) {
  const n = Buffer.from(name, 'utf8');
  const v = Buffer.alloc(4);
  v.writeInt32BE(value);
  return Buffer.concat([Buffer.from([TAG.INTEGER]), u16(n.length), n, u16(4), v]);
}

function header(operation, requestId) {
  const b = Buffer.alloc(8);
  b.writeUInt16BE(0x0200, 0); // IPP/2.0
  b.writeUInt16BE(operation, 2);
  b.writeUInt32BE(requestId, 4);
  return b;
}

// ---- decoding --------------------------------------------------------------

/**
 * Parses an IPP response into { statusCode, attributes } where attributes maps
 * a name to an array of values. Only the value types this client actually
 * reads are decoded (text-ish and integer); anything else is kept as a raw
 * Buffer rather than guessed at.
 *
 * A real parser rather than scanning the response for substrings: `media-ready`
 * decides what paper we ask for, and a substring match would happily pick up
 * `media-ready` out of `media-col-ready` and print onto the wrong size.
 */
function parseResponse(buf) {
  if (!buf || buf.length < 8) {
    throw new Error('IPP response too short');
  }
  const statusCode = buf.readUInt16BE(2);
  const attributes = {};

  let offset = 8;
  let lastName = null;

  while (offset < buf.length) {
    const tag = buf.readUInt8(offset);
    offset += 1;

    if (tag === TAG.END) break;
    // Delimiter tags (0x00-0x05) start a new group and carry no value.
    if (tag <= 0x05) {
      lastName = null;
      continue;
    }

    if (offset + 2 > buf.length) break;
    const nameLength = buf.readUInt16BE(offset);
    offset += 2;
    const name = nameLength > 0 ? buf.toString('utf8', offset, offset + nameLength) : lastName;
    offset += nameLength;

    if (offset + 2 > buf.length) break;
    const valueLength = buf.readUInt16BE(offset);
    offset += 2;
    const raw = buf.subarray(offset, offset + valueLength);
    offset += valueLength;

    if (!name) continue;
    if (nameLength > 0) lastName = name;

    let value;
    if (tag === TAG.INTEGER || tag === 0x23 /* enum */) {
      value = valueLength === 4 ? raw.readInt32BE(0) : raw;
    } else if (tag >= 0x40 && tag <= 0x4a) {
      value = raw.toString('utf8');
    } else {
      value = raw;
    }

    if (!attributes[name]) attributes[name] = [];
    attributes[name].push(value);
  }

  return { statusCode, attributes };
}

// ---- transport -------------------------------------------------------------

function postIpp(target, body, timeoutMs) {
  const { host, port, path } = target;
  return new Promise((resolve, reject) => {
    const req = http.request({
      host,
      port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/ipp',
        'Content-Length': body.length,
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`IPP HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(parseResponse(Buffer.concat(chunks)));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('IPP request timed out'));
    });
    req.write(body);
    req.end();
  });
}

function printerUri(target) {
  return `ipp://${target.host}:${target.port}${target.path}`;
}

/**
 * Get-Printer-Attributes. Used both to confirm a candidate address really is
 * a printer we can drive, and to read the paper actually loaded right now.
 */
async function getPrinterAttributes(target, { timeoutMs = 5000 } = {}) {
  const body = Buffer.concat([
    header(OP.GET_PRINTER_ATTRIBUTES, 1),
    Buffer.from([TAG.OPERATION_GROUP]),
    stringAttribute(TAG.CHARSET, 'attributes-charset', 'utf-8'),
    stringAttribute(TAG.LANGUAGE, 'attributes-natural-language', 'en'),
    stringAttribute(TAG.URI, 'printer-uri', printerUri(target)),
    Buffer.from([TAG.END]),
  ]);
  const { statusCode, attributes } = await postIpp(target, body, timeoutMs);
  if (!isSuccess(statusCode)) {
    throw new Error(`Get-Printer-Attributes failed: 0x${statusCode.toString(16)}`);
  }
  return attributes;
}

/** @returns {boolean} true if this printer can be handed a JPEG directly. */
function acceptsJpeg(attributes) {
  const formats = attributes['document-format-supported'] || [];
  return formats.some((f) => String(f).toLowerCase() === 'image/jpeg');
}

/**
 * The paper actually in the printer right now. Preferred over a configured
 * value so that swapping cassettes (postcard <-> card size) needs no settings
 * change — and so a stale setting can never send a job for paper that isn't
 * loaded.
 */
function readyMedia(attributes) {
  const ready = attributes['media-ready'] || attributes['media-default'] || [];
  const first = ready.find((m) => typeof m === 'string' && m);
  return first || null;
}

/**
 * Print-Job: hands the printer the JPEG bytes.
 *
 * `media` is omitted rather than guessed when unknown — the printer then uses
 * its own default, which is by definition the paper it is holding.
 */
async function printJob(target, data, { copies = 1, media = null, jobName = 'photobooth', timeoutMs = 60000 } = {}) {
  const jobAttributes = [Buffer.from([TAG.JOB_GROUP])];
  if (media) jobAttributes.push(stringAttribute(TAG.KEYWORD, 'media', media));
  jobAttributes.push(stringAttribute(TAG.KEYWORD, 'print-color-mode', 'color'));
  jobAttributes.push(integerAttribute('copies', copies));

  const body = Buffer.concat([
    header(OP.PRINT_JOB, 1),
    Buffer.from([TAG.OPERATION_GROUP]),
    stringAttribute(TAG.CHARSET, 'attributes-charset', 'utf-8'),
    stringAttribute(TAG.LANGUAGE, 'attributes-natural-language', 'en'),
    stringAttribute(TAG.URI, 'printer-uri', printerUri(target)),
    stringAttribute(TAG.NAME, 'requesting-user-name', 'photobooth'),
    stringAttribute(TAG.NAME, 'job-name', jobName),
    stringAttribute(TAG.MIME, 'document-format', 'image/jpeg'),
    ...jobAttributes,
    Buffer.from([TAG.END]),
    data,
  ]);

  const { statusCode, attributes } = await postIpp(target, body, timeoutMs);
  if (!isSuccess(statusCode)) {
    throw new Error(`Print-Job rejected: 0x${statusCode.toString(16)}`);
  }
  return {
    jobId: (attributes['job-id'] || [])[0] ?? null,
    jobState: (attributes['job-state'] || [])[0] ?? null,
  };
}

// ---- address parsing -------------------------------------------------------

/**
 * Accepts "ipp://host:631/ipp/print", "http://host/ipp/print", or a bare
 * "192.168.1.5". Returns null for anything unparseable rather than throwing,
 * so a typo in /admin degrades to auto-discovery instead of an error page.
 */
function parseTarget(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw.replace(/^ipp:\/\//i, 'http://') : `http://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch (err) {
    return null;
  }
  if (!url.hostname) return null;
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : DEFAULT_PORT,
    path: url.pathname && url.pathname !== '/' ? url.pathname : DEFAULT_PATH,
  };
}

// ---- discovery -------------------------------------------------------------

function tcpProbe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

/**
 * Every IPv4 address on this machine's subnets, excluding our own.
 *
 * Only /24 or smaller is walked: the venue runs on a phone hotspot (an iPhone
 * hands out a /28 — 14 usable addresses), and a wider mask would mean
 * thousands of probes. A printer that isn't on a small local subnet isn't
 * something we can find this way anyway.
 */
function candidateHosts() {
  const hosts = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      const prefix = typeof iface.cidr === 'string' ? Number(iface.cidr.split('/')[1]) : 24;
      if (!Number.isFinite(prefix) || prefix < 24) continue;
      const parts = iface.address.split('.').map(Number);
      if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p))) continue;
      const size = 2 ** (32 - prefix);
      const base = ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
      const network = base - (base % size);
      for (let i = 1; i < size - 1; i += 1) {
        const addr = network + i;
        const ip = [(addr >>> 24) & 0xff, (addr >>> 16) & 0xff, (addr >>> 8) & 0xff, addr & 0xff].join('.');
        if (ip !== iface.address) hosts.push(ip);
      }
    }
  }
  return [...new Set(hosts)];
}

/**
 * Finds a JPEG-capable IPP printer on the local subnet.
 *
 * Exists because the venue's network is a phone hotspot: it hands the printer
 * a different address every time it restarts, so any address written into
 * settings is one reboot away from being wrong. Rather than have a volunteer
 * read an IP off the printer's screen mid-event, look for it.
 */
async function discover({ port = DEFAULT_PORT, probeTimeoutMs = 700, attributesTimeoutMs = 3000 } = {}) {
  const hosts = candidateHosts();
  const reachable = [];
  // Bounded concurrency: a /24 is 253 probes and opening them all at once
  // exhausts sockets on Windows.
  const BATCH = 32;
  for (let i = 0; i < hosts.length; i += BATCH) {
    const batch = hosts.slice(i, i + BATCH);
    const results = await Promise.all(batch.map((h) => tcpProbe(h, port, probeTimeoutMs)));
    results.forEach((ok, idx) => { if (ok) reachable.push(batch[idx]); });
  }

  for (const host of reachable) {
    const target = { host, port, path: DEFAULT_PATH };
    try {
      const attributes = await getPrinterAttributes(target, { timeoutMs: attributesTimeoutMs });
      if (acceptsJpeg(attributes)) {
        return {
          target,
          media: readyMedia(attributes),
          model: (attributes['printer-make-and-model'] || [])[0] || null,
        };
      }
    } catch (err) {
      // Not an IPP printer, or not one we can drive — keep looking.
    }
  }
  return null;
}

module.exports = {
  getPrinterAttributes,
  printJob,
  discover,
  parseTarget,
  acceptsJpeg,
  readyMedia,
  parseResponse,
  isSuccess,
  DEFAULT_PORT,
  DEFAULT_PATH,
};
