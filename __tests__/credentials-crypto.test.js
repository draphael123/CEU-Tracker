const { encryptString, decryptString } = require('../credentials-loader');

describe('credentials encryption at rest (AES-256-GCM)', () => {
  const secret = JSON.stringify([{ name: 'Test NP', username: 'u@example.com', password: 'p@ssw0rd!' }]);
  const key = 'correct horse battery staple';

  test('round-trips plaintext through encrypt/decrypt', () => {
    const blob = encryptString(secret, key);
    expect(decryptString(blob, key)).toBe(secret);
  });

  test('produces base64 output that does not leak the plaintext', () => {
    const blob = encryptString(secret, key);
    expect(blob).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(blob).not.toContain('p@ssw0rd');
    expect(blob).not.toContain('example.com');
  });

  test('uses a fresh salt/iv so the same input encrypts differently each time', () => {
    expect(encryptString(secret, key)).not.toBe(encryptString(secret, key));
  });

  test('rejects decryption with the wrong key', () => {
    const blob = encryptString(secret, key);
    expect(() => decryptString(blob, 'wrong key')).toThrow();
  });

  test('rejects a tampered ciphertext (GCM auth tag)', () => {
    const blob = encryptString(secret, key);
    const buf = Buffer.from(blob, 'base64');
    buf[buf.length - 1] ^= 0xff; // flip a bit in the ciphertext
    expect(() => decryptString(buf.toString('base64'), key)).toThrow();
  });
});
