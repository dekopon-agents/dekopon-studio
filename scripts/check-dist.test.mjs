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
    'const unsafe = "javascript:alert(1)"',
  ]) expect(checkText(text, '.js')).not.toEqual([]);
  for (const url of ['/assets/main.js', './main.js', 'https://example.com/main.js', '/studio/../private.js', 'https://react.dev/errors/']) {
    expect(checkText(`<script src="${url}"></script>`, '.html')).not.toEqual([]);
  }
  expect(checkText('body { background: url(https://example.com/image.png) }', '.css')).not.toEqual([]);
  expect(checkText('@import "./external.css";', '.css')).not.toEqual([]);
});


test('rejects dot-relative fetch and Worker targets', () => {
  for (const target of ['./private', '../private']) {
    expect(checkText(`fetch("${target}")`, '.js')).toEqual([target]);
    expect(checkText(`new Worker("${target}")`, '.js')).toEqual([target]);
  }
});

test('validates each quoted image-set candidate', () => {
  expect(checkText('body { background-image: image-set("/studio/image.png" 1x, "/studio/image@2x.png" 2x) }', '.css')).toEqual([]);
  for (const candidates of [
    '"/assets/image.png" 1x',
    "'/assets/image.png' 1x",
    '"/studio/image.png" 1x, "/assets/image.png" 2x',
    'url("/studio/image.png") 1x, "/assets/image.png" 2x',
  ]) {
    expect(checkText(`body { background-image: image-set(${candidates}) }`, '.css')).toEqual(['/assets/image.png']);
  }
});

test('rejects entity-decoded URL control characters before accepting the Studio prefix', () => {
  for (const entity of ['&#9;', '&#10;', '&#13;']) {
    expect(checkText(`<img src="/studio/.${entity}./outside.png">`, '.html')).not.toEqual([]);
  }
});
