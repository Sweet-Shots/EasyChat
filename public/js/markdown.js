/* ============================================================
   Tiny, safe markdown renderer.
   Everything is HTML-escaped first, then a fixed set of inline
   rules is applied - no raw user HTML ever reaches the DOM.
   Supported: ```blocks```  `code`  **bold**  *italic*  __underline__
              ~~strike~~  ||spoiler||  > quote  links  @mentions
   ============================================================ */
(function (global) {
  'use strict';

  var SENTINEL = String.fromCharCode(0);

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function makeVault() {
    const items = [];
    return {
      keep(html) {
        items.push(html);
        return SENTINEL + (items.length - 1) + SENTINEL;
      },
      restore(text) {
        let out = text;
        const pattern = new RegExp(SENTINEL + '(\\d+)' + SENTINEL, 'g');
        for (let pass = 0; pass < 4 && out.indexOf(SENTINEL) !== -1; pass += 1) {
          out = out.replace(pattern, (_m, i) => items[Number(i)] ?? '');
        }
        return out;
      },
    };
  }

  function inline(text, vault, me) {
    let out = text;

    // `inline code`
    out = out.replace(/`([^`\n]+)`/g, (_m, code) => vault.keep(`<code>${code}</code>`));

    // links - the text is already escaped, so &amp; is walked back for the href
    out = out.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,:;!?"')\]}]/g, (url) => {
      const href = url.replace(/&amp;/g, '&').replace(/"/g, '%22');
      return vault.keep(
        `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${url}</a>`
      );
    });

    // ||spoiler||
    out = out.replace(/\|\|([\s\S]+?)\|\|/g, '<span class="spoiler" role="button" tabindex="0" aria-expanded="false" aria-label="Hidden text, activate to reveal">$1</span>');

    // **bold**  __underline__  *italic*  _italic_  ~~strike~~
    out = out.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/__(?=\S)([\s\S]*?\S)__/g, '<u>$1</u>');
    out = out.replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, '$1<em>$2</em>');
    out = out.replace(/(^|[^_\w])_(?=\S)([^_\n]*?\S)_(?!_)/g, '$1<em>$2</em>');
    out = out.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<s>$1</s>');

    // @mentions
    out = out.replace(/(^|\s)@([\p{L}\p{N}_.\-]{2,24})/gu, (match, lead, name) => {
      const mine = me && name.toLowerCase() === me.toLowerCase();
      return `${lead}<span class="mention${mine ? ' mention--you' : ''}">@${name}</span>`;
    });

    return out;
  }

  function render(raw, options) {
    const me = (options && options.me) || '';
    const vault = makeVault();
    let text = escapeHtml(String(raw || '').trim());

    // ```fenced blocks``` come out first so nothing formats inside them
    text = text.replace(/```(?:[a-z0-9+#-]*)\n?([\s\S]*?)```/gi, (_m, code) =>
      vault.keep(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`)
    );

    const lines = text.split('\n');
    const blocks = [];
    let quote = [];

    const flushQuote = () => {
      if (!quote.length) return;
      blocks.push(`<blockquote>${quote.join('<br>')}</blockquote>`);
      quote = [];
    };

    for (const line of lines) {
      const quoted = line.match(/^&gt;\s?(.*)$/);
      if (quoted) {
        quote.push(inline(quoted[1], vault, me));
      } else {
        flushQuote();
        blocks.push({ text: inline(line, vault, me) });
      }
    }
    flushQuote();

    // plain lines join with <br>; quotes and code blocks stand on their own
    let html = '';
    let run = [];
    const flushRun = () => {
      if (!run.length) return;
      html += run.join('<br>');
      run = [];
    };
    for (const block of blocks) {
      if (typeof block === 'string') {
        flushRun();
        html += block;
      } else {
        run.push(block.text);
      }
    }
    flushRun();

    html = vault.restore(html);
    // tidy breaks that landed against block elements
    html = html
      .replace(/(<br>)+(<pre>|<blockquote>)/g, '$2')
      .replace(/(<\/pre>|<\/blockquote>)(<br>)+/g, '$1')
      .replace(/^(<br>)+|(<br>)+$/g, '');
    return html;
  }

  /** Markdown stripped back to readable text, for quotes and previews. */
  function plain(raw) {
    return String(raw || '')
      .replace(/```[a-z0-9+#-]*\n?([\s\S]*?)```/gi, '$1')
      .replace(/`([^`\n]+)`/g, '$1')
      .replace(/\|\|([\s\S]+?)\|\|/g, '$1')
      .replace(/\*\*([\s\S]*?)\*\*/g, '$1')
      .replace(/__([\s\S]*?)__/g, '$1')
      .replace(/~~([\s\S]*?)~~/g, '$1')
      .replace(/(^|[^*\w])\*([^*\n]*?)\*(?!\*)/g, '$1$2')
      .replace(/^\s*>\s?/gm, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  global.EasyMarkdown = { render, escapeHtml, plain };
})(window);
