'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function input(name) {
  const listeners = {};
  const attributes = new Map();
  return {
    name,
    value: '',
    required: false,
    minLength: -1,
    maxLength: -1,
    dataset: { required: `${name} required`, tooShort: `${name} short`, tooLong: `${name} long`, pattern: `${name} pattern` },
    validity: { valid: true },
    addEventListener(type, listener) { listeners[type] = listener; },
    dispatch(type) { listeners[type]({}); },
    focus() { this.focused = true; },
    getAttribute(name) { return attributes.get(name) ?? null; },
    setAttribute(name, value) { attributes.set(name, value); },
    removeAttribute(name) { attributes.delete(name); },
  };
}

test('portal validator reports after interaction, clears on correction, and focuses the first invalid field', () => {
  const username = input('username');
  const password = input('password');
  const errors = Object.fromEntries([username, password].map(item => [item.name, {
    dataset: { hint: `${item.name} hint` },
    textContent: `${item.name} hint`,
    classList: { toggle(_name, enabled) { this.invalid = enabled; }, invalid: false },
    attributes: new Map(),
    setAttribute(name, value) { this.attributes.set(name, value); },
    removeAttribute(name) { this.attributes.delete(name); },
  }]));
  const listeners = {};
  const form = {
    querySelectorAll: () => [username, password],
    querySelector: selector => errors[selector.slice(1, -9)],
    addEventListener(type, listener) { listeners[type] = listener; },
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'apps/portal/validation.js'), 'utf8');
  vm.runInNewContext(source, { document: { querySelectorAll: () => [form] }, CSS: { escape: value => value } });

  assert.equal(errors.username.textContent, 'username hint');
  assert.equal(errors.username.classList.invalid, false);
  username.required = true;
  username.validity = { valid: false, valueMissing: true };
  username.dispatch('blur');
  assert.equal(errors.username.textContent, 'username required');
  assert.equal(errors.username.classList.invalid, true);
  assert.equal(username.getAttribute('aria-invalid'), 'true');

  username.validity = { valid: true };
  username.value = ' reviewer ';
  username.dispatch('input');
  assert.equal(errors.username.textContent, 'username hint');
  assert.equal(errors.username.classList.invalid, false);
  assert.equal(username.getAttribute('aria-invalid'), 'false');
  assert.equal(username.value, 'reviewer');

  password.required = true;
  password.minLength = 8;
  password.value = 'short';
  password.validity = { valid: true };
  let prevented = false;
  listeners.submit({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(password.focused, true);
  assert.equal(errors.password.textContent, 'password short');
  assert.equal(errors.username.textContent, 'username hint');
  assert.equal(errors.username.classList.invalid, false);
});
