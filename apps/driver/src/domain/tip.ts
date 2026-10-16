export const TIP_MAX = 500;

/** The sentence to show when the tip cannot be saved, else null. Same rules as the server (plain text). */
export function tipProblem(text: string, current: string): string | null {
  const body = text.replace(/\r\n?/gu, '\n').trim();
  if (!body) return '팁 내용을 입력해 주세요.';
  if ([...body].length > TIP_MAX) return `팁은 ${TIP_MAX}자까지 쓸 수 있습니다.`;
  if (/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(body)) return '팁에 쓸 수 없는 문자(<, >, 제어문자)가 있습니다.';
  if (body === current.replace(/\r\n?/gu, '\n').trim()) return '바뀐 내용이 없습니다.';
  return null;
}
