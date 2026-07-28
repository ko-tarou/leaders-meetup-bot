import { useCallback, useEffect, useRef, useState } from "react";
import type { EventAction } from "../../types";
import { api, APIError } from "../../api";
import type { RosterDocument } from "../../api/documents";
import { useToast } from "../ui/Toast";
import { colors } from "../../styles/tokens";
import { formatClass } from "./rosterFormat";
import { downloadRosterPdf } from "./rosterPdf";

// document_generation のメイン画面。
//
// 「名簿生成」タブ:
//   参加届 (participation_forms) × role_management のロール割当から名簿を
//   都度算出して表示する (保存しないので、参加届が出てロールにサインされると
//   再読み込みで即反映される)。列は 名前 / フリガナ / クラス / Gmail / 所属チーム。
//   チーム (ロール) 別にまとめ、「PDF をダウンロード」で名簿 PDF を保存できる。

type SubTab = "roster";

const printableWrapStyle: React.CSSProperties = {
  // html2canvas での取り込み対象。背景/文字色を明示 (hex) して確実にラスタライズする。
  backgroundColor: "#ffffff",
  color: "#111827",
  padding: "16px",
};

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fileDateStamp(iso: string): string {
  const d = new Date(iso);
  const base = Number.isNaN(d.getTime()) ? new Date() : d;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${base.getFullYear()}${p(base.getMonth() + 1)}${p(base.getDate())}`;
}

export function DocumentGenerationMainTab({
  eventId,
  action,
}: {
  eventId: string;
  action: EventAction;
}) {
  const toast = useToast();
  const [subTab] = useState<SubTab>("roster");
  const [doc, setDoc] = useState<RosterDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const printableRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await api.documents.roster(eventId, action.id);
      setDoc(d);
    } catch (e) {
      const msg =
        e instanceof APIError ? `${e.status} ${e.statusText}` : String(e);
      setError(`名簿の取得に失敗しました (${msg})`);
    } finally {
      setLoading(false);
    }
  }, [eventId, action.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleDownload = useCallback(async () => {
    const el = printableRef.current;
    if (!el || !doc) return;
    setDownloading(true);
    try {
      await downloadRosterPdf(el, `名簿_${fileDateStamp(doc.generatedAt)}.pdf`);
      toast.success("名簿 PDF をダウンロードしました");
    } catch (e) {
      toast.error(`PDF の生成に失敗しました (${String(e)})`);
    } finally {
      setDownloading(false);
    }
  }, [doc, toast]);

  return (
    <div>
      {/* サブタブ (現状は「名簿生成」のみ・将来のドキュメント種別追加を見越した枠) */}
      <div
        style={{
          display: "flex",
          gap: "4px",
          borderBottom: `1px solid ${colors.border}`,
          marginBottom: "16px",
        }}
      >
        <div
          style={{
            padding: "8px 16px",
            fontWeight: 600,
            fontSize: "0.875rem",
            color: subTab === "roster" ? colors.primary : colors.textSecondary,
            borderBottom:
              subTab === "roster"
                ? `2px solid ${colors.primary}`
                : "2px solid transparent",
          }}
        >
          名簿生成
        </div>
      </div>

      {/* ツールバー */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          marginBottom: "12px",
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          style={{
            padding: "6px 12px",
            fontSize: "0.875rem",
            borderRadius: "6px",
            border: `1px solid ${colors.borderStrong}`,
            background: colors.background,
            color: colors.text,
            cursor: loading ? "default" : "pointer",
          }}
        >
          {loading ? "読み込み中…" : "再読み込み"}
        </button>
        <button
          type="button"
          onClick={() => void handleDownload()}
          disabled={loading || downloading || !doc}
          style={{
            padding: "6px 12px",
            fontSize: "0.875rem",
            borderRadius: "6px",
            border: "none",
            background:
              loading || downloading || !doc
                ? colors.borderStrong
                : colors.primary,
            color: colors.textInverse,
            cursor: loading || downloading || !doc ? "default" : "pointer",
          }}
        >
          {downloading ? "PDF 生成中…" : "📄 PDF をダウンロード"}
        </button>
        {doc && (
          <span style={{ fontSize: "0.75rem", color: colors.textSecondary }}>
            生成時刻: {fmtDate(doc.generatedAt)} / 対象 {doc.totalMembers} 名
          </span>
        )}
      </div>

      {error && (
        <div
          style={{
            padding: "12px",
            borderRadius: "6px",
            background: colors.dangerSubtle,
            color: colors.danger,
            fontSize: "0.875rem",
            marginBottom: "12px",
          }}
        >
          {error}
        </div>
      )}

      {doc && !doc.hasRoleManagement && (
        <div
          style={{
            padding: "12px",
            borderRadius: "6px",
            background: colors.warningSubtle,
            color: colors.warning,
            fontSize: "0.875rem",
            marginBottom: "12px",
          }}
        >
          このイベントに「ロール管理」アクションが見つかりません。名簿は
          ロール割当を元に生成されるため、先にロール管理アクションを作成し、
          参加者をチーム (ロール) に割り当ててください。
        </div>
      )}

      {/* PDF 取り込み対象 (画面表示と同一要素をラスタライズする) */}
      <div ref={printableRef} style={printableWrapStyle}>
        <h2
          style={{
            fontSize: "1.125rem",
            fontWeight: 700,
            margin: "0 0 4px",
            color: "#111827",
          }}
        >
          カンファレンス運営 名簿
        </h2>
        {doc && (
          <div
            style={{
              fontSize: "0.75rem",
              color: "#6b7280",
              marginBottom: "12px",
            }}
          >
            生成時刻 {fmtDate(doc.generatedAt)}・対象 {doc.totalMembers} 名
          </div>
        )}

        {loading && (
          <div style={{ color: "#6b7280", fontSize: "0.875rem" }}>
            読み込み中…
          </div>
        )}

        {doc &&
          !loading &&
          doc.roles.length === 0 &&
          doc.unassigned.length === 0 && (
            <div style={{ color: "#6b7280", fontSize: "0.875rem" }}>
              名簿に載せる参加者がまだいません。
            </div>
          )}

        {doc &&
          !loading &&
          doc.roles.map((group) => (
            <RosterTeamTable
              key={group.roleId}
              teamName={group.roleName}
              members={group.members}
            />
          ))}

        {doc && !loading && doc.unassigned.length > 0 && (
          <RosterTeamTable
            teamName="(チーム未割当)"
            members={doc.unassigned}
          />
        )}
      </div>
    </div>
  );
}

// 1 チーム分の名簿テーブル。列: 名前 / フリガナ / クラス / Gmail / 所属チーム。
function RosterTeamTable({
  teamName,
  members,
}: {
  teamName: string;
  members: RosterDocument["roles"][number]["members"];
}) {
  const cell: React.CSSProperties = {
    border: "1px solid #d1d5db",
    padding: "6px 8px",
    fontSize: "0.8125rem",
    textAlign: "left",
    verticalAlign: "top",
    color: "#111827",
  };
  const th: React.CSSProperties = {
    ...cell,
    background: "#f3f4f6",
    fontWeight: 600,
    whiteSpace: "nowrap",
  };
  return (
    <div style={{ marginBottom: "16px" }}>
      <div
        style={{
          fontSize: "0.9375rem",
          fontWeight: 700,
          margin: "0 0 6px",
          color: "#111827",
        }}
      >
        {teamName}（{members.length} 名）
      </div>
      {members.length === 0 ? (
        <div style={{ fontSize: "0.8125rem", color: "#6b7280" }}>
          このチームの参加者はいません。
        </div>
      ) : (
        <table
          style={{
            borderCollapse: "collapse",
            width: "100%",
            tableLayout: "fixed",
          }}
        >
          <thead>
            <tr>
              <th style={{ ...th, width: "18%" }}>名前</th>
              <th style={{ ...th, width: "18%" }}>フリガナ</th>
              <th style={{ ...th, width: "20%" }}>クラス</th>
              <th style={{ ...th, width: "26%" }}>Gmail</th>
              <th style={{ ...th, width: "18%" }}>所属チーム</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.formId}>
                <td style={cell}>{m.name}</td>
                <td style={cell}>{m.nameKana ?? "-"}</td>
                <td style={cell}>{formatClass(m.grade, m.department)}</td>
                <td style={{ ...cell, wordBreak: "break-all" }}>{m.email}</td>
                <td style={cell}>{teamName}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
