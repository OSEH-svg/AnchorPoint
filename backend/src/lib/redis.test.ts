import { EventEmitter } from 'events';

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

class MockRedisClient extends EventEmitter {
  public get = jest.fn();
  public set = jest.fn();
  public del = jest.fn();
  public publish = jest.fn();
  public ping = jest.fn();
  public call = jest.fn();
  public exists = jest.fn();
  public duplicate: jest.Mock;

  constructor() {
    super();
    this.duplicate = jest.fn(() => {
      const duplicate = new MockRedisClient();
      mockRedisInstances.push(duplicate);
      return duplicate;
    });
  }
}

const mockRedisInstances: MockRedisClient[] = [];
const mockRedisConstructor = jest.fn(() => {
  const client = new MockRedisClient();
  mockRedisInstances.push(client);
  return client;
});

jest.mock('ioredis', () => ({
  __esModule: true,
  default: mockRedisConstructor,
}));

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: mockLogger,
}));

describe('Redis client error handling', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  const loadRedisModule = () => {
    let moduleRef: typeof import('./redis');

    jest.isolateModules(() => {
      moduleRef = require('./redis');
    });

    return moduleRef!;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockRedisInstances.length = 0;
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('logs Redis connection errors without throwing for the primary client', () => {
    const { redis } = loadRedisModule();
    const error = new Error('ECONNREFUSED');

    expect(() => (redis as MockRedisClient).emit('error', error)).not.toThrow();
    expect(mockLogger.error).toHaveBeenCalledWith('Redis connection error:', error);
  });

  it('logs Redis connection errors without throwing for duplicated clients', () => {
    const { redis } = loadRedisModule();
    const duplicate = (redis as MockRedisClient).duplicate() as MockRedisClient;
    const error = new Error('READONLY');

    expect(() => duplicate.emit('error', error)).not.toThrow();
    expect(mockLogger.error).toHaveBeenCalledWith('Redis connection error:', error);
  });
});
