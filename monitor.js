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

  INTERVAL_MS: 8 * 60 * 1000,

  TG_MAX_LEN: 3800,
  TG_DELAY_MS: 800,
  TG_RETRY: 1,

  MAX_ITEMS_PER_ALERT: 25,
  MAX_SCROLLS: 30,
};

// ================= GLOBAL LOCK =================

let isRunning = false;

// ================= UTIL =================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// ================= TELEGRAM =================

async function sendTelegramBatched(text) {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;

  for (let i = 0; i < text.length; i += CONFIG.TG_MAX_LEN) {
    let attempts = 0;
    while (attempts <= CONFIG.TG_RETRY) {
      try {
        await axios.post(
          url,
          {
            chat_id: process.env.TELEGRAM_CHAT_ID,
            text: text.slice(i, i + CONFIG.TG_MAX_LEN),
            disable_web_page_preview: true,
          },
          { timeout: 10000 }
        );
        break;
      } catch (err) {
        attempts++;
        if (attempts > CONFIG.TG_RETRY) {
          console.error("❌ Telegram send failed:", err.message);
        } else {
          await sleep(1000);
        }
      }
    }
    await sleep(CONFIG.TG_DELAY_MS);
  }
}

// ================= BROWSER =================

async function launchBrowser() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
  );

  await page.setViewport({ width: 1366, height: 768 });

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", {
      get: () => false,
    });
  });

  return { browser, page };
}

// ================= SCRAPERS =================

async function scrapeCount(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

  await page.waitForFunction(
    () =>
      document.querySelector(".length strong") ||
      document.querySelector("[data-test='product-count']"),
    { timeout: 30000 }
  );

  return page.evaluate(() => {
    const el =
      document.querySelector(".length strong") ||
      document.querySelector("[data-test='product-count']");
    const txt = el?.innerText || "";
    const m = txt.match(/\d+/);
    return m ? Number(m[0]) : 0;
  });
}

async function scrapeMenProducts(page) {
  await page.goto(CONFIG.MEN_URL, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });

  await page.waitForSelector("a.rilrtl-products-list__link", {
    timeout: 30000,
  });

  await page.evaluate(
    async (MAX_SCROLLS) => {
      let lastCount = 0;
      let scrolls = 0;

      while (scrolls < MAX_SCROLLS) {
        window.scrollBy(0, 1200);
        await new Promise((r) => setTimeout(r, 700));

        const currentCount = document.querySelectorAll(
          "a.rilrtl-products-list__link"
        ).length;

        if (currentCount === lastCount) break;

        lastCount = currentCount;
        scrolls++;
      }
    },
    CONFIG.MAX_SCROLLS
  );

  return page.evaluate(() => {
    const products = [];
    document
      .querySelectorAll("a.rilrtl-products-list__link")
      .forEach((a) => {
        const href = a.href || "";
        const m = href.match(/\/p\/(\d+)_?/);
        if (!m) return;

        products.push({
          id: m[1],
          title:
            a.querySelector(".name")?.innerText?.trim() ||
            a.querySelector(".name")?.getAttribute("aria-label") ||
            "",
          price:
            a.querySelector(".price strong")?.innerText ||
            a.querySelector(".price")?.innerText ||
            "",
          link: href,
        });
      });

    return products;
  });
}

// ================= MAIN RUN =================

async function runOnce() {
  if (isRunning) {
    console.log("⏳ Previous run still active, skipping...");
    return;
  }

  isRunning = true;
  console.log("🔄 Running SHEIN monitor…");

  const { browser, page } = await launchBrowser();

  try {
    // ---- COUNT SUMMARY ----
    const prevCounts = loadJSON(CONFIG.SNAPSHOT_COUNT, {});
    const menCount = await scrapeCount(page, CONFIG.MEN_URL);
    const womenCount = await scrapeCount(page, CONFIG.WOMEN_URL);

    const summaryMsg = `📦 SHEIN STOCK UPDATE (5 min)

MEN
Total: ${menCount}
Added: +${Math.max(0, menCount - (prevCounts.MEN || 0))}
Removed: -${Math.max(0, (prevCounts.MEN || 0) - menCount)}

WOMEN
Total: ${womenCount}
Added: +${Math.max(0, womenCount - (prevCounts.WOMEN || 0))}
Removed: -${Math.max(0, (prevCounts.WOMEN || 0) - womenCount)}

🕒 ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`;

    await sendTelegramBatched(summaryMsg);

    saveJSON(CONFIG.SNAPSHOT_COUNT, {
      MEN: menCount,
      WOMEN: womenCount,
    });

    // ---- MEN NEW PRODUCTS ----
    const oldMen = loadJSON(CONFIG.SNAPSHOT_MEN, []);
    const newMen = await scrapeMenProducts(page);

    const oldIds = new Set(oldMen.map((p) => p.id));
    const added = newMen.filter((p) => !oldIds.has(p.id));

    saveJSON(CONFIG.SNAPSHOT_MEN, newMen);

    if (!added.length) {
      console.log("ℹ️ No new MEN products");
      return;
    }

    let alertMsg = `🆕 MEN STOCK ALERT 🚨

New Products Added: ${added.length}

`;

    added.slice(0, CONFIG.MAX_ITEMS_PER_ALERT).forEach((p, i) => {
      alertMsg += `${i + 1}) ${p.title}
${p.price}
${p.link}

`;
    });

    if (added.length > CONFIG.MAX_ITEMS_PER_ALERT) {
      alertMsg += `… and ${
        added.length - CONFIG.MAX_ITEMS_PER_ALERT
      } more\n\n`;
    }

    alertMsg += `🕒 ${new Date().toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
    })}`;

    await sendTelegramBatched(alertMsg);
    console.log(`🚨 MEN alert sent (${added.length})`);
  } catch (err) {
    console.error("❌ Run error:", err.message);
  } finally {
    await browser.close();
    isRunning = false;
  }
}

// ================= SCHEDULER =================

(async () => {
  await runOnce();

  setInterval(() => {
    runOnce();
  }, CONFIG.INTERVAL_MS);
})();
