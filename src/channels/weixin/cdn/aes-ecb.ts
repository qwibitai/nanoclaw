/**
 * AES-128-ECB helpers used by the WeChat iLink CDN upload/download protocol.
 *
 * Ported from @tencent-weixin/openclaw-weixin v2.1.9 (src/cdn/aes-ecb.ts).
 */
import { createCipheriv, createDecipheriv } from 'node:crypto';

export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Ciphertext size after AES-128-ECB with PKCS7 padding (always multiple of 16). */
export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}
