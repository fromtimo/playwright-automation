import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

const PROFILE_DIR = path.resolve('app-data/chrome-profile');
const OUTPUT_DIR = path.resolve('app-data/output');
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const DEFAULT_CDP_URL = 'http://127.0.0.1:9222';
const CHATGPT_URL = 'https://chatgpt.com/g/g-p-6a234e2794608191abe426d6606bbdd6-perevody/project';
const REQUEST_DELAY_MIN_MS = 2000;
const REQUEST_DELAY_MAX_MS = 5000;
const CHATGPT_NO_RESPONSE_RETRY_MS = 20000;
const CHATGPT_MAX_SEND_ATTEMPTS = 4;
const CHATGPT_STABLE_ROUNDS = 3;
const CHATGPT_FORCE_STABLE_ROUNDS = 8;
const ENGLISH_PROMPT = `Я хочу, чтобы ты перевёл сценарий на английский язык (американский), без транскрипции подходящий для дикторской озвучки. Перевод должен звучать просто, понятно и естественно для носителей языка. Можно немного менять слова и выражения, но не сильно, и только если это помогает сделать текст более лаконичным и правильным, но важно сохранить общий смысл`;

let lastChatGptSubmitAt = 0;
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

function normalizeText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00A0/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
}

function countChars(text) {
  return Array.from(normalizeText(text)).length;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function isYesAnswer(text) {
  return ['y', 'yes', 'да', 'д', 'н'].includes(String(text || '').trim().toLowerCase());
}

function isNoAnswer(text) {
  return ['n', 'no', 'нет', 'т'].includes(String(text || '').trim().toLowerCase());
}

async function waitBeforeChatGptRequest(page) {
  if (!lastChatGptSubmitAt) return;

  const delay = randomInt(REQUEST_DELAY_MIN_MS, REQUEST_DELAY_MAX_MS);
  console.log(`Пауза перед следующим запросом ChatGPT: ${(delay / 1000).toFixed(1)} сек.`);
  await page.waitForTimeout(delay);
}

function parseParts(rawText) {
  const text = String(rawText || '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const headerRe = /^\s*(\d+)(?:\s+(\d+)\s*\/)?\s*$/;
  const parts = [];
  let current = null;

  for (const line of lines) {
    const match = line.match(headerRe);

    if (match) {
      if (current) pushPart(current, parts);
      current = {
        number: Number(match[1]),
        declaredCount: match[2] ? Number(match[2]) : null,
        lines: []
      };
      continue;
    }

    if (current) current.lines.push(line);
  }

  if (current) pushPart(current, parts);
  return parts;
}

function pushPart(part, parts) {
  const lines = [...part.lines];
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();

  const text = normalizeText(lines.join('\n'));
  if (!text) return;

  parts.push({
    number: part.number,
    declaredCount: part.declaredCount || countChars(text),
    text,
    sourceLength: countChars(text)
  });
}

function parseGoogleDocId(value) {
  const text = String(value || '').trim();
  const match = text.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(text)) return text;
  return null;
}

async function tryDownloadGoogleDocText(context, exportUrl) {
  try {
    const response = await context.request.get(exportUrl, { timeout: 120000 });
    if (!response.ok()) return { ok: false, status: response.status(), text: '' };
    return { ok: true, status: response.status(), text: await response.text() };
  } catch (err) {
    return { ok: false, status: null, text: '', error: err };
  }
}

async function readSourceText(context, sourceInput, rl) {
  const docId = parseGoogleDocId(sourceInput);

  if (!docId) {
    const localPath = path.resolve(sourceInput);
    return await fs.readFile(localPath, 'utf8');
  }

  const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`;
  let result = await tryDownloadGoogleDocText(context, exportUrl);
  if (result.ok) return result.text;

  console.log('\nНе получилось скачать Google Doc как txt. Открою документ в браузере — войди в Google и дай доступ, если нужно.');
  const page = await context.newPage();
  await page.goto(`https://docs.google.com/document/d/${docId}/edit`, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});
  await rl.question('Когда документ откроется и ты будешь залогинен, нажми Enter в терминале...');
  await page.close().catch(() => {});
  result = await tryDownloadGoogleDocText(context, exportUrl);

  if (!result.ok) {
    const statusText = result.status ? ` HTTP ${result.status}.` : '';
    throw new Error(`Не удалось прочитать Google Doc.${statusText} Можно скопировать текст в source.txt и запустить скрипт с путём к файлу.`);
  }

  return result.text;
}

async function getChatGptInput(page, timeout = 30000) {
  const selectors = [
    '#prompt-textarea',
    'textarea[data-testid="prompt-textarea"]',
    'textarea[placeholder*="Message" i]',
    'textarea[placeholder*="Сообщ" i]',
    'div[contenteditable="true"][id="prompt-textarea"]',
    'div.ProseMirror[contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]'
  ];

  const started = Date.now();

  while (Date.now() - started < timeout) {
    for (const selector of selectors) {
      const candidates = page.locator(selector);
      const count = await candidates.count().catch(() => 0);
      if (!count) continue;

      for (let i = count - 1; i >= 0; i--) {
        const locator = candidates.nth(i);
        const visible = await locator.isVisible().catch(() => false);
        const box = await locator.boundingBox().catch(() => null);
        if (visible && box && box.width > 5 && box.height > 5) return locator;
      }
    }

    await page.waitForTimeout(500);
  }

  throw new Error('Поле ввода ChatGPT не найдено. Возможно, нужно войти в аккаунт или принять стартовые окна.');
}

async function waitForChatGptInput(page, rl) {
  await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });

  try {
    await getChatGptInput(page, 30000);
    return;
  } catch (err) {
    console.log('\nНе вижу поле ввода ChatGPT. Проверь, что ты залогинен в нужном аккаунте.');
    await rl.question('Сделай это в открытом браузере, потом нажми Enter в терминале...');
    await getChatGptInput(page, 60000);
  }
}

