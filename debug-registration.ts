import { createTenant, deleteTenant, generateTestId } from './helpers/shared-helpers';
import { registerUserViaUI } from './helpers/ui-actions';
import { generateTestUsername } from './helpers/softfido';
import { chromium } from 'playwright';

async function main() {
  const tenantId = generateTestId('dbg');
  const username = generateTestUsername('dbg');
  console.log('Creating tenant:', tenantId);
  await createTenant(tenantId, 'Debug ' + tenantId);
  console.log('Tenant created');

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  page.on('response', (r) => {
    if (r.url().includes('register') || r.url().includes('webauthn') || r.status() >= 400) {
      console.log('[HTTP', r.status(), ']', r.url().substring(0, 100));
    }
  });
  page.on('console', (msg) => { if (msg.type() === 'error') console.log('[CONSOLE]', msg.text()); });

  try {
    console.log('Registering user:', username, 'in tenant:', tenantId);
    const result = await registerUserViaUI(page, { username, tenantId });
    console.log('Registration result:', JSON.stringify(result, null, 2));
  } catch (e: any) {
    console.error('Registration error:', e.message);
  } finally {
    await browser.close();
    await deleteTenant(tenantId).catch(() => {});
    console.log('Cleanup done');
  }
}

main();
