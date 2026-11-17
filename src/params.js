import { findUris, replaceUri } from "./uri.js";

// Reads the addresses a request mentions, wherever they are: the query string, a form body, a JSON body, or the text
// fields of a file upload. Also rewrites them (see rewriteRequest), keeping uploaded files byte for byte.

const CRLF = Buffer.from("\r\n");

export function boundaryOf(contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? "");
  return match ? match[1] ?? match[2] : null;
}

// Splits a multipart body into its parts. Each part keeps its raw header and body bytes, so files are never altered.
export function parseMultipart(buffer, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = [];
  let position = buffer.indexOf(delimiter);
  if (position === -1) return null;
  while (position !== -1) {
    const afterDelimiter = position + delimiter.length;
    if (buffer.slice(afterDelimiter, afterDelimiter + 2).toString() === "--") break; // closing delimiter
    const headerStart = afterDelimiter + CRLF.length;
    const headerEnd = buffer.indexOf("\r\n\r\n", headerStart);
    if (headerEnd === -1) return null;
    const next = buffer.indexOf(delimiter, headerEnd);
    if (next === -1) return null;
    const headers = buffer.slice(headerStart, headerEnd).toString("utf8");
    const body = buffer.slice(headerEnd + 4, next - CRLF.length);
    parts.push({ headers, body, isFile: /filename\*?=/i.test(headers) });
    position = next;
  }
  return parts;
}

export function buildMultipart(parts, boundary) {
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n${part.headers}\r\n\r\n`), part.body, CRLF);
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

const TEXT_PART_LIMIT = 256 * 1024;

// The text of a request that can carry addresses: [query string, ...body texts].
function textsOf(request) {
  const texts = [request.query ?? ""];
  const type = (request.contentType ?? "").toLowerCase();
  const body = request.body;
  if (!body || body.length === 0) return texts;
  if (type.startsWith("multipart/form-data")) {
    const boundary = boundaryOf(request.contentType);
    const parts = boundary ? parseMultipart(body, boundary) : null;
    if (!parts) return null; // can't be read: the caller refuses it
    for (const part of parts) {
      texts.push(part.headers);
      if (!part.isFile && part.body.length <= TEXT_PART_LIMIT) texts.push(part.body.toString("utf8"));
    }
    return texts;
  }
  // Forms, JSON, XML and plain text are all searched as text. Binary uploads outside multipart are not expected.
  if (body.length <= 8 * 1024 * 1024) texts.push(body.toString("utf8"));
  return texts;
}

// Every address the request mentions, or null when the body can't be read (a malformed upload).
export function urisOf(request) {
  const texts = textsOf(request);
  if (!texts) return null;
  const all = new Set();
  for (const text of texts) for (const uri of findUris(text)) all.add(uri);
  // The path itself can carry an address too (rare, but cheap to cover).
  for (const uri of findUris(request.path ?? "")) all.add(uri);
  return all;
}

// The same request with each `from` address replaced by its `to`. Uploaded files are untouched.
export function rewriteRequest(request, replacements) {
  const swap = (text) => replacements.reduce((current, [from, to]) => replaceUri(current, from, to), text);
  const result = { ...request, query: swap(request.query ?? "") };
  const type = (request.contentType ?? "").toLowerCase();
  const body = request.body;
  if (!body || body.length === 0) return result;
  if (type.startsWith("multipart/form-data")) {
    const boundary = boundaryOf(request.contentType);
    const parts = boundary ? parseMultipart(body, boundary) : null;
    if (!parts) return result;
    const rewritten = parts.map((part) =>
      part.isFile || part.body.length > TEXT_PART_LIMIT ? part : { ...part, body: Buffer.from(swap(part.body.toString("utf8")), "utf8") }
    );
    result.body = buildMultipart(rewritten, boundary);
    return result;
  }
  if (body.length <= 8 * 1024 * 1024) result.body = Buffer.from(swap(body.toString("utf8")), "utf8");
  return result;
}
