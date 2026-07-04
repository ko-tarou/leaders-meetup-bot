import { useState } from "react";
import type { EventAction } from "../../types";
import { api } from "../../api";
import { useToast } from "../ui/Toast";
import { colors } from "../../styles/tokens";

// app_management のメイン画面。
// - config.links = [{label, url}] を「開く」ボタンとして大きく表示
//   (コテージなら 表示コンテンツ編集 / タイムテーブル編集 への導線)。
// - 「リンクを編集」でフォーム編集 (追加 / 削除 / 上下入替 / 保存)。生 JSON は
//   触らせない。URL は同一 origin のパス (/ 始まり) のみ許可 (外部リンク注入防止)。

export type AppLink = { label: string; url: string };

export function parseAppLinks(configJson: string): AppLink[] {
  try {
    const cfg = JSON.parse(configJson || "{}") as { links?: unknown };
    if (Array.isArray(cfg.links)) {
      return cfg.links.filter(
        (l): l is AppLink =>
          !!l &&
          typeof (l as AppLink).label === "string" &&
          typeof (l as AppLink).url === "string" &&
          (l as AppLink).url.startsWith("/"),
      );
    }
  } catch {
    // 壊れた config は空扱い (編集して保存すれば復旧できる)
  }
  return [];
}

export function AppManagementTab({
  eventId,
  action,
  onSaved,
}: {
  eventId: string;
  action: EventAction;
  onSaved: () => void;
}) {
  const toast = useToast();
  const links = parseAppLinks(action.config);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<AppLink[]>([]);
  const [saving, setSaving] = useState(false);

  const startEdit = () => {
    setDraft(links.map((l) => ({ ...l })));
    setEditing(true);
  };

  const handleSave = async () => {
    const cleaned: AppLink[] = [];
    for (let i = 0; i < draft.length; i++) {
      const label = draft[i].label.trim();
      const url = draft[i].url.trim();
      if (!label && !url) continue; // 空行は無視
      if (!label) {
        toast.error(`リンク ${i + 1}: ラベルを入力してください`);
        return;
      }
      if (!url.startsWith("/")) {
        toast.error(`リンク ${i + 1}: URL は / から始まるパスにしてください`);
        return;
      }
      cleaned.push({ label, url });
    }
    setSaving(true);
    try {
      // 既存 config の他キー (schemaVersion 等) は壊さずマージする。
      let cfg: Record<string, unknown> = {};
      try {
        cfg = (JSON.parse(action.config || "{}") ?? {}) as Record<string, unknown>;
      } catch {
        cfg = {};
      }
      cfg.schemaVersion = cfg.schemaVersion ?? 1;
      cfg.links = cleaned;
      await api.events.actions.update(eventId, action.id, {
        config: JSON.stringify(cfg),
      });
      toast.success("リンクを保存しました");
      setEditing(false);
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= draft.length) return;
    const next = [...draft];
    [next[i], next[j]] = [next[j], next[i]];
    setDraft(next);
  };

  if (editing) {
    return (
      <div>
        <h3 style={{ margin: "0 0 0.5rem", fontSize: "1rem" }}>リンクを編集</h3>
        <p style={{ margin: "0 0 1rem", fontSize: "0.85rem", color: colors.textSecondary }}>
          編集ページへのボタンを設定します。URL はこのサイト内のパス (/ から始まる) のみ有効です。
        </p>
        <div style={{ display: "grid", gap: "0.5rem" }}>
          {draft.map((l, i) => (
            <div key={i} style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
              <input
                value={l.label}
                placeholder="ラベル (例: 表示コンテンツを編集)"
                onChange={(e) =>
                  setDraft(draft.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))
                }
                style={inputStyle}
              />
              <input
                value={l.url}
                placeholder="/admin/cottage/content"
                onChange={(e) =>
                  setDraft(draft.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))
                }
                style={{ ...inputStyle, minWidth: "14rem" }}
              />
              <button onClick={() => move(i, -1)} style={miniBtnStyle} aria-label={`リンク${i + 1}を上へ`}>↑</button>
              <button onClick={() => move(i, 1)} style={miniBtnStyle} aria-label={`リンク${i + 1}を下へ`}>↓</button>
              <button
                onClick={() => setDraft(draft.filter((_, j) => j !== i))}
                style={{ ...miniBtnStyle, color: colors.danger, borderColor: colors.danger }}
              >
                削除
              </button>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem" }}>
          <button
            onClick={() => setDraft([...draft, { label: "", url: "" }])}
            style={secondaryBtnStyle}
          >
            ＋ リンクを追加
          </button>
          <button onClick={handleSave} disabled={saving} style={primaryBtnStyle}>
            {saving ? "保存中..." : "保存"}
          </button>
          <button onClick={() => setEditing(false)} disabled={saving} style={secondaryBtnStyle}>
            キャンセル
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <p style={{ margin: "0 0 1rem", fontSize: "0.875rem", color: colors.textSecondary }}>
        アプリに配信する表示内容の編集ページを開きます。
      </p>
      {links.length === 0 ? (
        <p style={{ color: colors.textMuted, fontSize: "0.875rem" }}>
          リンクが未設定です。「リンクを編集」から編集ページの URL を追加してください。
        </p>
      ) : (
        <div style={{ display: "grid", gap: "0.75rem", maxWidth: "28rem" }}>
          {links.map((l) => (
            <a
              key={l.url}
              href={l.url}
              style={{
                display: "block",
                padding: "0.9rem 1rem",
                border: `1px solid ${colors.border}`,
                borderRadius: "0.5rem",
                background: colors.background,
                color: colors.primary,
                fontWeight: 600,
                textDecoration: "none",
              }}
            >
              {l.label} →
            </a>
          ))}
        </div>
      )}
      <button onClick={startEdit} style={{ ...secondaryBtnStyle, marginTop: "1rem" }}>
        リンクを編集
      </button>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "0.45rem 0.6rem",
  border: `1px solid ${colors.borderStrong}`,
  borderRadius: "0.25rem",
  fontSize: "0.875rem",
  flex: 1,
  minWidth: "10rem",
};

const miniBtnStyle: React.CSSProperties = {
  padding: "0.35rem 0.6rem",
  border: `1px solid ${colors.borderStrong}`,
  background: colors.background,
  borderRadius: "0.25rem",
  cursor: "pointer",
  fontSize: "0.8rem",
};

const primaryBtnStyle: React.CSSProperties = {
  background: colors.primary,
  color: colors.textInverse,
  border: "none",
  padding: "0.5rem 1rem",
  borderRadius: "0.25rem",
  cursor: "pointer",
};

const secondaryBtnStyle: React.CSSProperties = {
  padding: "0.5rem 1rem",
  border: `1px solid ${colors.borderStrong}`,
  background: colors.background,
  borderRadius: "0.25rem",
  cursor: "pointer",
};
