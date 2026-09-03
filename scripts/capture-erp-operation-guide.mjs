import { chromium } from 'file:///C:/Users/jacks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

const base='http://127.0.0.1:3000';
const out=path.resolve('tmp/pdfs/erp-operation-guide');
await fs.mkdir(out,{recursive:true});
const loginResponse=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'12345678'})});
const login=await loginResponse.json();
if(!loginResponse.ok)throw new Error(login.error||'登入失敗');
const token=login.data?.token||login.token;
const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
const page=await browser.newPage({viewport:{width:1600,height:1000},deviceScaleFactor:1});
await page.goto(base);
await page.evaluate(tokenValue=>{
  localStorage.setItem('erp-auth-token',tokenValue);
  localStorage.setItem('erp-source-database','SC');
  localStorage.setItem('erp-company-context','SC');
  localStorage.setItem('erp-theme','brown');
},token);
await page.reload({waitUntil:'networkidle'});

async function capture(index,module,screen,label,after){
  await page.locator(`[data-module="${module}"]`).click();
  await page.locator(`[data-screen="${screen}"]`).click();
  await page.waitForTimeout(1400);
  if(after)await after();
  const file=path.join(out,`${String(index).padStart(2,'0')}-${label}.png`);
  await page.screenshot({path:file,fullPage:false});
  return file;
}

const files=[];
files.push(await capture(1,'INV','items','item-master',async()=>{
  await page.locator('#masterKeyword').fill('DEMO-20260819-01');
  await page.locator('#masterSearch').click();
  await page.waitForTimeout(800);
}));
files.push(await capture(2,'SAL','sales-orders','sales-order'));
files.push(await capture(3,'INV','inventory-new-balance','stock-balance'));
files.push(await capture(4,'PUR','requisition-entry','requisition'));
files.push(await capture(5,'PUR','purchase-order-entry','purchase-order'));
files.push(await capture(6,'PUR','receipt-entry','receipt-entry'));
files.push(await capture(7,'SAL','sales-shipments','shipment'));
files.push(await capture(8,'FIN','ar-open','accounts-receivable'));
files.push(await capture(9,'FIN','ap-open','accounts-payable'));
files.push(await capture(10,'FIN','general-ledger','general-ledger',async()=>{
  await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));
  await page.waitForTimeout(500);
}));
await browser.close();
console.log(JSON.stringify({ok:true,files},null,2));
