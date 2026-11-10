/**
 * The flow-core wallet drill: the REAL wallet-frontend drives a started
 * flow, and gdc's REAL go-trust decides.
 *
 * The chain (design docs/siros-flow-core-design.md §13 — the standing
 * wallet-side evidence the scripted round trip cannot give):
 *
 *   1. A wallet user (a CDP virtual authenticator as the WSCD).
 *   2. A PID issued INTO the wallet from the gdc vc-apigw (the
 *      authorization_code offer leg: the wallet → PAR → authorize →
 *      the mini-oidc login → back → token → credential).
 *   3. POST /flows/ehic-pid-presentation/start → the deep link
 *      (openid4vp://?client_id&request_uri — the request-by-reference
 *      shapes flow-core serves for real wallets).
 *   4. The wallet presents the PID to the flow; the wallet backend's
 *      trust evaluation consults gdc's REAL go-trust (the verifiers
 *      list carries the flow service); the flow verifies and gdc's
 *      REAL go-trust PERMITS the presented credential.
 *   5. The flow completes: the EHIC issue offer rides the reply.
 *
 * The EHIC redemption INTO the wallet is out of scope here: the
 * embedded issuer demands client authentication on every grant
 * (private_key_jwt/WIA) and the wallet redeems pre-authorized offers
 * as a public client (client_id + DPoP) — a genuine interop gap the
 * drill surfaces, tracked as a spec question; the scripted live
 * round trip (siros-flow-core tests/live_gdc.rs) proves the EHIC
 * path with a registered client.
 *
 * Environment (the gdc deployment):
 *   FRONTEND_URL=https://sirosid-gdc-wallet-frontend.fly.dev
 *   ADMIN_URL=https://sirosid-gdc-wallet-proxy.fly.dev
 *   ADMIN_TOKEN=…             (the deploy prints it)
 *   VC_APIGW_URL=https://sirosid-gdc-vc-apigw.fly.dev
 *   FLOW_CORE_URL=https://sirosid-gdc-flow-core.fly.dev
 *
 * Run (see the deploy message — the same env as the conformance specs):
 *   npx playwright test specs/flow/flow-core-drill.spec.ts
 */

import { test, expect } from '../../helpers/tenant-setup-fixture';
import { loginUserViaUI } from '../../helpers/ui-actions';
import { WebAuthnHelper } from '../../helpers/webauthn';

const FLOW_CORE_URL =
  process.env.FLOW_CORE_URL || 'https://sirosid-gdc-flow-core.fly.dev';
// The drill's flow: the PLAIN-mode twin — the current gdc wallet pair
// completes OID4VP's unencrypted direct_post today (its engine posts
// the clear form; the .jwt mode waits on the frontend's
// response-encryption branch), so the plain twin is the vehicle that
// takes the drill through the last hop: the live PDP permit + the
// EHIC offer. Switch back to ehic-pid-presentation when the wallet
// pair answers the encrypted modes.
const FLOW_NAME =
  process.env.DRILL_FLOW || 'ehic-pid-presentation-plain';
const VC_APIGW_URL =
  process.env.VC_APIGW_URL || 'https://sirosid-gdc-vc-apigw.fly.dev';

/**
 * Register the apigw issuer and the flow service as a verifier on the
 * test's tenant (the same seeding scripts/bootstrap.py performs for
 * the default tenant): without the per-tenant issuer registration the
 * wallet falls back to the OID4VCI "unregistered client" convention
 * (client_id = redirect_uri), which the apigw's client registry
 * rejects at PAR (`invalid_client`); without the verifier
 * registration the wallet's trust evaluation refuses the request.
 */
const ISSUER_CLIENT_ID = 'e2e-test-client';
async function registerOnTenant(tenantId: string): Promise<void> {
  const admin = process.env.ADMIN_URL!;
  const token = process.env.ADMIN_TOKEN!;
  const issuer = await fetch(`${admin}/admin/tenants/${tenantId}/issuers`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      credential_issuer_identifier: VC_APIGW_URL,
      visible: true,
      client_id: ISSUER_CLIENT_ID,
    }),
  });
  expect(issuer.status, 'the issuer registration').toBeLessThan(300);
  const verifier = await fetch(`${admin}/admin/tenants/${tenantId}/verifiers`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'SIROS Flow Core', url: FLOW_CORE_URL }),
  });
  expect(verifier.status, 'the verifier registration').toBeLessThan(300);
  console.log(
    `[Drill] tenant seeded: issuer ${issuer.status}, verifier ${verifier.status}`,
  );
}

