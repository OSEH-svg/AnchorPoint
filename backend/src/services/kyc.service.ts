import { SUPPORTED_ASSET_CODES, getAsset, isDepositSupported, isWithdrawSupported } from '../config/assets';
import {
  InteractiveFlow,
  signInteractiveToken,
} from './sep24-interactive-token.service';
import prisma from "../lib/prisma";
import { KYCStatus } from "@prisma/client";
import { config } from "../config/env";
import { sendKycExpirationWarning } from "./notification.service";
import logger from "../utils/logger";

// Re-export for backward compatibility
export { SUPPORTED_ASSET_CODES as SUPPORTED_ASSETS };
export { getAsset, isDepositSupported, isWithdrawSupported };

export type SupportedAsset = string;

export const normalizeAssetCode = (assetCode: string): string =>
  assetCode.trim().toUpperCase();

export const isSupportedAsset = (assetCode: string): boolean =>
  getAsset(assetCode) !== undefined;

interface InteractiveUrlParams {
  baseUrl: string;
  transactionId: string;
  assetCode: string;
  account?: string;
  amount?: string;
  lang?: string;
  path: string;
  flow: InteractiveFlow;
}

export const buildInteractiveUrl = ({
  baseUrl,
  transactionId,
  assetCode,
  account,
  amount,
  lang = 'en',
  path,
  flow,
}: InteractiveUrlParams): string => {
  const token = signInteractiveToken({
    transactionId,
    account,
    assetCode,
    amount,
    lang,
    flow,
  });

  const url = new URL(path, baseUrl);
  url.searchParams.append('transaction_id', transactionId);
  url.searchParams.append('asset_code', assetCode);
  if (account) url.searchParams.append('account', account);
  if (amount) url.searchParams.append('amount', amount);
  url.searchParams.append('lang', lang);
  url.searchParams.append('token', token);
  return url.toString();
};

export const createDepositInteractiveUrl = (params: {
  baseUrl: string;
  transactionId: string;
  assetCode: string;
  account?: string;
  amount?: string;
  lang?: string;
}): string =>
  buildInteractiveUrl({
    ...params,
    path: '/kyc-deposit',
    assetCode: normalizeAssetCode(params.assetCode),
    flow: 'deposit',
  });

export const createWithdrawInteractiveUrl = (params: {
  baseUrl: string;
  transactionId: string;
  assetCode: string;
  account?: string;
  amount?: string;
  lang?: string;
}): string =>
  buildInteractiveUrl({
    ...params,
    path: '/kyc-withdraw',
    assetCode: normalizeAssetCode(params.assetCode),
    flow: 'withdraw',
  });

export const getExpiringKycCustomers = async (daysBeforeExpiration: number = 7) => {
  const expirationThreshold = new Date();
  expirationThreshold.setDate(expirationThreshold.getDate() + daysBeforeExpiration);

  return prisma.kycCustomer.findMany({
    where: {
      expiresAt: {
        lte: expirationThreshold,
        gte: new Date(),
      },
      status: KYCStatus.ACCEPTED,
    },
    include: {
      user: {
        select: {
          id: true,
          email: true,
        },
      },
    },
  });
};

export const updateKycStatus = async (customerId: string, status: KYCStatus) => {
  return prisma.kycCustomer.update({
    where: { id: customerId },
    data: { status },
  });
};

export const processKycExpirationGracePeriod = async (daysBeforeExpiration: number = 7) => {
  try {
    const expiringCustomers = await getExpiringKycCustomers(daysBeforeExpiration);

    for (const customer of expiringCustomers) {
      try {
        await updateKycStatus(customer.id, KYCStatus.KYC_EXPIRING_SOON);
        const renewalUrl = createDepositInteractiveUrl({
          baseUrl: config.INTERACTIVE_URL,
          transactionId: `kyc-renewal-${customer.id}`,
          assetCode: 'USDC',
        });
        await sendKycExpirationWarning(customer.user.id, renewalUrl);
        logger.info('Sent KYC expiration warning', { customerId: customer.id, userId: customer.user.id });
      } catch (error) {
        logger.error('Failed to process KYC expiration for customer', {
          customerId: customer.id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    return expiringCustomers.length;
  } catch (error) {
    logger.error('Failed to process KYC expiration grace period', { error });
    throw error;
  }
};
