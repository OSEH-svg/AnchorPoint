import { processFeeReportJob } from '../fee-report.worker';
import { FeeReportService } from '../../services/fee-report.service';

jest.mock('../../services/fee-report.service');
jest.mock('bullmq');

describe('Fee Report Worker Process', () => {
  let mockServiceInstance: jest.Mocked<FeeReportService>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockServiceInstance = (FeeReportService as jest.MockedClass<typeof FeeReportService>).prototype as jest.Mocked<FeeReportService>;

    mockServiceInstance.generateDailyReport.mockResolvedValue({
      reportType: 'DAILY',
      startDate: new Date('2026-01-01T00:00:00.000Z'),
      endDate: new Date('2026-01-01T23:59:59.999Z'),
      totalFees: '10.00',
      totalFeesXLM: '10.00',
      operationCounts: { DEPOSIT: 1, WITHDRAW: 0, SWAP: 0, SEP31: 0 },
      feeBreakdown: {},
    });

    mockServiceInstance.generateMonthlyReport.mockResolvedValue({
      reportType: 'MONTHLY',
      startDate: new Date('2026-01-01T00:00:00.000Z'),
      endDate: new Date('2026-01-31T23:59:59.999Z'),
      totalFees: '100.00',
      totalFeesXLM: '100.00',
      operationCounts: { DEPOSIT: 5, WITHDRAW: 2, SWAP: 1, SEP31: 1 },
      feeBreakdown: {},
    });

    mockServiceInstance.exportAsJSON.mockResolvedValue('/path/to/report.json');
    mockServiceInstance.exportAsPDF.mockResolvedValue('/path/to/report.pdf');
  });

  it('should process a daily fee report job', async () => {
    const mockJob: any = {
      id: 'job-123',
      name: 'generate-daily',
      data: { reportType: 'DAILY', date: '2026-01-01T00:00:00.000Z' },
    };

    const result = await processFeeReportJob(mockJob);

    expect(result.reportType).toBe('DAILY');
    expect(result.jsonPath).toBe('/path/to/report.json');
    expect(result.pdfPath).toBe('/path/to/report.pdf');
    expect(mockServiceInstance.generateDailyReport).toHaveBeenCalled();
    expect(mockServiceInstance.exportAsJSON).toHaveBeenCalled();
    expect(mockServiceInstance.exportAsPDF).toHaveBeenCalled();
  });

  it('should process a monthly fee report job', async () => {
    const mockJob: any = {
      id: 'job-456',
      name: 'generate-monthly',
      data: { reportType: 'MONTHLY', year: 2026, month: 0 },
    };

    const result = await processFeeReportJob(mockJob);

    expect(result.reportType).toBe('MONTHLY');
    expect(result.jsonPath).toBe('/path/to/report.json');
    expect(result.pdfPath).toBe('/path/to/report.pdf');
    expect(mockServiceInstance.generateMonthlyReport).toHaveBeenCalledWith(2026, 0);
  });
});
