'use strict';

for (const form of document.querySelectorAll('form[data-validate]')) {
  form.noValidate = true;
  const inputs = [...form.querySelectorAll('input:not([type="hidden"])')];
  let submitted = false;

  function message(input) {
    if (input.name === 'username') input.value = input.value.trim();
    const length = input.value.length;
    const validity = input.validity;
    if (input.required && !length) return input.dataset.required;
    if (input.dataset.whitespace && length && !input.value.trim()) return input.dataset.whitespace;
    if (input.minLength > 0 && length < input.minLength) return input.dataset.tooShort;
    if (input.maxLength > 0 && length > input.maxLength) return input.dataset.tooLong;
    if (validity.patternMismatch) return input.dataset.pattern;
    if (validity.valid) return '';
    return '입력값을 확인해 주세요.';
  }

  function validate(input) {
    const error = form.querySelector(`#${CSS.escape(input.name)}-error`);
    const text = message(input);
    error.textContent = text;
    error.hidden = !text;
    if (text) error.setAttribute('role', 'alert');
    else error.removeAttribute('role');
    input.setAttribute('aria-invalid', String(Boolean(text)));
    return !text;
  }

  for (const input of inputs) {
    if (input.getAttribute('aria-invalid') === 'true') input.dataset.touched = 'true';
    input.addEventListener('blur', () => {
      input.dataset.touched = 'true';
      validate(input);
    });
    input.addEventListener('input', () => {
      if (submitted || input.dataset.touched) validate(input);
    });
  }

  form.addEventListener('submit', event => {
    submitted = true;
    const invalid = inputs.filter(input => !validate(input));
    if (invalid.length) {
      event.preventDefault();
      invalid[0].focus();
    }
  });
}
