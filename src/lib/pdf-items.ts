// The positioned text of a PDF, read in the browser with pdf.js (loaded only when a PDF is dropped).
import type { PdfItem } from './statement-pdf';

export async function pdfItems(file: File | ArrayBuffer): Promise<PdfItem[]> {
  const pdfjs = await import('pdfjs-dist');
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
  }
  const data = new Uint8Array(file instanceof ArrayBuffer ? file : await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
  const items: PdfItem[] = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const tc = await (await doc.getPage(p)).getTextContent();
      for (const it of tc.items) {
        if ('str' in it && it.str) items.push({ page: p, x: it.transform[4], y: it.transform[5], s: it.str });
      }
    }
  } finally { await doc.destroy(); }
  return items;
}
