export type AuthFormKind = "login" | "register";

export type AuthFeedback = Readonly<{
  form: string;
  fields: Readonly<Record<string, string>>;
}>;

const PRODUCT_PATH = /^\/(?:$|(?:ui-layout|combined)(?:\/|$))/;

export function safeProductPath(value: unknown): string {
  if (typeof value !== "string" || /[\\\r\n]/.test(value)) return "/";
  try {
    const target = new URL(value, "https://local.invalid");
    if (target.origin !== "https://local.invalid" || !PRODUCT_PATH.test(target.pathname)) return "/";
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return "/";
  }
}

export function sameOriginPath(value: string, origin: string): string | null {
  try {
    const target = new URL(value, origin);
    if (target.origin !== origin || target.username || target.password || /[\\\r\n]/.test(value)) return null;
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return null;
  }
}

export function authenticationDestination(
  kind: AuthFormKind,
  responseUrl: string,
  origin: string,
  requestedNext: unknown,
): string | null {
  const redirected = sameOriginPath(responseUrl, origin);
  if (kind === "register") {
    // An existing session follows the login redirect through the gateway home alias.
    return redirected === "/login?registered=1" || redirected === "/combined/" ? redirected : null;
  }
  if (!redirected || safeProductPath(redirected) !== redirected) return null;
  // Fetch's final URL can lose the fragment or follow the gateway's root alias.
  // The login POST contract redirects to the sanitized next value we submitted.
  return safeProductPath(requestedNext);
}

export function encodeFormValues(values: ReadonlyArray<readonly [string, string]>): string {
  const encoded = new URLSearchParams();
  for (const [name, value] of values) encoded.append(name, value);
  return encoded.toString();
}

export function fallbackFeedback(kind: AuthFormKind, status: number): AuthFeedback {
  if (status === 403) return { form: "로그인 페이지에서 다시 시도해 주세요.", fields: {} };
  if (status === 429) return { form: "접근 요청이 많습니다. 잠시 후 다시 시도해 주세요.", fields: {} };
  if (status >= 500) return { form: "서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.", fields: {} };
  if (kind === "login" && status === 401) {
    return { form: "아이디와 비밀번호를 확인해 주세요.", fields: {} };
  }
  if (kind === "register" && status === 400) {
    return { form: "입력값을 확인해 주세요.", fields: {} };
  }
  return { form: "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.", fields: {} };
}

const REGISTER_ERRORS: Readonly<Record<string, ReadonlyArray<string>>> = {
  invite: ["초대 코드가 유효하지 않거나 이미 사용되었습니다."],
  username: ["이미 사용 중인 아이디입니다.", "영문 또는 숫자로 시작하는 3~40자로 입력해 주세요."],
  password: ["비밀번호를 8~128자로 입력해 주세요."],
  displayName: ["표시 이름은 제어 문자를 제외한 80자 이내로 입력해 주세요."],
};

export function serverFeedback(
  kind: AuthFormKind,
  status: number,
  formText: string,
  fieldTexts: Readonly<Record<string, string>>,
): AuthFeedback {
  const fallback = fallbackFeedback(kind, status);
  if (kind === "login" && status === 401) {
    return { form: formText === fallback.form ? formText : fallback.form, fields: {} };
  }
  if (kind !== "register" || status !== 400) return fallback;

  const fields: Record<string, string> = {};
  for (const [name, allowed] of Object.entries(REGISTER_ERRORS)) {
    const text = fieldTexts[name];
    if (text && allowed.includes(text)) fields[name] = text;
  }
  return { form: fallback.form, fields };
}

export const NETWORK_FEEDBACK: AuthFeedback = Object.freeze({
  form: "서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.",
  fields: Object.freeze({}),
});