test.describe('The flow-core wallet drill (gdc)', () => {
  test.beforeEach(async ({ tenantContext }) => {
    if (!tenantContext.ready) {
      test.skip(true, tenantContext.error || 'Tenant setup failed');
    }
  });

  test('the real wallet presents to a started flow and the live PDP permits', async ({
    page,
    tenantContext,
  }) => {
    test.setTimeout(240_000);
    const base = process.env.FRONTEND_URL!;
    const tenantId = tenantContext.tenantId;
    await registerOnTenant(tenantId);

    // Network visibility for the send (the drill's debugging ears).
    page.on('response', (r) => {
      if (r.url().includes('flow-core') || r.url().includes('flow-response')) {
        console.log(`[Drill http] ${r.status()} ${r.request().method()} ${r.url().slice(0, 140)}`);
      }
    });
    page.on('console', (m) => {
      const t = m.text();
      if (/error|fail|warn/i.test(t)) console.log(`[Drill console] ${t.slice(0, 240)}`);
    });

    // ── The wallet session: the virtual authenticator carries the
    //    registration's credentials; login with them.
    const webauthn = new WebAuthnHelper(page);
    await webauthn.initialize();
    await webauthn.injectPrfMock();
    await webauthn.addPlatformAuthenticator();
    for (const cred of tenantContext.credentials ?? []) {
      await webauthn.addCredential(cred);
    }
    const login = await loginUserViaUI(page, { tenantId });
    expect(login.success, JSON.stringify(login)).toBe(true);
    await page
      .waitForURL((url) => !url.toString().includes('/login'), { timeout: 20_000 })
      .catch(() => {});
    if (page.url().includes('/login')) {
      const continueBtn = page.locator('button:has-text("Continue")');
      if (await continueBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await continueBtn.click();
        await page.waitForURL(
          (url) => !url.toString().includes('/login'),
          { timeout: 20_000 },
        );
      }
    }
    await page.waitForTimeout(3000);
    const dismiss = page.locator('button:has-text("Dismiss")');
    if (await dismiss.isVisible({ timeout: 3000 }).catch(() => false)) {
      await dismiss.click();
    }
    console.log(`[Drill] Logged in: ${page.url()}`);

    // ── The PID: the gdc apigw's arf-1.8 offer, redeemed into the
    //    wallet through the authorization_code leg (PAR → authorize →
    //    the mini-oidc login → back → token → credential).
    const offerResponse = await fetch(`${VC_APIGW_URL}/offers/pid_1_8`);
    expect(offerResponse.status, 'the gdc apigw serves the arf-1.8 offer').toBe(200);
    const offerPayload: any = await offerResponse.json();
    const offerParam = offerPayload.offer as string; // "credential_offer=<urlencoded json>"
    expect(offerParam).toContain('credential_offer=');

    // Feed the offer to the wallet: /id/<tenant>/cb?credential_offer=…
    const walletOfferUrl = `${base}/id/${tenantId}/cb?${offerParam}`;
    console.log(`[Drill] Navigating to the offer…`);
    await page.goto(walletOfferUrl, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);
    console.log(`[Drill] Offer navigation landed: ${page.url()}`);

    // The authorize leg: the wallet may redirect to the apigw's
    // authorize → the mini-oidc's login page (a user dropdown — no
    // passwords). Drive whatever appears; log the chain.
    const droveLogin = await driveMiniOidcLogin(page);
    console.log(`[Drill] The authorize leg: ${page.url()} (login driven: ${droveLogin})`);

    // The apigw's consent (the mini-oidc login returns to it): pick
    // the credential radio, then the "Get credential" submit.
    await driveApigwConsent(page);

    // Back on the wallet: the credential page / a toast. The wallet
    // needs a moment to redeem the token + fetch the credential.
    await page.waitForTimeout(10000);
    console.log(`[Drill] After issuance: ${page.url()}`);
    await page.goto(`${base}/id/${tenantId}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(4000);
    console.log(`[Drill] Wallet home: ${page.url()}`);

    // ── Start the flow: the reply carries the request-by-reference
    //    shapes (request_uri + the openid4vp:// deep link).
    const startResponse = await fetch(
      `${FLOW_CORE_URL}/flows/${FLOW_NAME}/start`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          coverage: {
            pan: 'drill-pan-1',
            document_number: 'drill-ehic-0001',
            starting_date: '2026-01-01',
            ending_date: '2027-01-01',
            date_of_issuance: '2026-01-01',
            authentic_source: 'drill',
          },
        }),
      },
    );
    expect(startResponse.status, 'the flow starts').toBe(200);
    const start: any = await startResponse.json();
    const instance = start.instance as string;
    console.log(`[Drill] Flow started: ${instance}`);
    const deepLink = start.deep_link as string;
    expect(deepLink).toContain('openid4vp://');

    // The deep link → the wallet /cb?client_id&request_uri.
    const params = new URLSearchParams(deepLink.replace('openid4vp://?', ''));
    const walletVpUrl = `${base}/id/${tenantId}/cb?${params.toString()}`;
    console.log(`[Drill] Navigating to the VP request…`);
    await page.goto(walletVpUrl, { waitUntil: 'networkidle' });
    await page.waitForTimeout(5000);
    console.log(`[Drill] VP navigation landed: ${page.url()}`);

    // The preview screen: the wallet fetched the request object,
    // matched the DCQL against the held arf-1.8 PID, and shows what
    // would be shared with the requester (the flow's x509_hash
    // client id). Share it — gdc's REAL go-trust decides.
    const share = page.locator('button:has-text("Share"), #send-select-credentials');
    await expect(share.first()).toBeVisible({ timeout: 20_000 });
    // The old popup shape (next → select → send) if this build shows it.
    const nextButton = page.locator('#next-select-credentials');
    if (await nextButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await nextButton.click();
      await page.waitForTimeout(800);
      await page.locator('[id^="slider-select-credentials-"]').first().click();
      await page.waitForTimeout(500);
      await nextButton.click();
      await page.waitForTimeout(800);
    }
    await share.first().click();
    console.log(`[Drill] Shared — the live PDP decides…`);
    await page.waitForTimeout(6000);

    const consent = page.locator('#consent');
    if (await consent.isVisible({ timeout: 3000 }).catch(() => false)) {
      await consent.click();
      await page.waitForTimeout(3000);
    }
    await page.waitForTimeout(3000);
    console.log(`[Drill] After send: ${page.url()}`);

    // ── The oracle: the flow instance completed (the presentation
    //    verified and gdc's REAL go-trust permitted it) and the EHIC
    //    issue offer rides the flow's own reply.
    const statusResponse = await fetch(`${FLOW_CORE_URL}/flows/${instance}`);
    expect(statusResponse.status).toBe(200);
    const status: any = await statusResponse.json();
    console.log(`[Drill] Flow state: ${status.state}`);
    expect(status.state, JSON.stringify(status)).toBe('completed');
  });
});

/**
 * Drive the apigw's consent page: the credential radios + the
 * "Get credential" submit (the authorize leg returns here after the
 * mini-oidc login). The credential radio must be picked before the
 * submit (the form ignores a submit with no selection).
 */
async function driveApigwConsent(page: import('@playwright/test').Page): Promise<void> {
  // Only when we actually landed on the consent page.
  for (let i = 0; i < 10; i++) {
    if (page.url().includes('/authorization/consent')) break;
    await page.waitForTimeout(1000);
  }
  if (!page.url().includes('/authorization/consent')) {
    console.log(`[Drill] No consent page (${page.url()}) — skipping`);
    return;
  }
  console.log(`[Drill] Consent page: ${page.url()}`);
  // The consent page's shape: a credential card + the "Get credential"
  // button (the radio input is the card's picker — clicking the
  // button submits).
  const submit = page.locator('button:has-text("Get credential"), input[type="submit"][value="Get credential"]');
  await submit.first().waitFor({ state: 'visible', timeout: 15000 });
  await submit.first().click();
  console.log(`[Drill] Consent submitted: ${page.url()}`);
  await page.waitForTimeout(8000);
}

/**
 * Drive the authorize leg's login: the mini-oidc login page is a user
 * dropdown (no passwords — see mini-oidc/users.yaml). Returns whether
 * a login form was found and driven.
 */
async function driveMiniOidcLogin(page: import('@playwright/test').Page): Promise<boolean> {
  // The wallet redirects through the apigw authorize to the IdP login;
  // give the navigation a moment, then look for the user selector.
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.waitForTimeout(2000);
    const url = page.url();
    console.log(`[Drill] authorize leg at: ${url}`);
    if (url.includes('/login') || url.includes('authorize')) {
      // The wallet's own login page — not the IdP's; if we are still
      // logged in, this should pass through.
    }

    // The mini-oidc login form: a <select> of users + a submit.
    const select = page.locator('select').first();
    if (await select.isVisible({ timeout: 4000 }).catch(() => false)) {
      await select.selectOption({ index: 1 }).catch(async () => {
        // Not a plain select? try any option-bearing control.
        await page
          .locator('select option')
          .nth(1)
          .click({ force: true });
      });
      const submit = page.locator(
        'button[type="submit"], button:has-text("Continue"), button:has-text("Log in"), button:has-text("Login"), button:has-text("Sign in"), button:has-text("Submit")',
      );
      if (await submit.isVisible({ timeout: 3000 }).catch(() => false)) {
        await submit.first().click();
        return true;
      }
    }
    // Some IdP UIs render options as buttons/links instead.
    const userOption = page.locator('a:has-text("alice"), button:has-text("alice"), option:has-text("alice")').first();
    if (await userOption.isVisible({ timeout: 2000 }).catch(() => false)) {
      await userOption.click();
      const submit = page.locator(
        'button[type="submit"], button:has-text("Continue"), button:has-text("Log in"), button:has-text("Submit")',
      );
      if (await submit.isVisible({ timeout: 3000 }).catch(() => false)) {
        await submit.first().click();
        return true;
      }
    }
  }
  return false;
}