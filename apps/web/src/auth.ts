import {
  NETWORK_FEEDBACK,
  authenticationDestination,
  encodeFormValues,
  fallbackFeedback,
  safeProductPath,
  serverFeedback,
  type AuthFeedback,
  type AuthFormKind,
} from "./auth-contract";

const REQUEST_TIMEOUT_MS = 10_000;
const SERVER_FIELDS = new Set(["invite", "username", "displayName", "password"]);

function requiredElement<T extends Element>(parent: ParentNode, selector: string): T {
  const element = parent.querySelector<T>(selector);
  if (!element) throw new Error(`Missing authentication element: ${selector}`);
  return element;
}

function readServerFeedback(html: string, kind: AuthFormKind, status: number): AuthFeedback {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const formError = parsed.querySelector<HTMLElement>(".error")?.textContent?.trim() ?? "";
  const fields: Record<string, string> = {};

  for (const input of parsed.querySelectorAll<HTMLInputElement>('input[aria-invalid="true"]')) {
    if (!SERVER_FIELDS.has(input.name)) continue;
    const feedback = parsed.getElementById(`${input.name}-feedback`)?.textContent?.trim();
    if (feedback) fields[input.name] = feedback;
  }
  return serverFeedback(kind, status, formError, fields);
}

function renderFeedback(form: HTMLFormElement, feedback: AuthFeedback): void {
  const formError = requiredElement<HTMLElement>(form.closest(".auth-card") ?? document, "[data-auth-error]");
  formError.textContent = feedback.form;
  formError.hidden = !feedback.form;

  for (const input of form.querySelectorAll<HTMLInputElement>('input:not([type="hidden"])')) {
    const message = feedback.fields[input.name];
    const fieldFeedback = document.getElementById(`${input.name}-feedback`);
    if (!fieldFeedback) continue;
    fieldFeedback.textContent = message || fieldFeedback.dataset.hint || "";
    fieldFeedback.classList.toggle("is-error", Boolean(message));
    input.setAttribute("aria-invalid", String(Boolean(message)));
  }
}

function formValues(form: HTMLFormElement): ReadonlyArray<readonly [string, string]> {
  const values: Array<readonly [string, string]> = [];
  for (const [name, value] of new FormData(form)) {
    if (typeof value === "string") values.push([name, value]);
  }
  return values;
}

async function submit(form: HTMLFormElement, kind: AuthFormKind): Promise<void> {
  const button = requiredElement<HTMLButtonElement>(form, 'button[type="submit"]');
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  button.disabled = true;
  button.setAttribute("aria-disabled", "true");
  form.setAttribute("aria-busy", "true");
  renderFeedback(form, { form: "", fields: {} });

  try {
    const values = formValues(form);
    const response = await fetch(kind === "login" ? "/login" : "/dev/register", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: encodeFormValues(values),
      signal: controller.signal,
    });
    const destination = response.ok && response.redirected
      ? authenticationDestination(kind, response.url, window.location.origin, values.find(([name]) => name === "next")?.[1])
      : null;
    if (destination) {
      window.location.assign(destination);
      return;
    }
    const isAuthFailure = [400, 401, 403, 429].includes(response.status);
    const isHtml = response.headers.get("content-type")?.toLowerCase().includes("text/html");
    renderFeedback(form, isAuthFailure && isHtml
      ? readServerFeedback(await response.text(), kind, response.status)
      : fallbackFeedback(kind, response.status));
  } catch {
    renderFeedback(form, NETWORK_FEEDBACK);
  } finally {
    window.clearTimeout(timeout);
    button.disabled = false;
    button.removeAttribute("aria-disabled");
    form.removeAttribute("aria-busy");
  }
}

function bootstrap(): void {
  const form = document.querySelector<HTMLFormElement>("form[data-auth-kind]");
  if (!form) return;
  const rawKind = form.dataset.authKind;
  if (rawKind !== "login" && rawKind !== "register") return;
  const kind: AuthFormKind = rawKind;
  const query = new URLSearchParams(window.location.search);
  const loginNext = kind === "login" ? safeProductPath(query.get("next")) : "/";

  if (kind === "login") {
    requiredElement<HTMLInputElement>(form, 'input[name="next"]').value = loginNext;
    const registered = document.querySelector<HTMLElement>("[data-registered]");
    if (registered && query.get("registered") === "1") registered.hidden = false;
  }

  let pending = false;
  form.addEventListener("submit", (event) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    if (pending) return;
    pending = true;
    void submit(form, kind).finally(() => { pending = false; });
  });
}

// Deferred validation must register before the authentication submit listener.
if (document.readyState !== "complete") {
  document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
} else {
  bootstrap();
}
