require("dotenv").config();

const puppeteer = require("puppeteer");
const axios = require("axios");
const fs = require("fs");
const express = require("express");

// ================= KEEP ALIVE SERVER =================

const app = express();
const PORT = process.env.PORT || 10000;

app.get("/", (req, res) => {
  res.send("Shein Stock Bot Running");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("✅ Keep-alive server running on port", PORT);
});

// ================= CONFIG =================

const CONFIG = {
  categories: [
    {
      key: "MEN_ALL",
      label: "MEN (All Products)",
      url: "https://sheinindia.in/sheinverse/c/sverse-5939-37961?query=%3Arelevance%3Agenderfilter%3AMen",
    },
    {
      key: "MEN_FILTERED",
      label: "MEN (L, XL, 28, 30, 32)",
      url: "https://sheinindia.in/sheinverse/c/sverse-5939-37961?query=%3Arelevance%3Agenderfilter%3AMen%3Averticalsizegroupformat%3AL%3Averticalsizegroupformat%3AXL%3Averticalsizegroupformat%3A28%3Averticalsizegroupformat%3A30%3Averticalsizegroupformat%3A32&gridColumns=5",
    },
  ],

  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,

  snapshotFile: "stock.json",

  maxRetries: 2,
  retryDelay: 6000,

  normalUpdateLinks: 12,
  maxLinksPerCategory: 8,
  scrapeCooldownMs: 5000,

  categorySendThreshold: 5,
};

// ================= TELEGRAM =================

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${CONFIG.telegramBotToken}/sendMessage`;
  const MAX_LEN = 3800;

  const chunks = [];
  for (let i = 0; i < text.length; i += MAX_LEN) {
    chunks.push(text.slice(i, i + MAX_LEN));
  }

  for (const chunk of chunks) {
    await axios.post(url, {
      chat_id: CONFIG.telegramChatId,
      text: chunk,
      disable_web_page_preview: true,
    });
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log("✅ Telegram sent");
}

// ================= SNAPSHOT =================

function loadSnapshot() {
  try {
    if (!fs.existsSync(CONFIG.snapshotFile)) return {};
    return JSON.parse(fs.readFileSync(CONFIG.snapshotFile, "utf8"));
  } catch {
    return {};
  }
}

function saveSnapshot(data) {
  fs.writeFileSync(CONFIG.snapshotFile, JSON.stringify(data, null, 2));
}

// ================= SCRAPER =================

async function scrapeCategory(category, retry = 0) {
  let browser;

  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--no-zygote",
        "--single-process",
      ],
    });

    const page = await browser.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
    );

    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const type = req.resourceType();
      if (["image", "font", "media", "stylesheet"].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setViewport({ width: 1200, height: 720 });

    console.log(`🌐 Opening ${category.label}`);
    await page.goto(category.url, {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });

    // wait for product anchors
    await page.waitForSelector("a[href*='/product']", {
      timeout: 60000,
    });

    // ✅ Auto scroll to load lazy items
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let totalHeight = 0;
        const distance = 600;
        const timer = setInterval(() => {
          window.scrollBy(0, distance);
          totalHeight += distance;

          if (totalHeight >= document.body.scrollHeight) {
            clearInterval(timer);
            resolve();
          }
        }, 400);
      });
    });

    await new Promise((r) => setTimeout(r, 2000));

    // ✅ Robust extraction
    const data = await page.evaluate(() => {
      const countText =
        document.querySelector(".length strong")?.innerText || "";
      const totalItems = parseInt(countText.match(/\d+/)?.[0] || "0");

      const anchors = Array.from(
        document.querySelectorAll("a[href*='/product']")
      );

      const products = anchors.map((a) => ({
        link: a.href,
        title: a.innerText?.trim() || "",
      }));

      return { totalItems, products };
    });

    console.log(
      `📦 ${category.key} -> total: ${data.totalItems}, scraped: ${data.products.length}`
    );

    await browser.close();

    if (!data.products.length) throw new Error("No products detected");

    return data;
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error(
      `❌ ${category.key} scrape failed (${retry + 1}):`,
      err.message
    );

    if (retry < CONFIG.maxRetries) {
      await new Promise((r) => setTimeout(r, CONFIG.retryDelay));
      return scrapeCategory(category, retry + 1);
    }

    throw err;
  }
}

// ================= DIFF =================

function calculateDiff(oldCount, newCount) {
  return {
    added: Math.max(0, newCount - oldCount),
    removed: Math.max(0, oldCount - newCount),
  };
}

// ================= CATEGORY FILTER =================

function classifyProducts(products) {
  const buckets = {
    tshirt: [],
    hoodie: [],
    sweatshirt: [],
    cardigan: [],
    jeans: [],
    pants: [],
    trouser: [],
    trackpant: [],
    pyjama: [],
  };

  for (const p of products) {
    if (!p.link) continue;
    const name = p.title.toLowerCase();

    if (name.includes("t-shirt") || name.includes("tshirt"))
      buckets.tshirt.push(p.link);
    if (name.includes("hoodie")) buckets.hoodie.push(p.link);
    if (name.includes("sweatshirt")) buckets.sweatshirt.push(p.link);
    if (name.includes("cardigan")) buckets.cardigan.push(p.link);
    if (name.includes("jean")) buckets.jeans.push(p.link);
    if (name.includes("pant") && !name.includes("trackpant"))
      buckets.pants.push(p.link);
    if (name.includes("trouser")) buckets.trouser.push(p.link);
    if (name.includes("trackpant") || name.includes("track pant"))
      buckets.trackpant.push(p.link);
    if (name.includes("pyjama") || name.includes("pajama"))
      buckets.pyjama.push(p.link);
  }

  return buckets;
}

// ================= MAIN =================

async function runOnce() {
  console.log("🚀 STOCK MONITOR RUN");

  const snapshot = loadSnapshot();
  const newSnapshot = {};

  let menSection = "";
  let filteredSection = "";

  let filteredProducts = [];
  let filteredTotal = 0;

  const results = [];

  for (const category of CONFIG.categories) {
    try {
      const data = await scrapeCategory(category);
      results.push({ status: "fulfilled", value: data });
    } catch (err) {
      results.push({ status: "rejected", reason: err });
    }

    await new Promise((r) =>
      setTimeout(r, CONFIG.scrapeCooldownMs)
    );
  }

  CONFIG.categories.forEach((category, index) => {
    const result = results[index];
    if (result.status !== "fulfilled") return;

    const current = result.value;
    const previous = snapshot[category.key];

    let added = 0;
    let removed = 0;

    if (previous?.totalItems !== undefined) {
      const diff = calculateDiff(
        previous.totalItems,
        current.totalItems
      );
      added = diff.added;
      removed = diff.removed;
    }

    newSnapshot[category.key] = {
      totalItems: current.totalItems,
      products: current.products,
      time: Date.now(),
    };

    if (category.key === "MEN_ALL") {
      menSection = `1️⃣ MEN (All Products)
