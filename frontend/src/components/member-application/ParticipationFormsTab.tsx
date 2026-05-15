import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { api } from "../../api";
import type { EventAction, ParticipationForm } from "../../types";
import { Button } from "../ui/Button";
import { useToast } from "../ui/Toast";
import { colors } from "../../styles/tokens";

// participation-form Phase1 PR4:
// member_application action の「参加届」サブタブ。
//
// 合格者が合格メール内の共通 URL から提出した参加届を閲覧する (Phase1 は閲覧のみ)。
// admin API GET /orgs/:eventId/participation-forms (x-admin-token) を呼び、
// ParticipationForm[] を submittedAt 降順で受け取りカード表示する。
//
// 提出種別: applicationId が非 null なら「応募紐付き」、null なら「直接応募」。

type Props = {
  eventId: string;
  action: EventAction;
};

// ラベル変換マップ。BE / フォームの選択肢キーと一対一対応。
const GRADE_LABEL: Record<string, string> = {
  "1": "1年",
  "2": "2年",
  "3": "3年",
  "4": "4年",
  graduate: "院生",
};

const GENDER_LABEL: Record<string, string> = {
  male: "男性",
  female: "女性",
  other: "その他",
  prefer_not: "回答しない",
};

const ACTIVITY_LABEL: Record<string, string> = {
  event: "イベント運営",
  dev: "チーム開発",
  both: "両方",
};

const DEV_ROLE_LABEL: Record<string, string> = {
  pm: "PM",
  frontend: "フロントエンド",
  backend: "バックエンド",
  android: "Android",
  ios: "iOS",
  infra: "インフラ",
};

const EMPTY = "—";

/** null / 空文字を一貫して「—」に正規化して表示する。 */
function display(value: string | null | undefined): string {
  const v = (value ?? "").trim();
  return v === "" ? EMPTY : v;
}

/** key を label マップで変換。未知キー / 空は「—」。 */
function label(map: Record<string, string>, value: string | null): string {
  if (!value) return EMPTY;
  return map[value] ?? value;
}

