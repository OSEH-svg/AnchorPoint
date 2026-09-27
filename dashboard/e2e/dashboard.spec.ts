import { expect, test } from '@playwright/test';

test.describe('Dashboard Automated E2E Testing Suite', () => {
  test.beforeEach(async ({ page }) => {
    // Mock UI config backend API response for stable test runs
    await page.route('**/api/config/ui', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            brandName: 'AnchorPoint E2E',
            primaryColor: '#3b82f6',
            accentColor: '#14b8a6',
            supportEmail: 'e2e@anchorpoint.local',
            fieldRequirements: {
              deposit: [
                { key: 'walletAddress', label: 'Wallet Address', required: true, placeholder: 'G...' },
                { key: 'amount', label: 'Amount', required: true, placeholder: '500.00' },
              ],
              withdraw: [
                { key: 'iban', label: 'IBAN', required: true, placeholder: 'DE89370400440532013000' },
                { key: 'bankAccount', label: 'Bank Account', required: true, placeholder: 'Account number' },
              ],
              kyc: [
                { key: 'firstName', label: 'First Name', required: true },
                { key: 'lastName', label: 'Last Name', required: true },
              ],
            },
          },
        }),
      });
    });
  });

  test('user login and wallet connection flow', async ({ page }) => {
    // Mock injected Freighter API on window object
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).freighterApi = {
        isConnected: async () => true,
        getPublicKey: async () => 'GBRPYHIL2CI3FNQ4BXLFMNDLFIMPKVDTLVYS6KDRVREKMY47M0000000',
        getNetwork: async () => 'TESTNET',
      };
    });

    await page.goto('/');

    // Verify main brand heading loaded
    await expect(page.getByRole('heading', { name: 'AnchorPoint E2E' })).toBeVisible();

    // Verify connect wallet button is visible and click it
    const connectBtn = page.getByRole('button', { name: 'Connect Wallet' });
    await expect(connectBtn).toBeVisible();
    await connectBtn.click();

    // Verify wallet connected state is reflected in header
    await expect(page.getByText('TESTNET public key')).toBeVisible();
    await expect(page.getByText('GBRP...0000')).toBeVisible();
  });

  test('wallet connection failure handles error gracefully', async ({ page }) => {
    // Do not inject freighterApi to simulate missing wallet extension
    await page.goto('/');

    const connectBtn = page.getByRole('button', { name: 'Connect Wallet' });
    await expect(connectBtn).toBeVisible();
    await connectBtn.click();

    // Verify error notification is rendered
    await expect(page.getByRole('alert')).toContainText('Freighter is not installed');
  });

  test('transaction viewing and filter navigation flow', async ({ page }) => {
    await page.goto('/');

    // Navigate to History tab
    const historyTab = page.getByRole('button', { name: 'History' });
    await expect(historyTab).toBeVisible();
    await historyTab.click();

    // Verify transaction history view rendered
    await expect(page.getByTestId('active-view')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();

    // Test search filter input
    const searchInput = page.getByPlaceholder('Search by ID, asset, type, or ref...');
    await expect(searchInput).toBeVisible();
    await searchInput.fill('USDC');

    // Test status filter selector
    const statusSelect = page.getByRole('combobox');
    await expect(statusSelect).toBeVisible();
    await statusSelect.selectOption('Completed');
  });

  test('config updates and settings view flow', async ({ page }) => {
    await page.goto('/');

    // Navigate to Settings tab
    const settingsTab = page.getByRole('button', { name: 'Settings' });
    await expect(settingsTab).toBeVisible();
    await settingsTab.click();

    // Verify settings view sections are displayed
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Branding Configuration' })).toBeVisible();

    // Check brand name input value from synced config
    const brandInput = page.locator('#brand-name');
    await expect(brandInput).toHaveValue('AnchorPoint E2E');

    // Verify requirement lists for deposit and withdrawal fields
    await expect(page.getByRole('heading', { name: 'Deposit Fields' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Withdrawal Fields' })).toBeVisible();

    // Verify admin controls section present
    await expect(page.getByRole('heading', { name: 'Anchor Network Configuration' })).toBeVisible();
  });
});
