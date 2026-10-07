import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

const DEFAULT_CDP_URL = 'http://127.0.0.1:9222';
const OUTPUT_DIR = path.resolve('app-data/output');
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

let isShuttingDown = false;
let cleanupOnExit = async () => {};

process.on('SIGINT', async () => {
  if (isShuttingDown) process.exit(130);
  isShuttingDown = true;

  console.log('\n\nОстановлено пользователем. Закрываю ресурсы...');
  await cleanupOnExit().catch(() => {});
  process.exit(130);
});

function isCtrlCAbort(err) {
  return err?.name === 'AbortError' || /aborted with ctrl\+c/i.test(String(err?.message || err));
}

function isYesAnswer(text) {
  return ['y', 'yes', 'да', 'д', 'н'].includes(String(text || '').trim().toLowerCase());
}

function parseGoogleDocId(value) {
  const text = String(value || '').trim();
  const match = text.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(text)) return text;
  return null;
}

function shortenCountHeaders(rawText) {
  let replacements = 0;
  const text = String(rawText || '').replace(/\r\n?/g, '\n');
  const updatedText = text.replace(/^(\s*\d+)\s+\d+\s+(\d+)\s*\/?\s*$/gm, (_line, partNumber, shortCount) => {
    replacements += 1;
    return `${partNumber.trim()} ${shortCount}/`;
  });
  const spacedText = updatedText.replace(/\n+(?=\d+\s+\d+\/\s*(?:\n|$))/g, '\n\n');

  return { updatedText: spacedText.trim(), replacements };
}

async function readGoogleDocText(context, docId, rl) {
  const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`;

  try {
    const response = await context.request.get(exportUrl, { timeout: 120000 });
    if (response.ok()) return await response.text();
  } catch (err) {}

  console.log('\nНе получилось скачать документ как txt. Открою документ в браузере — войди в Google и дай доступ, если нужно.');
  const page = await context.newPage();
  await page.goto(`https://docs.google.com/document/d/${docId}/edit`, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});
  await rl.question('Когда документ откроется и ты будешь залогинен, нажми Enter в терминале...');
  await page.close().catch(() => {});

  const response = await context.request.get(exportUrl, { timeout: 120000 });
  if (!response.ok()) {
    throw new Error(`Не удалось прочитать Google Doc. HTTP ${response.status()}.`);
  }

  return await response.text();
}

async function writeClipboard(page, text) {
  await page.evaluate(async value => {
    await navigator.clipboard.writeText(value);
  }, text);
}

async function focusGoogleDocEditor(page) {
  const selectors = [
    '.kix-appview-editor',
    '.kix-page-content-wrapper',
    'div[aria-label*="Document" i]',
    'div[aria-label*="Документ" i]'
  ];

  for (const selector of selectors) {
    const editor = page.locator(selector).first();
    if (await editor.count().catch(() => 0)) {
      await editor.click({ force: true }).catch(() => {});
      await page.waitForTimeout(500);
      return;
    }
  }

  await page.mouse.click(450, 450);
  await page.waitForTimeout(500);
}

async function replaceGoogleDocText(context, docId, updatedText, rl) {
  const page = await context.newPage();
  await page.goto(`https://docs.google.com/document/d/${docId}/edit`, { waitUntil: 'domcontentloaded', timeout: 120000 });

  try {
    await page.waitForSelector('.kix-appview-editor, .kix-page-content-wrapper', { timeout: 60000 });
  } catch (err) {
    console.log('\nНе вижу редактор Google Docs. Если нужно, войди в Google или открой документ.');
    await rl.question('Когда документ будет открыт для редактирования, нажми Enter в терминале...');
  }

  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://docs.google.com' }).catch(() => {});
  await focusGoogleDocEditor(page);

  await writeClipboard(page, updatedText);
  await page.keyboard.press(`${MOD}+A`);
  await page.waitForTimeout(500);
  await page.keyboard.press(`${MOD}+A`);
  await page.waitForTimeout(500);
  await page.keyboard.press(`${MOD}+V`);
  await page.waitForTimeout(3000);

  return page.url();
}

async function main() {
  const rl = readline.createInterface({ input, output });
  let browser;

  cleanupOnExit = async () => {
    await browser?.close().catch(() => {});
    rl.close();
  };

  try {
    await fs.mkdir(OUTPUT_DIR, { recursive: true });

    const sourceInput = (await rl.question('Вставь URL/ID Google Doc: ')).trim();
    const docId = parseGoogleDocId(sourceInput);
    if (!docId) throw new Error('Не понял ссылку или ID Google Doc.');

    const cdpUrl = process.env.CDP_URL || DEFAULT_CDP_URL;
    browser = await chromium.connectOverCDP(cdpUrl, { preserveBrowserDownloads: true });
    const context = browser.contexts()[0] || await browser.newContext();

    const sourceText = await readGoogleDocText(context, docId, rl);
    const { updatedText, replacements } = shortenCountHeaders(sourceText);

    if (!replacements) {
      throw new Error('Не нашёл заголовки вида: 1 1041 806');
    }

    console.log(`\nОбработано заголовков: ${replacements}`);
    console.log('\nПример результата:');
    console.log(updatedText.split('\n').filter(line => /^\d+\s+\d+\/$/.test(line.trim())).slice(0, 10).join('\n'));

    const backupPath = path.join(OUTPUT_DIR, `short-counts-${Date.now()}.txt`);
    await fs.writeFile(backupPath, updatedText, 'utf8');
    console.log(`\nОбновлённый текст сохранён локально: ${backupPath}`);

    const answer = (await rl.question('Заменить текст в Google Doc на версию с сокращёнными числами? y/n [y]: ')).trim().toLowerCase();
    const shouldReplace = !answer || isYesAnswer(answer);

    if (!shouldReplace) {
      console.log('Остановлено без изменения Google Doc.');
      return;
    }

    const docUrl = await replaceGoogleDocText(context, docId, updatedText, rl);
    console.log(`\nГотово. Документ обновлён: ${docUrl}`);
  } catch (err) {
    if (isCtrlCAbort(err)) {
      console.log('\nОстановлено пользователем.');
      process.exitCode = 130;
      return;
    }

    console.error('\nОШИБКА:');
    console.error(err?.stack || err?.message || String(err));
    process.exitCode = 1;
  } finally {
    await cleanupOnExit();
  }
}

main();
