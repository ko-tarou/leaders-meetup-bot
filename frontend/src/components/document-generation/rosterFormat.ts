// document_generation (名簿生成): 表示用の整形ヘルパー (純関数・unit テスト対象)。

// participation_forms.grade ('1'|'2'|'3'|'4'|'graduate' 等) を表示ラベルにする。
export function gradeLabel(grade: string | null): string {
  if (!grade) return "";
  if (grade === "graduate") return "院";
  // 数値学年は「N年」。想定外の値はそのまま返す。
  return /^[1-9]$/.test(grade) ? `${grade}年` : grade;
}

// 「クラス」列 = 学年 + 学科 を 1 セルにまとめる。
// どちらも無ければ "-"。片方だけならその片方。
export function formatClass(
  grade: string | null,
  department: string | null,
): string {
  const g = gradeLabel(grade).trim();
  const d = (department ?? "").trim();
  const joined = [g, d].filter((s) => s.length > 0).join(" ");
  return joined.length > 0 ? joined : "-";
}
