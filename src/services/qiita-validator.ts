// 朝勉強会けじめ制度 PR5: Qiita 記事 URL の検証 + 本文文字数取得。
// parseQiitaUrl は https://qiita.com/<user>/items/<20桁hex> のみ受理 (大文字ドメイン不可)。
// fetchQiitaBodyLength は依存注入の fetch で markdown body length を取得。
export type QiitaParsed = { user: string; itemId: string };
export type QiitaFetchResult =
  | { ok: true; length: number }
  | { ok: false; reason: "not_found" | "fetch_error" };

const QIITA_URL_RE =
  /^https:\/\/qiita\.com\/([A-Za-z0-9_-]+)\/items\/([0-9a-f]{20})(?:[/?#].*)?$/;

export function parseQiitaUrl(raw: string): QiitaParsed | null {
  if (typeof raw !== "string") return null;
  const m = raw.match(QIITA_URL_RE);
  return m ? { user: m[1], itemId: m[2] } : null;
}

export async function fetchQiitaBodyLength(
  itemId: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<QiitaFetchResult> {
  let res: Response;
  try {
    res = await fetchImpl(`https://qiita.com/api/v2/items/${itemId}`, {
      headers: { Accept: "application/json" },
    });
  } catch (e) {
    console.error("fetchQiitaBodyLength: network", e);
    return { ok: false, reason: "fetch_error" };
  }
  if (res.status === 404) return { ok: false, reason: "not_found" };
  if (!res.ok) {
    console.error(`fetchQiitaBodyLength: status=${res.status}`);
    return { ok: false, reason: "fetch_error" };
  }
  try {
    const data = (await res.json()) as { body?: unknown };
    if (typeof data.body !== "string") return { ok: false, reason: "fetch_error" };
    return { ok: true, length: data.body.length };
  } catch (e) {
    console.error("fetchQiitaBodyLength: json", e);
    return { ok: false, reason: "fetch_error" };
  }
}
