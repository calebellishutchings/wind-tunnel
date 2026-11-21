/** Browser-native bytes. No Node runtime or Buffer polyfill is shipped. */
export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)
export const textOf = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)
export const viewOf = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
export const hexOf = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
export function joinBytes(...parts: Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.length
  }
  return joined
}
export const previewText = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) =>
    (byte >= 32 && byte <= 126) || [9, 10, 13].includes(byte)
      ? String.fromCharCode(byte)
      : `\\x${byte.toString(16).padStart(2, '0')}`,
  ).join('')
