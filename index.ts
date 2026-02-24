import puppeteer from "puppeteer";
import * as cheerio from "cheerio";
import fs from "fs-extra";
import path from "path";
import axios from "axios";
import { URL } from "url";
import { createInterface } from "node:readline/promises";

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

async function downloadAsset(url: string, targetPath: string) {
  try {
    const response = await axios.get(url, { responseType: "arraybuffer" });
    await fs.ensureDir(path.dirname(targetPath));
    await fs.writeFile(targetPath, response.data);
    return true;
  } catch (error) {
    console.error(
      `Failed to download asset: ${url}`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

async function main() {
  console.log("--- Website Downloader & Editor (Server-Side) ---\n");

  // 1. Ask for input using readline
  const websiteName = await rl.question("Enter website name (folder name): ");
  const targetUrl = await rl.question("Enter website URL: ");

  if (!websiteName || !targetUrl) {
    console.error("Website name and URL are required.");
    rl.close();
    process.exit(1);
  }

  const outputDir = path.join(process.cwd(), "webcode", websiteName);
  await fs.ensureDir(outputDir);

  console.log(`\nOpening ${targetUrl} in browser...`);

  // 2. Launch Puppeteer
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
  });

  const page = await browser.newPage();

  try {
    await page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 60000 });
  } catch (error) {
    console.error(
      "Failed to load page:",
      error instanceof Error ? error.message : error,
    );
    await browser.close();
    rl.close();
    process.exit(1);
  }

  // 3. Inject Content Editable (CRITICAL: This block is the ONLY part that runs inside the browser context)
  console.log("\n--- READY FOR EDITING ---");
  console.log("1. Edit any text directly in the opened browser window.");
  console.log("2. When finished, return to this terminal and press ENTER.");

  await page.evaluate(() => {
    /* 
       BROWSER-SIDE CODE BEGINS HERE
       This code is serialized and sent to the browser.
    */

    // 1. Enable editing
    document.body.contentEditable = "true";

    // 2. STOP LAGGING - Neutralize background activities
    console.log("Optimizing editor performance...");

    // Stop all intervals
    const maxIntervalId = window.setInterval(() => {}, 9999);
    for (let i = 1; i < maxIntervalId; i++) window.clearInterval(i);

    // Stop all timeouts (that haven't fired yet)
    const maxTimeoutId = window.setTimeout(() => {}, 9999);
    for (let i = 1; i < maxTimeoutId; i++) window.clearTimeout(i);

    // Disable CSS animations and transitions
    const style = document.createElement("style");
    style.innerHTML = `
      * {
        transition: none !important;
        animation: none !important;
      }
    `;
    document.head.appendChild(style);

    // Stop requestAnimationFrame loops
    window.requestAnimationFrame = () => 0;

    // Optional: Stop MutationObservers if we wanted to be extreme

    // 3. Add notification
    const toast = document.createElement("div");
    toast.id = "editor-toast-notification";
    Object.assign(toast.style, {
      position: "fixed",
      bottom: "20px",
      right: "20px",
      backgroundColor: "#333",
      color: "#fff",
      padding: "10px 20px",
      borderRadius: "5px",
      zIndex: "999999",
      fontFamily: "sans-serif",
      boxShadow: "0 2px 10px rgba(0,0,0,0.5)",
      pointerEvents: "none",
    });
    toast.innerText =
      "Performance Mode Active. LAG REDUCED. Press ENTER in terminal to save.";
    document.body.appendChild(toast);
  });

  // Wait for user to press ENTER in terminal
  await rl.question("\nPress ENTER to save and download the edited code...");

  console.log("\nExtracting and localizing assets...");

  // 4. Extract HTML (Server-side extraction)
  const htmlContent = await page.content();
  const $ = cheerio.load(htmlContent);

  // Remove the injected toast before saving
  $("#editor-toast-notification").remove();

  const baseUrl = new URL(targetUrl);
  const assetTasks: Promise<boolean>[] = [];

  // Helper to process tags (Server-side logic)
  async function processResource(selector: string, attr: string) {
    const elements = $(selector).toArray();
    for (const el of elements) {
      const originalSrc = $(el).attr(attr);
      if (
        !originalSrc ||
        originalSrc.startsWith("data:") ||
        originalSrc.startsWith("mailto:") ||
        originalSrc.startsWith("tel:")
      )
        continue;

      try {
        const absoluteUrl = new URL(originalSrc, baseUrl.href).href;
        const parsedUrl = new URL(absoluteUrl);

        // --- DOMAIN VALIDATION ---
        // If the asset is from a different domain, we skip it as per requirements.
        if (parsedUrl.hostname !== baseUrl.hostname) {
          // console.log(`Skipping external resource: ${absoluteUrl}`);
          continue;
        }

        const urlPath = parsedUrl.pathname;

        // Calculate the base directory of the target URL to make assets relative to it.
        // If the path doesn't end in '/' and doesn't have an extension, we treat it as a directory.
        let targetUrlDir = baseUrl.pathname;
        if (!targetUrlDir.endsWith("/")) {
          const extension = path.extname(targetUrlDir);
          if (!extension) {
            targetUrlDir += "/";
          } else {
            targetUrlDir = path.dirname(targetUrlDir);
            if (!targetUrlDir.endsWith("/")) targetUrlDir += "/";
          }
        }

        let localPath: string;
        if (urlPath.startsWith(targetUrlDir)) {
          // Asset is inside or below the target directory, make it relative
          localPath = urlPath.slice(targetUrlDir.length);
        } else {
          // Asset is elsewhere on the same domain - preserve its full path structure
          localPath = urlPath.startsWith("/") ? urlPath.substring(1) : urlPath;
        }

        // If localPath is empty (e.g., fetching the page itself/root), give it a fallback
        if (!localPath || localPath === "" || localPath === "/") {
          localPath =
            "assets/resource_" + Math.random().toString(36).substring(7);
        }

        // Ensure extension
        const ext = path.extname(localPath);
        if (!ext) {
          if (selector === "img") localPath += ".png";
          else if (selector === "script") localPath += ".js";
          else if (selector === "link") localPath += ".css";
        }

        const fullLocalPath = path.join(outputDir, localPath);

        // Update HTML to point to local relative path
        $(el).attr(attr, localPath);

        // Queue download
        assetTasks.push(downloadAsset(absoluteUrl, fullLocalPath));
      } catch (e) {
        console.warn(`Skipping invalid URL: ${originalSrc}`);
      }
    }
  }

  // Process Images, Scripts, Styles
  await processResource("img", "src");
  await processResource("script", "src");
  await processResource('link[rel="stylesheet"]', "href");
  await processResource('link[rel="icon"]', "href");
  await processResource('link[rel="shortcut icon"]', "href");
  await processResource("source", "src");
  await processResource("video", "src");

  // Wait for all downloads
  if (assetTasks.length > 0) {
    console.log(`Downloading ${assetTasks.length} assets...`);
    await Promise.all(assetTasks);
  }

  // Save modified HTML
  const finalHtml = $.html();
  await fs.writeFile(path.join(outputDir, "index.html"), finalHtml);

  console.log(
    `\nSuccess! Full website code stored inside: webcode/${websiteName}`,
  );

  await browser.close();
  rl.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("Critical Error:", err);
  process.exit(1);
});
