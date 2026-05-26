/**
 * 朝勉強会けじめ制度 PR5: parseQiitaUrl / fetchQiitaBodyLength characterization.
 *
 * parseQiitaUrl は https://qiita.com/<user>/items/<20桁hex> のみ受理。
 * fetchQiitaBodyLength は依存注入 fetch で 200 / 404 / 5xx / network / non-json
 * 全パスをカバーする。
 */
import { describe, it, expect, vi } from "vitest";
import {
  parseQiitaUrl,
  fetchQiitaBodyLength,
} from "../../../src/services/qiita-validator";

describe("parseQiitaUrl", () => {
  const ID = "a".repeat(20);
  it("正常 URL → { user, itemId }", () => {
    expect(parseQiitaUrl(`https://qiita.com/foo/items/${ID}`)).toEqual({
      user: "foo", itemId: ID,
    });
  });
  it("query 付き → 受理", () => {
    expect(parseQiitaUrl(`https://qiita.com/u/items/${ID}?utm=x`))
      .toEqual({ user: "u", itemId: ID });
  });
  it("hash 付き → 受理", () => {
    expect(parseQiitaUrl(`https://qiita.com/u/items/${ID}#sec`))
      .toEqual({ user: "u", itemId: ID });
  });
  it("末尾 / → 受理", () => {
    expect(parseQiitaUrl(`https://qiita.com/u/items/${ID}/`))
      .toEqual({ user: "u", itemId: ID });
  });
  it("http (TLS なし) → null", () => {
    expect(parseQiitaUrl(`http://qiita.com/u/items/${ID}`)).toBeNull();
  });
  it("大文字ドメイン → null", () => {
    expect(parseQiitaUrl(`https://QIITA.COM/u/items/${ID}`)).toBeNull();
  });
  it("非 Qiita ドメイン → null", () => {
    expect(parseQiitaUrl(`https://example.com/u/items/${ID}`)).toBeNull();
  });
  it("items パスなし → null", () => {
    expect(parseQiitaUrl(`https://qiita.com/u/posts/${ID}`)).toBeNull();
  });
  it("id 桁数違い → null", () => {
    expect(parseQiitaUrl(`https://qiita.com/u/items/abc`)).toBeNull();
  });
  it("id に非 hex 含む → null", () => {
    expect(parseQiitaUrl(`https://qiita.com/u/items/${"g".repeat(20)}`)).toBeNull();
  });
  it("非 string → null", () => {
    // @ts-expect-error 防御テスト
    expect(parseQiitaUrl(null)).toBeNull();
  });
});

function mockFetch(impl: () => Promise<Response> | Response): typeof globalThis.fetch {
  return ((async () => impl()) as unknown) as typeof globalThis.fetch;
}

describe("fetchQiitaBodyLength", () => {
  it("200 + body → { ok:true, length }", async () => {
    const f = mockFetch(() => new Response(JSON.stringify({ body: "abcde" }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    expect(await fetchQiitaBodyLength("x", f)).toEqual({ ok: true, length: 5 });
  });
  it("200 + 日本語 body → length は char 数", async () => {
    const f = mockFetch(() => new Response(JSON.stringify({ body: "あいう" }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    expect(await fetchQiitaBodyLength("x", f)).toEqual({ ok: true, length: 3 });
  });
  it("404 → not_found", async () => {
    const f = mockFetch(() => new Response("not found", { status: 404 }));
    expect(await fetchQiitaBodyLength("x", f)).toEqual({
      ok: false, reason: "not_found",
    });
  });
  it("500 → fetch_error", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = mockFetch(() => new Response("ng", { status: 500 }));
    expect(await fetchQiitaBodyLength("x", f)).toEqual({
      ok: false, reason: "fetch_error",
    });
    err.mockRestore();
  });
  it("network error (throw) → fetch_error", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = ((async () => { throw new Error("ECONNRESET"); }) as unknown) as typeof globalThis.fetch;
    expect(await fetchQiitaBodyLength("x", f)).toEqual({
      ok: false, reason: "fetch_error",
    });
    err.mockRestore();
  });
  it("200 + body missing → fetch_error", async () => {
    const f = mockFetch(() => new Response(JSON.stringify({ foo: "x" }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    expect(await fetchQiitaBodyLength("x", f)).toEqual({
      ok: false, reason: "fetch_error",
    });
  });
  it("URL に itemId が embed される", async () => {
    let captured = "";
    const f = (async (url: string) => {
      captured = url;
      return new Response(JSON.stringify({ body: "x" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    await fetchQiitaBodyLength("abcdef", f);
    expect(captured).toBe("https://qiita.com/api/v2/items/abcdef");
  });
});
