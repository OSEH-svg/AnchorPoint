-- AlterTable: add expiration support for KYC customers
ALTER TABLE "KycCustomer" ADD COLUMN "expiresAt" TIMESTAMP(3);
