# 001-3 PR3: Slack APIラッパー層

## 概要

汎用的なSlack API呼び出し層を構築する。将来どんなボット機能を追加しても、
このラッパーを通じてSlack APIを呼び出す設計にする。

## 作成するファイル

### src/services/slack-api.ts

汎用Slack APIクライアントクラス:

- constructor(token: string, signingSecret: string)
- postMessage(channel, text, blocks?) — chat.postMessage
- updateMessage(channel, ts, text, blocks?) — chat.update
- scheduleMessage(channel, postAt, text, blocks?) — chat.scheduleMessage
- addReaction(channel, timestamp, name) — reactions.add
- getUserInfo(userId) — users.info
- getChannelList() — conversations.list
- verifySignature(signature, timestamp, body) — リクエスト検証

### src/services/slack-blocks.ts

Block Kit ビルダーヘルパー:

- createPollMessage(title, options[]) — 投票用Block Kit
- createReminderMessage(meetingName, date, time) — リマインド用Block Kit
- createResultMessage(title, results[]) — 結果通知用Block Kit

## 行数目安: 150行以内
## ブランチ: feature/slack-api-wrapper
