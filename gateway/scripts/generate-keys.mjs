/**
 * Generate RS256 JWT key pair for development.
 * Usage: node scripts/generate-keys.mjs
 */
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const keysDir = resolve(__dirname, '..', 'keys');

mkdirSync(keysDir, { recursive: true });

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

writeFileSync(resolve(keysDir, 'private.pem'), privateKey);
writeFileSync(resolve(keysDir, 'public.pem'), publicKey);

console.log('✅ JWT RS256 key pair generated in ./keys/');
console.log('   private.pem — signing key (keep secret)');
console.log('   public.pem  — verification key (can be shared)');
