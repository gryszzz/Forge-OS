export function createSchedulerRoutesController(deps) {
  const {
    resolveOrigin,
    requireAuth,
    recordHttp,
    json,
    readJson,
    principalHasScope,
    exportPrometheus,
    schedulerUsesRedisAuthoritativeQueue,
    schedulerAuthEnabled,
    normalizeAddress,
    defaultAgentRecord,
    agentKey,
    persistAgentToRedis,
    deleteAgentFromRedis,
    removeLocalQueuedTasksForAgent,
    removeRedisQueuedTasksForAgent,
    getSharedMarketSnapshot,
    schedulerTick,
    nowMs,
    getRuntime,
    getAuthConfig,
    getConfig,
    getServiceTokenRegistrySize,
  } = deps;

  function histogramPBucket(hist, quantile = 0.95) {
    if (!hist || !hist.count || !Array.isArray(hist.buckets) || !(hist.count > 0)) return null;
    const target = Math.max(0, Math.min(1, Number(quantile || 0.95))) * hist.count;
    let best = null;
    for (const bucket of hist.buckets) {
      const cumulative = Number(hist.counts?.get?.(bucket) || 0);
      if (cumulative >= target) {
        best = Number(bucket);
        break;
      }
    }
    return Number.isFinite(best) ? best : Number(hist.buckets[hist.buckets.length - 1] || 0) || null;
  }

  function listAgents(principal = null) {
    const { agents } = getRuntime();
    const isAdmin = principalHasScope(principal, "admin");
    const subject = String(principal?.sub || "").trim();
    return Array.from(agents.values())
      .filter((agent) => isAdmin || !subject || String(agent?.userId || "") === subject)
      .map((agent) => ({
        id: agent.id,
        userId: agent.userId,
        name: agent.name,
        walletAddress: agent.walletAddress,
        strategyLabel: agent.strategyLabel,
        status: agent.status,
        cycleIntervalMs: agent.cycleIntervalMs,
        nextRunAt: agent.nextRunAt,
        lastCycleAt: agent.lastCycleAt,
        failureCount: agent.failureCount,
        queuePending: agent.queuePending,
        lastDispatch: agent.lastDispatch,
        callbackConfigured: Boolean(agent.callbackUrl),
        updatedAt: agent.updatedAt,
      }));
  }

  async function handleRequest(req, res) {
    const origin = resolveOrigin(req);
    const startedAt = nowMs();
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const routeKey = `${req.method || "GET"} ${url.pathname}`;

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type,X-User-Id,Authorization,X-Scheduler-Token",
      });
      res.end();
      recordHttp(routeKey, 204, startedAt);
      return;
    }

    const authResult = await requireAuth(req, res, origin, url.pathname);
    if (!authResult.ok) {
      recordHttp(routeKey, Number(authResult.status || 401), startedAt);
      return;
    }
    const principal = authResult.principal;

    const runtime = getRuntime();
    const cfg = getConfig();
    const authCfg = getAuthConfig();

    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, {
        ok: true,
        service: "forgeos-scheduler",
        kasApiBase: cfg.KAS_API_BASE,
        scheduler: {
          tickMs: cfg.TICK_MS,
          queueDepth: schedulerUsesRedisAuthoritativeQueue()
            ? Number(runtime.metrics.redisExecQueueReadyDepth || 0)
            : runtime.cycleQueue.length,
          queueCapacity: cfg.MAX_QUEUE_DEPTH,
          inFlight: runtime.cycleInFlight,
          concurrency: cfg.CYCLE_CONCURRENCY,
          saturated: runtime.schedulerSaturated,
          redisAuthoritativeQueue: schedulerUsesRedisAuthoritativeQueue(),
          redisQueue: schedulerUsesRedisAuthoritativeQueue()
            ? {
                readyDepth: Number(runtime.metrics.redisExecQueueReadyDepth || 0),
                processingDepth: Number(runtime.metrics.redisExecQueueProcessingDepth || 0),
                inflightDepth: Number(runtime.metrics.redisExecQueueInflightDepth || 0),
              }
            : null,
          leader: {
            instanceId: cfg.INSTANCE_ID,
            active: runtime.isLeader,
            lastRenewedAt: runtime.leaderLastRenewedAt || null,
            nextRenewAt: runtime.leaderNextRenewAt || null,
            lockTtlMs: cfg.LEADER_LOCK_TTL_MS,
            fenceToken: Number(runtime.leaderFenceToken || 0),
            acquireBackoffUntil: runtime.leaderAcquireBackoffUntil || null,
          },
        },
        auth: {
          enabled: schedulerAuthEnabled(),
          requireAuthForReads: authCfg.REQUIRE_AUTH_FOR_READS,
          jwtEnabled: Boolean(authCfg.JWT_HS256_SECRET || authCfg.JWKS_URL || authCfg.OIDC_ISSUER),
          jwtHs256Enabled: Boolean(authCfg.JWT_HS256_SECRET),
          jwksUrlConfigured: Boolean(authCfg.JWKS_URL),
          oidcIssuerConfigured: Boolean(authCfg.OIDC_ISSUER),
          jwksPinnedKids: authCfg.JWKS_ALLOWED_KIDS_LENGTH,
          jwksRequirePinnedKid: authCfg.JWKS_REQUIRE_PINNED_KID,
          serviceTokens: getServiceTokenRegistrySize(),
          quota: {
            windowMs: authCfg.QUOTA_WINDOW_MS,
            readMax: authCfg.QUOTA_READ_MAX,
            writeMax: authCfg.QUOTA_WRITE_MAX,
            tickMax: authCfg.QUOTA_TICK_MAX,
          },
        },
        redis: {
          enabled: runtime.metrics.redisEnabled,
          connected: runtime.metrics.redisConnected,
          keyPrefix: cfg.REDIS_PREFIX,
          loadedAgents: runtime.metrics.redisLoadedAgentsTotal,
          lastError: runtime.metrics.redisLastError || null,
          execQueueRecoveredOnBootTotal: runtime.metrics.redisExecRecoveredOnBootTotal,
          execQueueResetOnBootTotal: runtime.metrics.redisExecResetOnBootTotal,
        },
        agents: {
          count: runtime.agents.size,
          running: Array.from(runtime.agents.values()).filter((a) => a.status === "RUNNING").length,
          paused: Array.from(runtime.agents.values()).filter((a) => a.status === "PAUSED").length,
        },
        cache: {
          priceAgeMs: runtime.cache.price.ts ? nowMs() - runtime.cache.price.ts : null,
          blockdagAgeMs: runtime.cache.blockdag.ts ? nowMs() - runtime.cache.blockdag.ts : null,
          balanceEntries: runtime.cache.balances.size,
        },
        ts: nowMs(),
      }, origin);
      recordHttp(routeKey, 200, startedAt);
      return;
    }

    if (req.method === "GET" && url.pathname === "/metrics") {
      const body = exportPrometheus();
      res.writeHead(200, {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        "Access-Control-Allow-Origin": origin,
        "Cache-Control": "no-store",
      });
      res.end(body);
      recordHttp(routeKey, 200, startedAt);
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/telemetry-summary") {
      const queueDepth = schedulerUsesRedisAuthoritativeQueue()
        ? Number(runtime.metrics.redisExecQueueReadyDepth || 0)
        : runtime.cycleQueue.length;
      const queueCapacity = Math.max(1, Number(cfg.MAX_QUEUE_DEPTH || 1));
      const inFlight = Math.max(0, Number(runtime.cycleInFlight || 0));
      const concurrency = Math.max(1, Number(cfg.CYCLE_CONCURRENCY || 1));
      const queueRatio = Math.max(0, Math.min(1, queueDepth / queueCapacity));
      const inFlightRatio = Math.max(0, Math.min(1, inFlight / concurrency));
      const saturationProxyPct = Math.round(Math.max(queueRatio, inFlightRatio) * 100);
      json(res, 200, {
        ok: true,
        service: "forgeos-scheduler",
        scheduler: {
          queueDepth,
          queueCapacity,
          inFlight,
          concurrency,
          saturated: Boolean(runtime.schedulerSaturated),
          saturationProxyPct,
          redisAuthoritativeQueue: schedulerUsesRedisAuthoritativeQueue(),
          redisExecQueue: schedulerUsesRedisAuthoritativeQueue()
            ? {
                readyDepth: Number(runtime.metrics.redisExecQueueReadyDepth || 0),
                processingDepth: Number(runtime.metrics.redisExecQueueProcessingDepth || 0),
                inflightDepth: Number(runtime.metrics.redisExecQueueInflightDepth || 0),
              }
            : null,
        },
        callbacks: {
          successTotal: Number(runtime.metrics.callbackSuccessTotal || 0),
          errorTotal: Number(runtime.metrics.callbackErrorTotal || 0),
          dedupeSkippedTotal: Number(runtime.metrics.callbackDedupeSkippedTotal || 0),
          latencyP95BucketMs: histogramPBucket(runtime.metrics.callbackLatencyMs, 0.95),
        },
        ts: nowMs(),
      }, origin);
      recordHttp(routeKey, 200, startedAt);
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/agents") {
      json(res, 200, { agents: listAgents(principal), ts: nowMs() }, origin);
      recordHttp(routeKey, 200, startedAt);
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/agents/register") {
      let body;
      try {
        body = await readJson(req);
      } catch (e) {
        json(res, 400, { error: { message: String(e?.message || "invalid_json") } }, origin);
        recordHttp(routeKey, 400, startedAt);
        return;
      }
      const userId = String(principal?.sub || req.headers["x-user-id"] || body?.userId || "anon").slice(0, 120);
      try {
        const next = defaultAgentRecord(body, userId);
        const key = agentKey(userId, next.id);
        if (!runtime.agents.has(key) && runtime.agents.size >= cfg.MAX_SCHEDULED_AGENTS) {
          throw new Error("max_agents_reached");
        }
        const prev = runtime.agents.get(key);
        const saved = prev ? { ...prev, ...next, createdAt: prev.createdAt, updatedAt: nowMs() } : next;
        runtime.agents.set(key, saved);
        persistAgentToRedis(saved);
        json(res, 200, { ok: true, key, agent: saved }, origin);
        recordHttp(routeKey, 200, startedAt);
      } catch (e) {
        json(res, 400, { error: { message: String(e?.message || "register_failed") } }, origin);
        recordHttp(routeKey, 400, startedAt);
      }
      return;
    }

    if (req.method === "POST" && /^\/v1\/agents\/[^/]+\/control$/.test(url.pathname)) {
      let body;
      try {
        body = await readJson(req);
      } catch (e) {
        json(res, 400, { error: { message: String(e?.message || "invalid_json") } }, origin);
        recordHttp(routeKey, 400, startedAt);
        return;
      }
      const userId = String(principal?.sub || req.headers["x-user-id"] || body?.userId || "anon").slice(0, 120);
      const agentId = decodeURIComponent(url.pathname.split("/")[3] || "");
      const key = agentKey(userId, agentId);
      const rec = runtime.agents.get(key);
      if (!rec) {
        json(res, 404, { error: { message: "agent_not_found", key } }, origin);
        recordHttp(routeKey, 404, startedAt);
        return;
      }
      const action = String(body?.action || "").toLowerCase();
      if (action === "pause") rec.status = "PAUSED";
      else if (action === "resume") rec.status = "RUNNING";
      else if (action === "remove") runtime.agents.delete(key);
      else {
        json(res, 400, { error: { message: "invalid_action" } }, origin);
        recordHttp(routeKey, 400, startedAt);
        return;
      }
      if (action !== "remove") {
        rec.updatedAt = nowMs();
        rec.nextRunAt = action === "resume" ? nowMs() + 1000 : rec.nextRunAt;
        rec.queuePending = action === "pause" ? false : rec.queuePending;
        persistAgentToRedis(rec);
      } else {
        removeLocalQueuedTasksForAgent(key);
        await removeRedisQueuedTasksForAgent(key);
        deleteAgentFromRedis(key);
      }
      json(res, 200, { ok: true, action, key, agent: action === "remove" ? null : rec }, origin);
      recordHttp(routeKey, 200, startedAt);
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/market-snapshot") {
      const address = normalizeAddress(url.searchParams.get("address"));
      if (!address) {
        json(res, 400, { error: { message: "address_required" } }, origin);
        recordHttp(routeKey, 400, startedAt);
        return;
      }
      try {
        const snapshot = await getSharedMarketSnapshot(address);
        json(res, 200, {
          snapshot,
          cache: {
            priceAgeMs: runtime.cache.price.ts ? nowMs() - runtime.cache.price.ts : null,
            blockdagAgeMs: runtime.cache.blockdag.ts ? nowMs() - runtime.cache.blockdag.ts : null,
            balanceAgeMs: (() => {
              const st = runtime.cache.balances.get(address);
              return st?.ts ? nowMs() - st.ts : null;
            })(),
          },
        }, origin);
        recordHttp(routeKey, 200, startedAt);
      } catch (e) {
        json(res, 502, { error: { message: String(e?.message || "snapshot_failed") } }, origin);
        recordHttp(routeKey, 502, startedAt);
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/scheduler/tick") {
      await schedulerTick();
      const postTickRuntime = getRuntime();
      json(res, 200, {
        ok: true,
        ts: nowMs(),
        queueDepth: schedulerUsesRedisAuthoritativeQueue()
          ? Number(postTickRuntime.metrics.redisExecQueueReadyDepth || 0)
          : postTickRuntime.cycleQueue.length,
        inFlight: postTickRuntime.cycleInFlight,
        agents: postTickRuntime.agents.size,
      }, origin);
      recordHttp(routeKey, 200, startedAt);
      return;
    }

    json(res, 404, { error: { message: "not_found" } }, origin);
    recordHttp(routeKey, 404, startedAt);
  }

  return {
    listAgents,
    handleRequest,
  };
}
