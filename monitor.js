require("dotenv").config();
const puppeteer = require("puppeteer");
const axios = require("axios");
const fs = require("fs");

// ================= CONFIG =================

const CONFIG = {
  MEN_URL:
    "https://sheinindia.in/sheinverse/c/sverse-5939-37961?query=%3Arelevance%3Agenderfilter%3AMen",
  SNAPSHOT: "men_snapshot.json",
  INTERVAL_MS: 5 * 60 * 1000, // 5 min
  TG_MAX_LEN: 3800, // safe chunk
  TG_DELAY_MS: 800, // anti-flood
  MAX_ITEMS_PER_ALERT: 25, // safety cap
};

// ================= TELEGRAM =================

async function sendTelegramBatched(text) {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;

  for (let i = 0; i < text.length; i += CONFIG.TG_MAX_LEN) {
    const chunk = text.slice(i, i + CONFIG.TG_MAX_LEN);
    await axios.post(url, {
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text: chunk,
      disable_web_page_preview: true,
    });
    await new Promise((r) => setTimeout(r, CONFIG.TG_DELAY_MS));
  }
}

// ================= SNAPSHOT =================

function loadSnapshot() {
  try {
    if (!fs.existsSync(CONFIG.SNAPSHOT)) return [];
    const data = JSON.parse(fs.readFileSync(CONFIG.SNAPSHOT, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveSnapshot(data) {
  fs.writeFileSync(CONFIG.SNAPSHOT, JSON.stringify(data, null, 2));
}

// ================= SCRAPER (MEN ONLY) =================

async function scrapeMenProducts() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
  );

  await page.goto(CONFIG.MEN_URL, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });

  await page.waitForSelector(
    "a.rilrtl-products-list__link.desktop",
    { timeout: 60000 }
  );

  // ReactVirtualized deep scroll
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
          a.querySelector(".price strong")?.innerText?.trim() || "";

        out.push({ id, title, price, link: href });
      });
    return out;
  });

  await browser.close();
  return products;
}

// ================= MAIN =================

async function runOnce() {
  console.log("🔎 Checking MEN stock for new products…");

  const oldData = loadSnapshot();
  const newData = await scrapeMenProducts();

  const oldIds = new Set(oldData.map((p) => p.id));
  const added = newData.filter((p) => !oldIds.has(p.id));

  // Update snapshot FIRST TIME SAFE
  saveSnapshot(newData);

  if (!added.length) {
    console.log("ℹ️ No new MEN products");
    return;
  }

  // limit to avoid flood (still all detected internally)
  const sendList = added.slice(0, CONFIG.MAX_ITEMS_PER_ALERT);

  let message = `🆕 MEN STOCK ALERT 🚨

New Products Added: ${added.length}

`;

  sendList.forEach((p, i) => {
    message += `${i + 1}) ${p.title}\n${p.price}\n${p.link}\n\n`;
  });

  if (added.length > sendList.length) {
    message += `… and ${added.length - sendList.length} more\n\n`;
  }

  message += `🕒 ${new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
  })}`;

  await sendTelegramBatched(message);
  console.log(`✅ Alert sent (${added.length} new MEN products)`);
}

// ================= SCHEDULER =================

runOnce();
setInterval(runOnce, CONFIG.INTERVAL_MS);
