// PDF.js reads only the embedded text layer. It runs locally and does not send
// the document to any remote service. OCR and external vision are out of scope.
const isNode = typeof process !== 'undefined' && Boolean(process.versions?.node);
const moduleName = isNode ? 'pdfjs-dist/legacy/build/pdf.mjs' : '/vendor/pdfjs/pdf.mjs';
let enginePromise;

async function pdfjs() {
  enginePromise ??= import(moduleName).then(engine => {
    if (!isNode) engine.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.mjs';
    return engine;
  });
  return enginePromise;
}

function latin1(bytes) { return new TextDecoder('latin1').decode(bytes); }

function standardFontDataUrl() {
  if (!isNode) return '/vendor/pdfjs/standard_fonts/';
  const pathname = decodeURIComponent(new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url).pathname);
  return /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname;
}

function errorMessage(error) {
  const detail = `${error?.name || ''} ${error?.message || ''}`.toLowerCase();
  if (detail.includes('password') || detail.includes('encrypt')) return 'PDF protegido por criptografia. Peça uma exportação sem proteção ou informe os resultados manualmente.';
  if (detail.includes('invalid pdf') || detail.includes('invalidpdf')) return 'O arquivo não é um PDF válido.';
  return 'Não foi possível ler o texto deste PDF. Confira o original e informe os resultados manualmente.';
}

export function textLines(items) {
  // Muitos PDFs reais nao marcam hasEOL de forma confiavel: sem isso, uma pagina inteira vira uma
  // unica string gigante, que a extracao de exames nao consegue interpretar nem sinalizar como
  // pendencia (o valor da metadata engole a pagina inteira por causa do (.+) guloso no regex).
  // A quebra de linha e reconstruida pela posicao do glifo: mudanca de Y encerra a linha; uma
  // lacuna horizontal maior que a metrica normal vira espaco entre palavras que ficariam coladas.
  const lines = []; let line = ''; let lastX = null; let lastY = null;
  const flush = () => { const normalized = line.replace(/\s+/g, ' ').trim(); if (normalized) lines.push(normalized); line = ''; lastX = null; };
  for (const item of items) {
    if (!('str' in item) || typeof item.str !== 'string') continue;
    if (!item.str && !item.hasEOL) continue;
    const x = Array.isArray(item.transform) ? item.transform[4] : null;
    const y = Array.isArray(item.transform) ? item.transform[5] : null;
    if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) flush();
    if (lastX !== null && x !== null && x - lastX > 1.5) line += ' ';
    line += item.str;
    if (x !== null) lastX = x + (item.width || 0);
    lastY = y;
    if (item.hasEOL) flush();
  }
  flush();
  return lines.join('\n');
}

export async function extractPdfPages(bytes) {
  if (!(bytes instanceof Uint8Array) || !latin1(bytes.subarray(0, 5)).startsWith('%PDF-')) throw Error('O arquivo não é um PDF.');
  if (/\/Encrypt\b/.test(latin1(bytes))) throw Error('PDF protegido por criptografia. Peça uma exportação sem proteção ou informe os resultados manualmente.');
  let loadingTask;
  try {
    const engine = await pdfjs();
    loadingTask = engine.getDocument({ data: bytes.slice(), disableWorker: isNode, standardFontDataUrl: standardFontDataUrl() });
    const document = await loadingTask.promise;
    const pages = [];
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      pages.push(textLines((await page.getTextContent()).items));
    }
    const declaredPages = document.numPages;
    await document.destroy();
    const legivel = (pages.join('').match(/\p{L}/gu) || []).length >= 20;
    return { pages, legivel, declaredPages, hasImages: !legivel, problems: legivel ? [] : ['Este PDF não tem texto selecionável (pode ser uma foto ou uma digitalização). O aplicativo não faz OCR no computador: use "Pedir para a IA ler este PDF" (com a IA configurada e a permissão marcada) ou digite os resultados manualmente.'] };
  } catch (error) {
    await loadingTask?.destroy?.();
    throw Error(errorMessage(error));
  }
}
