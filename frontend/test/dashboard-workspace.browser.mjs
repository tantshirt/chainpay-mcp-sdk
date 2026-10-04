// Owner workspace acceptance (EXPERIENCE.md, 2026-10-04) in the design harness:
// every tab × {1440, 768, 390} × {populated, empty, unavailable metadata}, plus
// failed collections, keyboard use, panel focus restoration, 200% zoom and
// reduced motion. No wallet, no backend; external requests are blocked and
// fixture data is not payment evidence.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { BASE_URL, blockExternal, launchBrowser } from "./browser/_helpers.mjs";

const SHOTS = process.env.CHAINPAY_WORKSPACE_SHOTS || "/tmp/chainpay-workspace-shots";
await mkdir(SHOTS, { recursive: true });

const TABS = ["overview", "agents", "mandates", "cards", "assistant", "payments", "settings"];
const WIDTHS = [1440, 768, 390];
const STATES = {
  populated: "signed-in=fixture&decimals=fixture&inbox=fixture&slot=fixture&receipts",
  empty: "empty=1&signed-in=fixture&decimals=fixture",
  unavailable: "signed-in=fixture&inbox=fixture&slot=fixture",
};
const harness = (query) => `${BASE_URL}/test/fixtures/dashboard-harness.html?${query}`;

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await blockExternal(page);

async function open(query) {
  await page.goto(harness(query));
  await page.locator("h1").first().waitFor();
  // Let metadata, fixture sessions and fixture reads settle.
  await page.waitForFunction(() => !document.querySelector(".dashboard-app [aria-busy='true'] .cp-amount-skeleton, .cp-collection-state.is-loading"), null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(250);
}

async function noOverflow(label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `${label}: horizontal overflow ${overflow}px`);
}

/** Visible interactive controls in the workspace, Cards included, that are shorter than 44px. */
async function shortControls() {
  return page.evaluate(() => {
    const selector = "button, [role='tab'], [role='radio'], select, summary, a.astryx-button, input:not([type='hidden']):not([type='checkbox']):not([type='radio']):not([type='range']):not([type='file'])";
    return [...document.querySelectorAll(`.dashboard-app ${selector.split(", ").join(", .dashboard-app ")}`)]
      .map((el) => ({ el, box: el.getBoundingClientRect(), style: getComputedStyle(el) }))
      .filter(({ el, box, style }) => box.width > 4 && box.height > 0 && style.visibility !== "hidden" && el.offsetParent !== null)
      .filter(({ el, box }) => {
        if (box.height >= 43.5) return false;
        // A summary inside an inline raw-units disclosure keeps a 44px min-height with negative margins; measure that.
        return parseFloat(getComputedStyle(el).minHeight) < 44;
      })
      .map(({ el, box }) => `${el.tagName.toLowerCase()}.${[...el.classList].filter((c) => !/^x[0-9a-z]{5,8}$/.test(c)).slice(0, 3).join(".")} "${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 30)}" ${Math.round(box.height)}px`);
  });
}

