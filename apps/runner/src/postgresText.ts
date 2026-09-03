/**
 * PostgreSQL text/jsonb cannot represent U+0000 or unpaired UTF-16 surrogates.
 * Keep ordinary text unchanged; explicitly tag exceptional strings with a
 * reversible JSON-string-body encoding instead of dropping/replacing bytes.
 *
 * Literal strings beginning with the tag are encoded too, so user/tool text
 * can never collide with an encoded value. Apply AFTER credential redaction
 * and only at the database boundary, never to provider input or identities.
 * Existing readers see an explicit, readable escaped representation. Decoders
 * recover the exact original UTF-16 code units, including literal backslashes.
 */
export const POSTGRES_TEXT_ESCAPE_PREFIX = "[aisevak:string:json-escaped:v1]";

function needsEncoding(value: string): boolean {
  if (value.startsWith(POSTGRES_TEXT_ESCAPE_PREFIX)) return true;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function encodePostgresText(value: string): string {
  return needsEncoding(value)
    ? POSTGRES_TEXT_ESCAPE_PREFIX + JSON.stringify(value).slice(1, -1)
    : value;
}

export function decodePostgresText(value: string): string {
  return value.startsWith(POSTGRES_TEXT_ESCAPE_PREFIX)
    ? JSON.parse('"' + value.slice(POSTGRES_TEXT_ESCAPE_PREFIX.length) + '"') as string
    : value;
}

function mapJsonStrings<T>(value: T, transform: (text: string) => string): T {
  if (typeof value === "string") return transform(value) as T;
  if (Array.isArray(value)) return value.map((item) => mapJsonStrings(item, transform)) as T;
  if (value !== null && typeof value === "object") {
    // fromEntries preserves an own __proto__ key without invoking its setter.
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [transform(key), mapJsonStrings(item, transform)]
    )) as T;
  }
  return value;
}

export function encodePostgresJson<T>(value: T): T {
  return mapJsonStrings(value, encodePostgresText);
}

export function decodePostgresJson<T>(value: T): T {
  return mapJsonStrings(value, decodePostgresText);
}
