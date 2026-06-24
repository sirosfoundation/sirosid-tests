import { spawnSync } from 'child_process';

export const ANDROID_ENV = {
  ADB_PATH: process.env.ADB_PATH || process.env.ADB || 'adb',
  DEVICE_SERIAL: process.env.ANDROID_DEVICE_SERIAL || '',
  WALLET_PACKAGE: process.env.ANDROID_WALLET_PACKAGE || 'org.sirosfoundation.sdk.sample',
  WALLET_ACTIVITY: process.env.ANDROID_WALLET_ACTIVITY || 'org.sirosfoundation.sdk.sample.MainActivity',
};

function runAdb(args: string[], timeoutMs = 30000): { stdout: string; stderr: string; status: number } {
  const withSerial = ANDROID_ENV.DEVICE_SERIAL
    ? ['-s', ANDROID_ENV.DEVICE_SERIAL, ...args]
    : args;

  const result = spawnSync(ANDROID_ENV.ADB_PATH, withSerial, {
    encoding: 'utf8',
    timeout: timeoutMs,
  });

  return {
    stdout: result.stdout || '',
    stderr: result.error ? result.error.message : (result.stderr || ''),
    status: result.status ?? -1,
  };
}

export function ensureAndroidWalletReady(): void {
  const devices = runAdb(['devices']);
  if (devices.status !== 0) {
    throw new Error(`adb devices failed: ${devices.stderr || devices.stdout}`);
  }

  const lines = devices.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('List of devices'));

  const online = lines.some((line) => line.endsWith('\tdevice'));
  if (!online) {
    throw new Error(`No online Android device found via adb. Output: ${devices.stdout}`);
  }

  const pkg = runAdb(['shell', 'pm', 'list', 'packages', ANDROID_ENV.WALLET_PACKAGE]);
  if (pkg.status !== 0 || !pkg.stdout.includes(ANDROID_ENV.WALLET_PACKAGE)) {
    throw new Error(
      `Wallet package ${ANDROID_ENV.WALLET_PACKAGE} not installed on device. Output: ${pkg.stdout || pkg.stderr}`
    );
  }
}

export function startAndroidWallet(): void {
  runAdb(['shell', 'am', 'force-stop', ANDROID_ENV.WALLET_PACKAGE], 10000);
  const launch = runAdb(['shell', 'am', 'start', '-n', `${ANDROID_ENV.WALLET_PACKAGE}/${ANDROID_ENV.WALLET_ACTIVITY}`], 15000);
  if (launch.status !== 0) {
    throw new Error(`Failed to start wallet activity: ${launch.stderr || launch.stdout}`);
  }
}

export function sendCredentialOfferToAndroidWallet(interactionUrl: string): void {
  const start = runAdb(
    [
      'shell',
      'am',
      'start',
      '-a',
      'android.intent.action.VIEW',
      '-d',
      interactionUrl,
      ANDROID_ENV.WALLET_PACKAGE,
    ],
    20000
  );

  if (start.status !== 0 || /Error:/i.test(start.stdout) || /Exception/i.test(start.stdout)) {
    throw new Error(
      `Failed to open credential offer in Android wallet: ${start.stdout || start.stderr}`
    );
  }
}

export function sendInteractionUrlToAndroidWallet(interactionUrl: string): void {
  const start = runAdb(
    [
      'shell',
      'am',
      'start',
      '-W',
      '-n',
      `${ANDROID_ENV.WALLET_PACKAGE}/${ANDROID_ENV.WALLET_ACTIVITY}`,
      '-a',
      'android.intent.action.VIEW',
      '-d',
      interactionUrl,
    ],
    20000
  );

  const output = `${start.stdout}\n${start.stderr}`.trim();
  const hasFatalError = /Error:/i.test(output) || /Exception/i.test(output);
  const hasSuccessMarker = /Status:\s*ok/i.test(output) || /Activity:\s+/i.test(output);

  if (hasFatalError || (!hasSuccessMarker && start.status !== 0)) {
    throw new Error(
      `Failed to open interaction URL in Android wallet (status=${start.status}): ${output}`
    );
  }
}