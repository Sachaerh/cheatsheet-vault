// Unit tests for the strict folder path checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { folderName, folderPath } from '../lib/store.js';

test('folderPath accepts plain nested paths and the root', () => {
  assert.equal(folderPath(''), '');
  assert.equal(folderPath(undefined), '');
  assert.equal(folderPath('code'), 'code');
  assert.equal(folderPath('code/python 3/tips & tricks'), 'code/python 3/tips & tricks');
  assert.equal(folderPath('café/日本語'), 'café/日本語');
  assert.equal(folderPath('a/b/c/d/e/f/g/h'), 'a/b/c/d/e/f/g/h');
});

test('folderPath rejects anything that could leave data/ or reach hidden files', () => {
  const bad = [
    '..', '.', '../etc', 'a/..', 'a/../b', 'a/./b', '.trash', 'a/.trash', '.hidden', 'a/.git',
    '/etc', '/', 'a/', 'a//b', '\\..\\x', 'a\\b', '..\\..',
    'a\u0000b', 'a\nb', 'C:', 'x*', 'what?', ' lead', 'trail ', 'a/ b',
    'x'.repeat(121), 'a/b/c/d/e/f/g/h/i',
  ];
  for (const p of bad) assert.throws(() => folderPath(p), (e) => e.status === 400, JSON.stringify(p));
  for (const p of [42, {}, ['a'], false]) {
    assert.throws(() => folderPath(p), (e) => e.status === 400, String(p));
  }
});

test('folderName rejects separators, dots and empty names', () => {
  for (const n of ['', 'a/b', 'a\\b', '..', '.keep', undefined, null]) {
    assert.throws(() => folderName(n), (e) => e.status === 400, String(n));
  }
  assert.equal(folderName('Python'), 'Python');
  assert.equal(folderName('v1.2'), 'v1.2');
});
