import type { EventAction } from "../types";
import { MemberWelcomeConfigForm } from "./MemberWelcomeConfigForm";

// ADR-0008 / Sprint 11 PR2:
// アクション種別ごとの設定エディタを振り分けるモーダル。
// 将来的に task_management / pr_review_list / schedule_polling の
// 専用フォームを追加する想定。

type Props = {
  eventId: string;
  action: EventAction;
  onClose: () => void;
  onSaved: () => void;
};

export function ActionConfigModal({
  eventId,
  action,
  onClose,
  onSaved,
}: Props) {
  const renderForm = () => {
    switch (action.actionType) {
      case "member_welcome":
        return (
          <MemberWelcomeConfigForm
            eventId={eventId}
            action={action}
            onClose={onClose}
            onSaved={onSaved}
          />
        );
      // 将来: task_management, pr_review_list, schedule_polling もここに追加
      default:
        return (
          <div style={{ padding: "1rem", color: "#6b7280" }}>
            このアクションには専用設定がありません。
            <br />
            生 JSON で編集する場合は将来追加予定。
            <div
              style={{
                marginTop: "1rem",
                display: "flex",
                justifyContent: "flex-end",
              }}
            >
              <button
                onClick={onClose}
                style={{
                  padding: "0.5rem 1rem",
                  border: "1px solid #d1d5db",
                  background: "#fff",
                  borderRadius: "0.25rem",
                  cursor: "pointer",
                }}
              >
                閉じる
              </button>
            </div>
          </div>
        );
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "white",
          padding: "1.5rem",
          borderRadius: "0.5rem",
          width: "min(600px, 95vw)",
          maxHeight: "90vh",
          overflow: "auto",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0 }}>アクション設定</h3>
        {renderForm()}
      </div>
    </div>
  );
}
