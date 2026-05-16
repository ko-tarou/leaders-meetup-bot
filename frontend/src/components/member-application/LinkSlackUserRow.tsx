import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { api } from "../../api";
import type { SlackUser } from "../../types";
import { Button } from "../ui/Button";
import { useToast } from "../ui/Toast";
import { colors } from "../../styles/tokens";

// 未解決 (slackUserId=null) の提出に対する手動紐付け UI。
// roleManagementActionId が未設定なら注記のみ。設定済みなら workspace
// メンバーを取得し、検索 → 選択 → 実行で linkSlackUser (付与は BE 側)。
//
// ParticipationFormsTab から振る舞いを変えずに切り出したコンポーネント。
export function LinkSlackUserRow({
  eventId,
  formId,
  roleManagementActionId,
  disabled,
  onLinked,
}: {
  eventId: string;
  formId: string;
  roleManagementActionId: string;
  disabled: boolean;
  onLinked: () => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<SlackUser[] | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // open かつ actionId 設定済みのときだけ取得。actionId 変化時のみ再取得。
  useEffect(() => {
    if (!open || !roleManagementActionId) return;
    let cancelled = false;
    setMembers(null);
    api.roles
      .workspaceMembers(eventId, roleManagementActionId)
      .then((list) => {
        if (cancelled) return;
        setMembers(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (cancelled) return;
        setMembers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, eventId, roleManagementActionId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = members ?? [];
    if (!q) return all.slice(0, 100);
    return all
      .filter(
        (u) =>
          u.name.toLowerCase().includes(q) ||
          (u.realName?.toLowerCase().includes(q) ?? false) ||
          (u.displayName?.toLowerCase().includes(q) ?? false) ||
          u.id.toLowerCase().includes(q),
      )
      .slice(0, 100);
  }, [members, search]);

  if (!roleManagementActionId) {
    return (
      <div style={s.linkNote}>
        手動紐付けには「ロール自動割当設定」でロール管理アクションを先に設定してください。
      </div>
    );
  }

  if (!open) {
    return (
      <div style={s.linkRow}>
        <Button
          size="sm"
          variant="secondary"
          disabled={disabled}
          onClick={() => setOpen(true)}
        >
          Slackユーザーを紐付け
        </Button>
      </div>
    );
  }

  const handleLink = async () => {
    if (!selected) {
      toast.error("ユーザーを選択してください");
      return;
    }
    setSubmitting(true);
    try {
      await api.participation.linkSlackUser(eventId, formId, selected);
      toast.success("Slackユーザーを紐付け、ロールを付与しました");
      onLinked();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "紐付けに失敗しました");
      setSubmitting(false);
    }
  };

  return (
    <div style={s.linkBox}>
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="名前 / @handle / User ID で検索..."
        style={s.linkSearch}
        disabled={submitting}
      />
      <div style={s.linkList}>
        {members === null ? (
          <div style={s.mapMuted}>メンバー取得中...</div>
        ) : filtered.length === 0 ? (
          <div style={s.mapMuted}>該当するメンバーがいません</div>
        ) : (
          filtered.map((u) => (
            <label key={u.id} style={s.linkOption}>
              <input
                type="radio"
                name={`link-${formId}`}
                checked={selected === u.id}
                onChange={() => setSelected(u.id)}
                disabled={submitting}
              />
              <span>
                {u.displayName || u.realName || u.name}{" "}
                <span style={s.mapMuted}>@{u.name}</span>
              </span>
            </label>
          ))
        )}
      </div>
      <div style={s.linkActions}>
        <Button
          size="sm"
          disabled={submitting || !selected}
          onClick={() => void handleLink()}
        >
          {submitting ? "紐付け中..." : "紐付けて付与"}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={submitting}
          onClick={() => setOpen(false)}
        >
          キャンセル
        </Button>
      </div>
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  mapMuted: { fontSize: "0.8rem", color: colors.textMuted },
  linkRow: { marginTop: "0.625rem" },
  linkNote: {
    marginTop: "0.625rem",
    fontSize: "0.75rem",
    color: colors.textMuted,
  },
  linkBox: {
    marginTop: "0.625rem",
    padding: "0.625rem",
    border: `1px solid ${colors.borderStrong}`,
    borderRadius: 6,
    background: colors.background,
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
  },
  linkSearch: {
    padding: "0.4rem 0.5rem",
    border: `1px solid ${colors.borderStrong}`,
    borderRadius: 4,
    fontSize: "0.8rem",
    background: colors.background,
    color: colors.text,
  },
  linkList: {
    maxHeight: 200,
    overflowY: "auto",
    border: `1px solid ${colors.border}`,
    borderRadius: 4,
    padding: "0.25rem",
  },
  linkOption: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    padding: "0.25rem 0.375rem",
    fontSize: "0.8rem",
    cursor: "pointer",
  },
  linkActions: { display: "flex", gap: "0.5rem" },
};
