'use strict';

const http = require('node:http');

// Transitional Node consumers verify sessions at the single Kotlin owner.
function createKotlinAccess(origin) {
  const url = new URL(origin);
  if (url.origin !== origin || url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new TypeError('MEATBOX_KOTLIN_API_ORIGIN must be an exact loopback HTTP origin');
  }
  return {
    session(token) {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) return Promise.resolve(null);
      return new Promise((resolve, reject) => {
        const fail = () => { const error = new Error('Kotlin session unavailable'); error.status = 503; error.code = 'KOTLIN_SESSION_UNAVAILABLE'; reject(error); };
        const request = http.get(new URL('/api/session', url), {headers: {cookie: `meatbox_session=${token}`}, agent: false}, response => {
          let size = 0;
          const chunks = [];
          response.on('data', chunk => {
            size += chunk.length;
            if (size > 16384) response.destroy(new Error('Session response too large'));
            else chunks.push(chunk);
          });
          response.on('error', fail);
          response.on('end', () => {
            if (response.statusCode === 401) return resolve(null);
            if (response.statusCode !== 200 || !/^application\/json(?:;|$)/i.test(response.headers['content-type'] || '')) return fail();
            try {
              const user = JSON.parse(Buffer.concat(chunks).toString('utf8')).user;
              if (!user || typeof user !== 'object' || typeof user.username !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{2,39}$/.test(user.username)) return fail();
              resolve(user);
            } catch { fail(); }
          });
        });
        const timer = setTimeout(() => request.destroy(new Error('Session deadline exceeded')), 2000);
        request.on('error', fail);
        request.on('close', () => clearTimeout(timer));
      });
    },
  };
}

module.exports = {createKotlinAccess};
