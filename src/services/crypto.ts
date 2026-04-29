/**
 * ADR-0006: workspaces.bot_token / signing_secret 用の AES-256-GCM 暗号化ヘルパ
 *
 * 形式: "{iv_b64}:{ciphertext_b64}:{tag_b64}"
 * - IV: 12バイト（GCMの推奨）、ランダム生成
 * - 暗号文: 任意長
 * - 認証タグ: 16バイト（Web Crypto は ciphertext に append される）
 *
 * Cloudflare Workers の Web Crypto API は GCM のタグを ciphertext の末尾に
 * 自動で append するため、別途分離してから保存する。
 */

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

async function importKey(masterKeyBase64: string): Promise<CryptoKey> {
  const keyBytes = base64Decode(masterKeyBase64);
  if (keyBytes.length !== 32) {
    throw new Error("WORKSPACE_TOKEN_KEY must decode to 32 bytes (AES-256)");
  }
  return crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptToken(
  plaintext: string,
  masterKeyBase64: string,
): Promise<string> {
  const key = await importKey(masterKeyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoded = new TextEncoder().encode(plaintext);

  const cipherBufferWithTag = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded,
  );

  // Web Crypto は ciphertext + tag の連結バッファを返す
  const cipherWithTag = new Uint8Array(cipherBufferWithTag);
  const ciphertext = cipherWithTag.slice(0, cipherWithTag.length - TAG_LENGTH);
  const tag = cipherWithTag.slice(cipherWithTag.length - TAG_LENGTH);

  return `${base64Encode(iv)}:${base64Encode(ciphertext)}:${base64Encode(tag)}`;
}

export async function decryptToken(
  encrypted: string,
  masterKeyBase64: string,
): Promise<string> {
  const parts = encrypted.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted token format");
  }
  const [ivB64, ciphertextB64, tagB64] = parts;
  const iv = base64Decode(ivB64);
  const ciphertext = base64Decode(ciphertextB64);
  const tag = base64Decode(tagB64);

  if (iv.length !== IV_LENGTH) {
    throw new Error(`Invalid IV length: expected ${IV_LENGTH} bytes`);
  }
  if (tag.length !== TAG_LENGTH) {
    throw new Error(`Invalid auth tag length: expected ${TAG_LENGTH} bytes`);
  }

  // Web Crypto に渡すために ciphertext + tag を再結合
  const cipherWithTag = new Uint8Array(
    new ArrayBuffer(ciphertext.length + tag.length),
  );
  cipherWithTag.set(ciphertext, 0);
  cipherWithTag.set(tag, ciphertext.length);

  const key = await importKey(masterKeyBase64);
  const plainBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    cipherWithTag,
  );

  return new TextDecoder().decode(plainBuffer);
}

// === Base64 ヘルパ（atob/btoa は Workers でも使える） ===

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}

function base64Decode(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * ローカル開発・初期セットアップ用: 32バイトのランダムキーを生成して Base64 で返す。
 * `wrangler secret put WORKSPACE_TOKEN_KEY` の入力に使う想定。
 *
 * ※ Workers ランタイム上で呼ぶことは想定しない（kota が node 等で生成）。
 */
export function generateMasterKeyBase64(): string {
  const key = crypto.getRandomValues(new Uint8Array(32));
  return base64Encode(key);
}
