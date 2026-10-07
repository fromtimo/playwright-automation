import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

const LANGUAGES = [
  { no: 1, label: 'Болгарский', promptName: 'болгарский', aliases: ['1', 'болгарский', 'bg'] },
  { no: 2, label: 'Венгерский', promptName: 'венгерский', aliases: ['2', 'венгерский', 'hu'] },
  { no: 3, label: 'Вьетнамский', promptName: 'вьетнамский', aliases: ['3', 'вьетнамский', 'vi'] },
  { no: 4, label: 'Греческий', promptName: 'греческий', aliases: ['4', 'греческий', 'el'] },
  { no: 5, label: 'Индонезийский', promptName: 'индонезийский', aliases: ['5', 'индонезийский', 'индонез', 'id'] },
  { no: 6, label: 'Итальянский', promptName: 'итальянский', aliases: ['6', 'итальянский', 'it'] },
  { no: 7, label: 'Корейский', promptName: 'корейский', aliases: ['7', 'корейский', 'ko'] },
  { no: 8, label: 'Немецкий', promptName: 'немецкий', aliases: ['8', 'немецкий', 'de'] },
  { no: 9, label: 'Польский', promptName: 'польский', aliases: ['9', 'польский', 'pl'] },
  { no: 10, label: 'Румынский', promptName: 'румынский', aliases: ['10', 'румынский', 'ro'] },
  { no: 11, label: 'Сербский', promptName: 'сербский', aliases: ['11', 'сербский', 'sr'] },
  { no: 12, label: 'Тайский', promptName: 'тайский', aliases: ['12', 'тайский', 'th'] },
  { no: 13, label: 'Турецкий', promptName: 'турецкий', aliases: ['13', 'турецкий', 'tr'] },
  { no: 14, label: 'Финский', promptName: 'финский', aliases: ['14', 'финский', 'fi'] },
  { no: 15, label: 'Французский', promptName: 'французский', aliases: ['15', 'французский', 'fr'] },
  { no: 16, label: 'Хорватский', promptName: 'хорватский', aliases: ['16', 'хорватский', 'hr'] },
  { no: 17, label: 'Чешский', promptName: 'чешский', aliases: ['17', 'чешский', 'cs'] },
  { no: 18, label: 'Японский', promptName: 'японский', aliases: ['18', 'японский', 'ja'] },
  { no: 19, label: 'Албанский', promptName: 'албанский', aliases: ['19', 'албанский', 'sq'] },
  { no: 20, label: 'Грузинский', promptName: 'грузинский', aliases: ['20', 'грузинский', 'ka'] },
  { no: 21, label: 'Иврит', promptName: 'иврит', aliases: ['21', 'иврит', 'he', 'iw'] },
  { no: 22, label: 'Словацкий', promptName: 'словацкий', aliases: ['22', 'словацкий', 'sk'] },
  { no: 23, label: 'Шведский', promptName: 'шведский', aliases: ['23', 'шведский', 'sv'] },
  { no: 24, label: 'Бенгальский', promptName: 'бенгальский', aliases: ['24', 'бенгальский', 'bn'] },
  { no: 25, label: 'Малаялам', promptName: 'малаялам', aliases: ['25', 'малаялам', 'ml'] },
  { no: 26, label: 'Нидерландский', promptName: 'нидерландский', aliases: ['26', 'нидерландский', 'нидерланды', 'nl'] },
  { no: 27, label: 'Панджаби', promptName: 'панджаби (шахмукхи)', aliases: ['27', 'панджаби', 'паджамби', 'pa'] },
  { no: 28, label: 'Тамильский', promptName: 'тамильский', aliases: ['28', 'тамильский', 'ta'] },
  { no: 29, label: 'Телугу', promptName: 'телугу', aliases: ['29', 'телугу', 'te'] },
  { no: 30, label: 'Хинди', promptName: 'хинди', aliases: ['30', 'хинди', 'hi'] }
];

