/**
 * #541 — Mock SMTP server for local backend testing
 *
 * Uses nodemailer-mock to intercept outbound email and assert
 * on the message structure sent by SmtpAdminEmailService.
 */

const sentMail: any[] = [];
const mockNodemailerMock = {
  createTransport: jest.fn().mockImplementation((opts) => {
    return {
      sendMail: jest.fn().mockImplementation((mailOptions) => {
        sentMail.push(mailOptions);
        return Promise.resolve({ messageId: 'mock-id' });
      }),
    };
  }),
  mock: {
    reset: () => {
      sentMail.length = 0;
    },
    getSentMail: () => {
      return sentMail;
    },
  },
};

// Mock nodemailer and nodemailer-mock
jest.mock('nodemailer', () => mockNodemailerMock);
jest.mock('nodemailer-mock', () => mockNodemailerMock);

// Mock the environment config to have SMTP settings
jest.mock('../config/env', () => {
  const original = jest.requireActual('../config/env');
  return {
    ...original,
    config: {
      ...original.config,
      SMTP_HOST: 'localhost',
      SMTP_PORT: 587,
      SMTP_FROM: 'no-reply@anchorpoint.test',
      ADMIN_PASSWORD_RESET_URL_BASE: 'http://localhost:3000/admin/reset-password',
    },
  };
});

process.env.SMTP_HOST = 'localhost';
process.env.SMTP_PORT = '587';
process.env.SMTP_FROM = 'no-reply@anchorpoint.test';

import nodemailerMock from 'nodemailer-mock';
import { SmtpAdminEmailService } from './admin-email.service';

describe('SmtpAdminEmailService (nodemailer-mock)', () => {
  let service: SmtpAdminEmailService;

  beforeEach(() => {
    nodemailerMock.mock.reset();
    service = new SmtpAdminEmailService();
  });

  describe('sendPasswordResetEmail', () => {
    const baseInput = {
      to: 'admin@example.com',
      token: 'tok_abc123',
      expiresAt: new Date('2025-01-01T12:00:00Z'),
    };

    it('sends exactly one email on signup/password-reset', async () => {
      await service.sendPasswordResetEmail(baseInput);

      const sent = nodemailerMock.mock.getSentMail();
      expect(sent).toHaveLength(1);
    });

    it('addresses the email to the provided recipient', async () => {
      await service.sendPasswordResetEmail(baseInput);

      const [mail] = nodemailerMock.mock.getSentMail();
      expect(mail.to).toBe('admin@example.com');
    });

    it('uses the configured from address', async () => {
      await service.sendPasswordResetEmail(baseInput);

      const [mail] = nodemailerMock.mock.getSentMail();
      expect(mail.from).toBe('no-reply@anchorpoint.test');
    });

    it('includes the password-reset token in the plain-text body', async () => {
      await service.sendPasswordResetEmail(baseInput);

      const [mail] = nodemailerMock.mock.getSentMail();
      expect(typeof mail.text).toBe('string');
      expect(mail.text).toContain('tok_abc123');
    });

    it('includes the reset URL in the HTML body', async () => {
      await service.sendPasswordResetEmail(baseInput);

      const [mail] = nodemailerMock.mock.getSentMail();
      expect(typeof mail.html).toBe('string');
      expect(mail.html).toContain('http://localhost:3000/admin/reset-password');
      expect(mail.html).toContain('tok_abc123');
    });

    it('includes the expiry timestamp in the email', async () => {
      await service.sendPasswordResetEmail(baseInput);

      const [mail] = nodemailerMock.mock.getSentMail();
      expect(mail.text).toContain(baseInput.expiresAt.toISOString());
    });

    it('sends a second email independently (withdrawal scenario)', async () => {
      await service.sendPasswordResetEmail(baseInput);
      await service.sendPasswordResetEmail({ ...baseInput, to: 'other@example.com', token: 'tok_withdraw' });

      const sent = nodemailerMock.mock.getSentMail();
      expect(sent).toHaveLength(2);
      expect(sent[1].to).toBe('other@example.com');
      expect(sent[1].text).toContain('tok_withdraw');
    });
  });
});
