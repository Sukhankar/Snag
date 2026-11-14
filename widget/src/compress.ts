// Client-side attachment pipeline — no S3, no external storage.
//   images → OffscreenCanvas → WebP q0.72 (≤1600px wide) + 150px WebP q0.5 thumbnail
//   text   → CompressionStream('gzip')
//   pdf    → stored as-is
// Everything ends up as base64 in the ticket JSON.

export interface Attachment {
  file_name: string;
  mime_type: string;
  compression_type: string;
  payload_b64: string;
  thumbnail_b64?: string;
  /** Decoded bytes after compression — shown in the UI. */
  size: number;
}

const MAX_WIDTH = 1600;
const QUALITY = 0.72;
const THUMB_BOX = 150;
const THUMB_QUALITY = 0.5;
export const MAX_INPUT_BYTES = 25 << 20;
export const MAX_OUTPUT_BYTES = 8 << 20;

const TEXT_TYPES: Record<string, string> = {
  txt: 'text/plain',
  log: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
};

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(',') + 1));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

type Canvas2D = { canvas: OffscreenCanvas | HTMLCanvasElement; ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D };

function makeCanvas(w: number, h: number): Canvas2D {
  // OffscreenCanvas keeps encoding off the DOM; fall back for older Safari.
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  return { canvas, ctx: canvas.getContext('2d') as Canvas2D['ctx'] };
}

function encode({ canvas }: Canvas2D, type: string, quality: number): Promise<Blob> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type, quality });
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), type, quality));
}

/**
 * Draw scaled and encode as WebP. Browsers without a WebP encoder (older Safari) silently
 * return PNG; detect that and re-encode as JPEG on a white background instead.
 */
async function drawEncode(bmp: ImageBitmap, w: number, h: number, quality: number): Promise<Blob> {
  const c = makeCanvas(w, h);
  c.ctx.drawImage(bmp, 0, 0, w, h);
  const webp = await encode(c, 'image/webp', quality);
  if (webp.type === 'image/webp') return webp;
  c.ctx.fillStyle = '#fff';
  c.ctx.fillRect(0, 0, w, h);
  c.ctx.drawImage(bmp, 0, 0, w, h);
  return encode(c, 'image/jpeg', quality);
}

async function compressImage(file: File): Promise<Attachment> {
  const bmp = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_WIDTH / bmp.width);
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const t = Math.min(1, THUMB_BOX / Math.max(bmp.width, bmp.height));
    const [full, thumb] = await Promise.all([
      drawEncode(bmp, w, h, QUALITY),
      drawEncode(bmp, Math.max(1, Math.round(bmp.width * t)), Math.max(1, Math.round(bmp.height * t)), THUMB_QUALITY),
    ]);
    const isWebp = full.type === 'image/webp';
    const base = (file.name || 'screenshot').replace(/\.[^.]+$/, '') || 'screenshot';
    return {
      file_name: base + (isWebp ? '.webp' : '.jpg'),
      mime_type: full.type,
      compression_type: isWebp ? 'webp_canvas' : 'jpeg_canvas',
      payload_b64: await blobToBase64(full),
      thumbnail_b64: await blobToBase64(thumb),
      size: full.size,
    };
  } finally {
    bmp.close();
  }
}

async function gzip(blob: Blob): Promise<Blob> {
  return new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).blob();
}

export async function processFile(file: File): Promise<Attachment> {
  if (file.size > MAX_INPUT_BYTES) throw new Error(`${file.name} is larger than 25 MB`);

  let out: Attachment;
  if (/^image\/(png|jpeg|webp|gif|bmp)$/.test(file.type)) {
    out = await compressImage(file);
  } else {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const textType = TEXT_TYPES[ext] || (file.type.startsWith('text/') ? 'text/plain' : '');
    if (textType) {
      const canGzip = typeof CompressionStream !== 'undefined';
      const blob = canGzip ? await gzip(file) : file;
      out = {
        file_name: file.name,
        mime_type: textType,
        compression_type: canGzip ? 'gzip' : 'none',
        payload_b64: await blobToBase64(blob),
        size: blob.size,
      };
    } else if (file.type === 'application/pdf' || ext === 'pdf') {
      out = { file_name: file.name, mime_type: 'application/pdf', compression_type: 'none', payload_b64: await blobToBase64(file), size: file.size };
    } else {
      throw new Error(`${file.name}: unsupported file type`);
    }
  }
  if (out.size > MAX_OUTPUT_BYTES) throw new Error(`${file.name} is still over 8 MB after compression`);
  return out;
}
