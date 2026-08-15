const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execSync } = require('child_process');

(async () => {
  console.log('🚀 Starting CDP React Input Closed-Loop Test...');
  
  // Start a simple HTTP server for the test page
  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/test-react-input.html') {
      const htmlPath = '/home/agentuser/test-react-input.html';
      const html = fs.readFileSync(htmlPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });
  
  const PORT = 7777;
  await new Promise(resolve => server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    resolve();
  }));
  
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--window-size=480,800',
      '--disable-web-security'
    ],
    defaultViewport: { width: 480, height: 800, deviceScaleFactor: 2, isMobile: true }
  });
  
  const page = await browser.newPage();
  
  const consoleLogs = [];
  const pageErrors = [];
  const networkFailures = [];
  const apiCalls = [];
  
  page.on('console', msg => {
    const text = msg.text();
    consoleLogs.push({ type: msg.type(), text });
    if (msg.type() === 'error') console.error('Console error:', text);
  });
  
  page.on('pageerror', err => {
    pageErrors.push(err.message);
    console.error('Page error:', err.message);
  });
  
  page.on('requestfailed', req => {
    networkFailures.push({ url: req.url(), error: req.failure()?.errorText });
  });
  
  page.on('response', async response => {
    const url = response.url();
    if (url.includes('/api/') || url.includes('test')) {
      apiCalls.push({ url, status: response.status(), ok: response.ok() });
    }
  });
  
  console.log('Navigating to test page...');
  await page.goto(`http://localhost:${PORT}/test-react-input.html`, { 
    waitUntil: 'networkidle2', 
    timeout: 15000 
  });
  
  // Wait for React-like initialization
  await page.waitForSelector('#test-input', { timeout: 10000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('test-input');
    return el && document.querySelector('button');
  });
  
  console.log('Focusing input and typing test text...');
  await page.focus('#test-input');
  
  const testText = 'CDP真实闭环测试：React 输入 ok 123 中文🚀 测试成功';
  await page.keyboard.type(testText, { delay: 5 });
  
  // Wait for React state update
  await page.waitForFunction((expected) => {
    const el = document.getElementById('test-input');
    const status = document.getElementById('status');
    return el && el.value === expected && status && status.textContent.includes(expected);
  }, {}, testText);
  
  console.log('Verifying state after typing...');
  const state = await page.evaluate(() => {
    const input = document.getElementById('test-input');
    const btn = document.getElementById('submit-btn');
    const statusEl = document.getElementById('status');
    const resultEl = document.getElementById('result');
    return {
      inputValue: input ? input.value : '',
      buttonDisabled: btn ? btn.disabled : true,
      statusText: statusEl ? statusEl.textContent : '',
      resultText: resultEl ? resultEl.textContent : '',
      activeElement: document.activeElement ? document.activeElement.id : ''
    };
  });
  
  console.log('Clicking submit button...');
  await page.click('#submit-btn');
  
  // Wait for submit handling
  await page.waitForFunction(() => {
    const result = document.getElementById('result');
    return result && result.textContent.includes('CDP 闭环测试通过');
  }, {}, { timeout: 10000 });
  
  const finalState = await page.evaluate(() => {
    const input = document.getElementById('test-input');
    const result = document.getElementById('result');
    return {
      finalInputValue: input ? input.value : '',
      finalResult: result ? result.textContent : '',
      hasSuccess: (result ? result.textContent : '').includes('✅')
    };
  });
  
  // Take screenshot
  const screenshotPath = '/tmp/cdp-react-input-verification.png';
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(`Screenshot saved to ${screenshotPath}`);
  
  const hasErrors = pageErrors.length > 0 || networkFailures.length > 0 || 
                    consoleLogs.some(log => log.type === 'error' && !log.text.includes('vite'));
  
  const testResult = {
    success: !hasErrors && state.inputValue === testText && 
             !state.buttonDisabled && finalState.hasSuccess && 
             finalState.finalInputValue === '',
    inputValue: state.inputValue,
    buttonEnabled: !state.buttonDisabled,
    statusText: state.statusText,
    finalResultContainsSuccess: finalState.hasSuccess,
    consoleErrors: consoleLogs.filter(l => l.type === 'error'),
    pageErrors,
    networkFailures,
    screenshotPath,
    testText
  };
  
  console.log('\n=== CDP React Input Closed-Loop Test Result ===');
  console.log(JSON.stringify(testResult, null, 2));
  
  if (testResult.success) {
    console.log('\n✅ TEST PASSED: Real browser CDP closed-loop React input verification successful.');
    console.log('Key validations:');
    console.log('  • Keyboard input triggered React onInput / state update');
    console.log('  • DOM value synced with React state');
    console.log('  • Submit button state changed correctly');
    console.log('  • Submit action processed without errors');
    console.log('  • Screenshot evidence captured');
  } else {
    console.log('\n❌ TEST FAILED - see details above.');
  }
  
  await browser.close();
  server.close();
  
  // Output final verdict for agent
  if (testResult.success) {
    console.log('\nFINAL_VERDICT: PASS');
  } else {
    console.log('\nFINAL_VERDICT: FAIL');
  }
  
  process.exit(testResult.success ? 0 : 1);
})().catch(err => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
