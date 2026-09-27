/**
 * SEP-12 route validation tests
 *
 * Verifies Zod schemas reject invalid GET/PUT/DELETE customer requests with 400.
 */

import request from 'supertest';
import express from 'express';

jest.mock('../../lib/prisma', () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    kycCustomer: {
      upsert: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      findFirst: jest.fn(),
    },
  },
}));

jest.mock('../middleware/auth.middleware', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = { publicKey: 'GCM5WPR4DDR24FSAX5LIEM4J7AI3KOWJYANSXEPKYXCSZOTAYXE75AFN' };
    next();
  },
}));

jest.mock('../../services/kyc-provider.service', () => ({
  KycStatus: { PENDING: 'PENDING', ACCEPTED: 'ACCEPTED', REJECTED: 'REJECTED' },
  kycProvider: {
    providerName: 'mock',
    submitCustomer: jest.fn().mockResolvedValue({ status: 'PENDING', providerRef: 'ref-1' }),
    verifyWebhookSignature: jest.fn().mockReturnValue(true),
    parseWebhook: jest.fn(),
  },
}));

jest.mock('../../services/crypto.service', () => ({
  cryptoService: {
    encrypt: jest.fn((v: string) => ({ encryptedData: v, iv: 'iv' })),
  },
}));

import sep12Router from './sep12.route';
import prisma from '../../lib/prisma';

const VALID_ACCOUNT = 'GCM5WPR4DDR24FSAX5LIEM4J7AI3KOWJYANSXEPKYXCSZOTAYXE75AFN';

describe('SEP-12 Zod validation', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/sep12', sep12Router);
  });

  describe('GET /sep12/customer', () => {
    it('returns 400 when account query is missing', async () => {
      const res = await request(app).get('/sep12/customer');

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('error');
      expect(res.body.message).toBe('Validation failed');
      expect(res.body.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: expect.arrayContaining(['account']) }),
        ])
      );
    });

    it('returns 400 when account is not a valid Stellar public key', async () => {
      const res = await request(app).get('/sep12/customer').query({ account: 'INVALID' });

      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Validation failed');
    });

    it('passes validation and reaches controller for a valid account', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);

      const res = await request(app).get('/sep12/customer').query({ account: VALID_ACCOUNT });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Customer not found');
    });
  });

  describe('PUT /sep12/customer', () => {
    it('returns 400 when account is missing from body', async () => {
      const res = await request(app)
        .put('/sep12/customer')
        .send({ first_name: 'Ada' });

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('error');
      expect(res.body.message).toBe('Validation failed');
    });

    it('returns 400 when email_address is invalid', async () => {
      const res = await request(app)
        .put('/sep12/customer')
        .send({ account: VALID_ACCOUNT, email_address: 'not-an-email' });

      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Validation failed');
      expect(res.body.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: expect.arrayContaining(['email_address']) }),
        ])
      );
    });

    it('returns 400 when account is invalid', async () => {
      const res = await request(app)
        .put('/sep12/customer')
        .send({ account: 'not-a-stellar-key' });

      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Validation failed');
    });
  });

  describe('DELETE /sep12/customer/:account', () => {
    it('returns 400 when account param is invalid', async () => {
      const res = await request(app).delete('/sep12/customer/not-valid');

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('error');
      expect(res.body.message).toBe('Validation failed');
    });

    it('passes validation for a valid account param', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);

      const res = await request(app).delete(`/sep12/customer/${VALID_ACCOUNT}`);

      expect(res.status).toBe(200);
    });
  });
});
