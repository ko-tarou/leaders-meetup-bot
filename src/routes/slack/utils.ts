import type { DecryptedWorkspace } from "../../services/workspace";

/**
 * Slack 署名検証ミドルウェアが Context に set する変数の型。
 * 各サブアプリは c.get("rawBody") / c.get("workspace") を介して参照する。
 */
export type SlackVariables = {
  rawBody: string;
  // ADR-0006 (PR5): 署名検証で確定した workspace。後段ハンドラはこれを正とする。
  workspace: DecryptedWorkspace;
};

/**
 * 生 body から Slack team_id を抽出する（署名検証前のルーティング目的）。
 *
 * 注意: ここで取り出した team_id はまだ署名検証されていない。
 * 「どの workspace の signing_secret で検証すべきか」を決めるためだけに使い、
 * 検証成功後の payload まで信用しない。
 *
 * 形式判定:
 * - JSON (events API): top-level の team_id
 *   url_verification は team_id を持たないので呼び出し側で別経路 (default ws) を使う
 * - form-encoded:
 *   - slash commands: team_id=T...
 *   - interactions: payload={"team":{"id":"T..."}, ...}
 */
export function extractTeamId(
  rawBody: string,
  contentType: string,
): string | null {
  if (contentType.includes("application/json")) {
    try {
      const json = JSON.parse(rawBody);
      if (typeof json?.team_id === "string") return json.team_id;
      return null;
    } catch {
      return null;
    }
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(rawBody);
    const teamIdDirect = params.get("team_id");
    if (teamIdDirect) return teamIdDirect;
    const payloadStr = params.get("payload");
    if (payloadStr) {
      try {
        const payload = JSON.parse(payloadStr);
        if (typeof payload?.team?.id === "string") return payload.team.id;
      } catch {
        return null;
      }
    }
    return null;
  }

  return null;
}
