/**
 * Environment keys the managed tunnel and its stdio child are allowed to
 * inherit. Kept in a leaf module so both the LaunchAgent generator and the
 * tunnel launcher share one definition without importing each other.
 */

/** Keys carried through unchanged: identity, temp roots, trust stores. */
export const TUNNEL_BASE_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "PATH",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "NODE_EXTRA_CA_CERTS",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
] as const;

/**
 * Proxy keys, accepted in both cases. The tunnel reaches
 * `api.openai.com` over the control-plane poll; on a network that only
 * permits egress through a local proxy, losing these means every poll fails
 * even though the local gateway stays healthy.
 */
export const TUNNEL_PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
] as const;

export const TUNNEL_ENV_KEYS = [
  ...TUNNEL_BASE_ENV_KEYS,
  ...TUNNEL_PROXY_ENV_KEYS,
] as const;

const PROXY_SCHEMES = ["http:", "https:", "socks5:", "socks5h:", "socks4:", "socks4a:"];

/** `NO_PROXY` is a host list, not a URL, so it is validated separately. */
function isNoProxyValue(value: string): boolean {
  return value === "*" || value.split(",").every((entry) => /^[A-Za-z0-9.\-:*_\[\]]+$/.test(entry.trim()));
}

function isProxyValue(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return PROXY_SCHEMES.includes(parsed.protocol) && parsed.hostname !== "";
}

/**
 * Proxy variables that are safe to persist into a long-lived LaunchAgent.
 * A malformed value is dropped rather than written, so a typo in a shell
 * profile cannot poison the machine service's environment.
 */
export function proxyEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of TUNNEL_PROXY_ENV_KEYS) {
    const value = env[key]?.trim();
    if (!value) continue;
    const valid = key.toLowerCase() === "no_proxy" ? isNoProxyValue(value) : isProxyValue(value);
    if (!valid) continue;
    // launchd has no notion of a case-insensitive environment, and the tunnel
    // client honours the upper-case spelling on every platform.
    const canonical = key.toUpperCase();
    result[canonical] ??= value;
  }
  return result;
}
