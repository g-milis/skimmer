// Skimmer's PDF viewer: draws the PDF with PDF.js and fades less important words with white boxes.
// Opened by background.js with the PDF's address after the #.
import * as pdfjs from './pdf.min.mjs'; // PDF.js 6.5.438 (Apache-2.0)
pdfjs.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.mjs';

const ext = globalThis.browser ?? chrome;
const url = decodeURIComponent(location.hash.slice(1));
const msg = document.getElementById('msg');
// On failure, go back to the PDF (once, even if several pages fail); background.js shows the reason on the icon.
let failed;
const fail = e => failed ??= ext.runtime.sendMessage({ fail: e.name === 'InvalidPDFException' ? 'not a PDF' : e.message }).finally(() => history.back());

let pdf;
const pages = []; // per page: { div, page, viewport }
try {
  document.title = decodeURIComponent(url.split(/[?#]/)[0].split('/').pop()) || 'PDF';
  pdf = await pdfjs.getDocument({ data: await download(), isEvalSupported: false }).promise;
  const { light } = await ext.storage.local.get('light');
  if (!light) setInterval(() => ext.runtime.sendMessage({ paragraphs: [] }).catch(() => {}), 20000); // keep the model loaded
  msg.remove();

  // A placeholder per page at its final size. A page is drawn and scored when it comes within a screen of
  // the view; its drawing (about 20 MB on high-density screens) is dropped when it moves further away.
  const observer = new IntersectionObserver(entries => entries.forEach(e => {
    const p = pages.find(p => p.div === e.target);
    p.near = e.isIntersecting;
    if (!p.near) { p.div.querySelector('canvas')?.remove(); p.page.cleanup(); }
    else if (p.shown) draw(p).catch(fail);
    else { p.shown = true; show(p, light).catch(fail); }
  }), { rootMargin: '100% 0px' });
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const viewport = page.getViewport({ scale: Math.min(innerWidth - 24, 1000) / page.getViewport({ scale: 1 }).width });
    const div = document.body.appendChild(document.createElement('div'));
    Object.assign(div.style, { width: viewport.width + 'px', height: viewport.height + 'px' });
    div.style.cssText += `--total-scale-factor:${viewport.scale};--scale-round-x:1px;--scale-round-y:1px`; // for the text layer
    div.className = 'page';
    pages.push({ div, page, viewport });
    observer.observe(div);
  }
} catch (e) {
  fail(e);
}

// Download the PDF. Sites that don't allow it need a one-time permission for their origin, asked for with a button.
async function download() {
  const res = await fetch(url).catch(() => null);
  if (res?.ok) return res.arrayBuffer();
  const origins = [new URL(url).origin + '/*'];
  if (await ext.permissions.contains({ origins })) throw new Error(`could not download the PDF (${res?.status ?? 'network error'})`);
  msg.textContent = '';
  const button = msg.appendChild(document.createElement('button'));
  button.textContent = `Allow Skimmer to open PDFs from ${new URL(url).host}`;
  await new Promise(resolve => { button.onclick = () => ext.permissions.request({ origins }).then(ok => ok && resolve()); });
  msg.textContent = 'Loading…';
  return download();
}

// Draw a page at the screen's pixel density; again when it changes (browser zoom), so text stays sharp.
async function draw(p) {
  const { div, page, viewport } = p, canvas = document.createElement('canvas'), dpr = devicePixelRatio;
  [canvas.width, canvas.height] = [viewport.width * dpr, viewport.height * dpr];
  await page.render({ canvas, viewport, transform: [dpr, 0, 0, dpr, 0, 0] }).promise;
  div.querySelector('canvas')?.remove();
  if (p.near) div.prepend(canvas); // unless it was scrolled away meanwhile
}
(function redrawOnZoom() {
  matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', () => {
    pages.filter(p => p.div.querySelector('canvas')).forEach(p => draw(p).catch(fail));
    redrawOnZoom();
  }, { once: true });
})();

