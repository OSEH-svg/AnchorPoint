import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting Prisma database seed...');

  // 1. Seed Admin User
  const adminEmail = 'admin@anchorpoint.io';
  const adminUser = await prisma.adminUser.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
      // Hashed representation for 'AdminPassword123!'
      passwordHash: '$2b$10$EpRvmqqYp86C45/./.e0zO5mJg0/xNq345W2e7V2x/wV8O2e8m',
    },
  });
  console.log(`✅ Seeded admin account: ${adminUser.email}`);

  // 2. Seed Test Users
  const user1Key = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFXYSFSSTY2LN4YREOBW5';
  const user1 = await prisma.user.upsert({
    where: { publicKey: user1Key },
    update: {},
    create: {
      publicKey: user1Key,
      email: 'user1@anchorpoint.io',
      phone: '+15550101',
      notificationPreference: {
        create: {
          emailEnabled: true,
          smsEnabled: false,
          pushEnabled: true,
        },
      },
    },
  });

  const user2Key = 'GA5W25T2WYBG7RNEBCA3LSCM52UGLPCCYNNWJBDK3YCYM3TFRKND2K2G';
  const user2 = await prisma.user.upsert({
    where: { publicKey: user2Key },
    update: {},
    create: {
      publicKey: user2Key,
      email: 'user2@anchorpoint.io',
      phone: '+15550102',
      notificationPreference: {
        create: {
          emailEnabled: true,
          smsEnabled: true,
          pushEnabled: false,
        },
      },
    },
  });
  console.log(`✅ Seeded test users: ${user1.email}, ${user2.email}`);

  // 3. Seed System Config
  const systemConfig = await prisma.systemConfig.upsert({
    where: { version: 1 },
    update: {},
    create: {
      version: 1,
      isActive: true,
      settings: JSON.stringify({
        feeRate: '0.01',
        minDeposit: '10.00',
        maxWithdrawal: '10000.00',
        supportedAssets: ['XLM', 'USDC'],
        maintenanceMode: false,
      }),
    },
  });
  console.log(`✅ Seeded SystemConfig version ${systemConfig.version}`);

  // 4. Seed Sample Transactions
  const existingTxCount = await prisma.transaction.count();
  if (existingTxCount === 0) {
    const sampleTransactions = [
      {
        userId: user1.id,
        assetCode: 'USDC',
        amount: '100.00',
        type: 'DEPOSIT',
        status: 'COMPLETED',
        externalId: 'ext-dep-001',
        stellarTxId: 'tx-dep-001',
        feeAmount: '1.00',
        feeAssetCode: 'USDC',
        feeType: 'PERCENTAGE',
      },
      {
        userId: user1.id,
        assetCode: 'XLM',
        amount: '500.00',
        type: 'WITHDRAW',
        status: 'COMPLETED',
        externalId: 'ext-wd-001',
        stellarTxId: 'tx-wd-001',
        feeAmount: '5.00',
        feeAssetCode: 'XLM',
        feeType: 'FLAT',
      },
      {
        userId: user2.id,
        assetCode: 'USDC',
        amount: '250.00',
        type: 'SWAP',
        status: 'COMPLETED',
        externalId: 'ext-swap-001',
        stellarTxId: 'tx-swap-001',
        feeAmount: '0.50',
        feeAssetCode: 'USDC',
        feeType: 'PERCENTAGE',
      },
      {
        userId: user2.id,
        assetCode: 'USDC',
        amount: '1000.00',
        type: 'SEP31',
        status: 'COMPLETED',
        externalId: 'ext-sep31-001',
        stellarTxId: 'tx-sep31-001',
        feeAmount: '10.00',
        feeAssetCode: 'USDC',
        feeType: 'FLAT',
      },
      {
        userId: user1.id,
        assetCode: 'USDC',
        amount: '50.00',
        type: 'DEPOSIT',
        status: 'PENDING',
        externalId: 'ext-dep-002',
        feeAmount: '0.50',
        feeAssetCode: 'USDC',
        feeType: 'PERCENTAGE',
      },
      {
        userId: user2.id,
        assetCode: 'XLM',
        amount: '200.00',
        type: 'WITHDRAW',
        status: 'FAILED',
        externalId: 'ext-wd-002',
        feeAmount: '2.00',
        feeAssetCode: 'XLM',
        feeType: 'FLAT',
      },
    ];

    for (const txData of sampleTransactions) {
      await prisma.transaction.create({ data: txData });
    }
    console.log(`✅ Seeded ${sampleTransactions.length} sample transactions.`);
  } else {
    console.log(`ℹ️ Transactions table already populated (${existingTxCount} existing records).`);
  }

  console.log('🎉 Database seeding completed successfully.');
}

main()
  .catch((e) => {
    console.error('❌ Error seeding database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