const PROFILE_DIR = path.resolve('app-data/chrome-profile');
const OUTPUT_DIR = path.resolve('app-data/output');
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const DEFAULT_CDP_URL = 'http://127.0.0.1:9222';
const GEMINI_BASE_URL = 'https://gemini.google.com/app';
const GEMINI_REQUEST_DELAY_MIN_MS = 2000;
const GEMINI_REQUEST_DELAY_MAX_MS = 5000;
const GEMINI_NO_RESPONSE_RETRY_MS = 40000;
const GEMINI_MAX_SEND_ATTEMPTS = 4;
const GEMINI_STABLE_ROUNDS = 4;
const GEMINI_PARTS_PER_CHAT = 12;

let lastGeminiSubmitAt = 0;
let isShuttingDown = false;
let cleanupOnExit = async () => {};
const geminiChatUrls = new WeakMap();

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

function cleanTranslatedText(text) {
  return normalizeText(text)
    .split('\n')
    .map(line => line
      .replace(/[ \t]+([,.;:!?])/g, '$1')
      .replace(/([([{])\s+/g, '$1')
      .replace(/\s+([)\]}])/g, '$1')
      .replace(/[ \t]{2,}/g, ' ')
      .trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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

async function waitBeforeGeminiRequest(page) {
  if (!lastGeminiSubmitAt) return;

  const delay = randomInt(GEMINI_REQUEST_DELAY_MIN_MS, GEMINI_REQUEST_DELAY_MAX_MS);
  console.log(`Пауза перед следующим запросом Gemini: ${(delay / 1000).toFixed(1)} сек.`);
  await page.waitForTimeout(delay);
}

function parseParts(rawText) {
  const text = String(rawText || '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const headerRe = /^\s*(\d+)\s+(\d+)\s*\/\s*$/;
  const parts = [];
  let current = null;

  for (const line of lines) {
    const match = line.match(headerRe);

    if (match) {
      if (current) pushPart(current, parts);
      current = {
        number: Number(match[1]),
        declaredCount: Number(match[2]),
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
    declaredCount: part.declaredCount,
    text,
    sourceLength: countChars(text)
  });
}

function buildPrompt(language) {
  if (language.no === 18) {
    return `Переведи следующий русский текст на японский язык без транскрипции.
Требования к переводу:
Перевод должен быть предназначен для дикторской озвучки.
Текст должен звучать естественно, понятно и привычно для носителей языка.
Можно немного менять порядок слов, грамматические конструкции и выражения, если это необходимо для естественности языка перевода.
Нельзя добавлять новые предложения, факты, объяснения, выводы, комментарии, оценки или художественные описания, которых нет в оригинальном тексте.
Нельзя расширять текст. Объём перевода должен соответствовать объёму оригинала.
Каждое предложение оригинала должно иметь соответствующее предложение в переводе. Не пропускай и не добавляй смысловые фрагменты.
Сохраняй исходную структуру текста и порядок предложений.
Не добавляй вступления или заключения.
Не делай текст более «эпичным», «красивым» или эмоциональным, чем оригинал.
Переводи только то, что написано в исходном тексте.
Особые правила:
Все числа, даты, размеры, цены, количество и порядковые номера записывай только словами на языке перевода, без арабских цифр.
Не используй цифры вида 1, 2, 3, 100, 500 и т.д.
Имена собственные и названия мест передавай в принятой форме языка перевода.
Термины переводи точно по смыслу.
Формат ответа:
Только перевод.
Не добавляй комментарии, пояснения, примечания, анализ или сообщения о выполненной работе.
Мой текст:`;
  }

  return `Я хочу, чтобы ты перевёл сценарий на ${language.promptName} ЯЗЫК, без транскрипции подходящий для дикторской озвучки. Перевод должен звучать просто, понятно и естественно для носителей языка. Можно немного менять слова и выражения, но не сильно, и только если это помогает сделать текст более лаконичным и правильным, но важно сохранить общий смысл.
Только перевод без комментария. Обязательное условие: все цифры и числа (включая даты, цены, количество и порядковые номера) записывай исключительно прописью (словами на языке перевода), без использования арабских цифр.

Мой текст:`;
}

function parseLanguages(inputText) {
  const tokens = String(inputText || '')
    .split(',')
    .map(x => x.trim().toLowerCase())
    .filter(Boolean);

  if (!tokens.length) throw new Error('Не указаны языки. Пример: 1,3,5');

  const selected = [];

  for (const token of tokens) {
    const found = LANGUAGES.find(lang => lang.aliases.includes(token));
    if (!found) throw new Error(`Не понял язык: ${token}`);
    if (!selected.some(lang => lang.no === found.no)) selected.push(found);
  }

  return selected;
}

function printLanguagesTable() {
  const columns = 3;
  const rows = Math.ceil(LANGUAGES.length / columns);
  const columnWidth = 25;

  console.log('\nДоступные языки:');
  console.log('------------------------------------------------------------');

  for (let row = 0; row < rows; row++) {
    const cells = [];

    for (let column = 0; column < columns; column++) {
      const language = LANGUAGES[row + column * rows];
      if (!language) continue;

      const cell = `${String(language.no).padStart(2, ' ')}. ${language.label}`;
      cells.push(cell.padEnd(columnWidth, ' '));
    }

    console.log(cells.join(''));
  }

  console.log('------------------------------------------------------------');
}

function parseGoogleDocId(value) {
  const text = String(value || '').trim();
  const match = text.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(text)) return text;
  return null;
}

function buildGeminiUrl(authUser) {
  const value = String(authUser || '').trim();
  if (!value) return GEMINI_BASE_URL;
  return `${GEMINI_BASE_URL}?authuser=${encodeURIComponent(value)}`;
}

function isGeminiConversationUrl(url) {
  try {
    return /^\/app\/[^/?#]+/.test(new URL(url).pathname);
  } catch (err) {
    return false;
  }
}

function rememberGeminiChatUrl(page) {
  const url = page.url();
  if (isGeminiConversationUrl(url)) {
    geminiChatUrls.set(page, url);
    return url;
  }
  return geminiChatUrls.get(page) || '';
}

async function waitForGeminiChatUrl(page, timeout = 5000) {
  const started = Date.now();

  while (Date.now() - started < timeout) {
    const url = rememberGeminiChatUrl(page);
    if (url) return url;
    await page.waitForTimeout(250);
  }

  return rememberGeminiChatUrl(page);
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

async function waitForGeminiInput(page, rl, geminiAuthUser) {
  await page.goto(buildGeminiUrl(geminiAuthUser), { waitUntil: 'domcontentloaded' });

  try {
    await getGeminiInput(page, 20000);
    return;
  } catch (err) {
    console.log('\nНе вижу поле ввода Gemini. Возможно, нужно войти в аккаунт или принять стартовые окна.');
    await rl.question('Сделай это в открытом браузере, потом нажми Enter в терминале...');
    await getGeminiInput(page, 60000);
  }
}

async function startGeminiChatForLanguage(page, language, rl, geminiAuthUser, startPartNumber) {
  const newChatUrl = buildGeminiUrl(geminiAuthUser);
  geminiChatUrls.delete(page);

  const suffix = startPartNumber ? ` для части ${startPartNumber}` : '';
  console.log(`Открываю новый чат Gemini${suffix}...`);
  console.log(`Аккаунт Gemini: ${newChatUrl}`);

  await page.goto(newChatUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

  try {
    await getGeminiInput(page, 20000);
  } catch (err) {
    console.log('\nНе вижу поле ввода Gemini. Возможно, нужно войти в аккаунт или принять стартовые окна.');
    await rl.question('Сделай это в открытом браузере, потом нажми Enter в терминале...');
    await getGeminiInput(page, 60000);
  }

  console.log('Отправляю основной промт...');
  await sendGeminiMessage(page, buildPrompt(language), rl);
}

async function getGeminiInput(page, timeout = 30000) {
  const selectors = [
    'rich-textarea div[contenteditable="true"]',
    'div.ql-editor[contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    'div[role="textbox"][contenteditable="true"]',
    'rich-textarea',
    'textarea[placeholder*="Gemini" i]',
    'textarea[placeholder*="Спросите" i]',
    'textarea'
  ];

  const started = Date.now();

  while (Date.now() - started < timeout) {
    for (const selector of selectors) {
      const candidates = page.locator(selector);
      const count = await candidates.count().catch(() => 0);
      if (!count) continue;

      // Идём с конца, потому что активный composer обычно последний на странице.
      for (let i = count - 1; i >= 0; i--) {
        const locator = candidates.nth(i);
        const visible = await locator.isVisible().catch(() => false);
        const box = await locator.boundingBox().catch(() => null);
        if (visible && box && box.width > 5 && box.height > 5) return locator;
      }
    }
    await page.waitForTimeout(500);
  }

  throw new Error('Поле ввода Gemini не найдено. Возможно, изменился интерфейс Gemini Web.');
}

async function focusGeminiComposer(page) {
  const input = await getGeminiInput(page, 60000);

  // В Gemini Web иногда настоящий textarea присутствует в DOM, но Playwright не может
  // кликнуть по нему как по обычному видимому элементу. Поэтому сначала пробуем
  // обычный клик, затем клик мышью по координатам, затем фокус через JS.
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

async function clickGeminiNewChat(page) {
  const selectors = [
    'a[aria-label*="New chat" i]',
    'button[aria-label*="New chat" i]',
    'a[aria-label*="Новый чат" i]',
    'button[aria-label*="Новый чат" i]',
    'button:has-text("New chat")',
    'button:has-text("Новый чат")',
    'a:has-text("New chat")',
    'a:has-text("Новый чат")'
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
    return;
  } catch (err) {
    // Fallback for cases where Chrome blocks clipboard access.
    // insertText is slower, but works without clipboard permissions.
    await page.keyboard.insertText(text);
  }
}

async function clickGeminiSendButton(page) {
  const selectors = [
    'button[aria-label*="Send" i]',
    'button[aria-label*="Отправ" i]',
    'button[aria-label*="Submit" i]',
    'button[title*="Send" i]',
    'button[title*="Отправ" i]',
    'button[data-testid*="send" i]',
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

    const clicked = await page.evaluate(() => {
      const needles = ['send', 'submit', 'отправ'];
      const buttons = [...document.querySelectorAll('button')].reverse();

      for (const button of buttons) {
        const label = [
          button.getAttribute('aria-label'),
          button.getAttribute('title'),
          button.textContent
        ].filter(Boolean).join(' ').toLowerCase();

        const disabled = button.disabled || button.getAttribute('aria-disabled') === 'true';
        const rect = button.getBoundingClientRect();
        const visible = rect.width > 0 && rect.height > 0;

        if (visible && !disabled && needles.some(needle => label.includes(needle))) {
          button.click();
          return true;
        }
      }

      return false;
    }).catch(() => false);

    if (clicked) {
      await page.waitForTimeout(500);
      return true;
    }

    await page.waitForTimeout(300);
  }

  return false;
}

async function submitGeminiMessage(page) {
  await focusGeminiComposer(page);

  if (await clickGeminiSendButton(page)) return;

  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);

  if (await clickGeminiSendButton(page)) return;

  await page.keyboard.press(`${MOD}+Enter`).catch(() => {});
}

async function sendGeminiTextOnce(page, text) {
  await waitBeforeGeminiRequest(page);
  await waitUntilGeminiReadyForNextMessage(page);
  await focusGeminiComposer(page);
  await pasteOrTypeText(page, text);
  await page.waitForTimeout(700);
  await submitGeminiMessage(page);
  await waitForGeminiChatUrl(page);
  lastGeminiSubmitAt = Date.now();
}

async function reloadGeminiChat(page) {
  const currentUrl = page.url();
  const chatUrl = rememberGeminiChatUrl(page);

  if (chatUrl && currentUrl !== chatUrl) {
    await page.goto(chatUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  } else if (chatUrl) {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(async () => {
      await page.goto(chatUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    });
  } else {
    console.log('\nНе вижу URL текущего чата Gemini. Не перезагружаю страницу, чтобы случайно не открыть новый чат.');
  }

  await getGeminiInput(page, 60000);
  await page.waitForTimeout(1000);
}

async function waitForGeminiAnswer(page, before, rl) {
  let last = '';
  let stableRounds = 0;
  const started = Date.now();
  const maxWaitMs = 8 * 60 * 1000;
  let sawNewResponse = false;
  let loggedResponseStart = false;

  while (Date.now() - started < maxWaitMs) {
    const responses = await getGeminiResponses(page);
    const candidate = responses[responses.length - 1] || '';
    const normalizedCandidate = normalizeText(candidate);
    const hasNewResponse = normalizedCandidate && (
      responses.length > before.count ||
      normalizedCandidate !== before.last
    );

    if (hasNewResponse) {
      sawNewResponse = true;
      if (!loggedResponseStart) {
        console.log('Gemini начал отвечать, жду завершения...');
        loggedResponseStart = true;
      }

      if (candidate === last) stableRounds += 1;
      else stableRounds = 0;

      last = candidate;

      if (stableRounds >= GEMINI_STABLE_ROUNDS && await waitUntilGeminiNotGenerating(page)) {
        return { status: 'ok', text: cleanGeminiAnswer(candidate) };
      }

    } else if (!sawNewResponse && Date.now() - started >= GEMINI_NO_RESPONSE_RETRY_MS) {
      return { status: 'no-response', text: '' };
    }

    await page.waitForTimeout(1200);
  }

  console.log('\nОтвет Gemini долго не стабилизируется. Если в браузере ответ уже готов, можно продолжить вручную.');
  await rl.question('Нажми Enter, чтобы попробовать забрать последний видимый ответ...');

  const responses = await getGeminiResponses(page);
  const candidate = responses[responses.length - 1] || '';
  if (!candidate.trim()) throw new Error('Не удалось получить ответ Gemini.');
  return { status: 'ok', text: cleanGeminiAnswer(candidate) };
}

async function sendGeminiMessage(page, text, rl) {
  for (let attempt = 1; attempt <= GEMINI_MAX_SEND_ATTEMPTS; attempt++) {
    const before = await getGeminiResponseSnapshot(page);

    console.log(`Отправляю в Gemini, попытка ${attempt}/${GEMINI_MAX_SEND_ATTEMPTS}...`);
    await sendGeminiTextOnce(page, text);

    const result = await waitForGeminiAnswer(page, before, rl);
    if (result.status === 'ok') {
      rememberGeminiChatUrl(page);
      return result.text;
    }

    console.log(`\nGemini не дал новый ответ за ${GEMINI_NO_RESPONSE_RETRY_MS / 1000} секунд. Перезагружаю страницу и отправляю эту часть снова...`);
    await reloadGeminiChat(page);
  }

  throw new Error(`Gemini не дал ответ после ${GEMINI_MAX_SEND_ATTEMPTS} попыток отправки.`);
}

async function getGeminiResponses(page) {
  return await page.evaluate(() => {
    const selectors = [
      'message-content',
      'model-response message-content',
      'model-response',
      '[data-testid="response"]',
      '.markdown'
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
        if (seen.has(text)) continue;

        seen.add(text);
        items.push(text);
      }
    }

    return items;
  });
}

async function getGeminiResponseSnapshot(page) {
  const responses = await getGeminiResponses(page);
  return {
    count: responses.length,
    last: normalizeText(responses[responses.length - 1] || '')
  };
}

async function waitUntilGeminiReadyForNextMessage(page, timeout = 120000) {
  const started = Date.now();

  while (Date.now() - started < timeout) {
    await getGeminiInput(page, 3000).catch(() => null);
    if (await waitUntilGeminiNotGenerating(page)) return;
    await page.waitForTimeout(1000);
  }

  throw new Error('Gemini всё ещё генерирует ответ. Не отправляю следующий текст, чтобы не сломать очередь.');
}

async function waitUntilGeminiNotGenerating(page) {
  const stopSelectors = [
    'button[aria-label*="Stop" i]',
    'button[aria-label*="Останов" i]',
    'button[aria-label*="Cancel" i]',
    'button[aria-label*="Прекрат" i]',
    'button[title*="Stop" i]',
    'button[title*="Останов" i]',
    'button[data-testid*="stop" i]'
  ];

  const busySelectors = [
    '[aria-busy="true"]',
    '[role="progressbar"]',
    'mat-progress-spinner',
    'mat-spinner'
  ];

  for (let i = 0; i < 5; i++) {
    const isGenerating = await page.evaluate(({ stopSelectors, busySelectors }) => {
      const isVisible = el => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };

      for (const selector of stopSelectors) {
        for (const button of document.querySelectorAll(selector)) {
          const disabled = button.disabled || button.getAttribute('aria-disabled') === 'true';
          if (isVisible(button) && !disabled) return true;
        }
      }

      for (const selector of busySelectors) {
        for (const el of document.querySelectorAll(selector)) {
          if (isVisible(el)) return true;
        }
      }

      return false;
    }, { stopSelectors, busySelectors }).catch(() => false);

    if (isGenerating) return false;
    await page.waitForTimeout(400);
  }

  return true;
}

function cleanGeminiAnswer(text) {
  let out = normalizeText(text)
    .replace(/^```[a-zа-яё-]*\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  // Gemini Web иногда добавляет служебные подписи интерфейса в innerText ответа.
  // Убираем их, чтобы в документ попадал только перевод.
  out = out
    .replace(/^ответ\s+gemini\s*/i, '')
    .replace(/^gemini\s+said\s*:?\s*/i, '')
    .replace(/^gemini\s*:\s*/i, '')
    .replace(/^перевод\s*:\s*/i, '')
    .trim();

  out = out
    .split('\n')
    .filter(line => !/^ответ\s+gemini\s*$/i.test(line.trim()))
    .filter(line => !/^gemini\s+said\s*:?\s*$/i.test(line.trim()))
    .join('\n')
    .trim();

  // Если Gemini случайно обернул весь ответ в кавычки.
  if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith('«') && out.endsWith('»'))) {
    out = out.slice(1, -1).trim();
  }

  return out;
}

function buildTranslatedDocument(parts, translatedParts) {
  const blocks = [];

  for (let i = 0; i < parts.length; i++) {
    const translation = cleanTranslatedText(translatedParts[i]);
    blocks.push(`${parts[i].number} ${parts[i].declaredCount}/${countChars(translation)}\n${translation}`);
  }

  return blocks.join('\n\n');
}

function buildSafeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
}

async function createGoogleDocWithText(context, title, mainText, geminiChatUrl, rl) {
  const page = await context.newPage();
  await page.goto('https://docs.new', { waitUntil: 'domcontentloaded' });

  try {
    await page.waitForURL(/docs\.google\.com\/document\/d\//, { timeout: 60000 });
  } catch (err) {
    console.log('\nGoogle Docs не открыл новый документ. Возможно, нужно войти в Google.');
    await rl.question('Войди в Google/открой пустой документ, затем нажми Enter в терминале...');
  }

  // Название документа.
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

  // Фокус в тело документа.
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

  // Пустая страница в конце и ссылка на чат Gemini.
  await page.keyboard.press(`${MOD}+End`).catch(() => {});
  await page.waitForTimeout(500);
  await page.keyboard.press(`${MOD}+Enter`);
  await page.waitForTimeout(500);

  const linkText = geminiChatUrl;
  try {
    await writeClipboard(page, linkText);
    await page.keyboard.press(`${MOD}+V`);
  } catch (err) {
    await page.keyboard.insertText(linkText);
  }
  await page.waitForTimeout(5000);

  return page.url();
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

    printLanguagesTable();

    const sourceInput = (await rl.question('\nВставь URL/ID исходного Google Doc или путь к source.txt: ')).trim();
    const languagesInput = await rl.question('Какие языки перевести? Через запятую, например 1,3,5: ');
    const createDocsInput = (await rl.question('Создавать Google Docs автоматически? y/n [y]: ')).trim().toLowerCase();
    const geminiAuthUser = (await rl.question('Google аккаунт для Gemini: 0=дефолтный, 1=второй, 2=третий, 3=четвёртый [0]: ')).trim() || '0';
    const shouldCreateGoogleDocs = !isNoAnswer(createDocsInput);

    const selectedLanguages = parseLanguages(languagesInput);

    browserSession = await createBrowserSession(rl);
    const context = browserSession.context;

    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://gemini.google.com' }).catch(() => {});
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://docs.google.com' }).catch(() => {});

    const sourceText = await readSourceText(context, sourceInput, rl);
    const parts = parseParts(sourceText);

    if (!parts.length) {
      throw new Error('Не нашёл части. Заголовки должны быть отдельными строками вида: 1 854/');
    }

    console.log(`\nНайдено частей: ${parts.length}`);
    for (const part of parts) {
      const diff = part.sourceLength - part.declaredCount;
      console.log(`Часть ${part.number}: заголовок ${part.declaredCount}, фактически ${part.sourceLength}, разница ${diff}`);
    }

    const results = [];

    for (const language of selectedLanguages) {
      console.log(`\n=== ${language.no}-${language.label}: старт ===`);

      const geminiPage = await context.newPage();
      await startGeminiChatForLanguage(geminiPage, language, rl, geminiAuthUser, parts[0]?.number);

      const translatedParts = [];

      for (let partIndex = 0; partIndex < parts.length; partIndex++) {
        const part = parts[partIndex];

        if (partIndex > 0 && partIndex % GEMINI_PARTS_PER_CHAT === 0) {
          await startGeminiChatForLanguage(geminiPage, language, rl, geminiAuthUser, part.number);
        }

        console.log(`Перевожу часть ${part.number}/${parts.length}...`);
        const translated = await sendGeminiMessage(geminiPage, part.text, rl);
        const cleanedTranslated = cleanTranslatedText(translated);
        translatedParts.push(cleanedTranslated);
        console.log(`Готово: ${countChars(cleanedTranslated)} символов`);
      }

      const geminiChatUrl = rememberGeminiChatUrl(geminiPage) || geminiPage.url();
      const mainText = buildTranslatedDocument(parts, translatedParts);
      const finalText = `${mainText}\n\n\f\n${geminiChatUrl}\n`;

      const filename = `${buildSafeFilename(language.label)}.txt`;
      const outputPath = path.join(OUTPUT_DIR, filename);
      await fs.writeFile(outputPath, finalText, 'utf8');

      let googleDocUrl = '';

      if (shouldCreateGoogleDocs) {
        console.log('Создаю Google Doc и вставляю перевод...');
        const title = language.label;
        googleDocUrl = await createGoogleDocWithText(context, title, mainText, geminiChatUrl, rl);
        console.log(`Google Doc: ${googleDocUrl}`);
      }

      results.push({
        language: `${language.no}-${language.label}`,
        localFile: outputPath,
        geminiChatUrl,
        googleDocUrl
      });

      await geminiPage.close().catch(() => {});
    }

    const resultsPath = path.join(OUTPUT_DIR, 'results.json');
    await fs.writeFile(resultsPath, JSON.stringify(results, null, 2), 'utf8');

    console.log('\nГОТОВО. Результаты:');
    for (const result of results) {
      console.log(`\n${result.language}`);
      console.log(`Файл: ${result.localFile}`);
      console.log(`Gemini chat: ${result.geminiChatUrl}`);
      if (result.googleDocUrl) console.log(`Google Doc: ${result.googleDocUrl}`);
    }

    console.log(`\nJSON со ссылками: ${resultsPath}`);

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
