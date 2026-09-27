import { FcmPushProvider } from './providers';
import logger from '../../utils/logger';

jest.mock('../../utils/logger');

const https = require('https');

describe('FcmPushProvider', () => {
  let provider: FcmPushProvider;

  beforeEach(() => {
    provider = new FcmPushProvider();
    jest.clearAllMocks();
  });

  it('should return false when FCM_SERVER_KEY is not configured', async () => {
    delete process.env.FCM_SERVER_KEY;
    const result = await provider.send('test-token', 'Test message');
    expect(result).toBe(false);
  });

  it('should return false when the request encounters a network error', async () => {
    process.env.FCM_SERVER_KEY = 'test-server-key';
    const mockReq = {
      write: jest.fn(),
      end: jest.fn(),
      on: jest.fn().mockImplementation((_event, handler) => {
        handler(new Error('Network error'));
      }),
    };
    jest.spyOn(https, 'request').mockReturnValue(mockReq as any);

    const result = await provider.send('test-token', 'Test message');
    expect(result).toBe(false);
  });

  it('should return false when FCM returns a non-200 status code', async () => {
    process.env.FCM_SERVER_KEY = 'test-server-key';
    const mockRes = {
      statusCode: 401,
      on: jest.fn().mockImplementation((_event, handler) => {
        handler('Unauthorized');
      }),
      once: jest.fn(),
    };
    const mockReq = {
      write: jest.fn(),
      end: jest.fn(),
      on: jest.fn().mockImplementation((_event, handler) => {
        handler(mockRes);
      }),
    };
    jest.spyOn(https, 'request').mockReturnValue(mockReq as any);

    const result = await provider.send('test-token', 'Test message');
    expect(result).toBe(false);
  });

  it('should return true when FCM returns 200', async () => {
    process.env.FCM_SERVER_KEY = 'test-server-key';
    const mockRes = {
      statusCode: 200,
      on: jest.fn().mockImplementation((event, handler) => {
        if (event === 'data') {
          handler(JSON.stringify({ name: 'projects/anchor-point/messages/123' }));
        }
        if (event === 'end') {
          handler();
        }
      }),
      once: jest.fn(),
    };
    const mockReq = {
      write: jest.fn(),
      end: jest.fn(),
      on: jest.fn().mockImplementation((_event, handler) => {
        handler(mockRes);
      }),
    };
    jest.spyOn(https, 'request').mockReturnValue(mockReq as any);

    const result = await provider.send('test-fcm-token', 'Hello notification');
    expect(result).toBe(true);
  });
});