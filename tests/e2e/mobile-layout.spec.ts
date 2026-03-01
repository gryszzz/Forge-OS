import { expect, test, type Page, type TestInfo } from "@playwright/test";

type MobileViewport = {
  name: string;
  width: number;
  height: number;
};

const MOBILE_VIEWPORTS: MobileViewport[] = [
  { name: "iphone-se", width: 375, height: 667 },
  { name: "pixel-7", width: 412, height: 915 },
  { name: "iphone-pro-max", width: 430, height: 932 },
];

async function disableMotion(page: Page) {
  await page.addStyleTag({
    content:
      "*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important;}",
  });
}

async function assertNoHorizontalOverflow(page: Page, label: string) {
  const metrics = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    docScrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body?.scrollWidth ?? 0,
  }));

  expect(metrics.docScrollWidth, `${label}: document overflow`).toBeLessThanOrEqual(metrics.innerWidth + 2);
  expect(metrics.bodyScrollWidth, `${label}: body overflow`).toBeLessThanOrEqual(metrics.innerWidth + 2);
}

async function attachViewportScreenshot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test.describe("Mobile layout hardening", () => {
  test("wallet gate stays centered on mobile viewports", async ({ page }, testInfo) => {
    for (const vp of MOBILE_VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto("/");
      await disableMotion(page);
      await expect(page.getByTestId("wallet-gate-hero")).toBeVisible();
      await expect(page.getByTestId("web-wallet-setup")).toBeVisible();
      await assertNoHorizontalOverflow(page, `wallet gate ${vp.name}`);

      const hero = page.getByTestId("wallet-gate-hero");
      const box = await hero.boundingBox();
      expect(box, `${vp.name}: hero box missing`).not.toBeNull();
      if (box) {
        const heroCenterX = box.x + box.width / 2;
        const viewportCenterX = vp.width / 2;
        const delta = Math.abs(heroCenterX - viewportCenterX);
        expect(delta, `${vp.name}: hero not centered`).toBeLessThanOrEqual(Math.max(24, vp.width * 0.08));
        expect(box.x, `${vp.name}: hero starts outside viewport`).toBeGreaterThanOrEqual(-1);
        expect(box.x + box.width, `${vp.name}: hero exceeds viewport`).toBeLessThanOrEqual(vp.width + 2);
      }

      await attachViewportScreenshot(page, testInfo, `mobile-wallet-gate-${vp.name}`);
    }
  });

  test("dashboard overview values stay in-bounds on mobile viewports", async ({ page }, testInfo) => {
    for (const vp of MOBILE_VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto("/");
      await disableMotion(page);

      await page.getByTestId("wallet-gate-enter-demo-mode").click();
      await expect(page.getByTestId("overview-portfolio-header")).toBeVisible();
      await assertNoHorizontalOverflow(page, `overview ${vp.name}`);

      const overviewHeader = page.getByTestId("overview-portfolio-header");
      const headerBox = await overviewHeader.boundingBox();
      expect(headerBox, `${vp.name}: overview header missing`).not.toBeNull();
      if (headerBox) {
        expect(headerBox.x, `${vp.name}: overview header starts outside viewport`).toBeGreaterThanOrEqual(-1);
        expect(headerBox.x + headerBox.width, `${vp.name}: overview header exceeds viewport`).toBeLessThanOrEqual(
          vp.width + 2
        );
      }

      const stats = page.getByTestId("overview-quick-stats");
      await expect(stats).toBeVisible();
      const statCards = stats.locator(":scope > div");
      const cardCount = await statCards.count();
      expect(cardCount).toBeGreaterThan(0);
      for (let i = 0; i < cardCount; i += 1) {
        const cardBox = await statCards.nth(i).boundingBox();
        expect(cardBox, `${vp.name}: quick stat card ${i} missing`).not.toBeNull();
        if (cardBox) {
          expect(cardBox.x, `${vp.name}: quick stat card ${i} starts outside viewport`).toBeGreaterThanOrEqual(-1);
          expect(cardBox.x + cardBox.width, `${vp.name}: quick stat card ${i} exceeds viewport`).toBeLessThanOrEqual(
            vp.width + 2
          );
        }
      }

      await attachViewportScreenshot(page, testInfo, `mobile-overview-${vp.name}`);
    }
  });
});