export function ParticipationFormsTab({ eventId, action }: Props) {
  // action は member_application sub-tab の共通 props 形に合わせて受け取るが、
  // Phase1 は eventId 単位の一覧のみ参照する (将来の action 別表示用に保持)。
  void action;
  const toast = useToast();
  const [forms, setForms] = useState<ParticipationForm[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setForms(null);
    setError(null);
    api.participation
      .adminList(eventId)
      .then((list) => {
        if (cancelled) return;
        setForms(Array.isArray(list) ? list : []);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setForms([]);
        const msg = e instanceof Error ? e.message : "読み込みに失敗しました";
        setError(msg);
        toast.error(msg);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, toast]);

  const participationUrl = `${window.location.origin}/participation/${eventId}`;
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(participationUrl);
      toast.success("URL をコピーしました");
    } catch {
      toast.error("コピーに失敗しました");
    }
  };

  if (forms === null) {
    return (
      <div style={{ padding: "1rem", color: colors.textSecondary }}>
        読み込み中...
      </div>
    );
  }

  return (
    <div style={s.wrap}>
      <section style={s.shareBox} aria-label="参加届フォーム URL">
        <div style={s.shareLabel}>参加届フォーム URL</div>
        <p style={s.shareDesc}>
          このリンクを共有すると、誰でも参加届を記入できます。合格者には合格メールに個別リンクが自動で添付されます。
        </p>
        <div style={s.shareRow}>
          <input
            readOnly
            value={participationUrl}
            style={s.shareInput}
            aria-label="参加届フォーム URL"
            onFocus={(e) => e.currentTarget.select()}
          />
          <Button size="sm" onClick={handleCopy}>
            コピー
          </Button>
        </div>
      </section>

      <h3 style={s.h3}>参加届 ({forms.length}件)</h3>

      {error && (
        <div role="alert" style={s.error}>
          {error}
        </div>
      )}

      {forms.length === 0 ? (
        <div style={s.empty}>まだ参加届の提出がありません。</div>
      ) : (
        <div style={s.list}>
          {forms.map((f) => {
            const linked = f.applicationId !== null;
            const roleLabels = f.devRoles
              .map((r) => DEV_ROLE_LABEL[r] ?? r)
              .filter((r) => r.length > 0);
            const fields: { label: string; value: string }[] = [
              { label: "Slack表示名", value: display(f.slackName) },
              { label: "学籍番号", value: display(f.studentId) },
              { label: "学科", value: display(f.department) },
              { label: "学年", value: label(GRADE_LABEL, f.grade) },
              { label: "メール", value: display(f.email) },
              { label: "性別", value: label(GENDER_LABEL, f.gender) },
              {
                label: "アレルギー",
                value: f.hasAllergy ? `有: ${display(f.allergyDetail)}` : "無",
              },
              { label: "他の所属", value: display(f.otherAffiliations) },
              {
                label: "希望する活動",
                value: label(ACTIVITY_LABEL, f.desiredActivity),
              },
            ];
            return (
              <div key={f.id} style={s.card}>
                <div style={s.cardHeader}>
                  <span style={s.name}>{display(f.name)}</span>
                  <span style={linked ? s.badgeLinked : s.badgeDirect}>
                    {linked ? "応募紐付き" : "直接応募"}
                  </span>
                </div>

                <dl style={s.grid}>
                  {fields.map((fl) => (
                    <div key={fl.label} style={s.field}>
                      <dt style={s.fieldLabel}>{fl.label}</dt>
                      <dd style={s.fieldValue}>{fl.value}</dd>
                    </div>
                  ))}
                </dl>

                <div style={s.rolesRow}>
                  <span style={s.fieldLabel}>希望役職</span>
                  {roleLabels.length === 0 ? (
                    <span style={s.fieldValue}>{EMPTY}</span>
                  ) : (
                    <div style={s.chips}>
                      {roleLabels.map((r) => (
                        <span key={r} style={s.chip}>
                          {r}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                <div style={s.submittedAt}>
                  提出日時: {new Date(f.submittedAt).toLocaleString("ja-JP")}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const badgeBase: CSSProperties = {
  flexShrink: 0,
  padding: "0.125rem 0.5rem",
  borderRadius: 999,
  fontSize: "0.7rem",
  fontWeight: 600,
};

const s: Record<string, CSSProperties> = {
  wrap: { padding: "1rem" },
  shareBox: {
    padding: "0.75rem 1rem",
    background: colors.primarySubtle,
    border: `1px solid ${colors.primary}`,
    borderRadius: "0.5rem",
    marginBottom: "1rem",
  },
  shareLabel: {
    fontSize: "0.75rem",
    color: colors.textSecondary,
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    marginBottom: "0.25rem",
  },
  shareDesc: {
    margin: "0 0 0.5rem",
    fontSize: "0.8rem",
    color: colors.text,
    lineHeight: 1.5,
  },
  shareRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    flexWrap: "wrap",
  },
  shareInput: {
    flex: "1 1 280px",
    minWidth: 0,
    padding: "0.4rem 0.5rem",
    border: `1px solid ${colors.borderStrong}`,
    borderRadius: "0.375rem",
    fontFamily: "monospace",
    fontSize: "0.8rem",
    background: colors.background,
    color: colors.text,
  },
  h3: { margin: "0 0 0.75rem", fontSize: "1rem" },
  list: { display: "flex", flexDirection: "column", gap: "0.75rem" },
  card: {
    padding: "0.875rem 1rem",
    border: `1px solid ${colors.border}`,
    borderRadius: 8,
    background: colors.surface,
  },
  cardHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "0.5rem",
    marginBottom: "0.625rem",
  },
  name: {
    fontSize: "0.95rem",
    fontWeight: 600,
    color: colors.text,
    wordBreak: "break-word",
  },
  badgeLinked: {
    ...badgeBase,
    background: colors.successSubtle,
    color: colors.success,
  },
  badgeDirect: {
    ...badgeBase,
    background: colors.primarySubtle,
    color: colors.primary,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
    gap: "0.5rem 1rem",
    margin: 0,
  },
  field: { minWidth: 0 },
  fieldLabel: {
    fontSize: "0.7rem",
    color: colors.textSecondary,
    marginBottom: "0.0625rem",
  },
  fieldValue: {
    margin: 0,
    fontSize: "0.875rem",
    color: colors.text,
    wordBreak: "break-word",
    whiteSpace: "pre-wrap",
  },
  rolesRow: { marginTop: "0.625rem" },
  chips: {
    display: "flex",
    flexWrap: "wrap",
    gap: "0.25rem",
    marginTop: "0.1875rem",
  },
  chip: {
    padding: "0.125rem 0.5rem",
    borderRadius: 4,
    fontSize: "0.75rem",
    background: colors.primarySubtle,
    color: colors.primary,
  },
  submittedAt: {
    marginTop: "0.625rem",
    fontSize: "0.75rem",
    color: colors.textMuted,
  },
  empty: {
    padding: "1.5rem",
    textAlign: "center",
    color: colors.textSecondary,
    background: colors.surface,
    border: `1px dashed ${colors.border}`,
    borderRadius: 6,
  },
  error: {
    padding: "0.5rem 0.75rem",
    background: colors.dangerSubtle,
    color: colors.danger,
    borderRadius: 6,
    fontSize: "0.875rem",
    marginBottom: "0.75rem",
  },
};
