import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

/** Use an explicit executable, a Playwright download, or a known system browser. */
export function chromiumExecutable(): string {
  const configured = process.env.CHROME_PATH;
  if (configured) {
    if (!existsSync(configured)) throw new Error('CHROME_PATH does not identify an installed executable');
    return configured;
  }
  const candidates = [chromium.executablePath(),
    ...(process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
      : process.platform === 'win32' ? [join(process.env.PROGRAMFILES ?? '', 'Google/Chrome/Application/chrome.exe'), join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe')]
      : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/opt/google/chrome/chrome'])];
  const found = candidates.find(existsSync);
  if (!found) throw new Error('Install Chromium with the pinned Playwright CLI or set CHROME_PATH');
  return found;
}
