import { EVENT_INDEXER_BATCH_SIZE, EventIndexerService } from './event-indexer.service';

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: {
    contractEvent: {
      findFirst: jest.fn(),
      upsert: jest.fn(),
      findMany: jest.fn(),
    },
    $transaction: jest.fn(async (fn: any) =>
      fn({
        contractEvent: {
          findFirst: jest.fn().mockResolvedValue({ ledger: 150 }),
        },
      })
    ),
  },
}));

jest.mock('@stellar/stellar-sdk', () => ({
  rpc: {
    Server: jest.fn().mockImplementation(() => ({
      getLatestLedger: jest.fn(),
      getEvents: jest.fn(),
    })),
  },
  xdr: {
    ScVal: {
      fromXDR: jest.fn(() => ({})),
    },
  },
  scValToNative: jest.fn(() => 'native'),
}));

import prisma from '../lib/prisma';
import { rpc, xdr, scValToNative } from '@stellar/stellar-sdk';

describe('EventIndexerService bulk indexing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('exports a batch size of 50 ledgers', () => {
    expect(EVENT_INDEXER_BATCH_SIZE).toBe(50);
  });

  it('queries a 50-ledger range and indexes events concurrently', async () => {
    const getLatestLedger = jest.fn().mockResolvedValue({ sequence: 200 });
    const getEvents = jest.fn().mockResolvedValue({
      events: [
        {
          id: 'evt-1',
          contractId: 'CABC',
          ledger: 101,
          ledgerClosedAt: '2026-01-01T00:00:00Z',
          txHash: 'hash1',
          topic: ['t1'],
          value: 'v1',
          type: 'contract',
        },
        {
          id: 'evt-2',
          contractId: 'CABC',
          ledger: 120,
          ledgerClosedAt: '2026-01-01T00:01:00Z',
          txHash: 'hash2',
          topic: ['t2'],
          value: 'v2',
          type: 'contract',
        },
      ],
    });

    (rpc.Server as jest.Mock).mockImplementation(() => ({
      getLatestLedger,
      getEvents,
    }));

    (prisma.contractEvent.findFirst as jest.Mock).mockResolvedValue({ ledger: 100 });
    (prisma.contractEvent.upsert as jest.Mock).mockResolvedValue({});

    const service = new EventIndexerService('https://example.invalid');
    await service.indexEvents();

    expect(getEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        startLedger: 101,
        endLedger: 150,
      })
    );
    expect(prisma.contractEvent.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(xdr.ScVal.fromXDR).toHaveBeenCalled();
    expect(scValToNative).toHaveBeenCalled();
  });
});
