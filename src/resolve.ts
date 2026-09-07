import { allPanels, getPanel, PanelError, type PanelClient } from "./panel.js";

export interface ServerRef {
  panel: PanelClient;
  identifier: string;
  uuid: string;
  name: string;
  attributes: any;
}

export interface ListedServer {
  panel: string;
  attributes: any;
}

const LIST_CACHE_MS = 30_000;
const listCache = new Map<string, { at: number; servers: ListedServer[] }>();

async function fetchServerList(panel: PanelClient, type?: string): Promise<ListedServer[]> {
  const servers: ListedServer[] = [];
  let page = 1;
  for (;;) {
    const query: Record<string, string> = { per_page: "100", page: String(page) };
    if (type !== undefined) query.type = type;
    const response = await panel.api<{ data: Array<{ attributes: any }>; meta?: { pagination?: { total_pages?: number } } }>(
      "GET",
      "/",
      undefined,
      { query }
    );
    for (const entry of response.data ?? []) {
      servers.push({ panel: panel.alias, attributes: entry.attributes });
    }
    const totalPages = response.meta?.pagination?.total_pages ?? 1;
    if (page >= totalPages) break;
    page++;
  }
  return servers;
}

async function fetchServersForPanel(panel: PanelClient): Promise<ListedServer[]> {
  const cached = listCache.get(panel.alias);
  if (cached && Date.now() - cached.at < LIST_CACHE_MS) {
    return cached.servers;
  }

  const byKey = new Map<string, ListedServer>();
  for (const entry of await fetchServerList(panel)) {
    byKey.set(entry.attributes.uuid ?? entry.attributes.identifier, entry);
  }

  // The default listing is owned + subuser servers only, so a panel admin sees nothing for
  // servers they administer but aren't attached to. `type=admin-all` returns every server the
  // panel lets them touch, and answers 0 rows (not an error) for a non-admin key.
  try {
    for (const entry of await fetchServerList(panel, "admin-all")) {
      const key = entry.attributes.uuid ?? entry.attributes.identifier;
      if (!byKey.has(key)) byKey.set(key, entry);
    }
  } catch {
    // Forks that reject the `type` filter still get the default listing above.
  }

  const servers = [...byKey.values()];
  listCache.set(panel.alias, { at: Date.now(), servers });
  return servers;
}

/**
 * Lists servers, either for a single panel (panelAlias given) or across all configured panels.
 * Results are cached in-memory per panel for 30 seconds to avoid hammering the API on repeated lookups.
 */
export async function listAllServers(panelAlias?: string): Promise<ListedServer[]> {
  const panels = panelAlias !== undefined ? [getPanel(panelAlias)] : allPanels();
  const results: ListedServer[] = [];
  for (const panel of panels) {
    const servers = await fetchServersForPanel(panel);
    results.push(...servers);
  }
  return results;
}

function describeCandidate(entry: ListedServer): string {
  const attrs = entry.attributes;
  return `${attrs.name} (${attrs.identifier}) on panel ${entry.panel}`;
}

/**
 * Resolves a server reference string to a concrete ServerRef.
 *
 * Accepted forms:
 *  - "alias:ref" — explicit panel alias prefix, ref is any of the forms below
 *  - an 8-char identifier (exact match)
 *  - a full UUID (exact match)
 *  - a case-insensitive name substring (must be unique)
 *
 * Search order: exact identifier/uuid match, exact name match, unique substring match.
 */
export async function resolveServer(server: string, panelAlias?: string): Promise<ServerRef> {
  let alias = panelAlias;
  let ref = server;

  const colonIdx = server.indexOf(":");
  if (colonIdx > 0 && alias === undefined) {
    const prefix = server.slice(0, colonIdx);
    // Only treat as "alias:ref" if the prefix actually names a configured panel.
    try {
      getPanel(prefix);
      alias = prefix;
      ref = server.slice(colonIdx + 1);
    } catch {
      // not a known alias — treat the whole string as the ref
    }
  }

  const candidates = await listAllServers(alias);

  if (candidates.length === 0) {
    throw new PanelError(
      alias
        ? `No servers found on panel "${alias}".`
        : "No servers found on any configured panel."
    );
  }

  const refLower = ref.toLowerCase();

  const idOrUuidMatches = candidates.filter(
    (c) => c.attributes.identifier === ref || c.attributes.uuid === ref
  );
  if (idOrUuidMatches.length === 1) {
    return toServerRef(idOrUuidMatches[0]!);
  }

  const exactNameMatches = candidates.filter(
    (c) => typeof c.attributes.name === "string" && c.attributes.name.toLowerCase() === refLower
  );
  if (exactNameMatches.length === 1) {
    return toServerRef(exactNameMatches[0]!);
  }
  if (exactNameMatches.length > 1) {
    throw new PanelError(
      `Ambiguous server reference "${server}" — multiple exact name matches: ${exactNameMatches
        .map(describeCandidate)
        .join(", ")}`
    );
  }

  const substringMatches = candidates.filter(
    (c) => typeof c.attributes.name === "string" && c.attributes.name.toLowerCase().includes(refLower)
  );
  if (substringMatches.length === 1) {
    return toServerRef(substringMatches[0]!);
  }
  if (substringMatches.length > 1) {
    throw new PanelError(
      `Ambiguous server reference "${server}" — matches: ${substringMatches.map(describeCandidate).join(", ")}`
    );
  }

  throw new PanelError(
    `No server matching "${server}" found. Available servers: ${candidates.map(describeCandidate).join(", ")}`
  );
}

function toServerRef(entry: ListedServer): ServerRef {
  const panel = getPanel(entry.panel);
  return {
    panel,
    identifier: entry.attributes.identifier,
    uuid: entry.attributes.uuid,
    name: entry.attributes.name,
    attributes: entry.attributes,
  };
}
