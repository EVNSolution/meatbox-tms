const errors = {
  403: '요청 권한을 확인해 주세요.',
  409: '다른 변경이 먼저 저장됐습니다. 새로고침 후 다시 시도해 주세요.',
  503: '자원 자료가 설정되지 않았습니다.',
};
const codeErrors = {
  REGION_CODE_EXISTS: '이미 등록된 지역 코드입니다.',
  REGION_CODE_NOT_FOUND: '지역 코드를 찾을 수 없습니다. 다시 불러와 주세요.',
  INVALID_REGION_CODE: '영문자로 시작하는 영문·숫자 지역 코드를 입력해 주세요.',
  RESOURCE_REVISION_CONFLICT: errors[409],
};

function validate(snapshot) {
  if (!snapshot || !Number.isInteger(snapshot.revision) || !Array.isArray(snapshot.regionCodes) || !Array.isArray(snapshot.vehicles)) {
    throw new Error('자원 자료를 확인할 수 없습니다.');
  }
  return snapshot;
}

export function createResourceClient({ fetchImpl = fetch } = {}) {
  let snapshot = null;
  async function request(path, method = 'GET', body) {
    const response = await fetchImpl(path, {
      method, credentials: 'same-origin', headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const error = new Error(codeErrors[payload?.error] || errors[response.status] || '자원 요청을 처리하지 못했습니다. 다시 시도해 주세요.');
      error.code = payload?.error;
      error.status = response.status;
      throw error;
    }
    snapshot = validate(await response.json());
    return snapshot;
  }
  const requireRevision = () => {
    if (!snapshot) throw new Error('자원 자료를 먼저 불러와 주세요.');
    return snapshot.revision;
  };
  return {
    get snapshot() { return snapshot; },
    load: () => request('/api/resources'),
    createRegionCode: code => request('/api/resources/region-codes', 'POST', { revision: requireRevision(), code }),
    renameRegionCode: (oldCode, code) => request(`/api/resources/region-codes/${encodeURIComponent(oldCode)}`, 'PATCH', { revision: requireRevision(), code }),
    assignVehicles: assignments => request('/api/resources/vehicles', 'PATCH', { revision: requireRevision(), assignments }),
  };
}
