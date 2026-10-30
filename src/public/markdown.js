/**
 * Render AI answers as Markdown with LaTeX math.
 * The model's output is untrusted (it can contain raw HTML), and this page can
 * ask BSV Desktop to sign payments, so the parsed HTML is always sanitized.
 * Depends on window.marked, window.DOMPurify and window.katex (served from /vendor).
 *
 * Math syntax: $$...$$ and \[...\] for display math, $...$ and \(...\) inline.
 * Math is parsed as marked tokens, so `$` inside code spans/blocks is left alone.
 */
(function () {
  function renderMath(tex, displayMode) {
    // trust: false (default) keeps \href, \url etc. from producing links or scripts
    return katex.renderToString(tex.trim(), { displayMode, throwOnError: false, output: 'htmlAndMathml' });
  }

  const blockMath = {
    name: 'blockMath',
    level: 'block',
    start(src) {
      const m = src.match(/^ {0,3}(\$\$|\\\[)/m);
      return m ? m.index : undefined;
    },
    tokenizer(src) {
      const m = /^ {0,3}(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[ \t]*(?:\n+|$)/.exec(src);
      if (m) return { type: 'blockMath', raw: m[0], text: m[1] !== undefined ? m[1] : m[2] };
    },
    renderer(token) {
      return `<div class="math-display">${renderMath(token.text, true)}</div>\n`;
    }
  };

  const inlineMath = {
    name: 'inlineMath',
    level: 'inline',
    start(src) {
      const i = src.search(/\$|\\\(|\\\[/);
      return i < 0 ? undefined : i;
    },
    tokenizer(src) {
      let m = /^\$\$([\s\S]+?)\$\$/.exec(src) || /^\\\[([\s\S]+?)\\\]/.exec(src);
      if (m) return { type: 'inlineMath', raw: m[0], text: m[1], displayMode: true };
      m = /^\\\(([\s\S]+?)\\\)/.exec(src);
      if (m) return { type: 'inlineMath', raw: m[0], text: m[1], displayMode: false };
      // $...$ only when it hugs its content and isn't followed by a digit,
      // so prices like "$5 and $10" stay plain text
      m = /^\$(?![\s$])((?:\\.|[^\\$\n])+?)(?<=\S)\$(?!\d)/.exec(src);
      if (m) return { type: 'inlineMath', raw: m[0], text: m[1], displayMode: false };
    },
    renderer(token) {
      return renderMath(token.text, token.displayMode);
    }
  };

  marked.use({ gfm: true, breaks: true, extensions: [blockMath, inlineMath] });

  // Links in answers open in a new tab and can't reach back into this page
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.getAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });

  /** Replace `el`'s content with `markdownText` rendered as sanitized HTML. */
  window.renderMarkdown = function (el, markdownText) {
    const html = marked.parse(String(markdownText || ''));
    el.innerHTML = DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form', 'input', 'button'] });
  };
})();
