// Phase3-1 段階2: Slack Block Kit の素のリテラル重複を集約する pure builder。
//
// devhub-task-modal / sticky-task-board / sticky-pr-review-board /
// slack-blocks に散らばっていた Block Kit リテラル
// (plain_text オブジェクト / divider / header / mrkdwn section) を
// pure ファクトリにする。I/O は一切持たない（domain 層）。
//
// 重要不変条件: 生成される object のキー挿入順序を従来の手書きリテラルと
// 完全一致させる（既存 characterization が JSON.stringify(blocks) の
// 部分一致で観測しているため、キー順がズレると番人が落ちる）。
// そのため各ファクトリはキーを literal の出現順に並べて返す。

/** `{ type: "plain_text", text }` を生成する。 */
export function plainText(text: string): { type: "plain_text"; text: string } {
  return { type: "plain_text", text };
}

/** `{ type: "mrkdwn", text }` を生成する。 */
export function mrkdwnText(text: string): { type: "mrkdwn"; text: string } {
  return { type: "mrkdwn", text };
}

/** `{ type: "divider" }` を生成する。 */
export function divider(): { type: "divider" } {
  return { type: "divider" };
}

/** `{ type: "header", text: { type: "plain_text", text } }` を生成する。 */
export function headerBlock(text: string): {
  type: "header";
  text: { type: "plain_text"; text: string };
} {
  return { type: "header", text: plainText(text) };
}

/** `{ type: "section", text: { type: "mrkdwn", text } }` を生成する。 */
export function mrkdwnSection(text: string): {
  type: "section";
  text: { type: "mrkdwn"; text: string };
} {
  return { type: "section", text: mrkdwnText(text) };
}
