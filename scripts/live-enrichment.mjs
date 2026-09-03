const DAY = 86_400_000;

function matchConfig(program, target, entries) {
  const haystack = `${program.id} ${program.name} ${target.key} ${target.value}`;
  return entries.find((entry) => {
    if (entry.targetKey && entry.targetKey === target.key) return true;
    if (entry.address && String(target.value).toLowerCase().includes(String(entry.address).toLowerCase())) return true;
    if (!entry.match) return false;
    try { return new RegExp(entry.match, "i").test(haystack); } catch { return false; }
  }) ?? null;
}

async function fetchJson(url, options = {}) {
  const response = await (options.fetchImpl ?? fetch)(url, {
    method: options.method ?? "GET",
    headers: { accept: "application/json", "user-agent": "ScoutIQ/2.0 live-state", ...(options.headers ?? {}) },
    body: options.body,
    signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  if (payload?.error) throw new Error(payload.error.message ?? "RPC error");
  return payload;
}

async function rpc(url, method, params, fetchImpl) {
  return fetchJson(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    fetchImpl,
  }).then((payload) => payload.result);
}

function explorerUrl(config, query) {
  const base = config.explorerApiUrl ?? "https://api.etherscan.io/v2/api";
  const url = new URL(base);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  const envName = config.explorerApiKeyEnv;
  if (envName && process.env[envName]) url.searchParams.set("apikey", process.env[envName]);
  if (config.chainId) url.searchParams.set("chainid", String(config.chainId));
  return url.toString();
}

async function evmState(config, options) {
  const rpcUrl = config.rpcUrl ?? (config.rpcUrlEnv ? process.env[config.rpcUrlEnv] : null);
  const address = config.address;
  let code = null;
  let balanceWei = null;
  if (rpcUrl) {
    [code, balanceWei] = await Promise.all([
      rpc(rpcUrl, "eth_getCode", [address, "latest"], options.fetchImpl),
      rpc(rpcUrl, "eth_getBalance", [address, "latest"], options.fetchImpl),
    ]);
  }

  let verified = null;
  let tx30d = null;
  let lastActivity = null;
  if (config.explorerApiUrl || config.explorerApiKeyEnv) {
    const source = await fetchJson(explorerUrl(config, {
      module: "contract",
      action: "getsourcecode",
      address,
    }), { fetchImpl: options.fetchImpl }).catch(() => null);
    const sourceCode = source?.result?.[0]?.SourceCode;
    verified = sourceCode != null ? Boolean(String(sourceCode).trim()) : null;

    const cutoff = Math.floor((new Date(options.now).getTime() - 30 * DAY) / 1000);
    const seen = [];
    for (let page = 1; page <= 5; page += 1) {
      const transactions = await fetchJson(explorerUrl(config, {
        module: "account",
        action: "txlist",
        address,
        startblock: 0,
        endblock: 99999999,
        page,
        offset: 100,
        sort: "desc",
      }), { fetchImpl: options.fetchImpl }).catch(() => null);
      const rows = Array.isArray(transactions?.result) ? transactions.result : [];
      seen.push(...rows);
      if (rows.length < 100 || Number(rows.at(-1)?.timeStamp ?? 0) < cutoff) break;
    }
    tx30d = seen.filter((row) => Number(row.timeStamp ?? 0) >= cutoff).length;
    const newest = seen[0]?.timeStamp;
    lastActivity = newest ? new Date(Number(newest) * 1000).toISOString() : null;
  }

  const deployed = code == null ? null : code !== "0x" && code !== "0x0";
  const numericBalance = balanceWei == null ? null : Number(BigInt(balanceWei)) / 1e18;
  return {
    deployed,
    verified,
    tx30d,
    tvl: config.tvl ?? null,
    balance: Number.isFinite(numericBalance) ? numericBalance : null,
    lastActivity,
    chainId: config.chainId ?? null,
    address,
  };
}

export async function enrichLiveCache(programs, config = {}, priorCache = {}, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const entries = config.targets ?? [];
  const states = { ...(priorCache.states ?? {}) };
  let attempted = 0;
  let updated = 0;
  let failed = 0;
  for (const program of programs) {
    for (const target of program.targets ?? []) {
      const selected = matchConfig(program, target, entries);
      if (!selected) continue;
      const key = target.key;
      const age = states[key]?.fetchedAt ? new Date(now).getTime() - new Date(states[key].fetchedAt).getTime() : Infinity;
      if (age < Number(options.ttlHours ?? 6) * 3_600_000) continue;
      attempted += 1;
      try {
        const state = selected.adapter === "evm" ? await evmState(selected, { ...options, now }) : null;
        if (!state) throw new Error(`unsupported live adapter: ${selected.adapter}`);
        states[key] = { status: "ok", fetchedAt: now, ...state };
        updated += 1;
      } catch (error) {
        failed += 1;
        const previous = states[key];
        states[key] = previous?.status === "ok"
          ? { ...previous, lastErrorAt: now, lastError: String(error.message).slice(0, 180) }
          : { status: "pending", fetchedAt: null, lastErrorAt: now, lastError: String(error.message).slice(0, 180) };
      }
    }
  }
  return { cache: { version: 2, generatedAt: now, states }, stats: { configured: entries.length, attempted, updated, failed } };
}

export function liveStateFor(target, cache) {
  return cache?.states?.[target?.key] ?? null;
}
