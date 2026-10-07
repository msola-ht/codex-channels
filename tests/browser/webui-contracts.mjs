// Optional real-browser contracts. No project dependency or live Gateway required.
// PLAYWRIGHT_BROWSERS_PATH=/path/to/browsers node tests/browser/webui-contracts.mjs /path/to/playwright/index.mjs
// An optional second argument selects one fixture case for targeted verification.
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const webui = resolve(repo, "webui")
const requireWebui = createRequire(resolve(webui, "package.json"))
const { createServer } = await import(pathToFileURL(requireWebui.resolve("vite")).href)
const { default: react } = await import(pathToFileURL(requireWebui.resolve("@vitejs/plugin-react")).href)
const { default: tailwindcss } = await import(pathToFileURL(requireWebui.resolve("@tailwindcss/vite")).href)
const { chromium } = await (process.argv[2] ? import(pathToFileURL(resolve(process.argv[2])).href) : import("playwright"))
const server = await createServer({
  configFile: false, root: webui, logLevel: "error",
  plugins: [react(), tailwindcss(), { name: "browser-contract-fixture", configureServer(vite) {
    vite.middlewares.use("/__contracts", async (request, response, next) => {
      try {
        const html = await vite.transformIndexHtml(request.originalUrl ?? "/__contracts",
          `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@fs/${repo}/tests/browser/webui-fixture.jsx"></script></body></html>`)
        response.setHeader("content-type", "text/html")
        response.end(html)
      } catch (error) { next(error) }
    })
  } }],
  resolve: { alias: { "@": resolve(webui, "src"), react: dirname(requireWebui.resolve("react/package.json")), "react-dom": dirname(requireWebui.resolve("react-dom/package.json")), "react-router": dirname(requireWebui.resolve("react-router/package.json")) }, dedupe: ["react", "react-dom"] },
  optimizeDeps: { entries: [resolve(repo, "tests/browser/webui-fixture.jsx")] },
  server: { host: "127.0.0.1", port: 0, hmr: false, watch: null, fs: { allow: [repo] } },
})
let browser
const passed = []
try {
  await server.listen(0)
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ headless: true })
  async function run(name, scenario, action, setup) {
    if (process.argv[3] && process.argv[3] !== scenario) return
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const page = await context.newPage()
    page.setDefaultTimeout(10000)
    const errors = []
    const consoleErrors = []
    page.on("pageerror", error => errors.push(error.message))
    page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()) })
    await page.route("**/*", route => {
      const url = new URL(route.request().url())
      if (url.origin !== origin || url.pathname.startsWith("/api/")) {
        errors.push(`Unmocked network: ${url.origin}${url.pathname}`)
        return route.abort()
      }
      return route.continue()
    })
    try {
      await page.addInitScript(() => { try { localStorage.setItem("codex-webui:language", "en") } catch { /* Deliberately unavailable in the storage-failure fixture. */ } })
      if (setup) await setup(page)
      await page.goto(`${origin}/__contracts?case=${scenario}${scenario === "app" ? "#/threads/%zz" : scenario === "request-purpose" ? "#/requests?range=all&offset=50&limit=10" : ""}`)
      // Wait for initial modules, styles and fonts before exercising real input.
      await page.waitForLoadState("networkidle")
      await page.waitForFunction(() => !!window.__contract)
      await action(page)
      assert.deepEqual(await page.evaluate(() => window.__contract.unexpected), [])
      assert.deepEqual(errors.filter(error => scenario === "boundary" && error === "private-fixture-exception" ? false : true), [])
      assert.deepEqual(consoleErrors.filter(error => scenario === "boundary" && error.includes("private-fixture-exception") ? false : true), [])
      passed.push(name)
      console.log(`PASS ${name}`)
    } catch (error) {
      console.error(`FAIL ${name}\n${await page.locator("body").innerText()}\nBrowser errors: ${JSON.stringify(errors)}\nConsole: ${JSON.stringify(consoleErrors)}`)
      throw error
    } finally { await context.close() }
  }

  await run("Threads: one total sorts and reveals own then subagent input, cache and output", "threads", async page => {
    const total = page.getByRole("columnheader", { name: "Total", exact: true })
    assert.equal(await total.count(), 1)
    assert.equal(await page.getByRole("columnheader", { name: /Input tokens|Output tokens|Cache hit rate/ }).count(), 0)
    const row = page.getByRole("row").filter({ has: page.getByRole("link", { name: "root-browser", exact: true }) })
    const trigger = row.locator('[aria-description^="Own:"]')
    assert.equal(await trigger.getAttribute("aria-description"), "Own: Input 100, Cached 50, Output 20. Subagents: Input 800, Cached 300, Output 160")
    await trigger.hover()
    const tooltip = page.locator('[data-slot="tooltip-content"]')
    await tooltip.waitFor({ state: "visible" })
    const content = await tooltip.innerText()
    assert.ok(content.indexOf("Own") < content.indexOf("Subagents"))
    for (const value of ["100", "50", "20", "800", "300", "160"]) assert.ok(content.includes(value))
    await page.mouse.move(0, 0)
    await tooltip.waitFor({ state: "hidden" })
    await trigger.focus()
    await tooltip.waitFor({ state: "visible" })
    await page.getByRole("button", { name: "Simulate missing usage" }).click()
    assert.equal(await trigger.getAttribute("aria-description"), "Own: Input 100, Cached ≥ 50, Output 20. Subagents: Input 800, Cached ≥ 300, Output 160")
    await trigger.hover()
    await tooltip.waitFor({ state: "visible" })
    assert.ok((await tooltip.innerText()).includes("≥ 50"))
    assert.ok((await tooltip.innerText()).includes("≥ 300"))
    assert.equal(await trigger.innerText(), "1.08K")
    await page.mouse.move(0, 0)
    await tooltip.waitFor({ state: "hidden" })
    await total.getByRole("button").click()
    await page.waitForFunction(() => location.hash.includes("sort=totalTokens"))
    await page.waitForFunction(() => [...document.querySelectorAll('th')].some(element => element.textContent.trim() === "Total" && element.getAttribute("aria-sort") === "descending"))
    await total.getByRole("button").click()
    await page.waitForFunction(() => location.hash.includes("direction=asc"))
    await page.waitForFunction(() => [...document.querySelectorAll('th')].some(element => element.textContent.trim() === "Total" && element.getAttribute("aria-sort") === "ascending"))
    const detail = row.getByRole("link", { name: "root-browser", exact: true })
    assert.equal((await detail.getAttribute("href")).includes("sort="), false)
  })
  await run("Auto-review: preview, cancel, translated confirmation and saved readback", "reviewer", async page => {
    const reviewer = page.getByRole("combobox", { name: "Codex default approval mode", exact: true })
    assert.equal(await reviewer.innerText(), "Manual approval")
    await reviewer.click()
    await page.getByRole("option", { name: "Auto-review", exact: true }).click()
    const dialog = page.getByRole("alertdialog")
    await dialog.waitFor()
    assert.match(await dialog.innerText(), /Codex default approval mode/)
    assert.equal(await page.evaluate(() => window.__contract.changed), 0)
    assert.deepEqual(await page.evaluate(() => window.__contract.previews[0].setting), { kind: "approvals-reviewer", value: "auto_review" })
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
    assert.equal(await reviewer.innerText(), "Manual approval")
    await reviewer.click()
    await page.getByRole("option", { name: "Auto-review", exact: true }).click()
    await dialog.waitFor()
    // Switch locale without dismissing or submitting the pending operation.
    await page.evaluate(() => [...document.querySelectorAll("button")].find(button => button.textContent === "Switch language").click())
    assert.match(await dialog.innerText(), /Codex 默认审批方式/)
    assert.equal(await page.evaluate(() => window.__contract.changed), 0)
    await dialog.getByRole("button", { name: "确认写入", exact: true }).click()
    await dialog.waitFor({ state: "hidden" })
    await page.waitForFunction(() => window.__contract.changed === 1)
    assert.match(await page.getByRole("combobox", { name: "Codex 默认审批方式", exact: true }).innerText(), /Auto-review/)
    assert.deepEqual(await page.evaluate(() => window.__contract.requests.find(request => request.method === "PATCH").body), {
      revision: "reviewer-1", setting: { kind: "approvals-reviewer", value: "auto_review" }, confirmationToken: "reviewer-confirmation",
    })
  })
  await run("Settings: refreshed unedited fields invalidate old errors while preserving edited drafts", "settings", async page => {
    const contextWindow = page.locator("#codex-context-window")
    const percent = page.locator("#codex-compact-percent")
    await percent.fill("80")
    await page.getByRole("button", { name: "保存压缩设置", exact: true }).click()
    assert.equal(await contextWindow.getAttribute("aria-invalid"), "true")
    assert.equal(await page.evaluate(() => window.__contract.previews.length), 0)
    await page.getByRole("button", { name: "Refresh server snapshot", exact: true }).click()
    assert.equal(await contextWindow.inputValue(), "1000")
    assert.equal(await percent.inputValue(), "80")
    await page.locator("#codex-context-window-error").waitFor({ state: "detached" })
    assert.notEqual(await contextWindow.getAttribute("aria-invalid"), "true")
    await page.getByRole("button", { name: "保存压缩设置", exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.__contract.previews), [{ kind: "model-compact", contextWindow: 1000, autoCompactPercent: 80 }])
  })
  await run("AuthGate: Enter submits; 503 preserves token diagnosis; 401 reports invalid token", "auth", async page => {
    const input = page.locator("#auth-token")
    await input.fill("fixture-token")
    await input.press("Enter")
    await page.getByText("The service is unavailable. Try again later; you do not need to change the token.").waitFor()
    assert.equal(await page.evaluate(() => window.__contract.requests.length), 1)
    await page.evaluate(() => { window.__contract.status = 401 })
    await input.press("Enter")
    await page.getByText("Invalid token. Check it and try again.").waitFor()
    assert.equal(await input.inputValue(), "fixture-token")
  })
  await run("AuthGate: unavailable local and session storage prevents successful login", "auth", async page => {
    await page.evaluate(() => { window.__contract.status = 200 })
    await page.locator("#auth-token").fill("fixture-token")
    await page.locator("#auth-token").press("Enter")
    await page.getByText("The browser could not save the access token. Allow browser storage for this site and try again.").waitFor()
    assert.equal(await page.evaluate(() => window.__contract.requests.length), 1)
    assert.equal(await page.locator("#auth-token").isEnabled(), true)
  }, async page => {
    await page.addInitScript(() => {
      for (const name of ["localStorage", "sessionStorage"]) Object.defineProperty(window, name, { get() { throw new DOMException("Fixture storage unavailable", "SecurityError") } })
    })
  })
  await run("AuthGate: successful verification saves the token before reloading", "auth", async page => {
    await page.evaluate(() => { window.__contract.status = 200 })
    await page.locator("#auth-token").fill("fixture-token")
    await Promise.all([page.waitForEvent("framenavigated"), page.locator("#auth-token").press("Enter")])
    await page.waitForLoadState("networkidle")
    assert.equal(await page.evaluate(() => localStorage.getItem("codex-webui:token")), "fixture-token")
  })
  await run("AuthGate: unmount aborts pending verification", "auth", async page => {
    await page.evaluate(() => { window.__contract.hold = true })
    await page.locator("#auth-token").fill("fixture-token")
    await page.locator("#auth-token").press("Enter")
    await page.waitForFunction(() => window.__contract.requests.length === 1)
    await page.getByTestId("unmount").click()
    assert.equal(await page.evaluate(() => window.__contract.requests[0].signal.aborted), true)
  })
  await run("AuthGate: deadline abort restores retry and shows timeout", "auth", async page => {
    await page.evaluate(() => { window.__contract.hold = true })
    await page.locator("#auth-token").fill("fixture-token")
    await page.locator("#auth-token").press("Enter")
    await page.getByText("Verification timed out. Check the connection and try again.").waitFor()
    assert.equal(await page.locator("#auth-token").isEnabled(), true)
    assert.equal(await page.evaluate(() => window.__contract.requests[0].signal.aborted), true)
  }, async page => {
    await page.addInitScript(() => {
      const timeout = AbortSignal.timeout.bind(AbortSignal)
      AbortSignal.timeout = duration => timeout(duration === 30000 ? 50 : duration)
    })
  })
  await run("useApi: StrictMode and query replacement abort; late old data never delivered", "api", async page => {
    await page.waitForFunction(() => window.__contract.queries.length === 2)
    assert.equal(await page.evaluate(() => window.__contract.queries[0].signal.aborted), true)
    await page.getByRole("button", { name: "Switch query" }).click()
    await page.waitForFunction(() => window.__contract.queries.some(entry => entry.query === "B"))
    assert.equal(await page.evaluate(() => window.__contract.queries.filter(entry => entry.query === "A").every(entry => entry.signal.aborted)), true)
    await page.evaluate(() => window.__contract.queries.find(entry => entry.query === "B").resolve("B result"))
    await page.waitForFunction(() => document.querySelector('[data-testid="api-state"]').textContent === JSON.stringify({ data: "B result", loading: false }))
    await page.evaluate(async () => {
      window.__contract.queries.filter(entry => entry.query === "A").forEach(entry => entry.resolve("stale A"))
      await new Promise(requestAnimationFrame)
    })
    assert.deepEqual(JSON.parse(await page.getByTestId("api-state").innerText()), { data: "B result", loading: false })
  })
  await run("ResetCredits: synchronous double refresh sends once; unmount abort suppresses onChanged", "reset", async page => {
    await page.getByTestId("reset-ready").filter({ hasText: "true" }).waitFor()
    await page.getByRole("button", { name: "Double refresh" }).click()
    assert.equal(await page.evaluate(() => window.__contract.requests.filter(entry => entry.url.endsWith("/accounts/refresh")).length), 1)
    await page.getByTestId("unmount").click()
    await page.evaluate(async () => {
      const entry = window.__contract.requests.find(entry => entry.url.endsWith("/accounts/refresh"))
      if (!entry.signal.aborted) throw new Error("Refresh was not aborted")
      entry.resolve()
      await new Promise(requestAnimationFrame)
    })
    assert.equal(await page.evaluate(() => window.__contract.changed), 0)
  })
  await run("Relay catalog: StrictMode cancels old attempts; unmount suppresses late refresh and success", "catalog", async page => {
    await page.waitForFunction(() => window.__contract.requests.length >= 2)
    const attempts = await page.evaluate(() => window.__contract.requests.length)
    assert.equal(await page.evaluate(() => window.__contract.requests.filter(entry => !entry.signal.aborted).length), 1)
    await page.evaluate(async () => {
      window.__contract.requests.filter(entry => entry.signal.aborted).forEach(entry => entry.resolve())
      await new Promise(requestAnimationFrame)
    })
    await page.getByRole("button", { name: "Rerender catalog 0" }).click()
    await page.getByRole("button", { name: "Download twice" }).click()
    assert.equal(await page.evaluate(() => window.__contract.requests.length), attempts)
    await page.getByTestId("unmount").click()
    await page.evaluate(async () => {
      if (!window.__contract.requests.every(entry => entry.signal.aborted)) throw new Error("Catalog request survived unmount")
      window.__contract.requests.forEach(entry => entry.resolve())
      await new Promise(requestAnimationFrame)
    })
    assert.deepEqual(await page.evaluate(() => [window.__contract.catalogRefreshes, window.__contract.catalogSuccesses]), [0, 0])
  })
  await run("Relay catalog: failure does not auto-loop; manual retry is serialized and delivers once", "catalog", async page => {
    await page.waitForFunction(() => window.__contract.requests.some(entry => !entry.signal.aborted))
    const attempts = await page.evaluate(() => window.__contract.requests.length)
    await page.evaluate(() => window.__contract.requests.find(entry => !entry.signal.aborted).resolve(503))
    await page.waitForFunction(() => document.querySelector('[data-testid="catalog-state"]').textContent === JSON.stringify({ downloading: false, message: "error" }))
    await page.getByRole("button", { name: "Rerender catalog 0" }).click()
    assert.equal(await page.evaluate(() => window.__contract.requests.length), attempts)
    await page.getByRole("button", { name: "Download twice" }).click()
    assert.equal(await page.evaluate(() => window.__contract.requests.length), attempts + 1)
    await page.evaluate(() => window.__contract.requests.at(-1).resolve())
    await page.waitForFunction(() => window.__contract.catalogRefreshes === 1 && window.__contract.catalogSuccesses === 1)
    await page.getByRole("button", { name: "Rerender catalog 1" }).click()
    assert.equal(await page.evaluate(() => window.__contract.requests.length), attempts + 1)
  })
  await run("Tabs: vertical ArrowDown moves focus; Enter activates the tab", "tabs", async page => {
    await page.getByRole("tab", { name: "First", exact: true }).focus()
    await page.keyboard.press("ArrowDown")
    await page.waitForFunction(() => document.activeElement?.textContent === "Second")
    // Base UI defaults to manual activation (activateOnFocus=false).
    await page.keyboard.press("Enter")
    await page.getByRole("tabpanel").filter({ hasText: "Second panel" }).waitFor()
    assert.equal(await page.getByRole("tab", { name: "Second", exact: true }).getAttribute("aria-selected"), "true")
  })
  await run("Request purpose: apply/reset clear pagination; export and dump navigation preserve purpose", "request-purpose", async page => {
    await page.getByRole("button", { name: "Filter", exact: true }).click()
    await page.getByRole("combobox", { name: "Request purpose", exact: true }).click()
    await page.getByRole("option", { name: "Automatic approval review", exact: true }).click()
    await page.getByRole("dialog").getByRole("button", { name: "Apply", exact: true }).click()
    await page.waitForFunction(() => location.hash.includes("requestPurpose=autoApprovalReview") && !location.hash.includes("offset="))
    const download = page.waitForEvent("download")
    await page.getByRole("button", { name: "Export fixture" }).click()
    await download
    const exportUrl = await page.evaluate(() => window.__contract.requests.find(request => request.url.includes("requests/export?")).url)
    assert.equal(new URL(exportUrl, "http://fixture").searchParams.get("requestPurpose"), "autoApprovalReview")
    await page.getByRole("button", { name: "View request", exact: true }).click()
    const detail = page.getByRole("dialog")
    await detail.waitFor()
    for (const text of ["Owning thread", "owner-thread", "Owning turn", "owner-turn", "Original reviewer thread", "reviewer-thread", "Original reviewer turn", "reviewer-turn"]) assert.ok((await detail.innerText()).includes(text))
    await detail.getByRole("button", { name: "View traffic detail" }).click()
    const returnPath = await page.getByTestId("requests-return").innerText()
    assert.equal(new URL(returnPath, "http://fixture").searchParams.get("requestPurpose"), "autoApprovalReview")
    await page.goBack()
    await page.getByRole("button", { name: "Reset", exact: true }).click()
    await page.waitForFunction(() => !location.hash.includes("requestPurpose=") && !location.hash.includes("offset="))
  })
  await run("Request and traffic tables: shared column order, aligned headers and numeric cells, keyboard detail entry", "table-alignment", async page => {
    const expected = [
      ["Recorded at", "Provider", "Method", "Model", "Reasoning", "Status", "Input", "Cache hit", "Output", "First token", "Speed", "Request duration", "Source", "Detail"],
      ["Started at", "Provider", "Method", "Model", "Reasoning", "Status", "First token", "Speed", "Request duration", "Client", "Protocol", "Type", "Detail"],
    ]
    const tables = page.getByRole("table")
    assert.equal(await tables.count(), 2)
    for (let i = 0; i < 2; i++) assert.deepEqual(await tables.nth(i).getByRole("columnheader").allTextContents(), expected[i])
    const validateAlignment = async () => {
      const differences = await page.evaluate(() => Array.from(document.querySelectorAll("table")).flatMap(table => {
        const range = document.createRange()
        const textRect = element => {
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
          let node
          while ((node = walker.nextNode())) {
            if (node.textContent.trim()) { range.selectNodeContents(node); return range.getBoundingClientRect() }
          }
        }
        const firstHeader = textRect(table.querySelector("th"))
        const headerCenter = (firstHeader.top + firstHeader.bottom) / 2
        return Array.from(table.querySelectorAll("th")).flatMap((header, index) => {
          const head = textRect(header)
          const numeric = getComputedStyle(header).textAlign === "right"
          const edge = numeric ? "right" : "left"
          const expectedEdge = header.getBoundingClientRect()[edge] + (numeric ? -8 : 8)
          const result = [{ column: header.textContent, kind: "header", delta: Math.abs(head[edge] - expectedEdge) }]
          result.push({ column: header.textContent, kind: "header baseline", delta: Math.abs((head.top + head.bottom) / 2 - headerCenter) })
          for (const row of table.querySelectorAll("tbody tr")) {
            const cell = row.children[index]
            const rect = numeric ? textRect(cell) : (cell.querySelector('[data-slot="badge"]')?.getBoundingClientRect() ?? textRect(cell))
            result.push({ column: header.textContent, kind: "cell", delta: Math.abs(rect[edge] - expectedEdge) })
          }
          return result
        })
      }))
      assert.deepEqual(differences.filter(entry => entry.delta > 1), [])
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    }
    await validateAlignment()
    const time = tables.nth(0).getByRole("columnheader").first()
    assert.equal(await time.getAttribute("aria-sort"), "descending")
    await time.getByRole("button").click()
    assert.equal(await time.getAttribute("aria-sort"), "ascending")
    await validateAlignment()
    await page.setViewportSize({ width: 1024, height: 1000 })
    await validateAlignment()
    const detail = tables.nth(1).getByRole("row").nth(1).getByRole("button").last()
    await detail.focus()
    await page.keyboard.press("Enter")
    assert.equal(await page.evaluate(() => window.__contract.opened), 0)
    await page.addInitScript(() => localStorage.setItem("codex-webui:traffic-table-v2:columns", JSON.stringify({ detail: false, provider: false })))
    await page.reload()
    assert.equal(await tables.nth(1).getByRole("columnheader", { name: "Detail", exact: true }).count(), 1)
    assert.equal(await tables.nth(1).getByRole("columnheader", { name: "Provider", exact: true }).count(), 0)
  })
  await run("RequestsTable: stored hidden detail column remains keyboard accessible; Sheet Escape restores focus", "requests", async page => {
    const opener = page.getByRole("button", { name: "View request", exact: true })
    await opener.focus()
    await page.keyboard.press("Enter")
    await page.getByRole("dialog", { name: "Request detail" }).waitFor()
    await page.keyboard.press("Escape")
    await page.getByRole("dialog", { name: "Request detail" }).waitFor({ state: "hidden" })
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "View request")
  }, async page => {
    await page.addInitScript(() => localStorage.setItem("codex-webui:requests-table-state-v5:columns", JSON.stringify({ traffic: false, provider: false })))
  })
  await run("ManagementConfirmationDialog: initial cancel focus; saving prevents Escape dismissal", "confirmation", async page => {
    await page.getByRole("button", { name: "Open confirmation" }).click()
    const dialog = page.getByRole("alertdialog")
    await dialog.waitFor()
    await page.waitForFunction(() => document.activeElement?.textContent === "Cancel")
    await dialog.getByRole("button", { name: "Confirm changes", exact: true }).click()
    await page.keyboard.press("Escape")
    assert.equal(await dialog.isVisible(), true)
    assert.equal(await page.evaluate(() => window.__contract.cancelled), 0)
    assert.equal(await dialog.getByRole("button", { name: "Cancel", exact: true }).isDisabled(), true)
  })
  await run("Queue events: StrictMode leaves one subscription; unmount cancels all", "queue", async page => {
    await page.waitForFunction(() => window.__contract.subscriptions.length >= 2)
    assert.equal(await page.evaluate(() => window.__contract.subscriptions.filter(entry => !entry.signal.aborted).length), 1)
    await page.getByTestId("unmount").click()
    assert.equal(await page.evaluate(() => window.__contract.subscriptions.every(entry => entry.signal.aborted)), true)
  })
  await run("App: malformed encoded Thread path retains shell and recovery link", "app", async page => {
    await page.getByText("Invalid page address", { exact: true }).last().waitFor()
    const back = page.getByRole("button", { name: "Back to console", exact: true })
    await back.waitFor()
    assert.equal(await back.getAttribute("href"), "#/")
    assert.equal(await page.getByRole("link", { name: "Codex WebUI", exact: true }).count() > 0, true)
    assert.equal(await page.evaluate(() => window.__contract.requests.every(entry => entry.url === "/api/v1/time")), true)
  })
  await run("PageErrorBoundary: render failure provides recovery without exception disclosure", "boundary", async page => {
    await page.getByRole("button", { name: "Break page" }).click()
    await page.getByText("This page could not be displayed", { exact: true }).waitFor()
    const back = page.getByRole("button", { name: "Back to console", exact: true })
    await back.waitFor()
    assert.equal(await back.getAttribute("href"), "#/")
    assert.equal((await page.locator("body").innerText()).includes("private-fixture-exception"), false)
  })
  assert.ok(passed.length > 0, `No browser contracts matched fixture case: ${process.argv[3]}`)
  console.log(`\n${passed.length} real-browser contracts passed (Chromium, React StrictMode, isolated mocked API).`)
} finally {
  await browser?.close()
  await server.close()
}