async function focusChatGptComposer(page) {
  await page.bringToFront().catch(() => {});
  await page.keyboard.press(`${MOD}+End`).catch(() => {});
  await page.waitForTimeout(300);

  const input = await getChatGptInput(page, 60000);

  try {
    await input.scrollIntoViewIfNeeded({ timeout: 5000 });
  } catch (err) {}

  try {
    await input.click({ timeout: 5000 });
    await page.waitForTimeout(200);
    return;
  } catch (err) {}

  const box = await input.boundingBox().catch(() => null);
  if (box) {
    await page.mouse.click(box.x + Math.min(box.width / 2, box.width - 2), box.y + Math.min(box.height / 2, box.height - 2));
    await page.waitForTimeout(200);
    return;
  }

  await input.evaluate(el => {
    if (typeof el.focus === 'function') el.focus();
  }).catch(() => {});
  await page.waitForTimeout(200);
}

async function getChatGptComposerText(page) {
  const input = await getChatGptInput(page, 10000);
  return await input.evaluate(el => {
    if ('value' in el) return el.value || '';
    return el.innerText || el.textContent || '';
  }).catch(() => '');
}

async function clickChatGptNewChat(page) {
  const selectors = [
    'a[href="/"]',
    'a[aria-label*="New chat" i]',
    'button[aria-label*="New chat" i]',
    'a[aria-label*="Новый чат" i]',
    'button[aria-label*="Новый чат" i]',
    'a:has-text("New chat")',
    'button:has-text("New chat")',
    'a:has-text("Новый чат")',
    'button:has-text("Новый чат")'
  ];

  for (const selector of selectors) {
    const element = page.locator(selector).first();
    if (await element.count().catch(() => 0)) {
      if (await element.isVisible().catch(() => false)) {
        await element.click().catch(() => {});
        await page.waitForTimeout(1500);
        return;
      }
    }
  }

  await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

async function writeClipboard(page, text) {
  await page.evaluate(async value => {
    await navigator.clipboard.writeText(value);
  }, text);
}

async function pasteOrTypeText(page, text) {
  try {
    await writeClipboard(page, text);
    await page.keyboard.press(`${MOD}+V`);
  } catch (err) {
    await page.keyboard.insertText(text);
  }
}

async function pasteTextIntoChatGpt(page, text) {
  await focusChatGptComposer(page);
  await pasteOrTypeText(page, text);
  await page.waitForTimeout(700);

  let composerText = await getChatGptComposerText(page);
  if (normalizeText(composerText)) return;

  await focusChatGptComposer(page);
  await page.keyboard.insertText(text);
  await page.waitForTimeout(700);

  composerText = await getChatGptComposerText(page);
  if (!normalizeText(composerText)) {
    throw new Error('Не удалось вставить текст в поле ввода ChatGPT.');
  }
}

async function clickChatGptSendButton(page) {
  const selectors = [
    'button[data-testid="send-button"]',
    'button[aria-label*="Send" i]',
    'button[aria-label*="Отправ" i]',
    'button[title*="Send" i]',
    'button:has-text("Send")',
    'button:has-text("Отправить")'
  ];

  const started = Date.now();
  const timeout = 10000;

  while (Date.now() - started < timeout) {
    for (const selector of selectors) {
      const buttons = page.locator(selector);
      const count = await buttons.count().catch(() => 0);

      for (let i = count - 1; i >= 0; i--) {
        const button = buttons.nth(i);
        const visible = await button.isVisible().catch(() => false);
        const enabled = await button.isEnabled().catch(() => false);
        if (!visible || !enabled) continue;

        try {
          await button.click({ timeout: 3000 });
          await page.waitForTimeout(500);
          return true;
        } catch (err) {}
      }
    }

    await page.waitForTimeout(300);
  }

  return false;
}

async function submitChatGptMessage(page) {
  if (await clickChatGptSendButton(page)) return;

  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);

  if (await clickChatGptSendButton(page)) return;

  await page.keyboard.press(`${MOD}+Enter`).catch(() => {});
}

