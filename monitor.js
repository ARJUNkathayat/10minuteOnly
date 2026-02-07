require("dotenv").config();
const puppeteer = require("puppeteer");
const axios = require("axios");
const fs = require("fs");
const express = require("express");

/* ================== EXPRESS (MANDATORY FOR RENDER) ================== */
console.log("🔥 DEPLOY CHECK v3.1 — SELECTOR = rilrtl-products-list__link");


const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.status(200).send("SHEIN monitor running");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("🌐 Web service listening on port", PORT);
});

/* ================= CONFIG ================= */

const CONFIG = {
  MEN_URL:
    "https://sheinindia.in/sheinverse/c/sverse-5939-37961?query=%3Arelevance%3Agenderfilter%3AMen",
  WOMEN_URL:
    "https://sheinindia.in/sheinverse/c/sverse-5939-37961?query=%3Arelevance%3Agenderfilter%3AWomen",

  SNAPSHOT_COUNT: "count_snapshot.json",
  SNAPSHOT_MEN: "men_snapshot.json",

  INTERVAL_MS: 2* 60 * 1000,

  TG_MAX_LEN: 3800,
  TG_DELAY_MS: 800,
  TG_RETRY: 1,

  MAX_ITEMS_PER_ALERT: 25,
  MAX_SCROLLS: 30,
};

/* ================= GLOBAL LOCK ================= */

let isRunning = false;

/* ================= UTIL ================= */

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

/* ================= TELEGRAM ================= */

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
          { timeout: 15000 }
        );
        break;
      } catch (err) {
        attempts++;
        if (attempts > CONFIG.TG_RETRY) {
          console.error("❌ Telegram failed:", err.message);
        } else {
          await sleep(1000);
        }
      }
    }

    await sleep(CONFIG.TG_DELAY_MS);
  }
}

/* ================= BROWSER ================= */

async function launchBrowser() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  const page = await browser.newPage();

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
  );

  await page.setViewport({ width: 1366, height: 768 });

  return { browser, page };
}

/* ================= SCRAPERS ================= */

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

  await page.evaluate(async (MAX_SCROLLS) => {
    let last = 0;

    for (let i = 0; i < MAX_SCROLLS; i++) {
      window.scrollBy(0, 1200);
      await new Promise((r) => setTimeout(r, 700));

      const count = document.querySelectorAll(
        "a.rilrtl-products-list__link"
      ).length;

      if (count === last) break;
      last = count;
    }
  }, CONFIG.MAX_SCROLLS);

  return page.evaluate(() => {
    const products = [];

    document
      .querySelectorAll("a.rilrtl-products-list__link")
      .forEach((a) => {
        const href = a.href || "";
        const m = href.match(/\/p\/(\d+)/);
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

/* ================= MAIN LOGIC ================= */

async function runOnce() {
  if (isRunning) {
    console.log("⏳ Previous run active, skipping");
    return;
  }

  isRunning = true;
  console.log("🔄 Running SHEIN monitor By Arjun Kathayat…");

  let browser;

  try {
    const launched = await launchBrowser();
    browser = launched.browser;
    const page = launched.page;

    const prev = loadJSON(CONFIG.SNAPSHOT_COUNT, {});
    const menCount = await scrapeCount(page, CONFIG.MEN_URL);
    const womenCount = await scrapeCount(page, CONFIG.WOMEN_URL);

    const summary = `📦 SHEIN STOCK UPDATE

MEN: ${menCount} (+${Math.max(0, menCount - (prev.MEN || 0))})
WOMEN: ${womenCount} (+${Math.max(0, womenCount - (prev.WOMEN || 0))})

🕒 ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`;

    await sendTelegramBatched(summary);

    saveJSON(CONFIG.SNAPSHOT_COUNT, {
      MEN: menCount,
      WOMEN: womenCount,
    });

    const oldMen = loadJSON(CONFIG.SNAPSHOT_MEN, []);
    const newMen = await scrapeMenProducts(page);

    const oldIds = new Set(oldMen.map((p) => p.id));
    const added = newMen.filter((p) => !oldIds.has(p.id));

    saveJSON(CONFIG.SNAPSHOT_MEN, newMen);

    if (added.length) {
      let msg = `🆕 MEN STOCK ALERT (${added.length})\n\n`;

      added.slice(0, CONFIG.MAX_ITEMS_PER_ALERT).forEach((p, i) => {
        msg += `${i + 1}) ${p.title}\n${p.price}\n${p.link}\n\n`;
      });

      await sendTelegramBatched(msg);
      console.log(`🚨 MEN alert sent (${added.length})`);
    } else {
      console.log("ℹ️ No new MEN products");
    }
  } catch (err) {
    console.error("❌ Run error:", err.message);
  } finally {
    if (browser) await browser.close();
    isRunning = false;
  }
}

/* ================= SCHEDULER ================= */

setTimeout(runOnce, 15000); // first run after boot
setInterval(runOnce, CONFIG.INTERVAL_MS);
