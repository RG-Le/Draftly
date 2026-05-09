import * as crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * AES-256-GCM encryption service for OAuth tokens.
 *
 * Storage format (bytea): IV (12 bytes) || ciphertext || auth_tag (16 bytes)
 *
 * GCM provides both confidentiality and integrity (tamper detection via auth tag).
 */
export class EncryptionService {
  private readonly key: Buffer;

  constructor(hexKey: string) {
    this.key = Buffer.from(hexKey, 'hex');
    if (this.key.length !== 32) {
      throw new Error(`Encryption key must be 32 bytes (256 bits), got ${this.key.length} bytes`);
    }
  }

  /** Encrypt plaintext → Buffer (IV || ciphertext || auth_tag) */
  encrypt(plaintext: string): Buffer {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv);

    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // IV (12) + ciphertext (variable) + auth_tag (16)
    return Buffer.concat([iv, encrypted, authTag]);
  }

  /** Decrypt Buffer (IV || ciphertext || auth_tag) → plaintext */
  decrypt(data: Buffer): string {
    if (data.length < IV_LENGTH + AUTH_TAG_LENGTH) {
      throw new Error('Encrypted data is too short to be valid');
    }

    const iv = data.subarray(0, IV_LENGTH);
    const authTag = data.subarray(data.length - AUTH_TAG_LENGTH);
    const ciphertext = data.subarray(IV_LENGTH, data.length - AUTH_TAG_LENGTH);

    const decipher = crypto.createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf-8');
  }
}
