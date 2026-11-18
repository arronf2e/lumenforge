// Packfiles: building them (plain objects, zlib-deflated, SHA-1 trailer) and reading
// them (version 2/3, OFS_DELTA and REF_DELTA resolved recursively, thin-pack bases
// taken from the object store). Reading is strict — the trailer checksum and every
// object's size are verified — because receive-pack must refuse a corrupt pack
// without touching a ref.

import { createHash } from 'node:crypto';
import { deflateSync, createInflate } from 'node:zlib';
import { hashObject, readObject, writeObject, type ObjectType } from './gitobj.ts';

const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

const packEntryCache = new Map<string, Buffer>();

/** One object's pack entry (header + deflated payload); objects are immutable, so cache it. */
function packEntry(sha: string): Buffer {
  const cached = packEntryCache.get(sha);
  if (cached !== undefined) return cached;
  const object = readObject(sha);
  if (object === undefined) throw new Error(`pack builder asked for missing object ${sha}`);
  const entry = Buffer.concat([
    encodePackHeader(TYPE_CODE[object.type], object.payload.length),
    deflateSync(object.payload),
  ]);
  packEntryCache.set(sha, entry);
  return entry;
}

/** Build a pack from objects already in the store, in the order given. */
export function buildPack(shas: string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(shas.length, 8);
  parts.push(header);
  for (const sha of shas) parts.push(packEntry(sha));
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function encodePackHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let remaining = size;
  let first = (typeCode << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Inflate one deflate stream starting at `offset`; resolves with bytes consumed. */
function inflateAt(buffer: Buffer, offset: number): Promise<{ data: Buffer; consumed: number }> {
  return new Promise((resolve, reject) => {
    const stream = createInflate();
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => {
      const consumed = (stream as unknown as { bytesWritten: number }).bytesWritten;
      resolve({ data: Buffer.concat(chunks), consumed });
    });
    stream.end(buffer.subarray(offset));
  });
}

/** Apply a git delta (copy/insert instructions) to a base payload. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (op & 0x01) copyOffset = delta[offset++] as number;
      if (op & 0x02) copyOffset |= (delta[offset++] as number) << 8;
      if (op & 0x04) copyOffset |= (delta[offset++] as number) << 16;
      if (op & 0x08) copyOffset |= (delta[offset++] as number) << 24;
      if (op & 0x10) copySize = delta[offset++] as number;
      if (op & 0x20) copySize |= (delta[offset++] as number) << 8;
      if (op & 0x40) copySize |= (delta[offset++] as number) << 16;
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== targetSize || result.length !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

export interface ParsedPack {
  /** Every object the pack carries, resolved, by sha. */
  objects: Map<string, { type: ObjectType; payload: Buffer }>;
}

/**
 * Parse and verify a whole pack. Objects land in a staging map, NOT the store: the
 * caller commits them with storePack() once the pack and its ref updates check out.
 * A REF_DELTA base may come from the store (a thin pack against held objects).
 */
export async function parsePack(buffer: Buffer): Promise<ParsedPack> {
  if (buffer.length < 12 + 20) throw new Error('pack too short');
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack has no PACK signature');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version} is not supported`);
  const count = buffer.readUInt32BE(8);
  const trailer = buffer.subarray(buffer.length - 20);
  const computed = createHash('sha1').update(buffer.subarray(0, buffer.length - 20)).digest();
  if (!computed.equals(trailer)) throw new Error('pack trailer checksum mismatch');
  const end = buffer.length - 20;

  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    let byte = buffer[offset] as number;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buffer[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeCode === 6) {
      let b = buffer[offset] as number;
      offset += 1;
      let back = b & 0x7f;
      while (b & 0x80) {
        b = buffer[offset] as number;
        offset += 1;
        back = ((back + 1) << 7) | (b & 0x7f);
      }
      baseOffset = entryOffset - back;
    } else if (typeCode === 7) {
      baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (CODE_TYPE[typeCode] === undefined) {
      throw new Error(`pack object type ${typeCode} is not valid`);
    }
    const inflated = await inflateAt(buffer, offset);
    if (inflated.data.length !== size) throw new Error('pack object size mismatch');
    offset += inflated.consumed;
    const entry: Raw = { offset: entryOffset, typeCode, size, data: inflated.data, baseOffset, baseOid };
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== end) throw new Error('pack has stray bytes before its trailer');

  // REF_DELTA bases are plain entries named by sha: index them once instead of
  // re-hashing every plain entry for every delta.
  const plainBySha = new Map<string, Raw>();
  for (const entry of raw) {
    if (entry.typeCode !== 6 && entry.typeCode !== 7) {
      plainBySha.set(hashObject(CODE_TYPE[entry.typeCode] as ObjectType, entry.data), entry);
    }
  }

  const objects = new Map<string, { type: ObjectType; payload: Buffer }>();
  const resolvedByOffset = new Map<number, { type: ObjectType; payload: Buffer; sha: string }>();
  const resolve = (entry: Raw): { type: ObjectType; payload: Buffer; sha: string } => {
    const cached = resolvedByOffset.get(entry.offset);
    if (cached !== undefined) return cached;
    let type: ObjectType;
    let payload: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (baseEntry === undefined) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      type = base.type;
      payload = applyDelta(base.payload, entry.data);
    } else if (entry.typeCode === 7) {
      let base: { type: ObjectType; payload: Buffer } | undefined;
      const candidate = plainBySha.get(entry.baseOid as string);
      if (candidate !== undefined) base = resolve(candidate);
      if (base === undefined) {
        const stored = readObject(entry.baseOid as string);
        if (stored === undefined) throw new Error('ref-delta base is neither in the pack nor held');
        base = stored;
      } else if (hashObject(base.type, base.payload) !== entry.baseOid) {
        throw new Error('ref-delta base resolved to the wrong object');
      }
      type = base.type;
      payload = applyDelta(base.payload, entry.data);
    } else {
      type = CODE_TYPE[entry.typeCode] as ObjectType;
      payload = entry.data;
    }
    const sha = hashObject(type, payload);
    const resolved = { type, payload, sha };
    resolvedByOffset.set(entry.offset, resolved);
    objects.set(sha, { type, payload });
    return resolved;
  };
  for (const entry of raw) resolve(entry);
  return { objects };
}

/** Commit a parsed pack's objects into the store (writeObject already no-ops on a dupe). */
export function storePack(parsed: ParsedPack): void {
  for (const [, object] of parsed.objects) writeObject(object.type, object.payload);
}