Total: ${current.totalItems}
Added: +${added}
Removed: -${removed}`;
    }

    if (category.key === "MEN_FILTERED") {
      filteredProducts = current.products || [];
      filteredTotal = current.totalItems;

      filteredSection = `2️⃣ MEN (Filtered)
Total: ${current.totalItems}
Added: +${added}
Removed: -${removed}`;
    }
  });

  saveSnapshot(newSnapshot);

  // ================= NORMAL UPDATE =================

  const linksSource = filteredProducts.length
    ? filteredProducts
    : snapshot["MEN_ALL"]?.products || [];

  const normalLinks = linksSource
    .slice(0, CONFIG.normalUpdateLinks)
    .map((p) => `• ${p.link}`)
    .join("\n");

  const time = new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
  });

  const message = `📦 SHEIN STOCK UPDATE

${menSection}

${filteredSection}

🔗 Top Links:
${normalLinks || "No links found"}

Updated: ${time}`;

  await sendTelegram(message);

  // ================= CATEGORY SPLIT =================

  if (filteredTotal >= CONFIG.categorySendThreshold) {
    console.log(`✅ Sending category split messages`);

    const buckets = classifyProducts(filteredProducts);

    const categoryMessages = [
      { title: "T-SHIRTS", data: buckets.tshirt },
      { title: "HOODIES", data: buckets.hoodie },
      { title: "SWEATSHIRTS", data: buckets.sweatshirt },
      { title: "CARDIGANS", data: buckets.cardigan },
      { title: "JEANS", data: buckets.jeans },
      { title: "PANTS", data: buckets.pants },
      { title: "TROUSERS", data: buckets.trouser },
      { title: "TRACKPANTS", data: buckets.trackpant },
      { title: "PYJAMA", data: buckets.pyjama },
    ];

    for (const cat of categoryMessages) {
      if (!cat.data.length) continue;

      const links = cat.data
        .slice(0, CONFIG.maxLinksPerCategory)
        .map((l) => `• ${l}`)
        .join("\n");

      const msg = `${cat.title} (${cat.data.length} products)

${links}`;

      await sendTelegram(msg);
    }
  }
}

// ================= SCHEDULER =================

runOnce();
setInterval(runOnce, 10 * 60 * 1000); // every 10 minutes
