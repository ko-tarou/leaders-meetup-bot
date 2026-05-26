/**
 * 003 朝勉強会けじめ制度 PR14: 記事申請 Slack Modal の Block Kit ビルダ。
 *
 * - けじめ ch の「📝 記事を申請」ボタン押下時に views.open へ渡す view object。
 * - callback_id は `kejime_article_modal:<trackerActionId>` 形式。
 *   submit 時に view_submission ハンドラが actionId を抽出して
 *   processQiitaArticleSubmission に渡す。
 * - URL 入力 1 フィールド + hint (500文字以上要件) のみのシンプル構成。
 */
export function buildKejimeArticleModal(
  trackerActionId: string,
): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: `kejime_article_modal:${trackerActionId}`,
    title: { type: "plain_text", text: "けじめ 記事申請" },
    submit: { type: "plain_text", text: "申請" },
    close: { type: "plain_text", text: "キャンセル" },
    blocks: [
      {
        type: "input",
        block_id: "url_block",
        element: {
          type: "plain_text_input",
          action_id: "url_input",
          placeholder: {
            type: "plain_text",
            text: "https://qiita.com/<user>/items/<id>",
          },
        },
        label: { type: "plain_text", text: "Qiita 記事 URL" },
        hint: {
          type: "plain_text",
          text: "500文字以上の記事のみ承認対象。500文字未満は自動却下されます。",
        },
      },
    ],
  };
}
