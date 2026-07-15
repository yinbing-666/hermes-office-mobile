const puppeteer = require('puppeteer-core');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--window-size=390,844'],
  });
  const page = await browser.newPage();
  const consoleMessages = [];
  const failedRequests = [];
  const responses = [];
  page.on('console', (msg) => consoleMessages.push({ type: msg.type(), text: msg.text() }));
  page.on('pageerror', (err) => consoleMessages.push({ type: 'pageerror', text: err.message }));
  page.on('requestfailed', (req) => failedRequests.push({ method: req.method(), url: req.url(), error: req.failure()?.errorText || '' }));
  page.on('response', (res) => responses.push({ method: res.request().method(), url: res.url(), status: res.status(), contentType: res.headers()['content-type'] || '' }));

  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle0', timeout: 30000 });
  await page.click('.tabbar button:nth-child(2)');
  await page.waitForSelector('#agent-task', { timeout: 10000 });

  const testText = 'CDP真实闭环测试：React输入正常123';
  const initiallyDisabled = await page.$eval('.compose-card button', (button) => button.disabled);
  await page.type('#agent-task', testText, { delay: 8 });
  const inputState = await page.evaluate(() => ({
    value: document.querySelector('#agent-task')?.value,
    buttonText: document.querySelector('.compose-card button')?.textContent,
    buttonDisabled: document.querySelector('.compose-card button')?.disabled,
  }));
  await page.screenshot({ path: '/tmp/react-input-cdp.png', fullPage: true });

  const responsePromise = page.waitForResponse((res) => res.url().includes('/api/messages') && res.request().method() === 'POST', { timeout: 20000 });
  await page.click('.compose-card button');
  const messageResponse = await responsePromise.catch(() => null);
  await page.waitForFunction(() => {
    const btn = document.querySelector('.compose-card button');
    const status = document.querySelector('.send-status');
    return btn && !btn.disabled && status;
  }, { timeout: 20000 }).catch(() => null);

  const afterClickState = await page.evaluate(() => ({
    value: document.querySelector('#agent-task')?.value,
    buttonText: document.querySelector('.compose-card button')?.textContent,
    buttonDisabled: document.querySelector('.compose-card button')?.disabled,
    statusText: document.querySelector('.send-status')?.textContent || null,
    statusClass: document.querySelector('.send-status')?.className || null,
  }));

  const result = {
    title: await page.title(),
    initiallyDisabled,
    inputState,
    afterClickState,
    messagePostStatus: messageResponse ? messageResponse.status() : null,
    consoleMessages,
    failedRequests,
    responses: responses.filter((r) => r.url.includes('/api/') || r.url.includes('127.0.0.1:4173/')),
    screenshot: '/tmp/react-input-cdp.png',
  };
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
