// Injected on each toolbar click: removes skim rendering if present, otherwise applies it.
(async () => {
  if (globalThis.skimOff) return globalThis.skimOff();
  const ext = globalThis.browser ?? chrome;
  let busy = false, off = false, timer, keepAlive;
  const originals = new Map(); // wrapper -> the page's own text node, put back on toggle-off
  const onScroll = () => { clearTimeout(timer); timer = setTimeout(next, 100); }; // once scrolling pauses
  const opts = { capture: true, passive: true };
  globalThis.skimOff = () => {
    off = true;
    globalThis.skimOff = null;
    clearInterval(keepAlive);
    removeEventListener('scroll', onScroll, opts);
    originals.forEach((node, wrap) => wrap.replaceWith(node));
  };

  // Visible text nodes, grouped by their enclosing block element (paragraph, list item, ...).
  const SKIP = 'script,style,noscript,textarea,select,code,pre,kbd,samp,svg,math';
  const blockOf = el => {
    while (el.parentElement && getComputedStyle(el).display.startsWith('inline')) el = el.parentElement;
    return el;
  };
  const blocks = new Map();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node; (node = walker.nextNode());) {
    const el = node.parentElement;
    if (!node.data.trim() || el.closest(SKIP) || el.isContentEditable || !el.checkVisibility()) continue;
    const block = blockOf(el);
    if (!blocks.has(block)) blocks.set(block, []);
    blocks.get(block).push(node);
  }

  // Units of work: prose blocks (12+ words; menus, buttons and headings stay untouched),
  // split at text-node boundaries into runs of about 150 words.
  const words = nodes => nodes.flatMap(n => n.data.split(/\s+/).filter(Boolean));
  let pending = [];
  for (const nodes of blocks.values()) {
    if (words(nodes).length < 12) continue;
    let unit = [], count = 0;
    for (const node of nodes) {
      unit.push(node);
      if ((count += words([node]).length) >= 150) { pending.push(unit); unit = []; count = 0; }
    }
    if (unit.length) pending.push(unit);
  }

  // Lightweight scoring (right-click menu) uses word frequencies instead of the model.
  const { light } = await ext.storage.local.get('light');
  if (off) return;

  // Score only what is on or near the screen (within one screen), nearest first, more as you scroll.
  const distance = unit => {
    const range = new Range();
    range.setStartBefore(unit[0]);
    range.setEndAfter(unit.at(-1));
    const { top, bottom } = range.getBoundingClientRect();
    return Math.max(0, -bottom, top - innerHeight);
  };
  const next = async () => {
    if (busy || off) return;
    pending = pending.filter(u => u.every(n => n.isConnected)); // the page may have removed text since
    // Step 1: pick up to 4 not-yet-scored paragraphs within one screen of the viewport, nearest first.
    const batch = pending.map(u => [distance(u), u]).filter(([d]) => d < innerHeight).sort((a, b) => a[0] - b[0]).slice(0, 4).map(([, u]) => u);
    if (!batch.length) return;
    pending = pending.filter(u => !batch.includes(u));
    busy = true;
    // Step 2: get p(keep) for every word from the background script (background.js): the model (score())
    // or, in lightweight mode, English word frequencies (lightScore()).
    const keep = await ext.runtime.sendMessage({ light, paragraphs: batch.map(words) }).catch(e => ({ error: e.message }));
    busy = false;
    if (off) return;
    if (keep.error) { globalThis.skimOff(); return alert('Skim Tool: ' + keep.error); }
    // Step 4: fade the words, then look for more paragraphs near the screen.
    batch.forEach((unit, j) => render(unit, keep[j]));
    next();
  };
  if (!light) keepAlive = setInterval(() => ext.runtime.sendMessage({ paragraphs: [] }).catch(() => {}), 20000); // keep the model loaded while on
  addEventListener('scroll', onScroll, opts);
  next();

  // Step 4, the rendering: each text node is swapped for a <skim-text> holding one <skim-w> per word,
  // in the same order as the scores. Whitespace stays plain text, so line breaking is unchanged.
  function render(nodes, keep) {
    let k = 0;
    for (const node of nodes) {
      const wrap = document.createElement('skim-text');
      for (const part of node.data.split(/(\s+)/)) {
        if (!part.trim()) { wrap.append(part); continue; }
        const word = wrap.appendChild(document.createElement('skim-w'));
        word.textContent = part;
        // p(keep) in [0, 1] -> one of 4 opacity steps: .3 (likely dropped) .53 .77 1 (kept).
        word.style.opacity = 0.3 + 0.7 * Math.floor(keep[k++] * 3.999) / 3;
      }
      node.replaceWith(wrap);
      originals.set(wrap, node); // put back on toggle-off
    }
  }
})();
