export function createLatestSerialQueue(worker) {
  let running = false;
  let pending = null;
  let idleWaiters = [];

  async function drain() {
    if (running) return;
    running = true;
    while (pending) {
      const current = pending;
      pending = null;
      try {
        const result = await worker(current.value);
        current.waiters.forEach(({ resolve }) => resolve(result));
      } catch (error) {
        current.waiters.forEach(({ reject }) => reject(error));
      }
    }
    running = false;
    idleWaiters.splice(0).forEach(resolve => resolve());
  }

  return {
    enqueue(value) {
      const promise = new Promise((resolve, reject) => {
        if (pending) {
          pending.value = value;
          pending.waiters.push({ resolve, reject });
        } else {
          pending = { value, waiters:[{ resolve, reject }] };
        }
      });
      void drain();
      return promise;
    },
    whenIdle() {
      return running || pending ? new Promise(resolve => idleWaiters.push(resolve)) : Promise.resolve();
    },
    cancelPending(error) {
      if (!pending) return;
      pending.waiters.forEach(({ reject }) => reject(error));
      pending = null;
    },
  };
}

export function createFidRegistrationWorker({ put, refreshVersion, getVersion, setVersion, assertCurrent = () => {}, buildBody, rotateBootstrap }) {
  return async input => {
    let current = input;
    const fid = typeof current === 'string' ? current : current.fid;
    const attempt = () => {
      assertCurrent(current);
      const expectedFidVersion = getVersion(current) ?? 0;
      return put(buildBody ? buildBody(current, expectedFidVersion) : { fid, expectedFidVersion }, current);
    };
    assertCurrent(current);
    let result;
    try {
      result = await attempt();
    } catch (error) {
      if (error?.code === 'bootstrap_retry_expired' && rotateBootstrap) {
        current = await rotateBootstrap(current);
        assertCurrent(current);
        result = await attempt();
        assertCurrent(current);
        setVersion(result.fidVersion, current);
        return result;
      }
      if (error?.status !== 409 || !['fid_version_conflict', 'installation_bootstrap_conflict'].includes(error.code)) throw error;
      await refreshVersion(current);
      assertCurrent(current);
      result = await attempt();
    }
    assertCurrent(current);
    setVersion(result.fidVersion, current);
    return result;
  };
}
