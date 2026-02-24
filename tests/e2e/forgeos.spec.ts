import { expect, test, type Page } from "@playwright/test";

const MAINNET_ADDR = "kaspa:qpv7fcvdlz6th4hqjtm9qkkms2dw0raem963x3hm8glu3kjgj7922vy69hv85";

function txid(seed: string) {
  const base = seed.replace(/[^a-f0-9]/gi, "").toLowerCase() || "a";
  return (base.repeat(Math.ceil(64 / base.length))).slice(0, 64);
}

async function mockKaspaApi(page: Page) {
  let price = 0.12;
  let daa = 1_000_000;
  const receiptCalls = new Map<string, number>();

  await page.route("**/*", async (route) => {
    const url = route.request().url();

    if (/\/info\/price(?:\?|$)/.test(url)) {
      price = Number((price + 0.0002).toFixed(6));
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ price }) });
      return;
    }

    if (/\/info\/blockdag(?:\?|$)/.test(url)) {
      daa += 5;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ blockdag: { daaScore: daa, networkName: "mainnet" } }),
      });
      return;
    }

    if (/\/addresses\/.+\/balance(?:\?|$)/.test(url)) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ balance: 5000 * 1e8 }),
      });
      return;
    }

    if (/\/addresses\/.+\/utxos(?:\?|$)/.test(url)) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ utxos: [] }),
      });
      return;
    }

    const txMatch = url.match(/\/(?:transactions|txs|transaction)\/([a-f0-9]{64})(?:\?|$)/i);
    if (txMatch) {
      const id = txMatch[1].toLowerCase();
      const calls = (receiptCalls.get(id) || 0) + 1;
      receiptCalls.set(id, calls);
      if (calls <= 1) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ tx: { status: "pending", confirmations: 0 } }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ tx: { status: "confirmed", confirmations: 1, blockTime: Date.now() } }),
      });
      return;
    }

    await route.continue();
  });
}

async function installKaswareMock(page: Page) {
  await page.addInitScript((address) => {
    const mockState = {
      address,
      sendPlan: [] as Array<{ txid?: string; error?: string }>,
      sent: [] as Array<{ to: string; sompi: number; txid: string }>,
      seq: 0,
    };

    (window as any).__forgeosKaswareMock = mockState;
    (window as any).kasware = {
      requestAccounts: async () => [mockState.address],
      getNetwork: async () => "mainnet",
      getBalance: async () => ({ total: 5000 * 1e8 }),
      sendKaspa: async (to: string, sompi: number) => {
        const step = mockState.sendPlan.shift();
        if (step?.error) throw new Error(step.error);
        mockState.seq += 1;
        const nextTxid = step?.txid || `${mockState.seq.toString(16)}${"b".repeat(63)}`.slice(0, 64);
        mockState.sent.push({ to, sompi, txid: nextTxid });
        return nextTxid;
      },
      signMessage: async () => "mock-signature",
    };
  }, MAINNET_ADDR);
}

async function setKaswareSendPlan(page: Page, plan: Array<{ txid?: string; error?: string }>) {
  await page.evaluate((nextPlan) => {
    (window as any).__forgeosKaswareMock.sendPlan = [...nextPlan];
  }, plan);
}

async function connectKaswareAndDeploy(page: Page, agentName = "E2E Agent", deployTxId = txid("deploy")) {
  await page.goto("/");
  await setKaswareSendPlan(page, [{ txid: deployTxId }]);
  await page.getByRole("button", { name: /connect kasware/i }).click();
  await expect(page.getByText(/configure agent/i)).toBeVisible();
  await page.getByPlaceholder("KAS-Alpha-01").fill(agentName);
  await page.getByRole("button", { name: /^next$/i }).click();
  await page.getByRole("button", { name: /^next$/i }).click();
  await page.getByRole("button", { name: /deploy agent/i }).click();
  await page.getByRole("button", { name: /^sign & broadcast$/i }).click();
  await expect(page.getByText(new RegExp(`FORGE\\.OS / AGENT / ${agentName}`, "i"))).toBeVisible();
}

async function injectPendingActionQueueItem(page: Page, opts?: { amountKas?: number; type?: string; purpose?: string }) {
  const amountKas = Number(opts?.amountKas || 1.25);
  const type = String(opts?.type || "ACCUMULATE");
  const purpose = String(opts?.purpose || `E2E ${type} ${amountKas}`);
  return await page.evaluate(
    ({ amountKas, type, purpose, address }) => {
      const bridge = (window as any).__forgeosTest?.dashboard;
      if (!bridge?.enqueueQueueTx) throw new Error("ForgeOS test bridge unavailable");
      return bridge.enqueueQueueTx({
        type,
        metaKind: "action",
        from: address,
        to: address,
        amount_kas: Number(amountKas.toFixed(6)),
        purpose,
        dec: {
          action: type,
          liquidity_impact: "MODERATE",
          capital_allocation_kas: amountKas,
        },
      });
    },
    { amountKas, type, purpose, address: MAINNET_ADDR }
  );
}

