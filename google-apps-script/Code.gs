/**
 * Flaynity Email OTP API — Google Apps Script
 * Deploy as Web App: Execute as Me, access Anyone.
 *
 * Script Properties required:
 * Firebase Web configuration is embedded below from Flaynity's js/firebase-config.js.
 * SERVICE_ACCOUNT_EMAIL  = Firebase Auth admin service-account email
 * SERVICE_ACCOUNT_KEY    = service-account private key (include BEGIN/END lines)
 * OTP_HMAC_SECRET        = long random secret (32+ chars)
 *
 * POST application/x-www-form-urlencoded:
 * action=sendEmailCode|verifyEmailCode
 * idToken=<Firebase ID token>
 * code=<4-digit code, verify only>
 */

// Same public Firebase configuration as Flaynity/js/firebase-config.js.
// Firebase Web API keys identify the project; they are not service-account secrets.
const FIREBASE_CONFIG = Object.freeze({
  apiKey: 'AIzaSyCiUTQp_QDSbBIOGJXKI7jJmzQHPu8L14I',
  authDomain: 'flaynity-app.firebaseapp.com',
  databaseURL: 'https://flaynity-app-default-rtdb.firebaseio.com',
  projectId: 'flaynity-app',
  storageBucket: 'flaynity-app.firebasestorage.app',
  messagingSenderId: '587469287255',
  appId: '1:587469287255:web:6ec177b0c1c802efc95812',
  measurementId: 'G-HPMF5TPJB2'
});

const OTP_LENGTH = 4;
const OTP_TTL_SECONDS = 300;
const RESEND_SECONDS = 60;
const MAX_ATTEMPTS = 5;
const CODE_PREFIX = 'FLAYNITY_EMAIL_OTP_';

function doGet() {
  return json_({ ok: true, service: 'Flaynity Email Verification', version: 1 });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    const p = (e && e.parameter) || {};
    const action = String(p.action || '');
    const idToken = String(p.idToken || '');
    if (!idToken) return jsonError_('AUTH_REQUIRED', 'Please sign in again.', 401);

    const user = firebaseUser_(idToken);
    if (!user || !user.localId || !user.email) {
      return jsonError_('INVALID_TOKEN', 'Your session expired. Please sign in again.', 401);
    }
    if (user.emailVerified === true) return json_({ ok: true, verified: true });

    if (action === 'sendEmailCode') {
      if (!lock.tryLock(10000)) return jsonError_('BUSY', 'Please try again.', 429);
      try { return sendCode_(user); } finally { lock.releaseLock(); }
    }
    if (action === 'verifyEmailCode') {
      if (!lock.tryLock(10000)) return jsonError_('BUSY', 'Please try again.', 429);
      try { return verifyCode_(user, String(p.code || ''), idToken); } finally { lock.releaseLock(); }
    }
    return jsonError_('BAD_ACTION', 'Unsupported verification action.', 400);
  } catch (err) {
    console.error(err && err.stack || err);
    return jsonError_('SERVER_ERROR', 'Verification service is temporarily unavailable.', 500);
  }
}

function sendCode_(user) {
  const props = PropertiesService.getScriptProperties();
  const key = recordKey_(user.localId);
  const now = Date.now();
  const previous = readRecord_(key);
  if (previous && previous.sentAt && now - previous.sentAt < RESEND_SECONDS * 1000) {
    const wait = Math.ceil((RESEND_SECONDS * 1000 - (now - previous.sentAt)) / 1000);
    return jsonError_('RESOURCE_EXHAUSTED', 'Please wait ' + wait + ' seconds before requesting another code.', 429);
  }
  if (MailApp.getRemainingDailyQuota() < 1) {
    return jsonError_('MAIL_QUOTA', 'Email sending limit reached. Please try again later.', 429);
  }

  const code = String(Math.floor(1000 + Math.random() * 9000));
  const secret = required_('OTP_HMAC_SECRET');
  const record = {
    hash: otpHash_(user.localId, user.email.toLowerCase(), code, secret),
    sentAt: now,
    expiresAt: now + OTP_TTL_SECONDS * 1000,
    attempts: 0
  };
  // Save before sending; if delivery fails, the record is removed.
  PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(record));
  try {
    MailApp.sendEmail({
      to: user.email,
      subject: 'Your Flaynity verification code',
      name: 'Flaynity',
      body: 'Your Flaynity verification code is ' + code + '. It expires in 5 minutes. If you did not create a Flaynity account, ignore this email.',
      htmlBody: '<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:28px;color:#171717"><h2 style="margin:0 0 12px">Verify your Flaynity email</h2><p>Use this code to finish creating your account:</p><div style="font-size:34px;font-weight:800;letter-spacing:10px;padding:18px 0">' + code + '</div><p>This code expires in <b>5 minutes</b>. Do not share it with anyone.</p><p style="color:#777;font-size:12px">If you did not create a Flaynity account, you can ignore this email.</p></div>'
    });
  } catch (mailErr) {
    props.deleteProperty(key);
    throw mailErr;
  }
  return json_({ ok: true, sent: true, expiresIn: OTP_TTL_SECONDS, resendAfter: RESEND_SECONDS, digits: OTP_LENGTH });
}

