import { useEffect, useState } from "react";
import type { EventAction, GmailAccount } from "../../types";
import { api } from "../../api";
import type {
  BroadcastPreview,
  BroadcastSendResult,
  BroadcastLogRow,
} from "../../api/broadcast";
import { useToast } from "../ui/Toast";
import { colors } from "../../styles/tokens";

// participant_broadcast のメイン画面。
// HackIT 参加者への一斉メール送信を、連携済み Gmail から行う。
//
// 安全設計 (誤爆防止):
//   1. 文面 (件名 + 本文) と宛先を貼り付ける
//   2. 「プレビュー」で宛先数 / 除外 / 本文サンプルを確認 (Gmail 非接触のドライラン)
//   3. 「上記内容で送信する」チェック (confirm) を付けて初めて送信ボタンが押せる
//   差し込み記法は {name} {email} (lmb 既存テンプレと共通)。

type Config = {
  gmailAccountId?: string;
  recipientsText?: string;
  subject?: string;
  body?: string;
};

function parseConfig(json: string): Config {
  try {
    const c = JSON.parse(json || "{}") as Config;
    return {
      gmailAccountId: typeof c.gmailAccountId === "string" ? c.gmailAccountId : undefined,
      recipientsText: typeof c.recipientsText === "string" ? c.recipientsText : "",
      subject: typeof c.subject === "string" ? c.subject : "",
      body: typeof c.body === "string" ? c.body : "",
    };
  } catch {
    return { recipientsText: "", subject: "", body: "" };
  }
}

