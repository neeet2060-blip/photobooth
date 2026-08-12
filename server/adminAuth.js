'use strict';

/**
 * Password gate for /api/admin/* routes (2026-08-11 pre-launch audit fix).
 *
 * These routes had no authentication at all — anyone on the venue LAN could
 * change settings, delete frames, cancel print jobs, or read revenue with
 * just the URL. This module is deliberately minimal (a single shared
 * password, checked via a request header) rather than a full session/token
 * system — proportionate to this app's actual deployment (one booth, one
 * operator screen, not a multi-user system).
 *
 * Fails CLOSED: unlike server/tokPayment.js and server/cloud.js (where
 * "not configured" safely means "this optional integration does nothing"),
 * an unconfigured admin password must never mean "no password required" —
 * that would just be today's insecure default again. Every /api/admin/*
 * request is rejected until an operator creates the password file.
 */

const fs = require('fs');
const path = require('path');

const PASSWORD_FILE = process.env.PHOTOBOOTH_ADMIN_PASSWORD_FILE
  || path.join(__dirname, '..', 'secrets', 'admin-password.txt');

// null = not yet successfully loaded (keep re-checking the file on every
// call, same reasoning as tokPayment.js's getDb() — lets an operator create
// the file after boot without a restart); a real password string once found.
let cachedPassword = null;
let warnedOnce = false;

function warnOnce(message) {
  if (warnedOnce) return;
  warnedOnce = true;
  console.warn(`[adminAuth] ${message}`);
}

function readPassword() {
  if (cachedPassword !== null) return cachedPassword;
  let raw;
  try {
    raw = fs.readFileSync(PASSWORD_FILE, 'utf8').trim();
  } catch (err) {
    warnOnce(`admin routes are BLOCKED — no password file at ${PASSWORD_FILE}. See WINDOWS-SETUP.md to create one.`);
    return '';
  }
  if (!raw) {
    warnOnce(`admin routes are BLOCKED — ${PASSWORD_FILE} exists but is empty.`);
    return '';
  }
  cachedPassword = raw;
  return cachedPassword;
}

/**
 * @returns {boolean} true once a non-empty password file has been found.
 */
function isConfigured() {
  return Boolean(readPassword());
}

/**
 * Express middleware — apply to every /api/admin/* route.
 */
function requireAdmin(req, res, next) {
  const configured = readPassword();
  if (!configured) {
    res.status(503).json({ ok: false, error: 'admin_auth_not_configured' });
    return;
  }
  const supplied = req.headers['x-admin-password'];
  if (typeof supplied !== 'string' || supplied !== configured) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }
  next();
}

/**
 * Test-only seam: inject a password directly (or null to reset back to the
 * real file-based lookup) so tests never touch the real filesystem path.
 */
function _setPasswordForTests(password) {
  cachedPassword = password;
}

module.exports = { requireAdmin, isConfigured, _setPasswordForTests, PASSWORD_FILE };
