/**
 * participant_broadcast: 金沢工大 (KIT) 学生メール生成の pure domain。
 *
 * 参加者の学籍番号 (participation_forms.student_id 等) から、KIT 在学生メール
 *   `c<学籍番号>@st.kanazawa-it.ac.jp`
 * を組み立てる純粋関数群。env / db / fetch を一切持たない (副作用ゼロ)。
 *
 * 正規化方針 (hackit-for-participant SHEET_STRUCTURE.md の例に準拠):
 *   - 例: studentId "1234567" -> "c1234567@st.kanazawa-it.ac.jp"
 *   - 学籍番号は 7 桁数字が基本。全角数字は半角へ寄せ、空白・ハイフンは除去する。
 *   - 先頭に英字 1 文字 (例 "c1234567" と入力された場合の c) が付いていたら剥がす
 *     (メール側で必ず "c" を前置するため、二重 "cc" を防ぐ)。
 *   - 剥がした後が数字のみ・6〜9 桁でなければ「不正」として null を返す
 *     (呼び出し側で skipped として集計し、実送信しない)。
 *   - ★桁数レンジ (6〜9) は暫定。確定は運用側の学籍番号仕様に合わせて調整する。
 */

/** KIT 在学生メールのドメイン部。 */
export const KIT_STUDENT_EMAIL_DOMAIN = "st.kanazawa-it.ac.jp";

/** 正規化後に許容する学籍番号 (数字部) の形式。 */
const NORMALIZED_STUDENT_ID_RE = /^\d{6,9}$/;

/** 全角数字 (U+FF10..U+FF19) を半角へ変換する。 */
function toHalfWidthDigits(value: string): string {
  return value.replace(/[０-９]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 0x30),
  );
}

/**
 * 学籍番号を正規化し、KIT メールのローカル部に使う「数字のみの学籍番号」を返す。
 * 正規化できない (空・数字以外が残る・桁数外) 場合は null。
 *
 * 手順: trim -> 全角数字を半角化 -> 空白/ハイフン/全角空白除去 ->
 *       先頭英字 1 文字を剥がす -> 数字 6〜9 桁を検証。
 */
export function normalizeStudentId(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let v = toHalfWidthDigits(String(raw)).trim();
  if (!v) return null;
  // 空白 (半角/全角)・ハイフン・アンダースコアを除去。
  v = v.replace(/[\s　\-_]/g, "");
  // 先頭英字 1 文字 (c/C/b/B 等) を剥がす。学籍番号本体は数字なので安全。
  v = v.replace(/^[A-Za-z]/, "");
  if (!NORMALIZED_STUDENT_ID_RE.test(v)) return null;
  return v;
}

/**
 * 学籍番号から KIT 在学生メール `c<学籍番号>@st.kanazawa-it.ac.jp` を返す。
 * 正規化できない場合は null。
 */
export function studentIdToKitEmail(raw: string | null | undefined): string | null {
  const id = normalizeStudentId(raw);
  if (id == null) return null;
  return `c${id}@${KIT_STUDENT_EMAIL_DOMAIN}`;
}

/** 参加者 1 名分の入力 (学籍番号 + 表示名)。 */
export type ParticipantStudent = {
  studentId: string | null | undefined;
  name: string | null | undefined;
};

/** 学籍番号を KIT メールに変換できなかった参加者。 */
export type SkippedParticipant = {
  name: string;
  /** 生の学籍番号 (空なら "(空)")。ログ用に短縮しない。 */
  studentIdRaw: string;
  reason: "missing_student_id" | "invalid_student_id";
};

export type KitRecipientsResult = {
  /**
   * 既存 broadcast パイプライン (parseRecipients) に渡す宛先テキスト。
   * 各行 `表示名 <email>` 形式 (名前にカンマが有っても壊れない)。
   * 重複除去は下流 parseRecipients が担うのでここではしない。
   */
  recipientsText: string;
  /** 生成できた宛先メール (重複除去前・確認用)。 */
  emails: string[];
  /** 学籍番号が無い/不正で除外した参加者。 */
  skipped: SkippedParticipant[];
};

/**
 * 参加者リストから KIT 宛先テキストを組み立てる。
 * 学籍番号が無い/不正な参加者は skipped に回し、宛先には含めない。
 */
export function buildKitRecipients(
  participants: ParticipantStudent[],
): KitRecipientsResult {
  const lines: string[] = [];
  const emails: string[] = [];
  const skipped: SkippedParticipant[] = [];

  for (const p of participants) {
    const name = (p.name ?? "").trim();
    const raw = (p.studentId ?? "").trim();
    const email = studentIdToKitEmail(raw);
    if (email == null) {
      skipped.push({
        name,
        studentIdRaw: raw === "" ? "(空)" : raw,
        reason: raw === "" ? "missing_student_id" : "invalid_student_id",
      });
      continue;
    }
    emails.push(email);
    // `表示名 <email>` 形式。表示名が空ならメールのみ。
    lines.push(name ? `${name} <${email}>` : email);
  }

  return { recipientsText: lines.join("\n"), emails, skipped };
}
