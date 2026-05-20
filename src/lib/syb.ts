/**
 * Thin SYB v2 GraphQL client.
 *
 * Ported from /home/nina/nina-agent/scripts/nina_syb.py
 *
 * Auth header is Basic <token> (NOT Bearer).
 *
 * Mutations are unbouncered at the transport layer; gate them in the
 * caller via the Account.monitored / autoRevertEnabled flags.
 */

const ENDPOINT = "https://api.soundtrackyourbrand.com/v2";
const UA = "bmasia-syb-monitor/0.1";

export class SybError extends Error {
  status?: number;
  errors?: unknown;
  constructor(message: string, opts?: { status?: number; errors?: unknown }) {
    super(message);
    this.status = opts?.status;
    this.errors = opts?.errors;
  }
}

function token(): string {
  const t = process.env.SOUNDTRACK_API_TOKEN;
  if (!t) {
    throw new SybError(
      "SOUNDTRACK_API_TOKEN missing — set env var (operator-scope token shared with Nina)"
    );
  }
  return t;
}

export interface GraphQLResponse<T = unknown> {
  data?: T;
  errors?: Array<{ message: string; path?: string[]; extensions?: unknown }>;
}

export async function graphql<T = unknown>(
  query: string,
  variables: Record<string, unknown> = {}
): Promise<T> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${token()}`,
      "User-Agent": UA,
      Accept: "application/json",
    },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new SybError(`SYB HTTP ${res.status}: ${body.slice(0, 500)}`, {
      status: res.status,
    });
  }

  const json = (await res.json()) as GraphQLResponse<T>;

  if (json.errors && json.errors.length > 0) {
    throw new SybError(
      `SYB GraphQL: ${json.errors.map((e) => e.message).join("; ")}`,
      { errors: json.errors }
    );
  }

  if (json.data === undefined) {
    throw new SybError("SYB returned no data");
  }

  return json.data;
}

/** Self-test — confirm token resolves */
export async function whoami(): Promise<{ id?: string }> {
  return graphql<{ me: { id?: string } | null }>(`
    query { me { ... on PublicAPIClient { id } } }
  `).then((d) => d.me ?? {});
}
