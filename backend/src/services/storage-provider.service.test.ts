import {
  createStorageProvider,
  GcsStorageProvider,
  MAX_UPLOAD_SIZE_BYTES,
  MockStorageProvider,
  S3StorageProvider,
  StorageProviderError,
  storageConfigFromEnv,
  validateKycUpload,
  validateStorageProviderConfig,
  validateStorageConfigOnStartup,
  validateUploadSize,
} from './storage-provider.service';
import logger from '../utils/logger';

jest.mock('../utils/logger', () => ({
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
}));

describe('validateStorageConfigOnStartup', () => {
  const originalEnv = process.env;
  let exitMock: jest.SpyInstance;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    exitMock = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    (logger.error as jest.Mock).mockClear();
  });

  afterEach(() => {
    process.env = originalEnv;
    exitMock.mockRestore();
  });

  it('fails if STORAGE_PROVIDER is missing', () => {
    delete process.env.STORAGE_PROVIDER;
    validateStorageConfigOnStartup();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('STORAGE_PROVIDER environment variable is missing'));
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it('fails if STORAGE_PROVIDER is invalid', () => {
    process.env.STORAGE_PROVIDER = 'invalid-provider';
    validateStorageConfigOnStartup();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Invalid STORAGE_PROVIDER: "invalid-provider"'));
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it('fails if STORAGE_BUCKET is missing', () => {
    process.env.STORAGE_PROVIDER = 's3';
    delete process.env.STORAGE_BUCKET;
    validateStorageConfigOnStartup();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('STORAGE_BUCKET environment variable is missing'));
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it('fails if S3 keys are missing', () => {
    process.env.STORAGE_PROVIDER = 's3';
    process.env.STORAGE_BUCKET = 'my-bucket';
    delete process.env.STORAGE_REGION;
    validateStorageConfigOnStartup();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Missing required S3 configuration keys'));
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it('fails if GCS credentials are missing', () => {
    process.env.STORAGE_PROVIDER = 'gcs';
    process.env.STORAGE_BUCKET = 'my-bucket';
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    validateStorageConfigOnStartup();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Missing required GCS configuration key'));
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it('succeeds for valid S3 config', () => {
    process.env.STORAGE_PROVIDER = 's3';
    process.env.STORAGE_BUCKET = 'my-bucket';
    process.env.STORAGE_REGION = 'us-east-1';
    process.env.AWS_ACCESS_KEY_ID = 'key';
    process.env.AWS_SECRET_ACCESS_KEY = 'secret';
    validateStorageConfigOnStartup();
    expect(exitMock).not.toHaveBeenCalled();
  });

  it('succeeds for valid GCS config', () => {
    process.env.STORAGE_PROVIDER = 'gcs';
    process.env.STORAGE_BUCKET = 'my-bucket';
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '/path/to/key.json';
    validateStorageConfigOnStartup();
    expect(exitMock).not.toHaveBeenCalled();
  });
});

describe('StorageProvider initialization', () => {
  describe('validateStorageProviderConfig', () => {
    it('accepts a valid mock configuration', () => {
      expect(validateStorageProviderConfig({ provider: 'mock', bucket: 'test-bucket' })).toEqual({
        provider: 'mock',
        bucket: 'test-bucket',
        region: undefined,
      });
    });

    it('accepts a valid S3 configuration', () => {
      expect(
        validateStorageProviderConfig({ provider: 's3', bucket: 'kyc-bucket', region: 'us-east-1' })
      ).toEqual({
        provider: 's3',
        bucket: 'kyc-bucket',
        region: 'us-east-1',
      });
    });

    it('accepts a valid GCS configuration', () => {
      expect(validateStorageProviderConfig({ provider: 'gcs', bucket: 'kyc-bucket' })).toEqual({
        provider: 'gcs',
        bucket: 'kyc-bucket',
        region: undefined,
      });
    });

    it('rejects missing provider', () => {
      expect(() => validateStorageProviderConfig({ bucket: 'b' })).toThrow(StorageProviderError);
      expect(() => validateStorageProviderConfig({ bucket: 'b' })).toThrow('STORAGE_PROVIDER is required');
    });

    it('rejects unsupported provider', () => {
      expect(() =>
        validateStorageProviderConfig({ provider: 'azure' as 'mock', bucket: 'b' })
      ).toThrow('Unsupported STORAGE_PROVIDER: azure');
    });

    it('rejects missing bucket', () => {
      expect(() => validateStorageProviderConfig({ provider: 'mock', bucket: '' })).toThrow(
        'STORAGE_BUCKET is required'
      );
    });

    it('rejects S3 configuration without region', () => {
      expect(() => validateStorageProviderConfig({ provider: 's3', bucket: 'b' })).toThrow(
        'STORAGE_REGION is required for S3'
      );
    });
  });

  describe('createStorageProvider', () => {
    it('creates a mock provider with mock configuration', () => {
      const provider = createStorageProvider({ provider: 'mock', bucket: 'dev-bucket' });
      expect(provider).toBeInstanceOf(MockStorageProvider);
    });

    it('creates an S3 provider when region is supplied', () => {
      const provider = createStorageProvider({
        provider: 's3',
        bucket: 'prod-bucket',
        region: 'eu-west-1',
      });
      expect(provider).toBeInstanceOf(S3StorageProvider);
    });

    it('creates a GCS provider with bucket only', () => {
      const provider = createStorageProvider({ provider: 'gcs', bucket: 'gcs-bucket' });
      expect(provider).toBeInstanceOf(GcsStorageProvider);
    });

    it('fails early when bucket is missing', () => {
      expect(() => createStorageProvider({ provider: 'mock', bucket: '  ' })).toThrow(
        StorageProviderError
      );
    });
  });

  describe('storageConfigFromEnv', () => {
    const originalEnv = process.env;

    afterEach(() => {
      process.env = originalEnv;
    });

    it('defaults to mock provider in test environments', () => {
      process.env = { ...originalEnv };
      delete process.env.STORAGE_PROVIDER;
      delete process.env.STORAGE_BUCKET;

      expect(storageConfigFromEnv()).toEqual({
        provider: 'mock',
        bucket: 'mock-bucket',
        region: undefined,
      });
    });

    it('parses S3 environment variables', () => {
      process.env = {
        ...originalEnv,
        STORAGE_PROVIDER: 's3',
        STORAGE_BUCKET: 'anchor-kyc',
        STORAGE_REGION: 'us-west-2',
      };

      expect(storageConfigFromEnv()).toEqual({
        provider: 's3',
        bucket: 'anchor-kyc',
        region: 'us-west-2',
      });
    });
  });

  describe('MockStorageProvider', () => {
    it('generates mock presigned URLs and tracks uploaded keys', async () => {
      const provider = new MockStorageProvider('unit-test-bucket');
      const url = await provider.generatePresignedPutUrl('kyc/doc.pdf', 'application/pdf', 900);

      expect(url).toContain('unit-test-bucket.mock.storage');
      expect(url).toContain('kyc/doc.pdf');
      expect(await provider.objectExists('kyc/doc.pdf')).toBe(false);

      provider._markUploaded('kyc/doc.pdf');
      expect(await provider.objectExists('kyc/doc.pdf')).toBe(true);
    });

    it('rejects empty bucket at construction', () => {
      expect(() => new MockStorageProvider('')).toThrow('STORAGE_BUCKET is required');
    });
  });
});

describe('validateUploadSize', () => {
  it('accepts files at exactly the 10 MB limit', () => {
    expect(() => validateUploadSize(MAX_UPLOAD_SIZE_BYTES)).not.toThrow();
  });

  it('accepts files smaller than 10 MB', () => {
    expect(() => validateUploadSize(5 * 1024 * 1024)).not.toThrow();
  });

  it('rejects files larger than 10 MB', () => {
    expect(() => validateUploadSize(MAX_UPLOAD_SIZE_BYTES + 1)).toThrow(StorageProviderError);
    expect(() => validateUploadSize(MAX_UPLOAD_SIZE_BYTES + 1)).toThrow('exceeds the maximum allowed size');
  });
});

describe('validateKycUpload', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const png  = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  const pdf  = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]); // %PDF-1

  it('accepts a valid JPEG buffer declared as image/jpeg', () => {
    expect(() => validateKycUpload(jpeg, 'image/jpeg')).not.toThrow();
  });

  it('accepts a valid PNG buffer declared as image/png', () => {
    expect(() => validateKycUpload(png, 'image/png')).not.toThrow();
  });

  it('accepts a valid PDF buffer declared as application/pdf', () => {
    expect(() => validateKycUpload(pdf, 'application/pdf')).not.toThrow();
  });

  it('rejects a PDF buffer declared as image/jpeg', () => {
    expect(() => validateKycUpload(pdf, 'image/jpeg')).toThrow(StorageProviderError);
    expect(() => validateKycUpload(pdf, 'image/jpeg')).toThrow('magic bytes do not match');
  });

  it('rejects a JPEG buffer declared as image/png', () => {
    expect(() => validateKycUpload(jpeg, 'image/png')).toThrow(StorageProviderError);
  });

  it('rejects a JPEG buffer declared as application/pdf', () => {
    expect(() => validateKycUpload(jpeg, 'application/pdf')).toThrow(StorageProviderError);
  });

  it('rejects an unsupported MIME type', () => {
    expect(() => validateKycUpload(jpeg, 'image/gif')).toThrow(StorageProviderError);
    expect(() => validateKycUpload(jpeg, 'image/gif')).toThrow('Unsupported MIME type');
  });

  it('rejects a buffer too small to determine type', () => {
    expect(() => validateKycUpload(Buffer.from([0xff]), 'image/jpeg')).toThrow(StorageProviderError);
    expect(() => validateKycUpload(Buffer.from([0xff]), 'image/jpeg')).toThrow('too small');
  });
});
