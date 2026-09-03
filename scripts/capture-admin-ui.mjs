import { chromium } from 'file:///C:/Users/jacks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import fs from 'node:fs/promises';

await fs.mkdir('tmp/admin-ui',{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
const page=await browser.newPage({viewport:{width:1500,height:950}});
await page.goto('http://127.0.0.1:3000/admin');
await page.locator('#adminLoginForm input[name=username]').fill('admin');
await page.locator('#adminLoginForm input[name=password]').fill('12345678');
await page.locator('#adminLoginForm button[type=submit]').click();
await page.locator('#adminShell').waitFor({state:'visible'});
await page.screenshot({path:'tmp/admin-ui/accounts.png',fullPage:true});
await page.locator('[data-view=roles]').click();
await page.waitForTimeout(300);
await page.screenshot({path:'tmp/admin-ui/permissions.png',fullPage:true});
await browser.close();
console.log('admin UI capture passed');
