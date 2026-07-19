/**
 * participant_broadcast: 参加者一斉送信の pure domain。
 *
 * 宛先リスト (貼り付けテキスト) の parse / 正規化 / 重複除去と、件名・本文
 * テンプレの差し込みを扱う純粋関数群。env / db / fetch を一切持たない
 * (副作用ゼロ) ので unit テストで挙動を固定できる。
 *
 * 差し込み記法は lmb 既存テンプレ (application-email 等) と揃えて単一波括弧
 * `{name}` `{email}` を使う (renderTemplate と互換)。
 */

export type Recipient = {
  /** 小文字化・trim 済みのメールアドレス。 */
  email: string;
  /** 表示名 (差し込み {name} 用)。無ければ空文字。 */
  name: string;
};

/**
 * ごく緩いメール形式チェック。厳密な RFC 検証はせず、明らかな不正
 * (空白含む・@ が無い・ドメインにドットが無い) だけ弾く。
 */
export function isLikelyEmail(value: string): boolean {
  const v = value.trim();
  if (!v || /\s/.test(v)) return false;
  const at = v.indexOf("@");
  if (at <= 0 || at !== v.lastIndexOf("@")) return false;
  const domain = v.slice(at + 1);
  return domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".");
}

/**
 * 1 行を 1 宛先として parse する。対応フォーマット:
 *   - `foo@example.com`
 *   - `foo@example.com,山田太郎`            (カンマ or タブ区切り: 先頭=メール)
 *   - `山田太郎 <foo@example.com>`           (RFC 風 表示名 + 山括弧)
 * 解析できない行は null を返す (呼び出し側で invalid として集計する)。
 */
export function parseRecipientLine(line: string): Recipient | null {
  const raw = line.trim();
  if (!raw) return null;

  // `Name <email>` 形式
  const angle = raw.match(/^(.*?)<([^<>]+)>\s*$/);
  if (angle) {
    const name = angle[1].trim().replace(/^["']|["']$/g, "");
    const email = angle[2].trim().toLowerCase();
    if (!isLikelyEmail(email)) return null;
    return { email, name };
  }

  // カンマ / タブ区切り (先頭カラムをメールとして扱う)
  const parts = raw.split(/[,\t]/).map((p) => p.trim());
  const email = (parts[0] ?? "").toLowerCase();
  if (!isLikelyEmail(email)) return null;
  const name = (parts[1] ?? "").replace(/^["']|["']$/g, "").trim();
  return { email, name };
}

export type ParseRecipientsResult = {
  /** 正常に parse でき、重複除去済みの宛先。 */
  recipients: Recipient[];
  /** parse できなかった行 (原文)。 */
  invalidLines: string[];
  /** 重複により除外されたメール数 (同一メールの 2 回目以降)。 */
  duplicateCount: number;
};

/**
 * 貼り付けテキスト全体を parse する。改行区切り。
 * 同一メール (小文字比較) は最初の 1 件だけ残す。
 */
export function parseRecipients(text: string | null | undefined): ParseRecipientsResult {
  const lines = (text ?? "").split(/\r?\n/);
  const recipients: Recipient[] = [];
  const invalidLines: string[] = [];
  const seen = new Set<string>();
  let duplicateCount = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    const parsed = parseRecipientLine(line);
    if (!parsed) {
      invalidLines.push(line.trim());
      continue;
    }
    if (seen.has(parsed.email)) {
      duplicateCount++;
      continue;
    }
    seen.add(parsed.email);
    recipients.push(parsed);
  }

  return { recipients, invalidLines, duplicateCount };
}

/**
 * participant_broadcast の action.config スキーマ (JSON 文字列で保存)。
 * 全 field optional。未設定は UI 側で空扱い。
 */
export type BroadcastConfig = {
  /** 送信元 Gmail アカウント (gmail_accounts.id)。未設定なら送信不可。 */
  gmailAccountId?: string;
  /** 宛先貼り付けテキスト (下書き保存用)。 */
  recipientsText?: string;
  /** 件名テンプレ。 */
  subject?: string;
  /** 本文テンプレ (plain text)。{name} {email} 差し込み対応。 */
  body?: string;
};

export function readBroadcastConfig(
  rawConfig: string | null | undefined,
): BroadcastConfig {
  if (!rawConfig) return {};
  try {
    const parsed = JSON.parse(rawConfig) as { [k: string]: unknown };
    const out: BroadcastConfig = {};
    if (typeof parsed.gmailAccountId === "string") out.gmailAccountId = parsed.gmailAccountId;
    if (typeof parsed.recipientsText === "string") out.recipientsText = parsed.recipientsText;
    if (typeof parsed.subject === "string") out.subject = parsed.subject;
    if (typeof parsed.body === "string") out.body = parsed.body;
    return out;
  } catch {
    return {};
  }
}