function verifyCode_(user, code, idToken) {
  if (!/^\d{4}$/.test(code)) return jsonError_('INVALID_CODE', 'Enter the 4-digit verification code.', 400);
  const props = PropertiesService.getScriptProperties();
  const key = recordKey_(user.localId);
  const record = readRecord_(key);
  if (!record) return jsonError_('CODE_NOT_FOUND', 'Request a new verification code.', 400);
  if (Date.now() > Number(record.expiresAt || 0)) {
    props.deleteProperty(key);
    return jsonError_('CODE_EXPIRED', 'This code has expired. Request a new code.', 400);
  }
  if (Number(record.attempts || 0) >= MAX_ATTEMPTS) {
    props.deleteProperty(key);
    return jsonError_('TOO_MANY_ATTEMPTS', 'Too many incorrect attempts. Request a new code.', 429);
  }

  const expected = String(record.hash || '');
  const actual = otpHash_(user.localId, user.email.toLowerCase(), code, required_('OTP_HMAC_SECRET'));
  if (!constantTimeEqual_(expected, actual)) {
    record.attempts = Number(record.attempts || 0) + 1;
    props.setProperty(key, JSON.stringify(record));
    return jsonError_('INVALID_CODE', 'The code is incorrect. Please try again.', 400);
  }

  // Only after the OTP is correct, set Firebase Auth emailVerified using Admin credentials.
  setFirebaseEmailVerified_(user.localId);
  props.deleteProperty(key);
  return json_({ ok: true, verified: true });
}

function firebaseUser_(idToken) {
  const apiKey = FIREBASE_CONFIG.apiKey;
  const response = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + encodeURIComponent(apiKey), {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ idToken: idToken }),
    muteHttpExceptions: true
  });
  const body = JSON.parse(response.getContentText() || '{}');
  if (response.getResponseCode() !== 200 || !body.users || !body.users.length) {
    throw new Error('Firebase token validation failed: ' + (body.error && body.error.message || response.getResponseCode()));
  }
  return body.users[0];
}

function setFirebaseEmailVerified_(uid) {
  const projectId = FIREBASE_CONFIG.projectId;
  const accessToken = serviceAccountAccessToken_();
  const url = 'https://identitytoolkit.googleapis.com/v1/projects/' + encodeURIComponent(projectId) + '/accounts:update';
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + accessToken },
    payload: JSON.stringify({ localId: uid, emailVerified: true }),
    muteHttpExceptions: true
  });
  const body = JSON.parse(response.getContentText() || '{}');
  if (response.getResponseCode() !== 200 || body.emailVerified !== true) {
    throw new Error('Could not update Firebase emailVerified: ' + (body.error && body.error.message || response.getResponseCode()));
  }
}

function serviceAccountAccessToken_() {
  const email = required_('SERVICE_ACCOUNT_EMAIL');
  const privateKey = required_('SERVICE_ACCOUNT_KEY').replace(/\\n/g, '\n');
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url_(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64Url_(JSON.stringify({
    iss: email,
    scope: 'https://www.googleapis.com/auth/identitytoolkit',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }));
  const unsigned = header + '.' + claim;
  const signature = Utilities.computeRsaSha256Signature(unsigned, privateKey);
  const assertion = unsigned + '.' + Utilities.base64EncodeWebSafe(signature).replace(/=+$/g, '');
  const response = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: assertion },
    muteHttpExceptions: true
  });
  const body = JSON.parse(response.getContentText() || '{}');
  if (response.getResponseCode() !== 200 || !body.access_token) {
    throw new Error('Service account token error: ' + (body.error_description || body.error || response.getResponseCode()));
  }
  return body.access_token;
}

function otpHash_(uid, email, code, secret) {
  const raw = uid + '|' + email + '|' + code;
  const bytes = Utilities.computeHmacSha256Signature(raw, secret);
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/g, '');
}
function recordKey_(uid) { return CODE_PREFIX + uid; }
function readRecord_(key) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  if (!value) return null;
  try { return JSON.parse(value); } catch (_) { return null; }
}
function required_(name) {
  const value = PropertiesService.getScriptProperties().getProperty(name);
  if (!value) throw new Error('Missing Script Property: ' + name);
  return value;
}
function base64Url_(value) {
  return Utilities.base64EncodeWebSafe(value).replace(/=+$/g, '');
}
function constantTimeEqual_(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
function jsonError_(code, message, status) {
  return json_({ ok: false, code: code, error: message, status: status });
}