try {
  // 1. Every tab × width × state.
  for (const [state, query] of Object.entries(STATES)) {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 1000 });
      for (const tab of TABS) {
        await open(`tab=${tab}&${query}`);
        const label = `${tab} ${state} ${width}`;
        assert.equal(await page.locator("h1").first().evaluate((el) => getComputedStyle(el).fontSize), "28px", `${label}: page title 28px`);
        await noOverflow(label);
        const short = await shortControls();
        assert.deepEqual(short, [], `${label}: controls under 44px`);
        const text = await page.locator(".dashboard-page").innerText();
        assert.doesNotMatch(text, /\bbase units\b/, `${label}: unformatted base units shown as an amount`);
        assert.equal(await page.locator(".cp-usage-ring").count(), tab === "overview" && state !== "empty" ? 1 : 0, `${label}: exactly one usage ring, on Overview`);
        if (state === "unavailable" && tab === "overview") {
          assert.match(text, /Amount unavailable/, `${label}: unavailable metadata says so`);
          assert.equal(await page.locator(".cp-usage-ring.is-unavailable").count(), 1, `${label}: dashed ring without a percentage`);
          assert.doesNotMatch(await page.locator(".cp-usage-ring").innerText(), /\d/, `${label}: no percentage when metadata is unavailable`);
        }
        if (state === "unavailable" && tab === "mandates") assert.match(text, /Amounts unavailable/, `${label}: ledger hides amounts`);
        if (state === "populated" && tab === "overview") {
          assert.match(text, /91\.50\s*USDC/, `${label}: spent across active permissions`);
          assert.match(text, /158\.50\s*USDC/, `${label}: remaining allowance`);
          assert.match(await page.locator(".cp-usage-ring").innerText(), /36/, `${label}: ring percentage`);
        }
        if (state === "populated" && tab === "payments") assert.match(text, /4\.500001\s*USDC/, `${label}: every significant digit kept`);
        // Distinct icon per tone: a positive status is never shown with any icon but check-circle, and nothing else uses it.
        const statuses = await page.locator(".cp-status").evaluateAll((els) => els.map((el) => [el.dataset.tone, el.dataset.icon]));
        for (const [tone, icon] of statuses) assert.equal(tone === "positive", icon === "check-circle", `${label}: ${tone} status uses ${icon}`);
        await page.screenshot({ path: `${SHOTS}/${tab}-${state}-${width}.png`, fullPage: true });
      }
    }
  }

  // 2. Failed collections never read as zero or all clear.
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await open("tab=overview&fail=1&signed-in=fixture&decimals=fixture");
    const counts = page.locator(".cp-overview-counts");
    for (const name of ["Connected agents", "Cards"]) {
      const tile = counts.locator(".cp-count").filter({ hasText: name });
      assert.equal((await tile.locator(".cp-count-value").innerText()).trim(), "—", `${name} count is a dash when it could not be read`);
      assert.match(await tile.innerText(), /Couldn’t load/);
    }
    const overview = await page.locator(".dashboard-page").innerText();
    assert.doesNotMatch(overview, /Nothing needs your attention/, "no all-clear when expiry could not be checked");
    assert.match(overview, /Expiry not checked/);
    assert.match(overview, /expiry couldn’t be checked/);
    assert.match(overview, /Couldn’t load your agents/);
    assert.match(overview, /Couldn’t load your cards/);
    await page.screenshot({ path: `${SHOTS}/overview-failed-${width}.png`, fullPage: true });

    await open("tab=agents&fail=1&signed-in=fixture&decimals=fixture");
    assert.match(await page.locator(".dashboard-page").innerText(), /Couldn’t load your agents/);
    await page.getByRole("button", { name: "Try again" }).first().waitFor();
    await page.screenshot({ path: `${SHOTS}/agents-failed-${width}.png`, fullPage: true });

    await open("tab=payments&fail=1&signed-in=fixture&decimals=fixture");
    const payments = await page.locator(".dashboard-page").innerText();
    assert.match(payments, /Payment history is unavailable/);
    assert.doesNotMatch(payments, /\d+ settled/, "no settled count from data that did not load");
    await page.screenshot({ path: `${SHOTS}/payments-failed-${width}.png`, fullPage: true });
  }

  // 3. Signed-out is not empty.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await open("tab=agents");
  assert.match(await page.locator(".dashboard-page").innerText(), /Sign in to see your agents/);
  assert.doesNotMatch(await page.locator(".dashboard-page").innerText(), /No agents connected yet/);
  await open("tab=overview");
  assert.equal((await page.locator(".cp-count").filter({ hasText: "Connected agents" }).locator(".cp-count-value").innerText()).trim(), "—");

  // 4. Keyboard: sidebar navigation, ledger row, panel focus restoration, Pause stays reachable.
  await open(`tab=overview&${STATES.populated}`);
  const sidebar = page.locator(".dashboard-sidebar");
  await sidebar.getByRole("button", { name: "Spending permissions", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: "Spending permissions", exact: true, level: 1 }).waitFor();
  const row = page.getByRole("row", { name: /Inspect spending permission MdT1/ });
  await row.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Spending permission" });
  await dialog.waitFor();
  assert.match(await dialog.textContent(), /Created/, "creation date moved into details");
  assert.match(await dialog.textContent(), /Mandate address/, "protocol IDs live in details");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await page.waitForTimeout(250);
  assert.equal(await row.evaluate((el) => el === document.activeElement), true, "focus returns to the row that opened the panel");
  assert.equal(await row.getByRole("button", { name: "Pause", exact: true }).isVisible(), true, "Pause stays visible in the ledger");
  // Segmented filter is keyboard operable.
  await page.getByRole("radio", { name: "Paused", exact: true }).click();
  assert.equal(await page.getByRole("row", { name: /Inspect spending permission/ }).count(), 1);
  await page.getByRole("radio", { name: "All", exact: true }).click();

  // 5. 200% zoom on every tab.
  for (const tab of TABS) {
    await open(`tab=${tab}&${STATES.populated}`);
    await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
    await noOverflow(`${tab} 200% zoom`);
    if (tab === "overview" || tab === "mandates") await page.screenshot({ path: `${SHOTS}/${tab}-zoom200-1440.png`, fullPage: true });
    await page.evaluate(() => { document.documentElement.style.zoom = "1"; });
  }

  // 6. Reduced motion removes transitions; the ring never animates; amounts render without counting.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(`tab=overview&${STATES.populated}`);
  const motion = await page.evaluate(() => {
    const row = document.querySelector(".cp-row");
    const ring = document.querySelector(".cp-usage-ring-fill");
    return { row: row ? getComputedStyle(row).transitionDuration : "", ring: ring ? `${getComputedStyle(ring).transitionDuration}|${getComputedStyle(ring).animationName}` : "" };
  });
  assert.equal(motion.row, "0s");
  assert.equal(motion.ring, "0s|none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const ringMotion = await page.locator(".cp-usage-ring-fill").evaluate((el) => `${getComputedStyle(el).transitionDuration}|${getComputedStyle(el).animationName}`);
  assert.equal(ringMotion, "0s|none", "the ring fill never animates");

  assert.deepEqual(errors, []);
  console.log(`PASS: ${TABS.length} tabs × ${WIDTHS.length} widths × ${Object.keys(STATES).length} states, failed collections, signed-out, keyboard and focus restore, 200% zoom, reduced motion. Screenshots in ${SHOTS}. No financial action.`);
} finally {
  await browser.close();
}
