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
    if (/[\t\n\r]/.test(value)) {
      errors.push(value);
      return;
    }
    if (value.startsWith('/studio/')) {
      const decoded = decodeURIComponent(value.split(/[?#]/)[0]);
      if (decoded.includes('\\') || decoded.split('/').includes('..')) errors.push(value);
      return;
    }
    if (asset || !Object.hasOwn(allowlist, value)) errors.push(value);
  }
  function strings(value) {
    // Parse JS literals before scanning so escapes cannot conceal a URL.
    if (/^(?:data|blob|javascript):/i.test(value)) {
      check(value);
      return;
    }
    for (const match of value.matchAll(/(?:[a-z][a-z\d+.-]*:\/\/|\/\/)[^\s"'<>`\\)]+/gi)) check(match[0]);
    if (/^\/(?!\/)[\w.%]/.test(value) || /^\.\.?\//.test(value)) check(value);
  }
  function css(value) {
    try {
      const tokens = [];
      let index = 0;
      let gap = false;
      let unquotedUrl = false;
      while (index < value.length) {
        if (/\s/.test(value[index])) { index++; gap = true; continue; }
        if (value.startsWith('/*', index)) {
          if (unquotedUrl) throw new Error('comment opener inside unquoted URL');
          const end = value.indexOf('*/', index + 2);
          if (end < 0) throw new Error('unterminated comment');
          index = end + 2;
          gap = true;
          continue;
        }
        let text = '';
        let type = 'symbol';
        const quote = value[index];
        if (quote === '"' || quote === "'") {
          type = 'string';
          index++;
          while (index < value.length && value[index] !== quote) {
            const char = value[index++];
            if (/[\n\r\f]/.test(char)) throw new Error('unescaped newline in string');
            if (char !== '\\') { text += char; continue; }
            if (index === value.length) throw new Error('unfinished string escape');
            if (/[\n\r\f]/.test(value[index])) {
              if (value[index++] === '\r' && value[index] === '\n') index++;
              continue;
            }
            const hex = value.slice(index).match(/^[\da-f]{1,6}/i)?.[0];
            if (hex) {
              const point = parseInt(hex, 16);
              text += point === 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)
                ? '\ufffd' : String.fromCodePoint(point);
              index += hex.length;
              if (/\s/.test(value[index] ?? '')) {
                if (value[index++] === '\r' && value[index] === '\n') index++;
              }
            } else text += value[index++];
          }
          if (value[index++] !== quote) throw new Error('unterminated string');
        } else if (/[\w.-]/.test(quote)) {
          type = 'word';
          while (index < value.length && /[\w.-]/.test(value[index])) text += value[index++];
        } else {
          // Escaped identifiers and unquoted URL escapes are unsupported, not ignored.
          if (quote === '\\') throw new Error('unsupported escape outside a string');
          text = value[index++];
        }
        if (type === 'symbol' && text === '(' && tokens.at(-1)?.text.toLowerCase() === 'url') {
          // Decide from the raw body, before apparent comments can be discarded.
          const first = value.slice(index).trimStart()[0];
          unquotedUrl = first !== '"' && first !== "'";
        } else if (type === 'symbol' && text === ')') unquotedUrl = false;
        tokens.push({ type, text, gap });
        gap = false;
      }
      let cursor = 0;
      const is = text => tokens[cursor]?.text === text;
      function requireToken(text) {
        if (!is(text)) throw new Error(`expected ${text}`);
        cursor++;
      }
      function url() {
        requireToken('(');
        let target = '';
        if (tokens[cursor]?.type === 'string') target = tokens[cursor++].text;
        else {
          let first = true;
          while (tokens[cursor] && !is(')')) {
            const token = tokens[cursor++];
            if ((!first && token.gap) || token.type === 'string' || /[()]/.test(token.text)) {
              throw new Error('unsupported unquoted URL');
            }
            target += token.text;
            first = false;
          }
        }
        requireToken(')');
        check(target, true);
      }
      function imageSet() {
        requireToken('(');
        while (true) {
          if (tokens[cursor]?.type === 'string') check(tokens[cursor++].text, true);
          else if (tokens[cursor]?.text.toLowerCase() === 'url') { cursor++; url(); }
          else throw new Error('expected a quoted image-set candidate or url()');
          if (/^(?:\d+(?:\.\d*)?|\.\d+)(?:x|dppx|dpi|dpcm)$/i.test(tokens[cursor]?.text ?? '')) cursor++;
          if (is(')')) { cursor++; return; }
          requireToken(',');
        }
      }
      while (cursor < tokens.length) {
        const token = tokens[cursor++];
        if (token.type === 'word' && is('(')) {
          if (token.text.toLowerCase() === 'url') url();
          else if (/^(?:-webkit-)?image-set$/i.test(token.text)) imageSet();
        } else if (token.text === '@' && tokens[cursor]?.text.toLowerCase() === 'import') {
          cursor++;
          if (tokens[cursor]?.type === 'string') check(tokens[cursor++].text, true);
        }
      }
    } catch (error) {
      errors.push(`Cannot parse CSS: ${error.message}`);
    }
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