async function getChatGptResponses(page) {
  return await page.evaluate(() => {
    const selectors = [
      '[data-message-author-role="assistant"]',
      '[data-testid^="conversation-turn-"] [data-message-author-role="assistant"]',
      'article:has([data-message-author-role="assistant"])'
    ];

    const items = [];
    const seen = new Set();

    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        if (rect.width === 0 || rect.height === 0 || style.visibility === 'hidden' || style.display === 'none') continue;

        const text = (el.innerText || el.textContent || '').trim();
        if (!text || text.length < 2) continue;
        if (/^(you said|chatgpt said)$/i.test(text)) continue;
        if (seen.has(text)) continue;

        seen.add(text);
        items.push(text);
      }
    }

    return items;
  });
}

async function getChatGptResponseSnapshot(page) {
  const responses = await getChatGptResponses(page);
  return {
    count: responses.length,
    last: normalizeText(responses[responses.length - 1] || '')
  };
}

async function waitUntilChatGptNotGenerating(page) {
  const stopSelectors = [
    'button[data-testid="stop-button"]',
    'button[aria-label*="Stop" i]',
    'button[aria-label*="Останов" i]'
  ];

  for (let i = 0; i < 5; i++) {
    const isGenerating = await page.evaluate(selectors => {
      return selectors.some(selector => {
        const button = document.querySelector(selector);
        if (!button) return false;
        const rect = button.getBoundingClientRect();
        const disabled = button.disabled || button.getAttribute('aria-disabled') === 'true';
        return rect.width > 0 && rect.height > 0 && !disabled;
      });
    }, stopSelectors).catch(() => false);

    if (isGenerating) return false;
    await page.waitForTimeout(400);
  }

  return true;
}

