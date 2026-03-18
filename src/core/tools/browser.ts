import type { Browser, BrowserContext, Page } from "playwright";
import type { Tool, ToolParam, ToolResult } from "./types.js";

const MAX_TEXT_CHARS = 4000;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n\n[truncated, showing first ${max} of ${text.length} chars]`;
}

type BrowserAction = "get_text" | "screenshot" | "click" | "fill" | "evaluate";

const TIMEOUT = 30_000;

const PARAMETERS: ToolParam[] = [
  { name: "action", type: "string", description: "Action to perform: get_text, screenshot, click, fill, evaluate", required: true },
  { name: "url", type: "string", description: "URL to navigate to" },
  { name: "selector", type: "string", description: "CSS selector for click/fill actions" },
  { name: "value", type: "string", description: "Value for fill/search actions" },
  { name: "script", type: "string", description: "JavaScript to evaluate on the page" },
];

export class BrowserTool implements Tool {
  readonly name = "browser";
  readonly description = "Browse websites with a real browser (Playwright). Use when the 'web' tool can't access a site, or for interactive tasks like clicking and filling forms.";
  readonly parameters = PARAMETERS;

  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = params.action as BrowserAction | undefined;
    if (!action) {
      return { success: false, output: "", error: "Missing required parameter: action" };
    }

    try {
      const page = await this.getPage();

      switch (action) {
        case "get_text":
          return await this.getText(page, params.url as string | undefined);
        case "screenshot":
          return await this.screenshot(page, params.url as string | undefined);
        case "click":
          return await this.click(page, params.selector as string | undefined);
        case "fill":
          return await this.fill(page, params.selector as string | undefined, params.value as string | undefined);
        case "evaluate":
          return await this.evaluateScript(page, params.script as string | undefined);
        default:
          return { success: false, output: "", error: `Unknown action: ${action}` };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: "", error: message };
    }
  }

  async dispose(): Promise<void> {
    const browser = this.browser;
    this.page = null;
    this.context = null;
    this.browser = null;
    if (browser) {
      await browser.close();
    }
  }

  // ---- private ----------------------------------------------------------

  private async getPage(): Promise<Page> {
    if (this.page) return this.page;

    const { chromium } = await import("playwright");

    try {
      this.browser = await chromium.launch({ headless: true });
    } catch {
      // Chromium not installed — attempt auto-install
      const { execSync } = await import("child_process");
      execSync("npx playwright install chromium", { stdio: "pipe", timeout: 120_000 });
      this.browser = await chromium.launch({ headless: true });
    }

    this.context = await this.browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(TIMEOUT);
    return this.page;
  }

  private async getText(page: Page, url: string | undefined): Promise<ToolResult> {
    if (!url) return { success: false, output: "", error: "Missing required parameter: url" };
    await page.goto(url, { timeout: TIMEOUT, waitUntil: "load" });
    // Wait a bit for JS-rendered content (SPAs like Wildberries)
    await page.waitForTimeout(2000);
    const text = await page.textContent("body") ?? "";
    const cleaned = text.replace(/\s+/g, " ").trim();
    return { success: true, output: truncate(cleaned, MAX_TEXT_CHARS) };
  }

  private async screenshot(page: Page, url: string | undefined): Promise<ToolResult> {
    if (!url) return { success: false, output: "", error: "Missing required parameter: url" };
    await page.goto(url, { timeout: TIMEOUT, waitUntil: "load" });
    await page.waitForTimeout(2000);
    const buffer = await page.screenshot({ fullPage: true });
    return { success: true, output: buffer.toString("base64") };
  }

  private async click(page: Page, selector: string | undefined): Promise<ToolResult> {
    if (!selector) return { success: false, output: "", error: "Missing required parameter: selector" };
    await page.click(selector, { timeout: TIMEOUT });
    return { success: true, output: `Clicked: ${selector}` };
  }

  private async fill(page: Page, selector: string | undefined, value: string | undefined): Promise<ToolResult> {
    if (!selector) return { success: false, output: "", error: "Missing required parameter: selector" };
    if (value === undefined) return { success: false, output: "", error: "Missing required parameter: value" };
    await page.fill(selector, value, { timeout: TIMEOUT });
    return { success: true, output: `Filled ${selector} with value` };
  }

  private async evaluateScript(page: Page, script: string | undefined): Promise<ToolResult> {
    if (!script) return { success: false, output: "", error: "Missing required parameter: script" };
    const result = await page.evaluate(script);
    if (result === undefined || result === null) return { success: true, output: "" };
    const output = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    return { success: true, output };
  }
}
