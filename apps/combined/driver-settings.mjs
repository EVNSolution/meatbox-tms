import { referenceIcon } from './reference-icons.mjs';
const inquiryDraft = { title: '', body: '' };
const inquiries = [];

const permissionRows = [
  ['위치', '지도에서 현재 위치를 표시합니다.'],
  ['카메라', '배송 완료 증빙을 촬영합니다.'],
  ['사진 앨범', '배송 완료 증빙 사진을 선택합니다.'],
];

const legalDocuments = [
  '개인정보 처리방침',
  '배송원 이용약관',
  '위치기반서비스 이용약관',
];

export function openDriverSettings(showSheet) {
  const openSettings = () => showSheet({
    title: '환경설정',
    subtitle: '권한, 버전, 계정',
    body: `
      <div class="dv-stack">
        <section class="dv-card dv-stack" aria-labelledby="driver-permissions-title">
          <div>
            <strong id="driver-permissions-title">앱 권한</strong>
            <p class="dv-muted">배송 중 사용하는 기기 권한입니다.</p>
          </div>
          ${permissionRows.map(([label, description]) => `
            <div class="dv-setting-row">
              <div class="dv-setting-copy">
                <div class="dv-inline"><strong>${label}</strong><span class="dv-chip">앱에서 설정</span></div>
                <span class="dv-muted">${description}</span>
              </div>
              <button class="dv-button" type="button" disabled>관리</button>
            </div>
          `).join('')}
          <button class="dv-button" type="button" disabled>기기 설정에서 권한 관리</button>
        </section>

        <section class="dv-card dv-stack" aria-labelledby="driver-version-title">
          <div class="dv-inline">
            <strong id="driver-version-title">앱 버전</strong>
            <span class="dv-chip">웹 데모</span>
          </div>
          <div class="dv-setting-row">
            <span class="dv-muted">실행 환경</span>
            <strong>브라우저 데모</strong>
          </div>
          <p class="dv-muted">설치 버전과 업데이트 확인은 실제 배송원 앱에서 제공됩니다.</p>
        </section>

        <button class="dv-link-row" type="button" data-settings-action="inquiries">
          <span class="dv-setting-copy"><strong>문의사항</strong><span class="dv-muted">문의를 작성하고 이전 문의를 확인합니다.</span></span>
          ${referenceIcon('next')}
        </button>

        <section class="dv-card dv-stack" aria-labelledby="driver-legal-title">
          <strong id="driver-legal-title">법적 정보</strong>
          ${legalDocuments.map((label) => `
            <button class="dv-link-row" type="button" disabled>
              <span>${label}</span><span class="dv-muted">앱에서 확인</span>
            </button>
          `).join('')}
        </section>

        <section class="dv-card dv-stack" aria-labelledby="driver-account-title">
          <div>
            <strong id="driver-account-title">계정 관리</strong>
            <p class="dv-muted">미트박스 배송원 계정과 연결된 데이터 삭제를 요청합니다.</p>
          </div>
          <button class="dv-button dv-danger" type="button" data-settings-action="delete-account">계정 삭제 요청</button>
        </section>
      </div>
    `,
    onClick(event) {
      const action = event.target.closest('[data-settings-action]')?.dataset.settingsAction;
      if (action === 'inquiries') openInquiryList();
      if (action === 'delete-account') openDeleteConfirmation();
    },
  });

  const openInquiryList = () => showSheet({
    title: '문의사항',
    subtitle: '배송원 지원',
    back: openSettings,
    body: `
      <div class="dv-stack">
        <button class="dv-button dv-primary" type="button" data-settings-action="compose-inquiry">새 문의 작성</button>
        <div class="dv-empty">
          <strong>작성한 문의가 없습니다.</strong>
          <span class="dv-muted">실제 배송원 앱에 등록한 문의가 여기에 표시됩니다.</span>
        </div>
        ${inquiries.map((inquiry) => `
          <button class="dv-link-row" type="button" data-inquiry-id="${escapeHTML(inquiry.id)}">
            <span class="dv-setting-copy"><strong>${escapeHTML(inquiry.title)}</strong><span class="dv-muted">${escapeHTML(inquiry.createdAt)}</span></span>
            ${referenceIcon('next')}
          </button>
        `).join('')}
      </div>
    `,
    onClick(event) {
      if (event.target.closest('[data-settings-action="compose-inquiry"]')) openInquiryComposer();
      const inquiryId = event.target.closest('[data-inquiry-id]')?.dataset.inquiryId;
      const inquiry = inquiries.find((item) => item.id === inquiryId);
      if (inquiry) openInquiryDetail(inquiry);
    },
  });

  const openInquiryDetail = (inquiry) => showSheet({
    title: '문의 상세',
    subtitle: '등록한 문의',
    back: openInquiryList,
    body: `
      <article class="dv-card dv-stack">
        <strong>${escapeHTML(inquiry.title)}</strong>
        <div class="dv-inline dv-muted"><span>${escapeHTML(inquiry.authorName)}</span><time>${escapeHTML(inquiry.createdAt)}</time></div>
        <p>${escapeHTML(inquiry.body)}</p>
      </article>
    `,
  });

  const openInquiryComposer = () => showSheet({
    title: '문의 작성',
    subtitle: '작성 내용은 이 데모에서 전송되지 않습니다.',
    back: openInquiryList,
    body: `
      <form class="dv-stack" data-settings-form="inquiry">
        <label class="dv-stack">
          <strong>제목</strong>
          <textarea class="dv-field" name="title" maxlength="120" rows="2" placeholder="문의 제목을 입력해 주세요">${escapeHTML(inquiryDraft.title)}</textarea>
          <span class="dv-muted" data-settings-count="title">${inquiryDraft.title.length}/120</span>
        </label>
        <label class="dv-stack">
          <strong>내용</strong>
          <textarea class="dv-field" name="body" maxlength="4000" rows="8" placeholder="문의 내용을 자세히 입력해 주세요">${escapeHTML(inquiryDraft.body)}</textarea>
          <span class="dv-muted" data-settings-count="body">${inquiryDraft.body.length}/4000</span>
        </label>
        <div class="dv-card dv-muted" role="status">문의 서버가 연결되지 않은 데모 화면입니다. 입력 내용은 전송되지 않습니다.</div>
        <div class="dv-form-actions">
          <button class="dv-button" type="button" data-settings-action="cancel-inquiry">취소</button>
          <button class="dv-button dv-primary" type="submit" disabled>문의 등록 불가</button>
        </div>
      </form>
    `,
    onClick(event) {
      if (event.target.closest('[data-settings-action="cancel-inquiry"]')) openInquiryList();
    },
    onInput(event) {
      const field = event.target.closest('[name="title"], [name="body"]');
      if (!field) return;
      inquiryDraft[field.name] = field.value;
      const count = event.currentTarget.querySelector(`[data-settings-count="${field.name}"]`);
      if (count) count.textContent = `${field.value.length}/${field.maxLength}`;
    },
  });

  const openDeleteConfirmation = () => showSheet({
    title: '계정을 삭제하시겠습니까?',
    subtitle: '계정 삭제 요청',
    back: openSettings,
    body: `
      <div class="dv-stack">
        <div class="dv-card dv-stack">
          <strong>계정 전체 삭제 요청</strong>
          <p>진행 중인 배송이 있으면 요청할 수 없으며, 접수 후에는 앱에서 로그아웃됩니다.</p>
          <p class="dv-muted">이 웹 데모에는 실제 계정 삭제 API가 연결되어 있지 않습니다.</p>
        </div>
        <div class="dv-form-actions">
          <button class="dv-button" type="button" data-settings-action="cancel-deletion">취소</button>
          <button class="dv-button dv-danger" type="button" disabled>삭제 요청 불가</button>
        </div>
      </div>
    `,
    onClick(event) {
      if (event.target.closest('[data-settings-action="cancel-deletion"]')) openSettings();
    },
  });

  return openSettings();
}

function escapeHTML(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
