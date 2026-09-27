'use strict';

const express = require('express');
const { ResourceError } = require('./resource-store');

function createResourceRouter({ store, origin }) {
  const router = express.Router();
  router.use((req, res, next) => store ? next() : res.status(503).json({ error: 'RESOURCE_DATABASE_UNAVAILABLE', message: '자원 등록부가 설정되지 않았습니다.' }));
  const route = handler => (req, res) => {
    try { res.json(handler(req)); }
    catch (error) {
      const known = error instanceof ResourceError;
      res.status(known ? error.status : 503).json({ error: known ? error.code : 'RESOURCE_DATABASE_UNAVAILABLE',
        message: known ? error.message : '자원 등록부를 사용할 수 없습니다.' });
    }
  };
  const json = express.json({ limit: '256kb', strict: true, type: 'application/json' });
  router.use((req, res, next) => {
    if (!['POST', 'PATCH'].includes(req.method)) return next();
    if (req.headers.origin !== origin) return res.status(403).json({ error: 'ORIGIN_REQUIRED', message: '같은 출처에서 다시 시도해 주세요.' });
    json(req, res, error => error ? res.status(400).json({ error: 'INVALID_JSON' }) : next());
  });
  const validBody = (body, keys) => body && typeof body === 'object' && !Array.isArray(body) &&
    Object.keys(body).length === keys.length && keys.every(key => Object.hasOwn(body, key));
  router.get('/', route(() => store.snapshot()));
  router.post('/region-codes', route(req => {
    if (!validBody(req.body, ['revision', 'code'])) throw new ResourceError(400, 'INVALID_INPUT', '입력값을 확인해 주세요.');
    return store.createRegionCode(req.body.revision, req.body.code);
  }));
  router.patch('/region-codes/:code', route(req => {
    if (!validBody(req.body, ['revision', 'code'])) throw new ResourceError(400, 'INVALID_INPUT', '입력값을 확인해 주세요.');
    return store.renameRegionCode(req.body.revision, req.params.code, req.body.code);
  }));
  router.patch('/vehicles', route(req => {
    if (!validBody(req.body, ['revision', 'assignments'])) throw new ResourceError(400, 'INVALID_INPUT', '입력값을 확인해 주세요.');
    return store.assignVehicles(req.body.revision, req.body.assignments);
  }));
  router.patch('/vehicles/:id', route(req => {
    if (!validBody(req.body, ['revision', 'regionCode'])) throw new ResourceError(400, 'INVALID_INPUT', '입력값을 확인해 주세요.');
    return store.assignVehicle(req.body.revision, req.params.id, req.body.regionCode);
  }));
  return router;
}

module.exports = { createResourceRouter };
