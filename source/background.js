// Scores words with LLMLingua-2 (TinyBERT), a token classifier trained to imitate GPT-4's
// word deletions when compressing text: p(keep) per word, computed locally, one pass per paragraph.
import * as ort from './ort.wasm.bundle.min.mjs'; // ONNX Runtime Web 1.31.1 (MIT)

const MODEL = 'https://huggingface.co/atjsh/llmlingua-2-js-tinybert-meetingbank-onnx-v4/resolve/e49e9637ec1e9a88defd52b6422cf2d40e96d539/';
const FILES = { // SHA-256 as published in the repo's SHA256SUMS
  'onnx/model_uint8.onnx': 'ea0bdb1f2b3b231e8ecf2948d943753f3cd47d9c9f6c14e6b7f66d432332bbb5',
  'vocab.txt': '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3',
};
ort.env.wasm.wasmPaths = { wasm: chrome.runtime.getURL('source/ort-wasm-simd-threaded.wasm') }; // no import(): service workers forbid it
ort.env.wasm.numThreads = 1;

// Toolbar click injects the content script, which toggles skim rendering on the page.
// PDFs open in Skimmer's own viewer (viewer.html): the content script asks for it on PDF documents.
// Firefox's PDF viewer refuses extensions, so there a web page that refuses injection is tried as a PDF.
// Other refusals (brave://, about:, extension stores, local files) leave nothing to do.
// Extensions cannot read local files, so local PDFs are not supported. Clicking in the viewer goes back.
const VIEWER = chrome.runtime.getURL('source/viewer.html');
const openViewer = (tabId, url) => url.startsWith('file:')
  ? flash('local PDFs are not supported')
  : chrome.tabs.update(tabId, { url: VIEWER + '#' + encodeURIComponent(url) });
const toggle = tab => tab.url?.startsWith(VIEWER)
  ? chrome.tabs.update(tab.id, { url: decodeURIComponent(new URL(tab.url).hash.slice(1)) })
  : chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['source/content_script.js'] })
    .catch(() => (VIEWER.startsWith('moz-extension:') && /^https?:/.test(tab.url) ? openViewer(tab.id, tab.url)
      : flash(tab.url?.startsWith('file:') ? 'local PDFs are not supported' : "can't run on this page")));
chrome.action.onClicked.addListener(toggle);

// Problems show as a ✕ on the toolbar icon for a few seconds, with the reason in its tooltip.
let flashTimer;
function flash(reason) {
  chrome.action.setBadgeText({ text: '✕' });
  chrome.action.setTitle({ title: 'Skimmer: ' + reason });
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: chrome.runtime.getManifest().action.default_title });
  }, 4000);
}

// Right-click the toolbar icon to switch to lightweight scoring (no model).
chrome.runtime.onInstalled.addListener(() => chrome.storage.local.get('light', ({ light }) => chrome.contextMenus.removeAll(() =>
  chrome.contextMenus.create({ id: 'light', type: 'checkbox', checked: !!light, title: 'Lightweight scoring (no model)', contexts: ['action'] }))));
chrome.contextMenus.onClicked.addListener(info => chrome.storage.local.set({ light: info.checked }));

// Step 2: the content script sends the words of the paragraphs near the screen ({ light, paragraphs: [[word, ...], ...] }).
// They are scored as one stream (fewer model runs, more context) and the scores are split back per paragraph.
chrome.runtime.onMessage.addListener(({ light, paragraphs, pdf, fail }, sender, reply) => {
  if (pdf) return void openViewer(sender.tab.id, pdf);
  if (fail) return void flash(fail);
  (light ? lightScore(paragraphs.flat()) : load().then(m => score(m, paragraphs.flat())))
    .then(keep => reply(paragraphs.map(p => keep.splice(0, p.length))), e => reply({ error: e.message }));
  return true; // reply asynchronously
});

