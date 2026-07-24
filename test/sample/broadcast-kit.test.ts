/**
 * participant_broadcast: KIT 学生メール生成 pure domain の unit テスト。
 * 本番 export を無改変で import して挙動を固定する。
 * ※ 学籍番号はすべてダミー (実在番号を使わない)。
 */
import { describe, it, expect } from "vitest";
import {
  normalizeStudentId,
  studentIdToKitEmail,
  buildKitRecipients,
  KIT_STUDENT_EMAIL_DOMAIN,
} from "../../src/domain/broadcast/kit";

describe("normalizeStudentId", () => {
  it("7 桁数字はそのまま返す", () => {
    expect(normalizeStudentId("1234567")).toBe("1234567");
  });
  it("先頭 c を剥がす", () => {
    expect(normalizeStudentId("c1234567")).toBe("1234567");
    expect(normalizeStudentId("C1234567")).toBe("1234567");
  });
  it("空白・ハイフンを除去する", () => {
    expect(normalizeStudentId(" 123 4567 ")).toBe("1234567");
    expect(normalizeStudentId("123-4567")).toBe("1234567");
  });
  it("全角数字を半角化する", () => {
    expect(normalizeStudentId("１２３４５６７")).toBe("1234567");
  });
  it("不正 (空・数字以外残る・桁数外) は null", () => {
    expect(normalizeStudentId("")).toBeNull();
    expect(normalizeStudentId(null)).toBeNull();
    expect(normalizeStudentId("abc")).toBeNull();
    expect(normalizeStudentId("12ab34")).toBeNull();
    expect(normalizeStudentId("123")).toBeNull(); // 短すぎ
    expect(normalizeStudentId("1234567890")).toBeNull(); // 長すぎ
  });
});

describe("studentIdToKitEmail", () => {
  it("学籍番号 -> KIT 在学生メール", () => {
    expect(studentIdToKitEmail("1234567")).toBe(
      `c1234567@${KIT_STUDENT_EMAIL_DOMAIN}`,
    );
    // 先頭 c 付き入力でも二重 cc にならない
    expect(studentIdToKitEmail("c7654321")).toBe(
      `c7654321@${KIT_STUDENT_EMAIL_DOMAIN}`,
    );
  });
  it("不正な学籍番号は null", () => {
    expect(studentIdToKitEmail("")).toBeNull();
    expect(studentIdToKitEmail("xxx")).toBeNull();
  });
});

describe("buildKitRecipients", () => {
  it("学籍番号 -> 宛先テキスト (表示名 <email>) と skipped を返す", () => {
    const result = buildKitRecipients([
      { studentId: "1234567", name: "田中太郎" },
      { studentId: "c7654321", name: "山田花子" },
      { studentId: "", name: "学籍番号なし" }, // missing
      { studentId: "abc", name: "不正番号" }, // invalid
      { studentId: "1112223", name: "" }, // 名前なし -> email のみ
    ]);

    expect(result.emails).toEqual([
      `c1234567@${KIT_STUDENT_EMAIL_DOMAIN}`,
      `c7654321@${KIT_STUDENT_EMAIL_DOMAIN}`,
      `c1112223@${KIT_STUDENT_EMAIL_DOMAIN}`,
    ]);
    expect(result.recipientsText.split("\n")).toEqual([
      `田中太郎 <c1234567@${KIT_STUDENT_EMAIL_DOMAIN}>`,
      `山田花子 <c7654321@${KIT_STUDENT_EMAIL_DOMAIN}>`,
      `c1112223@${KIT_STUDENT_EMAIL_DOMAIN}`,
    ]);
    expect(result.skipped).toEqual([
      { name: "学籍番号なし", studentIdRaw: "(空)", reason: "missing_student_id" },
      { name: "不正番号", studentIdRaw: "abc", reason: "invalid_student_id" },
    ]);
  });

  it("空入力は空の結果", () => {
    expect(buildKitRecipients([])).toEqual({
      recipientsText: "",
      emails: [],
      skipped: [],
    });
  });
});