test.describe("ForgeOS E2E", () => {
  test.beforeEach(async ({ page }) => {
    await mockKaspaApi(page);
  });

  test("wallet gate supports demo mode", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /enter demo mode/i }).click();
    await expect(page.getByText(/forge\.os \/ new agent/i)).toBeVisible();
    await expect(page.getByText(/DEMO/i)).toBeVisible();
  });

  test("wallet gate supports mocked kasware", async ({ page }) => {
    await installKaswareMock(page);
    await connectKaswareAndDeploy(page, "Kasware E2E");
    await expect(page.getByText(/RUN QUANT CYCLE/i)).toBeVisible();
  });

  test("queue reject and sign flow works with mocked kasware", async ({ page }) => {
    await installKaswareMock(page);
    await connectKaswareAndDeploy(page, "Queue Flow");

    const rejectId = await injectPendingActionQueueItem(page, { amountKas: 1.1, purpose: "reject test queue item" });
    await page.getByTestId("dashboard-tab-queue").click();
    const rejectCard = page.getByTestId(`queue-item-${rejectId}`);
    await rejectCard.getByRole("button", { name: /reject/i }).click();
    await expect(page.getByTestId(`queue-item-status-${rejectId}`)).toHaveText(/REJECTED/i);

    await setKaswareSendPlan(page, [{ txid: txid("actionsign") }, { error: "wallet rejected treasury payout" }]);
    const signId = await injectPendingActionQueueItem(page, { amountKas: 1.2, purpose: "sign test queue item" });
    const signCard = page.getByTestId(`queue-item-${signId}`);
    await signCard.getByTestId(`queue-item-sign-${signId}`).click();
    await page.getByRole("button", { name: /^sign & broadcast$/i }).click();
    await expect(page.getByTestId(`queue-item-status-${signId}`)).toHaveText(/SIGNED/i);
    await expect(page.getByText(/TREASURY_FEE/i)).toBeVisible();
  });

  test("treasury payout second tx can queue then sign", async ({ page }) => {
    await installKaswareMock(page);
    await connectKaswareAndDeploy(page, "Treasury Queue");

    const actionId = await injectPendingActionQueueItem(page, { amountKas: 1.33, purpose: "treasury queue seed" });
    await page.getByTestId("dashboard-tab-queue").click();
    // kaswareProvider.send() first tries with priorityFee, then silently falls back to a
    // second sendKaspa call if the first throws. So each "send" may consume two plan slots.
    // Action sign: prio-fee attempt succeeds (plan[0]) — no fallback consumed.
    // Treasury auto-send: prio-fee attempt fails (plan[1]) → inner catch → fallback also
    //   fails (plan[2]) → outer catch → enqueueTreasuryFeeTx → PENDING.
    // Treasury manual sign: prio-fee attempt succeeds (plan[3]) — no fallback consumed.
    await setKaswareSendPlan(page, [
      { txid: txid("action") },
      { error: "treasury prio-fee rejected" },
      { error: "treasury fallback rejected" },
      { txid: txid("treasury") },
    ]);

    const actionCard = page.getByTestId(`queue-item-${actionId}`);
    await actionCard.getByTestId(`queue-item-sign-${actionId}`).click();
    await page.getByRole("button", { name: /^sign & broadcast$/i }).click();

    const treasuryCard = page.getByTestId(/queue-item-.+/).filter({ hasText: "TREASURY_FEE" }).first();
    const treasuryId = await treasuryCard.getAttribute("data-testid");
    if (!treasuryId) throw new Error("Treasury queue card test id missing");
    const treasuryQueueId = treasuryId.replace("queue-item-", "");
    await expect(page.getByTestId(`queue-item-status-${treasuryQueueId}`)).toHaveText(/PENDING/i);
    await page.getByTestId(`queue-item-sign-${treasuryQueueId}`).click();
    await page.getByRole("button", { name: /^sign & broadcast$/i }).click();
    await expect(page.getByTestId(`queue-item-status-${treasuryQueueId}`)).toHaveText(/SIGNED/i);
  });

  test("network switching resets session and updates URL", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /enter demo mode/i }).click();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId("network-select").selectOption({ value: "testnet-10" });
    await page.waitForURL(/network=testnet-10/);
    // After reload with testnet-10, WalletGate shows; verify network label is visible
    await expect(page.getByText(/kaspa testnet/i).first()).toBeVisible();
  });

  test("pause/resume/kill-switch controls work and auto-cycle countdown is visible", async ({ page }) => {
    await installKaswareMock(page);
    await connectKaswareAndDeploy(page, "Controls E2E");

    await expect(page.getByText(/AUTO \d{2}:\d{2}/i)).toBeVisible();
    await page.getByTestId("dashboard-tab-controls").click();
    await page.getByRole("button", { name: /^PAUSE AGENT$/i }).click();
    await expect(page.getByText(/^PAUSED$/i)).toBeVisible();
    await page.getByRole("button", { name: /^RESUME AGENT$/i }).click();
    await expect(page.getByText(/^RUNNING$/i)).toBeVisible();

    const killPendingId = await injectPendingActionQueueItem(page, { amountKas: 0.9, purpose: "kill switch pending queue item" });
    await page.getByTestId("dashboard-tab-controls").click();
    await page.getByRole("button", { name: /KILL-SWITCH/i }).click();
    await expect(page.getByText(/^SUSPENDED$/i)).toBeVisible();
    await page.getByTestId("dashboard-tab-queue").click();
    await expect(page.getByTestId(`queue-item-status-${killPendingId}`)).toHaveText(/REJECTED/i);
  });
});
