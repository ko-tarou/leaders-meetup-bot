import { useEffect, useState } from "react";
import { WeekCalendarPicker } from "../WeekCalendarPicker";
import { Button } from "../ui/Button";
import { colors } from "../../styles/tokens";

// 005-interviewer / Sprint 25:
// 面接官 1 名の利用可能 slot を編集するエディタ。
// admin の「面接官」サブタブ（編集モード）と、公開ページ /interviewer/:token
// の両方から再利用される。保存先は呼び出し側で `onSave(slots)` を渡して切替える。
//
// initial slots は親で fetch 済みの値を渡す（hooks の責務分離のため）。
// 保存時のローディング・成功表示・エラー表示はここで持つ。

type Props = {
  /** 表示用ラベル（編集対象の説明）。 */
  title?: string;
  /** 編集対象の説明文。 */
  description?: string;
  /** 既に保存済みの slots（UTC ISO の配列）。 */
  initialSlots: string[];
  /** 保存時に呼ぶ。失敗時は throw すれば呼び出し元のエラーをここで表示する。 */
  onSave: (slots: string[]) => Promise<void>;
  /** 戻る等のセカンダリ操作を表示したい場合に使う（任意）。 */
  onBack?: () => void;
  /** 戻るボタンのラベル。 */
  backLabel?: string;
};

export function InterviewerSlotsEditor({
  title,
  description,
  initialSlots,
  onSave,
  onBack,
  backLabel = "← 一覧に戻る",
}: Props) {
  const [slots, setSlots] = useState<string[]>(initialSlots);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // initialSlots が後から差し替わるケース（編集対象を切り替えた）に追従。
  useEffect(() => {
    setSlots(initialSlots);
    setSavedAt(null);
    setError(null);
  }, [initialSlots]);

  const handleSave = async () => {
    setError(null);
    setSaving(true);
    try {
      await onSave(slots);
      setSavedAt(new Date().toISOString());
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ padding: "1rem" }}>
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          style={{
            background: "transparent",
            border: "none",
            color: colors.primary,
            cursor: "pointer",
            fontSize: "0.875rem",
            padding: 0,
            marginBottom: "0.75rem",
          }}
        >
          {backLabel}
        </button>
      )}
      {title && <h3 style={{ marginTop: 0 }}>{title}</h3>}
      {description && (
        <p
          style={{
            color: colors.textSecondary,
            fontSize: "0.875rem",
            marginBottom: "1rem",
          }}
        >
          {description}
        </p>
      )}

      {error && (
        <div
          role="alert"
          style={{
            color: colors.danger,
            marginBottom: "0.5rem",
            fontSize: "0.875rem",
          }}
        >
          {error}
        </div>
      )}

      <WeekCalendarPicker selectedSlots={slots} onChange={setSlots} />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
          marginTop: "1rem",
        }}
      >
        <Button onClick={handleSave} disabled={saving} isLoading={saving}>
          保存
        </Button>
        {savedAt && (
          <span style={{ fontSize: "0.875rem", color: colors.success }}>
            ✓ 保存しました
          </span>
        )}
        <span
          style={{
            fontSize: "0.75rem",
            color: colors.textSecondary,
            marginLeft: "auto",
          }}
        >
          {slots.length} スロット選択中
        </span>
      </div>
    </div>
  );
}