function cleanChatGptAnswer(text) {
  let out = normalizeText(text)
    .replace(/^```[a-zа-яё-]*\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  out = out
    .replace(/^chatgpt\s*:\s*/i, '')
    .replace(/^translation\s*:\s*/i, '')
    .replace(/^перевод\s*:\s*/i, '')
    .trim();

  if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith('«') && out.endsWith('»'))) {
    out = out.slice(1, -1).trim();
  }

  return out;
}

async function sendChatGptTextOnce(page, text) {
  await waitBeforeChatGptRequest(page);
  await pasteTextIntoChatGpt(page, text);
  await submitChatGptMessage(page);
  lastChatGptSubmitAt = Date.now();
}

async function reloadChatGptChat(page) {
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(async () => {
    await page.goto(page.url(), { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  });
  await getChatGptInput(page, 60000);
  await page.waitForTimeout(1000);
}

async function waitForChatGptAnswer(page, before, rl) {
  let last = '';
  let stableRounds = 0;
  const started = Date.now();
  const maxWaitMs = 12 * 60 * 1000;
  let sawNewResponse = false;
  let loggedResponseStart = false;

  while (Date.now() - started < maxWaitMs) {
    const responses = await getChatGptResponses(page);
    const candidate = responses[responses.length - 1] || '';
    const normalizedCandidate = normalizeText(candidate);
    const hasNewResponse = normalizedCandidate && (
      responses.length > before.count ||
      normalizedCandidate !== before.last
    );

    if (hasNewResponse) {
      sawNewResponse = true;
      if (!loggedResponseStart) {
        console.log('ChatGPT начал отвечать, жду завершения...');
        loggedResponseStart = true;
      }

      if (candidate === last) stableRounds += 1;
      else stableRounds = 0;

      last = candidate;

      if (stableRounds >= CHATGPT_STABLE_ROUNDS && await waitUntilChatGptNotGenerating(page)) {
        return { status: 'ok', text: cleanChatGptAnswer(candidate) };
      }

      if (stableRounds >= CHATGPT_FORCE_STABLE_ROUNDS) {
        console.log('Ответ ChatGPT не меняется, забираю его и продолжаю...');
        return { status: 'ok', text: cleanChatGptAnswer(candidate) };
      }
    } else if (!sawNewResponse && Date.now() - started >= CHATGPT_NO_RESPONSE_RETRY_MS) {
      return { status: 'no-response', text: '' };
    }

    await page.waitForTimeout(1200);
  }

  console.log('\nОтвет ChatGPT долго не стабилизируется. Если в браузере ответ уже готов, можно продолжить вручную.');
  await rl.question('Нажми Enter, чтобы попробовать забрать последний видимый ответ...');

  const responses = await getChatGptResponses(page);
  const candidate = responses[responses.length - 1] || '';
  if (!candidate.trim()) throw new Error('Не удалось получить ответ ChatGPT.');
  return { status: 'ok', text: cleanChatGptAnswer(candidate) };
}

async function sendChatGptMessage(page, text, rl) {
  for (let attempt = 1; attempt <= CHATGPT_MAX_SEND_ATTEMPTS; attempt++) {
    const before = await getChatGptResponseSnapshot(page);

    console.log(`Отправляю в ChatGPT, попытка ${attempt}/${CHATGPT_MAX_SEND_ATTEMPTS}...`);
    await sendChatGptTextOnce(page, text);

    const result = await waitForChatGptAnswer(page, before, rl);
    if (result.status === 'ok') return result.text;

    console.log(`\nChatGPT не дал новый ответ за ${CHATGPT_NO_RESPONSE_RETRY_MS / 1000} секунд. Перезагружаю страницу и отправляю этот текст снова...`);
    await reloadChatGptChat(page);
  }

  throw new Error(`ChatGPT не дал ответ после ${CHATGPT_MAX_SEND_ATTEMPTS} попыток отправки.`);
}

function buildTranslatedDocument(parts, translatedParts) {
  const blocks = [];

  for (let i = 0; i < parts.length; i++) {
    const translation = normalizeText(translatedParts[i]);
    blocks.push(`${parts[i].number} ${parts[i].declaredCount}/${countChars(translation)}\n${translation}`);
  }

  return blocks.join('\n\n');
}

async function createGoogleDocWithText(context, title, mainText, chatUrl, rl) {
  const page = await context.newPage();
  await page.goto('https://docs.new', { waitUntil: 'domcontentloaded', timeout: 120000 });

  try {
    await page.waitForURL(/docs\.google\.com\/document\/d\//, { timeout: 60000 });
  } catch (err) {
    console.log('\nGoogle Docs не открыл новый документ. Возможно, нужно войти в Google.');
    await rl.question('Войди в Google/открой пустой документ, затем нажми Enter в терминале...');
  }

  const titleSelectors = [
    'input.docs-title-input',
    'input[aria-label*="Rename" i]',
    'input[aria-label*="Переименовать" i]'
  ];

  for (const selector of titleSelectors) {
    const input = page.locator(selector).first();
    if (await input.count().catch(() => 0)) {
      if (await input.isVisible().catch(() => false)) {
        await input.fill(title).catch(async () => {
          await input.click();
          await page.keyboard.press(`${MOD}+A`);
          await page.keyboard.type(title);
        });
        break;
      }
    }
  }

  await page.waitForTimeout(2000);

  const editorSelectors = [
    '.kix-appview-editor',
    '.kix-page-content-wrapper',
    'div[aria-label*="Document" i]',
    'div[aria-label*="Документ" i]'
  ];

  let focused = false;
  for (const selector of editorSelectors) {
    const editor = page.locator(selector).first();
    if (await editor.count().catch(() => 0)) {
      await editor.click({ force: true }).catch(() => {});
      focused = true;
      break;
    }
  }

  if (!focused) {
    await page.mouse.click(450, 450);
  }

  await page.waitForTimeout(500);
  try {
    await writeClipboard(page, mainText);
    await page.keyboard.press(`${MOD}+V`);
  } catch (err) {
    await page.keyboard.insertText(mainText);
  }
  await page.waitForTimeout(3000);

  await page.keyboard.press(`${MOD}+End`).catch(() => {});
  await page.waitForTimeout(500);
  await page.keyboard.press(`${MOD}+Enter`);
  await page.waitForTimeout(500);

  try {
    await writeClipboard(page, chatUrl);
    await page.keyboard.press(`${MOD}+V`);
  } catch (err) {
    await page.keyboard.insertText(chatUrl);
  }
  await page.waitForTimeout(5000);

  return page.url();
}

function buildSafeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
}

async function createBrowserSession(rl) {
  const cdpDefault = process.env.CDP_URL ? 'y' : 'n';
  const cdpAnswer = (await rl.question(`Использовать уже открытый Chrome через CDP? y/n [${cdpDefault}]: `)).trim().toLowerCase();
  const useCdp = cdpAnswer ? isYesAnswer(cdpAnswer) : cdpDefault === 'y';

  if (useCdp) {
    const cdpUrl = process.env.CDP_URL || DEFAULT_CDP_URL;
    const browser = await chromium.connectOverCDP(cdpUrl, { preserveBrowserDownloads: true });
    const context = browser.contexts()[0] || await browser.newContext();
    await openInitialBlankPage(context);
    return {
      context,
      close: async () => {
        await browser.close().catch(() => {});
      }
    };
  }

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    channel: 'chrome',
    viewport: { width: 1440, height: 950 },
    permissions: ['clipboard-read', 'clipboard-write']
  });

  await openInitialBlankPage(context);

  return {
    context,
    close: async () => {
      await context.close().catch(() => {});
    }
  };
}

async function openInitialBlankPage(context) {
  let pages = context.pages();
  let page = pages[0] || await context.newPage();

  await page.goto('about:blank').catch(() => {});

  pages = context.pages();
  for (const extraPage of pages) {
    if (extraPage !== page) await extraPage.close().catch(() => {});
  }

  await page.bringToFront().catch(() => {});
}

async function main() {
  const rl = readline.createInterface({ input, output });
  let browserSession;

  cleanupOnExit = async () => {
    await browserSession?.close().catch(() => {});
    rl.close();
  };

  try {
    await fs.mkdir(OUTPUT_DIR, { recursive: true });

    const sourceInput = (await rl.question('\nВставь URL/ID исходного Google Doc или путь к source.txt: ')).trim();
    const createDocsInput = (await rl.question('Создавать Google Doc автоматически? y/n [y]: ')).trim().toLowerCase();
    const shouldCreateGoogleDocs = !isNoAnswer(createDocsInput);

    browserSession = await createBrowserSession(rl);
    const context = browserSession.context;

    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://chatgpt.com' }).catch(() => {});
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://docs.google.com' }).catch(() => {});

    const sourceText = await readSourceText(context, sourceInput, rl);
    const parts = parseParts(sourceText);

    if (!parts.length) {
      throw new Error('Не нашёл части. Заголовки должны быть отдельными строками вида: 1 854/ или просто 1.');
    }

    console.log(`\nНайдено частей: ${parts.length}`);
    for (const part of parts) {
      const diff = part.sourceLength - part.declaredCount;
      console.log(`Часть ${part.number}: заголовок ${part.declaredCount}, фактически ${part.sourceLength}, разница ${diff}`);
    }

    const chatPage = await context.newPage();
    await waitForChatGptInput(chatPage, rl);
    await clickChatGptNewChat(chatPage);

    console.log('\nОтправляю основной промт...');
    await sendChatGptMessage(chatPage, ENGLISH_PROMPT, rl);

    const translatedParts = [];

    for (const part of parts) {
      console.log(`Перевожу часть ${part.number}/${parts.length}...`);
      const translated = await sendChatGptMessage(chatPage, part.text, rl);
      translatedParts.push(translated);
      console.log(`Готово: ${countChars(translated)} символов`);
    }

    const chatUrl = chatPage.url();
    const mainText = buildTranslatedDocument(parts, translatedParts);
    const finalText = `${mainText}\n\n\f\n${chatUrl}\n`;

    const filename = `${buildSafeFilename('Английский')}.txt`;
    const outputPath = path.join(OUTPUT_DIR, filename);
    await fs.writeFile(outputPath, finalText, 'utf8');

    let googleDocUrl = '';

    if (shouldCreateGoogleDocs) {
      console.log('Создаю Google Doc и вставляю перевод...');
      googleDocUrl = await createGoogleDocWithText(context, 'Английский', mainText, chatUrl, rl);
      console.log(`Google Doc: ${googleDocUrl}`);
    }

    const resultsPath = path.join(OUTPUT_DIR, 'english-chatgpt-result.json');
    await fs.writeFile(resultsPath, JSON.stringify({
      language: 'Английский',
      localFile: outputPath,
      chatGptUrl: chatUrl,
      googleDocUrl
    }, null, 2), 'utf8');

    console.log('\nГОТОВО.');
    console.log(`Файл: ${outputPath}`);
    console.log(`ChatGPT chat: ${chatUrl}`);
    if (googleDocUrl) console.log(`Google Doc: ${googleDocUrl}`);
    console.log(`JSON со ссылками: ${resultsPath}`);
  } finally {
    await cleanupOnExit();
  }
}

main().catch(err => {
  if (isCtrlCAbort(err)) {
    console.log('\nОстановлено пользователем.');
    process.exit(130);
  }

  console.error('\nОШИБКА:');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
