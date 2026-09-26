import { createHash } from 'node:crypto';
import { beginCell, Cell, Dictionary } from '@ton/core';

export interface NftMetadata { name: string; description: string; imageData?: string }
const keyHash = (key: string) => BigInt('0x' + createHash('sha256').update(key).digest('hex'));
function snake(data: Buffer, prefix = true): Cell {
  const capacity = prefix ? 126 : 127;
  const cell = beginCell();
  if (prefix) cell.storeUint(0, 8);
  cell.storeBuffer(data.subarray(0, capacity));
  if (data.length > capacity) cell.storeRef(snake(data.subarray(capacity), false));
  return cell.endCell();
}
export function encodeMetadata(metadata: NftMetadata): Cell {
  if (!metadata.name || Buffer.byteLength(metadata.name) > 256 || Buffer.byteLength(metadata.description) > 2048) throw new Error('Metadata exceeds limits');
  if (metadata.imageData && (Buffer.byteLength(metadata.imageData) > 4096 || !metadata.imageData.trim().startsWith('<svg'))) throw new Error('imageData must be a short SVG');
  const values: Record<string, string> = { name: metadata.name, description: metadata.description };
  if (metadata.imageData) values.image_data = metadata.imageData;
  const dict = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
  for (const [key, value] of Object.entries(values)) dict.set(keyHash(key), snake(Buffer.from(value, 'utf8')));
  return beginCell().storeUint(0, 8).storeDict(dict).endCell();
}
export function decodeMetadata(content: Cell): Record<string, string> {
  const slice = content.beginParse();
  if (slice.loadUint(8) !== 0) throw new Error('Expected TEP-64 on-chain content');
  const dict = slice.loadDict(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
  const result: Record<string, string> = {};
  for (const key of ['name', 'description', 'image_data']) {
    const value = dict.get(keyHash(key));
    if (!value) continue;
    let tail = value.beginParse();
    if (tail.loadUint(8) !== 0) throw new Error('Expected snake prefix');
    const chunks: Buffer[] = [];
    for (;;) {
      chunks.push(tail.loadBuffer(tail.remainingBits / 8));
      if (!tail.remainingRefs) break;
      tail = tail.loadRef().beginParse();
    }
    result[key] = Buffer.concat(chunks).toString('utf8');
  }
  return result;
}
