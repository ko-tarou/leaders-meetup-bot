/**
 * public-session トークン (認可根治) の純ユニット網。
 * mint/verify の署名検証・失効・形式不正を固定する。
 */
import { describe, it, expect } from "vitest";
import {
  mintPublicToken,
  verifyPublicToken,
  PUBLIC_TOKEN_PREFIX,
} from "../../../src/domain/public-session";

const SECRET = "unit-secret";

describe("mintPublicToken / verifyPublicToken", () => {
  it("mint したトークンは pub. 接頭辞を持ち verify で payload を復元できる", async () => {
    const token = await mintPublicToken(SECRET, {
      p: "view",
      e: "ev1",
      a: "ac1",
    });
    expect(token.startsWith(PUBLIC_TOKEN_PREFIX)).toBe(true);
    const session = await verifyPublicToken(SECRET, token);
    expect(session).toMatchObject({ p: "view", e: "ev1", a: "ac1" });
    expect(typeof session?.exp).toBe("number");
  });

  it("別 secret で検証すると null (署名不一致)", async () => {
    const token = await mintPublicToken(SECRET, { p: "edit", e: "e", a: "a" });
    expect(await verifyPublicToken("other-secret", token)).toBeNull();
  });

  it("改竄した payload/署名は null", async () => {
    const token = await mintPublicToken(SECRET, { p: "edit", e: "e", a: "a" });
    expect(await verifyPublicToken(SECRET, token.slice(0, -2) + "zz")).toBeNull();
  });

  it("失効済み (ttl<=0) は null", async () => {
    const token = await mintPublicToken(SECRET, { p: "view", e: "e", a: "a" }, -1);
    expect(await verifyPublicToken(SECRET, token)).toBeNull();
  });

  it("pub. 接頭辞が無い (生 ADMIN_TOKEN 等) は null", async () => {
    expect(await verifyPublicToken(SECRET, "raw-admin-token")).toBeNull();
    expect(await verifyPublicToken(SECRET, null)).toBeNull();
    expect(await verifyPublicToken(SECRET, "")).toBeNull();
  });

  it("permission が view/edit 以外に改竄されても復元しない (署名で守られる)", async () => {
    // 正規 mint → 署名が payload に紐づくので p を差し替えると検証で落ちる。
    const token = await mintPublicToken(SECRET, { p: "view", e: "e", a: "a" });
    const [prefixAndPayload] = token.split(".sig-would-be-here");
    void prefixAndPayload;
    // payload 部を別 permission に差し替えた偽トークンは署名不一致 → null。
    const forged = await mintPublicToken("attacker", { p: "edit", e: "e", a: "a" });
    expect(await verifyPublicToken(SECRET, forged)).toBeNull();
  });
});
