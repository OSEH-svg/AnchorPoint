import {
  decryptEnvSecret,
  isEncryptedEnvValue,
  verifyDecryptionCapabilityOnStartup,
  ENCRYPTED_ENV_PREFIX,
} from './key-management.service';

describe('env secret decryption helpers', () => {
  it('detects kms-prefixed values', () => {
    expect(isEncryptedEnvValue(`${ENCRYPTED_ENV_PREFIX}abc`)).toBe(true);
    expect(isEncryptedEnvValue('plaintext')).toBe(false);
    expect(isEncryptedEnvValue(undefined)).toBe(false);
  });

  it('returns plaintext values unchanged', async () => {
    await expect(decryptEnvSecret('plain-db-url', { nodeEnv: 'development' })).resolves.toBe(
      'plain-db-url'
    );
  });

  it('falls back to local ciphertext payload in development without KMS', async () => {
    await expect(
      decryptEnvSecret(`${ENCRYPTED_ENV_PREFIX}local-secret`, {
        nodeEnv: 'development',
        kmsService: null,
      })
    ).resolves.toBe('local-secret');
  });

  it('decrypts via provided KMS service', async () => {
    const kmsService = {
      decryptKey: jest.fn().mockResolvedValue('decrypted-value'),
      encryptKey: jest.fn(),
      getKeyByReference: jest.fn(),
      healthCheck: jest.fn(),
      rotateKey: jest.fn(),
    };

    await expect(
      decryptEnvSecret(`${ENCRYPTED_ENV_PREFIX}cipher`, {
        nodeEnv: 'production',
        kmsService: kmsService as any,
      })
    ).resolves.toBe('decrypted-value');

    expect(kmsService.decryptKey).toHaveBeenCalledWith(
      expect.objectContaining({ ciphertext: 'cipher' })
    );
  });

  it('verifyDecryptionCapabilityOnStartup returns true when no encrypted secrets', async () => {
    await expect(
      verifyDecryptionCapabilityOnStartup({
        NODE_ENV: 'production',
        DATABASE_URL: 'file:./dev.db',
        JWT_SECRET: 'local-secret',
      })
    ).resolves.toBe(true);
  });
});