export function ParticipantBroadcastMainTab({
  eventId,
  action,
  onChanged,
}: {
  eventId: string;
  action: EventAction;
  onChanged: () => void;
}) {
  const toast = useToast();
  const initial = parseConfig(action.config);

  const [accounts, setAccounts] = useState<GmailAccount[]>([]);
  const [gmailAccountId, setGmailAccountId] = useState(initial.gmailAccountId ?? "");
  const [recipientsText, setRecipientsText] = useState(initial.recipientsText ?? "");
  const [subject, setSubject] = useState(initial.subject ?? "");
  const [body, setBody] = useState(initial.body ?? "");
  const [skipAlreadySent, setSkipAlreadySent] = useState(true);

  const [preview, setPreview] = useState<BroadcastPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [sendResult, setSendResult] = useState<BroadcastSendResult | null>(null);
  const [logs, setLogs] = useState<BroadcastLogRow[]>([]);

  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    api.gmailAccounts.list().then(setAccounts).catch(() => setAccounts([]));
    loadLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action.id]);

  const loadLogs = () => {
    api.broadcast
      .logs(eventId, action.id)
      .then(setLogs)
      .catch(() => setLogs([]));
  };

  // 文面 / 宛先を変えたら preview / confirm を無効化する (古い確認で送らせない)。
  const invalidatePreview = () => {
    setPreview(null);
    setConfirmed(false);
    setSendResult(null);
  };

  const handleSaveDraft = async () => {
    setSaving(true);
    try {
      await api.events.actions.update(eventId, action.id, {
        config: JSON.stringify({ gmailAccountId, recipientsText, subject, body }),
      });
      toast.success("下書きを保存しました");
      onChanged();
    } catch {
      toast.error("下書きの保存に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  const handlePreview = async () => {
    setPreviewing(true);
    setConfirmed(false);
    setSendResult(null);
    try {
      const p = await api.broadcast.preview(eventId, action.id, {
        recipientsText,
        subject,
        body,
        skipAlreadySent,
      });
      setPreview(p);
    } catch {
      toast.error("プレビューに失敗しました");
    } finally {
      setPreviewing(false);
    }
  };

  const canSend =
    !!gmailAccountId &&
    !!subject.trim() &&
    !!body.trim() &&
    !!preview &&
    preview.recipientCount > 0 &&
    confirmed &&
    !sending;

  const handleSend = async () => {
    if (!canSend) return;
    setSending(true);
    try {
      const r = await api.broadcast.send(eventId, action.id, {
        gmailAccountId,
        recipientsText,
        subject,
        body,
        skipAlreadySent,
        confirm: true,
      });
      setSendResult(r);
      if (r.failed === 0) {
        toast.success(`${r.sent} 件送信しました`);
      } else {
        toast.error(`${r.sent} 件送信 / ${r.failed} 件失敗`);
      }
      setConfirmed(false);
      setPreview(null);
      loadLogs();
    } catch (e) {
      toast.error(
        e instanceof Error ? `送信に失敗しました: ${e.message}` : "送信に失敗しました",
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <div style={{ maxWidth: 760 }}>
      {accounts.length === 0 && (
        <div style={warnBox}>
          送信元の Gmail が連携されていません。「ワークスペース」画面から Gmail
          を連携してください (haccckit@gmail.com を連携すると HackIT から送れます)。
        </div>
      )}

      {/* 送信元 */}
      <label style={labelStyle}>送信元 Gmail</label>
      <select
        value={gmailAccountId}
        onChange={(e) => {
          setGmailAccountId(e.target.value);
          invalidatePreview();
        }}
        style={inputStyle}
      >
        <option value="">-- 選択 --</option>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.email}
          </option>
        ))}
      </select>

      {/* 宛先 */}
      <label style={labelStyle}>
        宛先 (1 行 1 件・
        <code>email</code> / <code>email,名前</code> / <code>名前 &lt;email&gt;</code>)
      </label>
      <textarea
        value={recipientsText}
        onChange={(e) => {
          setRecipientsText(e.target.value);
          invalidatePreview();
        }}
        rows={6}
        placeholder={"taro@example.com,山田太郎\nhanako@example.com"}
        style={{ ...inputStyle, fontFamily: "monospace", resize: "vertical" }}
      />

      {/* 件名 */}
      <label style={labelStyle}>件名 (差し込み: {"{name}"} {"{email}"})</label>
      <input
        value={subject}
        onChange={(e) => {
          setSubject(e.target.value);
          invalidatePreview();
        }}
        placeholder="【HackIT】Slack 参加とチーム名の登録のお願い"
        style={inputStyle}
      />

      {/* 本文 */}
      <label style={labelStyle}>本文 (差し込み: {"{name}"} {"{email}"})</label>
      <textarea
        value={body}
        onChange={(e) => {
          setBody(e.target.value);
          invalidatePreview();
        }}
        rows={10}
        placeholder={"{name} さん\n\nHackIT 事務局です。以下をお願いします。\n1. Slack に参加\n2. チーム名を登録\n"}
        style={{ ...inputStyle, resize: "vertical" }}
      />

      <label style={{ ...checkRow, marginTop: 8 }}>
        <input
          type="checkbox"
          checked={skipAlreadySent}
          onChange={(e) => {
            setSkipAlreadySent(e.target.checked);
            invalidatePreview();
          }}
        />
        過去に送信済みの宛先を除外する (二重送信防止・推奨)
      </label>

      {/* アクション行 */}
      <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
        <button onClick={handleSaveDraft} disabled={saving} style={secondaryBtn}>
          {saving ? "保存中…" : "下書きを保存"}
        </button>
        <button onClick={handlePreview} disabled={previewing} style={primaryBtn}>
          {previewing ? "確認中…" : "プレビュー (送らない)"}
        </button>
      </div>

      {/* プレビュー結果 */}
      {preview && (
        <div style={previewBox}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>
            送信対象: {preview.recipientCount} 件
          </div>
          <div style={{ fontSize: 13, color: colors.text }}>
            {preview.duplicateCount > 0 && (
              <div>重複除外: {preview.duplicateCount} 件</div>
            )}
            {preview.alreadySentCount > 0 && (
              <div>送信済み除外: {preview.alreadySentCount} 件</div>
            )}
            {preview.invalidLines.length > 0 && (
              <div style={{ color: colors.danger }}>
                解析できない行: {preview.invalidLines.length} 件（
                {preview.invalidLines.slice(0, 3).join(" / ")}
                {preview.invalidLines.length > 3 ? " …" : ""}）
              </div>
            )}
          </div>

          {preview.sample && (
            <div style={sampleBox}>
              <div style={{ fontSize: 12, color: colors.textMuted }}>
                サンプル (先頭宛先 {preview.sample.to})
              </div>
              <div style={{ fontWeight: 600, marginTop: 4 }}>
                件名: {preview.sample.subject}
              </div>
              <pre style={preStyle}>{preview.sample.body}</pre>
            </div>
          )}

          {preview.recipientCount > 0 && (
            <>
              <label style={{ ...checkRow, marginTop: 12 }}>
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                上記 {preview.recipientCount} 件に、この件名・本文で送信する
              </label>
              <button
                onClick={handleSend}
                disabled={!canSend}
                style={{
                  ...dangerBtn,
                  marginTop: 8,
                  opacity: canSend ? 1 : 0.5,
                  cursor: canSend ? "pointer" : "not-allowed",
                }}
              >
                {sending ? "送信中…" : `📧 ${preview.recipientCount} 件に一斉送信`}
              </button>
            </>
          )}
        </div>
      )}

      {/* 送信結果 */}
      {sendResult && (
        <div style={previewBox}>
          <div style={{ fontWeight: 600 }}>
            送信結果: 成功 {sendResult.sent} / 失敗 {sendResult.failed} (合計{" "}
            {sendResult.attempted})
          </div>
          {sendResult.failures.length > 0 && (
            <ul style={{ margin: "8px 0 0", paddingLeft: 18, color: colors.danger }}>
              {sendResult.failures.slice(0, 10).map((f) => (
                <li key={f.email} style={{ fontSize: 13 }}>
                  {f.email}: {f.error}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* 送信ログ */}
      <div style={{ marginTop: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <h4 style={{ margin: 0 }}>送信ログ ({logs.length})</h4>
          <button onClick={loadLogs} style={{ ...secondaryBtn, padding: "2px 8px" }}>
            更新
          </button>
        </div>
        {logs.length === 0 ? (
          <p style={{ color: colors.textMuted, fontSize: 13 }}>
            まだ送信履歴はありません。
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>日時</th>
                  <th style={thStyle}>宛先</th>
                  <th style={thStyle}>件名</th>
                  <th style={thStyle}>状態</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id}>
                    <td style={tdStyle}>
                      {new Date(l.createdAt).toLocaleString("ja-JP")}
                    </td>
                    <td style={tdStyle}>{l.recipientEmail}</td>
                    <td style={tdStyle}>{l.subject}</td>
                    <td
                      style={{
                        ...tdStyle,
                        color: l.status === "sent" ? colors.success : colors.danger,
                      }}
                    >
                      {l.status === "sent" ? "送信" : `失敗: ${l.errorMessage ?? ""}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  margin: "14px 0 4px",
};
const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  border: `1px solid ${colors.border}`,
  borderRadius: 6,
  fontSize: 14,
  boxSizing: "border-box",
};
const checkRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 13,
};
const primaryBtn: React.CSSProperties = {
  padding: "8px 14px",
  background: colors.primary,
  color: colors.textInverse,
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 14,
};
const secondaryBtn: React.CSSProperties = {
  padding: "8px 14px",
  background: colors.surface,
  color: colors.text,
  border: `1px solid ${colors.borderStrong}`,
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 14,
};
const dangerBtn: React.CSSProperties = {
  padding: "10px 16px",
  background: colors.danger,
  color: colors.textInverse,
  border: "none",
  borderRadius: 6,
  fontSize: 15,
  fontWeight: 600,
};
const warnBox: React.CSSProperties = {
  padding: "10px 12px",
  background: colors.warningSubtle,
  border: `1px solid ${colors.warning}`,
  borderRadius: 6,
  fontSize: 13,
  marginBottom: 12,
};
const previewBox: React.CSSProperties = {
  marginTop: 16,
  padding: "12px 14px",
  background: colors.surface,
  border: `1px solid ${colors.border}`,
  borderRadius: 8,
};
const sampleBox: React.CSSProperties = {
  marginTop: 10,
  padding: "10px 12px",
  background: colors.textInverse,
  border: `1px solid ${colors.border}`,
  borderRadius: 6,
};
const preStyle: React.CSSProperties = {
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontFamily: "inherit",
  fontSize: 13,
  margin: "4px 0 0",
};
const tableStyle: React.CSSProperties = {
  borderCollapse: "collapse",
  width: "100%",
  fontSize: 13,
};
const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "6px 8px",
  borderBottom: `2px solid ${colors.border}`,
  whiteSpace: "nowrap",
};
const tdStyle: React.CSSProperties = {
  padding: "6px 8px",
  borderBottom: `1px solid ${colors.border}`,
  verticalAlign: "top",
};