// Lightweight scoring (no model): rare words carry more information. Word frequency follows Zipf's law
// (frequency ~ 1/rank), so log(rank) in a list of common English words is linear in a word's information
// content; scaled to [0, 1], words not in the list count as rarest. Hyphenated words take their rarest part.
let ranks;
async function lightScore(words) {
  ranks ??= fetch(chrome.runtime.getURL('source/words.txt')).then(r => r.text()).then(t => new Map(t.trim().split('\n').map((w, i) => [w, i + 1])));
  const r = await ranks, rarest = r.size + 1;
  return words.map(w => {
    const parts = w.toLowerCase().replace(/’/g, "'").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').split(/[-–—/]/).filter(Boolean);
    return parts.length ? Math.max(...parts.map(p => Math.log(r.get(p) ?? rarest))) / Math.log(rarest) : 0;
  });
}

// The model (14 MB, 8-bit) is downloaded from Hugging Face on first use, verified, then served from the extension's cache.
let model;
function load() {
  return model ??= (async () => {
    chrome.action.setBadgeText({ text: '…' });
    const cache = await caches.open('skim-model');
    const get = async file => {
      const cached = await cache.match(MODEL + file);
      if (cached) return cached.arrayBuffer();
      const res = await fetch(MODEL + file);
      if (!res.ok) throw new Error(`model download failed (${res.status})`);
      const data = await res.arrayBuffer();
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), b => b.toString(16).padStart(2, '0')).join('');
      if (hash !== FILES[file]) throw new Error(`checksum mismatch for ${file}`);
      await cache.put(MODEL + file, new Response(data));
      return data;
    };
    const [onnx, vocab] = await Promise.all(Object.keys(FILES).map(get));
    return { session: await ort.InferenceSession.create(onnx), vocab: new Map(new TextDecoder().decode(vocab).split('\n').map((t, i) => [t, i])) };
  })().catch(e => { model = null; throw e; }).finally(() => chrome.action.setBadgeText({ text: '' }));
}

// BERT uncased WordPiece: lowercase, strip accents and invisible characters, split off punctuation,
// greedy longest-match subwords; pieces over 100 characters are [UNK], as in BERT.
function tokenize(vocab, word) {
  const ids = [];
  for (const piece of word.toLowerCase().normalize('NFD').replace(/[\p{Mn}\p{Cc}\p{Cf}]/gu, '').match(/[\p{L}\p{N}]+|[^\p{L}\p{N}\s]/gu) ?? []) {
    if (piece.length > 100) { ids.push(vocab.get('[UNK]')); continue; }
    for (let start = 0, end, id; start < piece.length; start = end) {
      for (end = piece.length; end > start; end--)
        if ((id = vocab.get((start ? '##' : '') + piece.slice(start, end))) !== undefined) break;
      if (end === start) { ids.push(vocab.get('[UNK]')); break; }
      ids.push(id);
    }
  }
  return ids;
}

// Step 3, the model pass: p(keep) per word.
async function score({ session, vocab }, words) {
  // Each word becomes one or more subword token ids, each tagged with the index of its word.
  const tokens = words.flatMap((w, i) => tokenize(vocab, w).map(id => [id, i]));
  const sum = new Float32Array(words.length), n = new Float32Array(words.length);
  // BERT reads at most 512 tokens, so the stream goes in windows of 510 plus [CLS] and [SEP].
  for (let s = 0; s < tokens.length; s += 510) {
    const win = tokens.slice(s, s + 510);
    const ids = [vocab.get('[CLS]'), ...win.map(t => t[0]), vocab.get('[SEP]')];
    const tensor = f => new ort.Tensor('int64', BigInt64Array.from(ids, f), [1, ids.length]);
    // One forward pass gives two logits per token: [drop, keep].
    const { logits: { data } } = await session.run({ input_ids: tensor(BigInt), attention_mask: tensor(() => 1n), token_type_ids: tensor(() => 0n) });
    // Softmax over the pair gives p(keep) per token (k + 1 skips [CLS]); summed per word here, averaged below.
    win.forEach(([, w], k) => { sum[w] += 1 / (1 + Math.exp(data[2 * k + 2] - data[2 * k + 3])); n[w]++; });
  }
  return Array.from(sum, (v, i) => (n[i] ? v / n[i] : 1)); // words with no tokens stay fully visible
}
