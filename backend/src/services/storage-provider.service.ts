import logger from '../utils/logger';

export const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

const MAGIC_BYTES: Record<string, { bytes: number[]; offset?: number }> = {
  'image/jpeg': { bytes: [0xff, 0xd8, 0xff] },
  'image/png':  { bytes: [0x89, 0x50, 0x4e, 0x47] },
  'application/pdf': { bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
};

/**
 * Throws a StorageProviderError when `size` exceeds MAX_UPLOAD_SIZE_BYTES.
 */
export function validateUploadSize(size: number): void {
  if (size > MAX_UPLOAD_SIZE_BYTES) {
    throw new StorageProviderError(
      `File size ${size} bytes exceeds the maximum allowed size of ${MAX_UPLOAD_SIZE_BYTES} bytes (10 MB)`
    );
  }
}

/**
 * Verifies that `buffer`'s magic bytes match `declaredMimeType`.
 * Throws a StorageProviderError for unsupported or mismatched MIME types.
 */
export function validateKycUpload(buffer: Buffer, declaredMimeType: string): void {
  const expected = MAGIC_BYTES[declaredMimeType];
  if (!expected) {
    throw new StorageProviderError(
      `Unsupported MIME type: ${declaredMimeType}. Allowed: ${Object.keys(MAGIC_BYTES).join(', ')}`
    );
  }
  if (buffer.length < expected.bytes.length) {
    throw new StorageProviderError(
      `File too small to determine type for declared MIME type: ${declaredMimeType}`
    );
  }
  const matches = expected.bytes.every((byte, i) => buffer[i] === byte);
  if (!matches) {
    throw new StorageProviderError(
      `File magic bytes do not match declared MIME type: ${declaredMimeType}. The file may be masquerading as a different type.`
    );
  }
}

/**
 * Provider-agnostic interface for cloud object storage.
 * Implementations exist for S3 and GCS; the mock is used in development/test.
 */
export interface StorageProvider {
  /** Generate a time-limited pre-signed PUT URL for the given storage key. */
  generatePresignedPutUrl(key: string, contentType: string, expiresInSeconds: number): Promise<string>;
  /** Return true when the object at `key` exists in the bucket. */
  objectExists(key: string): Promise<boolean>;
  /** Permanently delete the object at `key` from the bucket. */
  deleteObject(key: string): Promise<void>;
}

export type StorageProviderKind = 'mock' | 's3' | 'gcs';

export interface StorageProviderConfig {
  provider: StorageProviderKind;
  bucket: string;
  region?: string;
}

export class StorageProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageProviderError';
  }
}

const SUPPORTED_PROVIDERS: StorageProviderKind[] = ['mock', 's3', 'gcs'];

export function validateStorageProviderConfig(
  config: Partial<StorageProviderConfig>
): StorageProviderConfig {
  if (!config.provider) {
    throw new StorageProviderError('STORAGE_PROVIDER is required');
  }
  if (!SUPPORTED_PROVIDERS.includes(config.provider)) {
    throw new StorageProviderError(`Unsupported STORAGE_PROVIDER: ${config.provider}`);
  }
  if (!config.bucket?.trim()) {
    throw new StorageProviderError('STORAGE_BUCKET is required');
  }
  if (config.provider === 's3' && !config.region?.trim()) {
    throw new StorageProviderError('STORAGE_REGION is required for S3');
  }
  return {
    provider: config.provider,
    bucket: config.bucket.trim(),
    region: config.region?.trim(),
  };
}

export function storageConfigFromEnv(env: NodeJS.ProcessEnv = process.env): StorageProviderConfig {
  return validateStorageProviderConfig({
    provider: (env.STORAGE_PROVIDER ?? 'mock') as StorageProviderKind,
    bucket: env.STORAGE_BUCKET ?? 'mock-bucket',
    region: env.STORAGE_REGION,
  });
}

/** Minimal in-memory mock used when STORAGE_PROVIDER is absent or 'mock'. */
export class MockStorageProvider implements StorageProvider {
  private readonly bucket: string;
  private readonly uploadedKeys = new Set<string>();

