// What a stored upload actually is, decided from its bytes.
//
// The multer filter only looks at the extension, and the Content-Type a browser
// attaches to a multipart part is whatever the caller wrote. Neither says what
// the file is, so a `.pdf` that is really HTML was stored, kept with its
// claimed `text/html`, and served back under it (issue #124). This is the one
// place that decides: the kind comes from the content, the extension and the
// declared type must agree with it, and the content type the API stores and
// serves is the one defined here — never the client's.

const path = require('path');

const KINDS = {
  pdf: { mime: 'application/pdf', extensions: ['.pdf'] },
  jpeg: { mime: 'image/jpeg', extensions: ['.jpg', '.jpeg'], aliases: ['image/jpg', 'image/pjpeg'] },
  png: { mime: 'image/png', extensions: ['.png'] },
  doc: { mime: 'application/msword', extensions: ['.doc'] },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', extensions: ['.docx'] },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extensions: ['.xlsx'] },
};

// Browsers and OS shells send this when they do not recognise the extension. It
// asserts nothing, so it is not a contradiction of the content.
const GENERIC_TYPE = 'application/octet-stream';

const startsWith = (buffer, bytes) =>
  buffer.length >= bytes.length && bytes.every((byte, index) => buffer[index] === byte);

// Kind from content, or null. The caller passes the whole file (uploads are
// capped at 10MB): the two OOXML formats are zip archives that differ only in
// which part names they contain, and those sit in the entry headers.
const detectKind = (buffer) => {
  // The PDF header may be preceded by a little junk; readers accept it within
  // the first 1024 bytes, so this does too.
  if (buffer.subarray(0, 1024).includes('%PDF-')) return 'pdf';
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'doc';

  if (startsWith(buffer, [0x50, 0x4b, 0x03, 0x04])) {
    const word = buffer.includes('word/document.xml');
    const sheet = buffer.includes('xl/workbook.xml');
    // A package claiming to be both is a polyglot, not a document.
    if (word && !sheet) return 'docx';
    if (sheet && !word) return 'xlsx';
  }
  return null;
};

const kindForExtension = (extension) =>
  Object.keys(KINDS).find((kind) => KINDS[kind].extensions.includes(String(extension).toLowerCase())) || null;

const normaliseMime = (value) => String(value || '').split(';')[0].trim().toLowerCase();

// Does the type the client declared contradict the kind the content proved?
const declaredTypeAgrees = (declared, kind) => {
  const mime = normaliseMime(declared);
  return !mime || mime === GENERIC_TYPE || mime === KINDS[kind].mime || (KINDS[kind].aliases || []).includes(mime);
};

// Verdict on one upload: { kind, mime } when the extension, the declared type
// and the bytes all describe the same thing, otherwise { error }.
const checkUpload = ({ buffer, originalName, declaredMime }) => {
  const extensionKind = kindForExtension(path.extname(originalName || ''));
  if (!extensionKind) return { error: 'This file type is not allowed. Allowed types: pdf, doc, docx, jpg, jpeg, png, xlsx.' };

  const kind = detectKind(buffer);
  if (kind !== extensionKind) return { error: 'The file contents do not match its extension.' };
  if (!declaredTypeAgrees(declaredMime, kind)) return { error: 'The declared file type does not match the file contents.' };

  return { kind, mime: KINDS[kind].mime };
};

// The type to serve a stored file under, from its (server-sanitised) name —
// never from anything the client sent. Unknown extensions are served as opaque
// bytes rather than guessed at.
const mimeForFileName = (fileName) => {
  const kind = kindForExtension(path.extname(fileName || ''));
  return kind ? KINDS[kind].mime : GENERIC_TYPE;
};

// RFC 6266 / 5987 Content-Disposition: an ASCII fallback for old clients and the
// real name percent-encoded as UTF-8. Interpolating the name raw let a quote or
// newline end the header value early.
const contentDisposition = (fileName) => {
  const name = String(fileName || 'download');
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\%;]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
};

module.exports = {
  GENERIC_TYPE,
  detectKind,
  checkUpload,
  mimeForFileName,
  contentDisposition,
};
