'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createDemo } = require('../server');

test('Node resource ownership can be disabled without opening or creating a database', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'meatbox-resource-owner-'));
  const database = path.join(directory, 'must-not-exist.sqlite');
  const access = { session: async token => token === 'allowed' ? { username:'owner-reviewer' } : null };
  const demo = createDemo({ origin:'http://127.0.0.1:4173', access, resourceDatabasePath:database, resourceOwner:'kotlin' });
  await new Promise(resolve => demo.server.listen(0, '127.0.0.1', resolve));
  t.after(async()=>{await demo.close();await fs.rm(directory,{recursive:true,force:true});});
  const origin = `http://127.0.0.1:${demo.server.address().port}`;
  const anonymous = await fetch(origin+'/api/resources');
  assert.equal(anonymous.status,401);
  for (const [method,route] of [['GET',''],['HEAD',''],['POST','/region-codes'],['PATCH','/vehicles'],['PATCH','/vehicles/V1'],['PATCH','/region-codes/A']]) {
    const response = await fetch(origin+'/api/resources'+route,{method,headers:{cookie:'meatbox_session=allowed',origin:'http://127.0.0.1:4173'}});
    assert.equal(response.status,503);
    assert.equal(response.headers.get('x-meatbox-resource-owner'),'kotlin');
    if(method!=='HEAD') assert.deepEqual(await response.json(),{error:'RESOURCE_OWNER_MOVED'});
  }
  await assert.rejects(fs.stat(database),{code:'ENOENT'});
  assert.throws(()=>createDemo({origin:'http://127.0.0.1:4173',access,resourceOwner:'both'}),/must be node or kotlin/);
});
