require("dotenv").config();
const puppeteer = require("puppeteer");
const axios = require("axios");
const fs = require("fs");

// ================= CONFIG =================

const CONFIG = {
  MEN_URL:
    "https://sheinindia.in/sheinverse/c/sverse-5939-37961?query=%3Arelevance%3Agenderfilter%3AMen",
  WOMEN_URL:
    "https://sheinindia.in/sheinverse/c/sverse-5939-37961?query=%3Arelevance%3Agenderfilter%3AWomen",

  SNAPSHOT_COUNT: "count_snapshot.json",
  SNAPSHOT_MEN: "men_snapshot.json",

  INTERVAL_MS: 5 * 60 * 1000,

  // Telegram safety
  TG_MAX_LEN: 3800,
  TG_DELAY_MS: 800,
  MAX_ITEMS_PER_ALERT: 25,
};

// ================= TELEGRAM =================

async function sendTelegramBatched(text) {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;

  for (let i = 0; i < text.length; i += CONFIG.TG_MAX_LEN) {
    await axios.post(url, {
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text: text.slice(i, i + CONFIG.TG_MAX_LEN),
      disable_web_page_preview: true,
    });
    await new Promise((r) => setTimeout(r, CONFIG.TG_DELAY_MS));
  }
}

// ================= SNAPSHOT HELPERS =================

function loadJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ================= COUNT SCRAPER =================

async function scrapeCount(url) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox"],
  });

  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector(".length strong");

  const count = await page.evaluate(() => {
    const txt =
      document.querySelector(".length strong")?.innerText || "";
    const m = txt.match(/\d+/);
    return m ? Number(m[0]) : 0;
  });

  await browser.close();
  return count;
}

// ================= MEN PRODUCT SCRAPER =================

async function scrapeMenProducts() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox"],
  });

  const page = await browser.newPage();
  await page.goto(CONFIG.MEN_URL, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });

  await page.waitForSelector(
    "a.rilrtl-products-list__link.desktop"
  );

  // ReactVirtualized scroll
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let y = 0;
      const step = 900;
      const t = setInterval(() => {
        window.scrollBy(0, step);
        y += step;
        if (y > document.body.scrollHeight) {
          clearInterval(t);
          resolve();
        }
      }, 400);
    });
  });

  const products = await page.evaluate(() => {
    const out = [];
    document
      .querySelectorAll("a.rilrtl-products-list__link.desktop")
      .forEach((a) => {
        const href = a.href;
        const m = href.match(/\/p\/(\d+)_?/);
        if (!m) return;

        const id = m[1];
        const title =
          a.querySelector(".name")?.innerText?.trim() ||
          a.querySelector(".name")?.getAttribute("aria-label") ||
          "";
        const price =
          a.querySelector(".price strong")?.innerText || "";

        out.push({ id, title, price, link: href });
      });
    return out;
  });

  await browser.close();
  return products;
}

// ================= MAIN =================

async function runOnce() {

  console.log("🔄 Running SHEIN monitor By Arjun…");

  // -------- STOCK SUMMARY --------
  const prevCounts = loadJSON(CONFIG.SNAPSHOT_COUNT, {});
  const menCount = await scrapeCount(CONFIG.MEN_URL);
  const womenCount = await scrapeCount(CONFIG.WOMEN_URL);

  const menOld = prevCounts.MEN || 0;
  const womenOld = prevCounts.WOMEN || 0;

  const summaryMsg = `📦 SHEIN STOCK UPDATE (5 min)

MEN
Total: ${menCount}
Added: +${Math.max(0, menCount - menOld)}
Removed: -${Math.max(0, menOld - menCount)}

WOMEN
Total: ${womenCount}
Added: +${Math.max(0, womenCount - womenOld)}
Removed: -${Math.max(0, womenOld - womenCount)}

🕒 ${new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
  })}`;

  await sendTelegramBatched(summaryMsg);
  saveJSON(CONFIG.SNAPSHOT_COUNT, {
    MEN: menCount,
    WOMEN: womenCount,
  });

  // -------- MEN NEW PRODUCT ALERT --------
  const oldMen = loadJSON(CONFIG.SNAPSHOT_MEN, []);
  const newMen = await scrapeMenProducts();

  const oldIds = new Set(oldMen.map((p) => p.id));
  const added = newMen.filter((p) => !oldIds.has(p.id));

  saveJSON(CONFIG.SNAPSHOT_MEN, newMen);

  if (!added.length) {
    console.log("ℹ️ No new MEN products");
    return;
  }

  const sendList = added.slice(0, CONFIG.MAX_ITEMS_PER_ALERT);

  let alertMsg = `🆕 MEN STOCK ALERT 🚨

New Products Added: ${added.length}

`;

  sendList.forEach((p, i) => {
    alertMsg += `${i + 1}) ${p.title}\n${p.price}\n${p.link}\n\n`;
  });

  if (added.length > sendList.length) {
    alertMsg += `… and ${added.length - sendList.length} more\n\n`;
  }

  alertMsg += `🕒 ${new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
  })}`;

  await sendTelegramBatched(alertMsg);
  console.log(`🚨 MEN alert sent (${added.length})`);
}

// ================= SCHEDULER =================

runOnce();
setInterval(runOnce, CONFIG.INTERVAL_MS);
