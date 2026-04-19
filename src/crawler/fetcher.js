// HTTP(S) GET with timeout, redirect, size cap, and content-type guard.
// Pure stdlib (node:http / node:https).

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { CONFIG } from '../config.js';

/**
 * Categorized fetch error.
 * @typedef {{ kind: 'net'|'type'|'size'|'http', message: string, status?: number }} FetchError
 */

class CategorizedError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.kind = kind;
    Object.assign(this, extra);
  }
}

function pickAgent(protocol) {
  return protocol === 'https:' ? https : http;
}

/**
 * Perform a single GET (no redirect) and deliver body bytes.
 * @param {string} urlStr
 */
function doGetOnce(urlStr) {
  return new Promise((resolve, reject) => {
    let urlObj;
    try {
      urlObj = new URL(urlStr);
    } catch {
      return reject(new CategorizedError('net', `invalid url: ${urlStr}`));
    }
    if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
      return reject(new CategorizedError('net', `unsupported scheme: ${urlObj.protocol}`));
    }

    const lib = pickAgent(urlObj.protocol);
    const options = {
      method: 'GET',
      protocol: urlObj.protocol,
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: (urlObj.pathname || '/') + (urlObj.search || ''),
      headers: {
        'User-Agent': CONFIG.USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
        'Accept-Encoding': 'identity',
        'Connection': 'close',
      },
      timeout: CONFIG.FETCH_TIMEOUT_MS,
    };

    let settled = false;
    const finish = (fn, val) => { if (!settled) { settled = true; fn(val); } };

    const req = lib.request(options, (res) => {
      const status = res.statusCode || 0;
      const headers = res.headers || {};

      // Redirect — caller handles chaining. Drain response body.
      if (status >= 300 && status < 400 && headers.location) {
        res.resume();
        return finish(resolve, {
          redirect: true,
          location: headers.location,
          status,
          contentType: headers['content-type'] || '',
        });
      }

      if (status < 200 || status >= 300) {
        res.resume();
        return finish(reject, new CategorizedError('http', `http ${status}`, { status }));
      }

      const contentType = (headers['content-type'] || '').toLowerCase();
      if (!contentType.startsWith('text/html')) {
        res.resume();
        return finish(reject, new CategorizedError('type', `non-html content-type: ${contentType || '(none)'}`));
      }

      // Declared Content-Length short-circuit.
      const declaredLen = Number(headers['content-length']);
      if (Number.isFinite(declaredLen) && declaredLen > CONFIG.FETCH_MAX_BODY_BYTES) {
        res.resume();
        return finish(reject, new CategorizedError('size', `declared content-length ${declaredLen} exceeds cap`));
      }

      const chunks = [];
      let received = 0;
      let oversized = false;

      res.on('data', (chunk) => {
        if (oversized) return;
        received += chunk.length;
        if (received > CONFIG.FETCH_MAX_BODY_BYTES) {
          oversized = true;
          res.destroy();
          return finish(reject, new CategorizedError('size', `body exceeded ${CONFIG.FETCH_MAX_BODY_BYTES} bytes`));
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        if (oversized) return;
        const body = Buffer.concat(chunks, received).toString('utf8');
        finish(resolve, {
          redirect: false,
          status,
          contentType,
          body,
        });
      });

      res.on('error', (err) => {
        finish(reject, new CategorizedError('net', `response error: ${err.message}`));
      });
    });

    req.on('timeout', () => {
      req.destroy(new CategorizedError('net', `timeout after ${CONFIG.FETCH_TIMEOUT_MS}ms`));
    });

    req.on('error', (err) => {
      if (err && err.kind) {
        finish(reject, err);
      } else {
        finish(reject, new CategorizedError('net', err && err.message ? err.message : 'network error'));
      }
    });

    req.end();
  });
}

/**
 * Fetch a URL, following up to CONFIG.FETCH_MAX_REDIRECTS redirects.
 * @param {string} url
 * @returns {Promise<{status:number, contentType:string, body:string, finalUrl:string}>}
 * @throws {CategorizedError}
 */
export async function fetchPage(url) {
  let current = url;
  let redirects = 0;

  while (true) {
    const res = await doGetOnce(current);
    if (!res.redirect) {
      return { status: res.status, contentType: res.contentType, body: res.body, finalUrl: current };
    }
    if (redirects >= CONFIG.FETCH_MAX_REDIRECTS) {
      throw new CategorizedError('net', `too many redirects (> ${CONFIG.FETCH_MAX_REDIRECTS})`);
    }
    let nextUrl;
    try {
      nextUrl = new URL(res.location, current).toString();
    } catch {
      throw new CategorizedError('net', `invalid redirect location: ${res.location}`);
    }
    redirects += 1;
    current = nextUrl;
  }
}
