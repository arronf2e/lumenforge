// The pkt-line codec of the git wire protocol: 4-hex-digit length-prefixed packets,
// with 0000 flush, 0001 delimiter and 0002 response-end as control packets. Encoding
// refuses payloads over git's 65520-byte packet maximum; decoding a whole buffered
// request body at once is enough here, since smart-HTTP requests are never streamed.

/** git's LARGE_PACKET_MAX, the largest legal pkt-line including its 4-byte header. */
export const PKT_MAX = 65520;

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Encode one data packet. */
export function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length + 4 > PKT_MAX) throw new Error(`pkt-line payload too large: ${data.length}`);
  const header = (data.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(header, 'ascii'), data]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');
export const RESPONSE_END = Buffer.from('0002', 'ascii');

/** Decode a complete buffer into packets plus any raw trailing bytes after a flush. */
export function decodePackets(buffer: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      // Everything after the first flush of a receive-pack request is the packfile.
      return { packets, rest: buffer.subarray(offset) };
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3 || length > PKT_MAX) throw new Error(`invalid pkt-line length ${length}`);
    if (offset + length > buffer.length) throw new Error('truncated pkt-line payload');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: Buffer.alloc(0) };
}

/** Decode a request body that must be exactly a packet stream (upload-pack requests). */
export function decodeAllPackets(buffer: Buffer): Packet[] {
  const { packets, rest } = decodePackets(buffer);
  if (rest.length > 0) throw new Error('trailing bytes after the packet stream');
  return packets;
}

/** The text lines of the data packets, in order. */
export function packetLines(packets: Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}
