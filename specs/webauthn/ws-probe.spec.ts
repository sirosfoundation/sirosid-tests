import { test, expect } from '@playwright/test';

test('raw websocket probe from real browser context', async ({ page }) => {
  await page.goto('https://sirosid-mdoc-test-wallet-frontend.fly.dev/id/default/');
  await page.waitForLoadState('networkidle');

  const result = await page.evaluate(() => {
    return new Promise((resolve) => {
      const ws = new WebSocket('wss://sirosid-mdoc-test-wallet-proxy.fly.dev/api/v2/wallet');
      const events: string[] = [];
      const finish = () => { clearTimeout(timer); setTimeout(() => resolve(events), 100); };
      const timer = setTimeout(() => { events.push('TIMEOUT after 6s of no more events'); resolve(events); }, 6000);
      ws.onopen = () => { events.push('open'); };
      ws.onmessage = (e) => { events.push('message: ' + String(e.data).slice(0, 300)); };
      ws.onerror = (e) => { events.push('error event fired'); };
      ws.onclose = (e) => { events.push(`close: code=${e.code} reason=${JSON.stringify(e.reason)} wasClean=${e.wasClean}`); finish(); };
      setTimeout(() => { events.push('still open after 5s, no close'); }, 5000);
    });
  });
  console.log('WS_PROBE_RESULT', JSON.stringify(result));
});
