import { readFile, readdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseJavaScript } from 'acorn';
import { parse as parseHtml } from 'parse5';

const allowlist = JSON.parse(await readFile(new URL('./url-allowlist.json', import.meta.url), 'utf8'));
const urlAttributes = new Set(['src', 'href', 'action', 'formaction', 'poster', 'data', 'cite', 'background', 'manifest']);

export function checkText(text, extension) {
  const errors = [];
  function check(value, asset = false) {
    if (value.startsWith('/studio/')) {
      const decoded = decodeURIComponent(value.split(/[?#]/)[0]);
      if (decoded.includes('\\') || decoded.split('/').includes('..')) errors.push(value);
      return;
    }
    if (asset || !Object.hasOwn(allowlist, value)) errors.push(value);
  }
  function strings(value) {
    // Parse JS literals before scanning so escapes cannot conceal a URL.
    for (const match of value.matchAll(/(?:[a-z][a-z\d+.-]*:\/\/|\/\/)[^\s"'<>`\\)]+|\b(?:data|blob|javascript):[^\s"'<>`]+/gi)) check(match[0]);
    if (/^\/(?!\/)[\w.%]/.test(value)) check(value);
  }
  function css(value) {
    for (const match of value.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)|@import\s+["']([^"']+)["']/gi)) check(match[2] ?? match[3], true);
    strings(value);
  }
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Literal' && typeof node.value === 'string') strings(node.value);
    if (node.type === 'TemplateElement') strings(node.value.cooked ?? node.value.raw);
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source) check(node.source.value, true);
    if (node.type === 'ImportExpression' && node.source.type === 'Literal') check(node.source.value, true);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  }
  function html(node) {
    for (const attr of node.attrs ?? []) {
      if (urlAttributes.has(attr.name)) check(attr.value, true);
      if (attr.name === 'srcset') attr.value.split(',').forEach(part => check(part.trim().split(/\s+/)[0], true));
      if (attr.name === 'style') css(attr.value);
      strings(attr.value);
    }
    if (node.tagName === 'style') css(node.childNodes.map(child => child.value ?? '').join(''));
    if (node.tagName === 'script' && !node.attrs.some(attr => attr.name === 'src')) {
      walk(parseJavaScript(node.childNodes.map(child => child.value ?? '').join(''), { ecmaVersion: 'latest', sourceType: 'module' }));
    }
    (node.childNodes ?? []).forEach(html);
    if (node.content) html(node.content);
  }
  if (extension === '.js') walk(parseJavaScript(text, { ecmaVersion: 'latest', sourceType: 'module' }));
  else if (extension === '.html') html(parseHtml(text));
  else if (extension === '.css') css(text);
  else throw new Error(`Unexpected built file type: ${extension}`);
  return [...new Set(errors)];
}

async function checkDist(directory) {
  let count = 0;
  const failures = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = resolve(path, entry.name);
      if (entry.isDirectory()) await visit(file);
      else {
        count++;
        const extension = entry.name.slice(entry.name.lastIndexOf('.'));
        for (const url of checkText(await readFile(file, 'utf8'), extension)) failures.push(`${relative(directory, file)}: ${url}`);
      }
    }
  }
  await visit(directory);
  if (!count) throw new Error('dist is empty');
  if (failures.length) throw new Error(`URLs outside /studio/ or the inert allow-list:\n${failures.join('\n')}`);
  console.log(`Checked URLs in ${count} built files.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await checkDist(resolve('dist'));
}
