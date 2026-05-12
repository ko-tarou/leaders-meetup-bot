/**
 * 005-feedback: Gemini 1.5 Flash でユーザーの「使い方の質問」に答えるサービス。
 *
 * - DevHub Ops の機能概要を system_instruction に詰め込み、毎回のリクエストで送る。
 * - 過去 N 件の会話履歴は呼び出し側 (FE) が state として保持し、ここに渡す。
 * - 失敗時 (api key 未設定 / Gemini 4xx,5xx) は throw する → endpoint 側で
 *   500 を返し、FE は「エラーが発生しました」を表示する。
 *
 * モデル: gemini-1.5-flash (最も安価で高速、ヘルプ用途には十分)。
 */
import type { Env } from "../types/env";

export type ChatHistoryItem = {
  role: "user" | "assistant";
  content: string;
};

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent";

// マスタープロンプト。DevHub Ops の機能を網羅的に列挙し、AI がドメイン知識
// 無しでも質問に答えられるようにする。
const SYSTEM_PROMPT = `あなたは DevHub Ops のヘルプアシスタントです。
DevHub Ops は Slack ボットを GUI で管理できる SaaS で、以下の機能があります:

## イベント・アクション
- イベント (HackIt、リーダー雑談会、DevelopersHub 運営 など) を作成
- 各イベントに「アクション」を追加 (日程調整、タスク管理、PR レビュー一覧、新メンバー入会、出席確認、週次リマインド、ロール管理)

## 主なアクション
- **日程調整**: Slack で投票を作成・締切、自動 cron 周期で実施
- **タスク管理**: Slack に sticky task board、複数 channel 対応
- **PR レビュー**: PR レビュー依頼一覧、LGTM 2 件で merged 通知
- **新メンバー入会**: 応募フォーム + 面接官管理 + 自動メール送信 (Gmail) + 状態遷移トリガー
- **ロール管理**: ロール定義 + メンバー割当 + channel 割当 + 同期実行 (invite/kick)
- **出席確認**: Slack 匿名投票 (出席/欠席/未定)
- **週次リマインド**: 曜日 + 時刻でチームチャンネルにメッセージ送信

## 共通機能
- Workspace 管理: Slack ワークスペース連携、Gmail 連携、bot 一括招待
- 公開管理: アクション単位の公開 URL を発行 (パスワード hackit、View/Edit 権限)
- カレンダータブ: 面接官入力 slot + 確定済 application を週グリッドで表示

## 操作のヒント
- 設定変更は対象アクションのサブタブから
- メールテンプレートは {name}, {email}, {meetLink}, {slackInviteLink} 等の placeholder 対応
- Slack 招待リンクは複数登録可、自動監視あり

ユーザーの質問に対して、上記の機能を参照して **簡潔に** 答えてください。
わからない質問には「管理者にお問い合わせください」と返してください。
日本語で回答してください。`;

type GeminiPart = { text: string };
type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };
type GeminiResponse = {
  candidates?: {
    content?: { parts?: { text?: string }[] };
  }[];
  error?: { message?: string };
};

/**
 * Gemini API を叩いて応答テキストを返す。
 * api key 未設定 / API 失敗時は throw する (endpoint 側で 500 にする)。
 */
export async function callGemini(
  env: Env,
  message: string,
  history?: ChatHistoryItem[],
): Promise<string> {
  if (!env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY not configured");
  }
  if (!message.trim()) {
    throw new Error("message is empty");
  }

  // 履歴を Gemini 形式に変換 (assistant → model)。
  // 過剰な履歴 (>20 件) は API トークン圧迫するので直近 20 件のみ送る。
  const trimmedHistory = (history ?? []).slice(-20);
  const contents: GeminiContent[] = [
    ...trimmedHistory.map<GeminiContent>((h) => ({
      role: h.role === "assistant" ? "model" : "user",
      parts: [{ text: h.content }],
    })),
    { role: "user", parts: [{ text: message }] },
  ];

  const requestBody = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 800,
    },
  };

  const url = `${GEMINI_URL}?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });

  const rawText = await res.text();
  if (!res.ok) {
    throw new Error(`Gemini API ${res.status}: ${rawText.slice(0, 500)}`);
  }

  let data: GeminiResponse;
  try {
    data = JSON.parse(rawText) as GeminiResponse;
  } catch {
    throw new Error(`Gemini response parse error: ${rawText.slice(0, 200)}`);
  }
  if (data.error?.message) {
    throw new Error(`Gemini API error: ${data.error.message}`);
  }
  const text =
    data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ??
    "";
  if (!text) {
    throw new Error("Gemini response had no text content");
  }
  return text;
}
