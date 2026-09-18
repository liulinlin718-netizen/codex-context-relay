# Development

Node.js 22+ is the only runtime dependency. Run `node --test tests/*.test.mjs` and `node scripts/package.mjs` from this repository. Tests create synthetic data under the checkout's ignored `.runtime/`. No model credentials are required.

## Optional browser checks

Install Playwright explicitly in this checkout (not globally):

```sh
npm install --no-save --package-lock=false playwright
```

Set `RELAY_BROWSER_EXECUTABLE` to an existing Chromium/Chrome/Edge executable, or explicitly install Playwright's browser with its normal installer. Set `PLAYWRIGHT_BROWSERS_PATH` before installation to choose a browser cache. The checks do not download browsers automatically. Run:

```sh
node scripts/browser-release-proof.mjs
node scripts/browser-connection-proof.mjs
```

Both scripts start and stop their own local selector. Connection responses in the second script are labeled fixtures, not a real host connection. Browser profiles, screenshots, downloads and reports stay in ignored local folders. Do not upload generated profiles, histories, API configuration, credentials or receipts.

Real model inference and native desktop message selection/transfer remain unverified. See [integration boundaries](INTEGRATION.md).
