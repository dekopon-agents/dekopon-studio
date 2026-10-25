// @vitest-environment node
import { expect, test } from 'vitest';
import { checkText } from './check-dist.mjs';

test('accepts Studio assets and inert diagnostic and namespace strings', () => {
  expect(checkText('<script src="/studio/assets/main.js"></script>', '.html')).toEqual([]);
  expect(checkText('const namespace = "http://www.w3.org/2000/svg";', '.js')).toEqual([]);
  expect(checkText('const diagnostic = "https://react.dev/errors/";', '.js')).toEqual([]);
});

test('rejects external, escaped, protocol-relative, relative and wrongly rooted asset URLs', () => {
  for (const text of [
    'fetch("https://example.com/private")',
    'fetch("https:\\u002f\\u002fexample.com/private")',
    'const endpoint = "//example.com/private"',
    'import("./reader.js")',
    'const asset = "/assets/main.js"',
  ]) expect(checkText(text, '.js')).not.toEqual([]);
  for (const url of ['/assets/main.js', './main.js', 'https://example.com/main.js', '/studio/../private.js', 'https://react.dev/errors/']) {
    expect(checkText(`<script src="${url}"></script>`, '.html')).not.toEqual([]);
  }
  expect(checkText('body { background: url(https://example.com/image.png) }', '.css')).not.toEqual([]);
  expect(checkText('@import "./external.css";', '.css')).not.toEqual([]);
});