  constructor(bucket = 'mock-bucket') {
    if (!bucket.trim()) {
      throw new StorageProviderError('STORAGE_BUCKET is required');
    }
    this.bucket = bucket;
  }

  async generatePresignedPutUrl(key: string, _contentType: string, _expiresInSeconds: number): Promise<string> {
    return `https://${this.bucket}.mock.storage/${key}?X-Mock-Signed=1`;
  }

  async objectExists(key: string): Promise<boolean> {
    return this.uploadedKeys.has(key);
  }

  async deleteObject(key: string): Promise<void> {
    this.uploadedKeys.delete(key);
  }

  /** Test helper: simulate a completed upload for a key. */
  _markUploaded(key: string): void {
    this.uploadedKeys.add(key);
  }
}

/** AWS S3 implementation of StorageProvider. */
export class S3StorageProvider implements StorageProvider {
  private readonly bucket: string;
  private readonly region: string;

  constructor(config: StorageProviderConfig) {
    const validated = validateStorageProviderConfig(config);
    if (validated.provider !== 's3') {
      throw new StorageProviderError('S3StorageProvider requires provider s3');
    }
    this.bucket = validated.bucket;
    this.region = validated.region!;
  }

  async generatePresignedPutUrl(key: string, contentType: string, expiresInSeconds: number): Promise<string> {
    return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}?X-Amz-Expires=${expiresInSeconds}&Content-Type=${encodeURIComponent(contentType)}`;
  }

  async objectExists(_key: string): Promise<boolean> {
    return false;
  }

  async deleteObject(_key: string): Promise<void> {
    // S3 stub: real deletion would use DeleteObjectCommand
  }
}

/** Google Cloud Storage implementation of StorageProvider. */
export class GcsStorageProvider implements StorageProvider {
  private readonly bucket: string;

  constructor(config: StorageProviderConfig) {
    const validated = validateStorageProviderConfig(config);
    if (validated.provider !== 'gcs') {
      throw new StorageProviderError('GcsStorageProvider requires provider gcs');
    }
    this.bucket = validated.bucket;
  }

  async generatePresignedPutUrl(key: string, contentType: string, expiresInSeconds: number): Promise<string> {
    return `https://storage.googleapis.com/${this.bucket}/${key}?X-Goog-Expires=${expiresInSeconds}&Content-Type=${encodeURIComponent(contentType)}`;
  }

  async objectExists(_key: string): Promise<boolean> {
    return false;
  }

  async deleteObject(_key: string): Promise<void> {
    // GCS stub: real deletion would use storage.bucket().file(key).delete()
  }
}

export function createStorageProvider(config: StorageProviderConfig): StorageProvider {
  const validated = validateStorageProviderConfig(config);
  switch (validated.provider) {
    case 'mock':
      return new MockStorageProvider(validated.bucket);
    case 's3':
      return new S3StorageProvider(validated);
    case 'gcs':
      return new GcsStorageProvider(validated);
    default:
      throw new StorageProviderError(`Unsupported STORAGE_PROVIDER: ${validated.provider}`);
  }
}

export const storageProvider: StorageProvider = createStorageProvider(storageConfigFromEnv());

export function validateStorageConfigOnStartup(): void {
  const provider = process.env.STORAGE_PROVIDER;
  if (!provider) {
    logger.error('STORAGE_PROVIDER environment variable is missing.');
    process.exit(1);
  }

  if (provider !== 's3' && provider !== 'gcs') {
    logger.error(`Invalid STORAGE_PROVIDER: "${provider}". Must be either 's3' or 'gcs'.`);
    process.exit(1);
  }

  const bucket = process.env.STORAGE_BUCKET;
  if (!bucket) {
    logger.error('STORAGE_BUCKET environment variable is missing.');
    process.exit(1);
  }

  if (provider === 's3') {
    const region = process.env.STORAGE_REGION;
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    if (!region || !accessKeyId || !secretAccessKey) {
      logger.error('Missing required S3 configuration keys (STORAGE_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY).');
      process.exit(1);
    }
  } else if (provider === 'gcs') {
    const credentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!credentials) {
      logger.error('Missing required GCS configuration key (GOOGLE_APPLICATION_CREDENTIALS).');
      process.exit(1);
    }
  }
}
