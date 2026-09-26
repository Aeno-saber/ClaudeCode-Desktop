'use strict';
/**
 * 轻量 Markdown 渲染 + 语法着色。
 *
 * 为什么要自己写：这是个离线桌面应用，不能依赖 CDN；而本机 npm 安装被火绒拖得极慢，
 * 也不适合为了一层 Markdown 去拉一堆依赖。所以内联实现，覆盖面按聊天场景取舍。
 *
 * 安全：先做 HTML 转义再套标记，所有生成的标签都由本文件拼出，模型输出的原文
 * 不可能变成可执行标签。链接只允许 http/https/mailto。
 */
(function (global) {
  // ------------------------------------------------------------ 工具

  function escapeHtml(s) {
    // 只转义这三个：保留引号，否则会把源码里的字符串字面量打乱，影响高亮
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, '&quot;');
  }

  /**
   * 用于「已经过 escapeHtml 的文本」——此时 & < > 已经是实体，再转一次就会
   * 变成 &amp;amp; 这种双重转义。所以这里只补属性上下文真正危险的引号。
   */
  function quoteAttr(s) {
    return String(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function safeUrl(u) {
    const t = String(u).trim();
    return /^(https?:|mailto:)/i.test(t) ? t : null;
  }

  // ------------------------------------------------------ 语法着色

  const KEYWORDS = {
    js: 'const let var function return if else for while do break continue new class extends super this typeof instanceof in of try catch finally throw switch case default async await yield import export from as delete void null undefined true false static get set',
    ts: 'const let var function return if else for while do break continue new class extends implements interface type enum namespace super this typeof instanceof in of try catch finally throw switch case default async await yield import export from as delete void readonly public private protected abstract declare satisfies keyof infer null undefined true false static',
    py: 'def class return if elif else for while break continue import from as pass raise try except finally with lambda yield global nonlocal assert del in is not and or None True False async await self',
    sh: 'if then else elif fi for while until do done case esac function return in local export readonly declare exit set unset shift trap break continue',
    json: 'true false null',
    css: '',
    html: '',
  };

  const RULESETS = {
    clike: [
      { cls: 'cmt', pattern: '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/' },
      { cls: 'str', pattern: '"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\'|`(?:\\\\.|[^`\\\\])*`' },
      { cls: 'num', pattern: '\\b(?:0[xX][0-9a-fA-F]+|0[bB][01]+|\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b' },
      { cls: 'kw', pattern: '\\b(?:' + KEYWORDS.js.replace(/ /g, '|') + ')\\b' },
      { cls: 'typ', pattern: '\\b(?:string|number|boolean|any|void|never|unknown|Promise|Array|Object|Map|Set|String|Number|Boolean|Error|Record|Partial|Response|Request|Buffer|JSON)\\b' },
      { cls: 'fn', pattern: '\\b[A-Za-z_$][\\w$]*(?=\\s*\\()' },
      { cls: 'attr', pattern: '\\b[A-Za-z_$][\\w$]*(?=\\s*:)' },
    ],
    sh: [
      { cls: 'cmt', pattern: '#[^\\n]*' },
      { cls: 'str', pattern: '"(?:\\\\.|[^"\\\\])*"|\'[^\']*\'' },
      { cls: 'kw', pattern: '\\b(?:' + KEYWORDS.sh.replace(/ /g, '|') + ')\\b' },
      { cls: 'num', pattern: '\\b\\d+\\b' },
      { cls: 'op', pattern: '(?:^|\\s)(?:--?[A-Za-z][\\w-]*)' },
      { cls: 'fn', pattern: '\\b[A-Za-z_][\\w-]*(?=\\s)' },
    ],
    py: [
      { cls: 'cmt', pattern: '#[^\\n]*' },
      { cls: 'str', pattern: '"""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'|"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\'' },
      { cls: 'kw', pattern: '\\b(?:' + KEYWORDS.py.replace(/ /g, '|') + ')\\b' },
      { cls: 'num', pattern: '\\b(?:0[xX][0-9a-fA-F]+|\\d+(?:\\.\\d+)?)\\b' },
      { cls: 'fn', pattern: '\\b[A-Za-z_][\\w]*(?=\\s*\\()' },
      { cls: 'attr', pattern: '(?<=\\.)[A-Za-z_][\\w]*' },
    ],
    json: [
      { cls: 'attr', pattern: '"(?:\\\\.|[^"\\\\])*"(?=\\s*:)' },
      { cls: 'str', pattern: '"(?:\\\\.|[^"\\\\\\n])*"' },
      { cls: 'num', pattern: '\\b-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b' },
      { cls: 'kw', pattern: '\\b(?:true|false|null)\\b' },
    ],
    css: [
      { cls: 'cmt', pattern: '\\/\\*[\\s\\S]*?\\*\\/' },
      { cls: 'str', pattern: '"(?:\\\\.|[^"\\\\])*"|\'[^\']*\'' },
      { cls: 'attr', pattern: '[-a-zA-Z]+(?=\\s*:)' },
      { cls: 'num', pattern: '#[0-9a-fA-F]{3,8}\\b|\\b\\d+(?:\\.\\d+)?(?:px|em|rem|%|vh|vw|s|ms|fr|deg)?\\b' },
      { cls: 'typ', pattern: '\\.[-\\w]+|#[\\w-]+|::?[\\w-]+' },
      { cls: 'fn', pattern: '\\b[a-z-]+(?=\\()' },
    ],
    html: [
      { cls: 'cmt', pattern: '<!--[\\s\\S]*?-->' },
      { cls: 'kw', pattern: '</?[A-Za-z][\\w-]*' },
      { cls: 'attr', pattern: '\\b[A-Za-z-]+(?==)' },
      { cls: 'str', pattern: '"(?:[^"]*)"|\'[^\']*\'' },
      { cls: 'op', pattern: '\\/?>' },
    ],
  };

  function familyFor(lang) {
    const l = String(lang || '').toLowerCase();
    if (/^(js|javascript|jsx|mjs|cjs|ts|typescript|tsx|java|c|cpp|c\+\+|cs|csharp|go|rust|rs|php|swift|kotlin|kt|scala|dart|rb|ruby)$/.test(l)) return 'clike';
    if (/^(sh|bash|zsh|shell|console|shellsession|powershell|ps1|cmd|bat)$/.test(l)) return 'sh';
    if (/^(py|python|python3)$/.test(l)) return 'py';
    if (/^(json|jsonc|json5)$/.test(l)) return 'json';
    if (/^(css|scss|sass|less)$/.test(l)) return 'css';
    if (/^(html|xml|svg|vue|htm)$/.test(l)) return 'html';
    if (/^(diff|patch)$/.test(l)) return 'diff';
    if (/^(yaml|yml|toml|ini|conf|env)$/.test(l)) return 'yaml';
    return null;
  }

  const lexerCache = new Map();
  function lexerFor(family) {
    if (lexerCache.has(family)) return lexerCache.get(family);
    const rules = RULESETS[family];
    let fn = null;
    if (rules) {
      const re = new RegExp(rules.map((r) => '(' + r.pattern + ')').join('|'), 'g');
      fn = function (src) {
        return src.replace(re, function () {
          const args = arguments;
          for (let k = 0; k < rules.length; k++) {
            if (args[k + 1] !== undefined) {
              return '<span class="tk-' + rules[k].cls + '">' + args[k + 1] + '</span>';
            }
          }
          return args[0];
        });
      };
    }
    lexerCache.set(family, fn);
    return fn;
  }

  function highlight(code, lang) {
    const escaped = escapeHtml(code);
    const l = String(lang || '').toLowerCase();
    if (l === 'diff' || l === 'patch') {
      return escaped.split('\n').map((line) => {
        if (/^\+/.test(line)) return '<span class="tk-str">' + line + '</span>';
        if (/^-/.test(line)) return '<span class="tk-attr">' + line + '</span>';
        if (/^@@/.test(line)) return '<span class="tk-kw">' + line + '</span>';
        return line;
      }).join('\n');
    }
    if (l === 'yaml' || l === 'yml' || l === 'toml' || l === 'ini' || l === 'conf' || l === 'env') {
      return escaped.split('\n').map((line) => {
        const m = /^(\s*)([#][^\n]*)$/.exec(line);
        if (m) return m[1] + '<span class="tk-cmt">' + m[2] + '</span>';
        return line.replace(/^(\s*)([\w.$-]+)(\s*[:=])/, (_, a, k, sep) =>
          a + '<span class="tk-attr">' + k + '</span>' + sep);
      }).join('\n');
    }
    const lexer = lexerFor(familyFor(lang) || 'clike');
    return lexer ? lexer(escaped) : escaped;
  }

  function codeBlockHtml(code, lang) {
    const label = String(lang || '').trim() || 'text';
    return '<div class="code-block">' +
      '<div class="code-head"><span class="lang">' + escapeHtml(label) + '</span>' +
      '<button class="code-copy" data-copy-code="1" type="button">' +
      '<svg class="ic"><use href="#i-copy"/></svg><span>复制</span></button></div>' +
      '<pre><code class="code-block">' + highlight(code, label) + '</code></pre>' +
      '</div>';
  }

  // ------------------------------------------------------------ 行内

  const INLINE_TOKENS = [];

  function stash(html) {
    INLINE_TOKENS.push(html);
    return '\u0000' + (INLINE_TOKENS.length - 1) + '\u0000';
  }

  function restore(s) {
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => INLINE_TOKENS[Number(i)] || '');
  }

  function inline(text) {
    let s = escapeHtml(text);

    // 行内代码优先，免得里面的 * _ 被当成强调
    s = s.replace(/(`+)([\s\S]*?)\1/g, (_, _t, code) =>
      stash('<code>' + code.replace(/^ | $/g, '') + '</code>'));

    // 图片（放在链接前面）
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, alt, url) => {
      const u = safeUrl(url);
      return u ? stash('<img src="' + quoteAttr(u) + '" alt="' + quoteAttr(alt) + '">') : m;
    });

    // 链接
    s = s.replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, txt, url) => {
      const u = safeUrl(url);
      return u ? stash('<a href="' + quoteAttr(u) + '" target="_blank" rel="noreferrer">' + txt + '</a>') : m;
    });

    // 裸链接
    s = s.replace(/(^|[\s(])((?:https?:\/\/)[^\s<>)]+)/g, (m, pre, url) => pre + stash(
      '<a href="' + quoteAttr(url) + '" target="_blank" rel="noreferrer">' + url + '</a>'));

    s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?=[^*\w]|$)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_\w])_([^_\n]+)_(?=[^_\w]|$)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    s = s.replace(/==([^=]+)==/g, '<mark>$1</mark>');

    // 删除线里的内容已转义，这里再兜一层：把转义后的反斜杠转义还原
    s = s.replace(/\\([\\`*_{}\[\]()#+\-.!>])/g, '$1');

    return restore(s);
  }

  // ------------------------------------------------------------ 块级

  function isBlank(l) { return !l || !l.trim(); }

  function renderTable(rows) {
    const cells = (r) => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
    const head = cells(rows[0]);
    const body = rows.slice(2).map(cells);
    let html = '<table><thead><tr>' + head.map((c) => '<th>' + inline(c) + '</th>').join('') + '</tr></thead>';
    if (body.length) {
      html += '<tbody>' + body.map((r) =>
        '<tr>' + head.map((_, i) => '<td>' + inline(r[i] || '') + '</td>').join('') + '</tr>').join('') + '</tbody>';
    }
    return html + '</table>';
  }

  const RE_TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  const RE_HR = /^\s*(?:\*\s*){3,}$|^\s*(?:-\s*){3,}$|^\s*(?:_\s*){3,}$/;
  const RE_UL = /^(\s*)([-*+])\s+(.*)$/;
  const RE_OL = /^(\s*)(\d+)[.)]\s+(.*)$/;
  const RE_HEAD = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

  function renderBlocks(src) {
    const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // 围栏代码
      const fence = /^\s*(`{3,}|~{3,})\s*([^\s`]*)\s*$/.exec(line);
      if (fence) {
        const marker = fence[1][0];
        const lang = fence[2];
        const buf = [];
        i++;
        while (i < lines.length && !new RegExp('^\\s*' + marker + '{3,}\\s*$').test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        i++; // 吃掉结束围栏
        out.push(codeBlockHtml(buf.join('\n'), lang));
        continue;
      }

      if (isBlank(line)) { i++; continue; }

      const head = RE_HEAD.exec(line);
      if (head) {
        const lv = head[1].length;
        out.push('<h' + lv + '>' + inline(head[2]) + '</h' + lv + '>');
        i++;
        continue;
      }

      if (RE_HR.test(line)) { out.push('<hr>'); i++; continue; }

      // 表格
      if (line.includes('|') && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1])) {
        const rows = [line];
        i++;
        while (i < lines.length && lines[i].includes('|') && !isBlank(lines[i])) { rows.push(lines[i]); i++; }
        out.push(renderTable(rows));
        continue;
      }

      // 引用
      if (/^\s*>/.test(line)) {
        const buf = [];
        while (i < lines.length && (/^\s*>/.test(lines[i]) || (!isBlank(lines[i]) && buf.length && !/^\s*(```|#{1,6}\s)/.test(lines[i])))) {
          buf.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        out.push('<blockquote>' + renderBlocks(buf.join('\n')) + '</blockquote>');
        continue;
      }

      // 列表
      if (RE_UL.test(line) || RE_OL.test(line)) {
        const ordered = RE_OL.test(line) && !RE_UL.test(line);
        const re = ordered ? RE_OL : RE_UL;
        const baseIndent = re.exec(line)[1].length;
        const items = [];
        let cur = null;
        while (i < lines.length) {
          const m = re.exec(lines[i]);
          if (m && m[1].length <= baseIndent + 1) {
            if (cur !== null) items.push(cur);
            cur = m[3];
            i++;
            continue;
          }
          if (isBlank(lines[i])) {
            // 列表后的空行：若下一行还是本列表项，则算松散列表
            const nxt = lines[i + 1];
            if (nxt && (re.test(nxt) || /^\s{2,}\S/.test(nxt))) { cur += '\n'; i++; continue; }
            break;
          }
          if (cur !== null && /^\s{2,}/.test(lines[i])) { cur += '\n' + lines[i].trim(); i++; continue; }
          break;
        }
        if (cur !== null) items.push(cur);

        const lis = items.map((it) => {
          const task = /^\[([ xX])\]\s+([\s\S]*)$/.exec(it);
          if (task) {
            const checked = task[1].toLowerCase() === 'x' ? ' checked' : '';
            return '<li class="task"><input type="checkbox" disabled' + checked + '>' + inline(task[2]) + '</li>';
          }
          return '<li>' + inline(it).replace(/\n/g, '<br>') + '</li>';
        }).join('');
        out.push((ordered ? '<ol>' : '<ul>') + lis + (ordered ? '</ol>' : '</ul>'));
        continue;
      }

      // 段落
      const buf = [];
      while (i < lines.length && !isBlank(lines[i]) &&
             !/^\s*(```|~{3,})/.test(lines[i]) &&
             !RE_HEAD.test(lines[i]) && !RE_HR.test(lines[i]) &&
             !/^\s*>/.test(lines[i]) && !RE_UL.test(lines[i]) && !RE_OL.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      if (buf.length) out.push('<p>' + inline(buf.join('\n')).replace(/\n/g, '<br>') + '</p>');
      else i++;
    }
    return out.join('');
  }

  function render(src) {
    INLINE_TOKENS.length = 0;
    return renderBlocks(src == null ? '' : String(src));
  }

  global.Markdown = { render, highlight, escapeHtml, escapeAttr, quoteAttr };
})(window);