async function show(p, light) {
  const { div, page, viewport } = p;
  await draw(p);

  // Invisible text over the page, so it can be selected, copied and found (Ctrl+F).
  const text = await page.getTextContent();
  const textLayer = div.appendChild(document.createElement('div'));
  textLayer.className = 'textLayer';
  await new pdfjs.TextLayer({ textContentSource: text, container: textLayer, viewport }).render();

  // Links: open websites in a new tab, jump to places in the document.
  for (const a of await page.getAnnotations()) {
    if (a.subtype !== 'Link' || !(a.url || a.dest)) continue;
    const [x1, y1] = viewport.convertToViewportPoint(a.rect[0], a.rect[1]), [x2, y2] = viewport.convertToViewportPoint(a.rect[2], a.rect[3]);
    const link = div.appendChild(document.createElement('a'));
    link.style.cssText = `left:${Math.min(x1, x2)}px;top:${Math.min(y1, y2)}px;width:${Math.abs(x2 - x1)}px;height:${Math.abs(y2 - y1)}px`;
    if (a.url) Object.assign(link, { href: a.url, target: '_blank', rel: 'noopener' });
    else { link.href = '#'; link.onclick = e => { e.preventDefault(); jump(a.dest); }; }
  }

  // Each word with its box on the page. A text item is one run of text in one font. Words are measured with
  // that font (PDF.js has loaded it into the page): their position along the run, scaled to its real width,
  // and the exact extent of their ink (letters reach past their advance width and above the font's ascent),
  // plus 1 px so no edge of a letter shows.
  const { items, styles } = text;
  const measure = document.createElement('canvas').getContext('2d');
  const words = [];
  for (const item of items) {
    const [, b, c, d, x, y] = pdfjs.Util.transform(viewport.transform, item.transform);
    if (!item.str?.trim() || Math.abs(b) > 1e-3) continue; // skip empty and rotated text
    measure.font = `${Math.hypot(c, d)}px "${item.fontName}", ${styles[item.fontName]?.fontFamily ?? 'sans-serif'}`;
    const scale = item.width * viewport.scale / measure.measureText(item.str).width;
    for (const m of item.str.matchAll(/\S+/g)) {
      const start = x + measure.measureText(item.str.slice(0, m.index)).width * scale, ink = measure.measureText(m[0]);
      words.push({ text: m[0], x: start - ink.actualBoundingBoxLeft * scale - 1, y: y - ink.actualBoundingBoxAscent - 1,
        w: (ink.actualBoundingBoxLeft + ink.actualBoundingBoxRight) * scale + 2, h: ink.actualBoundingBoxAscent + ink.actualBoundingBoxDescent + 2 });
    }
  }

  // Score in runs of 150 words, like paragraphs on web pages, then cover each word with a white box:
  // the less likely it is kept, the more opaque the box (0.7, 0.47, 0.23, none), as on web pages.
  const paragraphs = [];
  for (let i = 0; i < words.length; i += 150) paragraphs.push(words.slice(i, i + 150).map(w => w.text));
  const keep = await ext.runtime.sendMessage({ light, paragraphs });
  if (keep.error) throw new Error(keep.error);
  keep.flat().forEach((k, i) => {
    const level = Math.floor(k * 3.999), { x, y, w, h } = words[i];
    if (level < 3) div.insertBefore(document.createElement('i'), textLayer).style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px;opacity:${0.7 * (1 - level / 3)}`;
  });
}

// Scroll to a destination inside the PDF: a page, and the point on it when given ([page, {name: 'XYZ'}, x, y, zoom]).
// Links to destinations the PDF doesn't have do nothing.
async function jump(dest) {
  const [ref, kind, x, y] = (typeof dest === 'string' ? await pdf.getDestination(dest) : dest) ?? [];
  const target = pages[Number.isInteger(ref) ? ref : await pdf.getPageIndex(ref).catch(() => -1)];
  if (!target) return;
  const { div, viewport } = target;
  const top = kind?.name === 'XYZ' && y != null ? viewport.convertToViewportPoint(x ?? 0, y)[1] : 0;
  scrollTo({ top: div.offsetTop + top - 8 });
}
