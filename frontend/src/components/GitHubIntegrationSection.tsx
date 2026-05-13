import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { GitHubConnectedAction, GitHubUserMapping } from "../types";
import { api } from "../api";
import { useToast } from "./ui/Toast";
import { useConfirm } from "./ui/ConfirmDialog";
import { colors } from "../styles/tokens";

// 005-github-webhook: WorkspacesPage に置く「GitHub 連携」セクション。
//
// 機能:
//   1. webhook 受信 URL を表示 + コピー (admin が GitHub repo 側に貼り付ける)
//   2. webhook secret 設定手順 (wrangler secret put GITHUB_WEBHOOK_SECRET) の案内
//   3. GitHub username → Slack user id のマッピング table (add/edit/delete)
//   4. 現在 githubRepo が設定されている pr_review_list action 一覧 (read-only)
//
// マッピングは全件保存モデル (PUT /github-mappings)。
// FE は dirty フラグを持ち、「保存」を押されるまで BE に反映しない。

const styles = {
  section: {
    marginTop: "2rem",
    paddingTop: "1rem",
    borderTop: `1px solid ${colors.border}`,
  } as CSSProperties,
  header: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    marginBottom: "0.5rem",
  } as CSSProperties,
  desc: {
    fontSize: "0.85rem",
    color: colors.textSecondary,
    marginTop: 0,
    marginBottom: "0.75rem",
  } as CSSProperties,
  urlBox: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    background: colors.border,
    padding: "0.5rem 0.75rem",
    borderRadius: "0.25rem",
    fontFamily: "monospace",
    fontSize: "0.8rem",
    wordBreak: "break-all",
  } as CSSProperties,
  table: {
    width: "100%",
    borderCollapse: "collapse",
    marginTop: "0.5rem",
  } as CSSProperties,
  th: {
    textAlign: "left",
    padding: "0.375rem 0.5rem",
    borderBottom: `1px solid ${colors.border}`,
    fontSize: "0.85rem",
    color: colors.textSecondary,
  } as CSSProperties,
  td: {
    padding: "0.375rem 0.5rem",
    borderBottom: `1px solid ${colors.border}`,
    fontSize: "0.875rem",
  } as CSSProperties,
  input: {
    width: "100%",
    padding: "0.25rem 0.5rem",
    border: `1px solid ${colors.border}`,
    borderRadius: "0.25rem",
    fontSize: "0.875rem",
    background: colors.background,
    color: colors.text,
  } as CSSProperties,
  primaryBtn: {
    background: colors.primary,
    color: colors.textInverse,
    border: "none",
    padding: "0.375rem 0.75rem",
    borderRadius: "0.25rem",
    cursor: "pointer",
    fontSize: "0.875rem",
  } as CSSProperties,
  secondaryBtn: {
    background: "transparent",
    color: colors.textSecondary,
    border: `1px solid ${colors.borderStrong}`,
    padding: "0.375rem 0.75rem",
    borderRadius: "0.25rem",
    cursor: "pointer",
    fontSize: "0.875rem",
  } as CSSProperties,
  dangerBtn: {
    background: colors.danger,
    color: colors.textInverse,
    border: "none",
    padding: "0.25rem 0.5rem",
    borderRadius: "0.25rem",
    cursor: "pointer",
    fontSize: "0.75rem",
  } as CSSProperties,
};

const WEBHOOK_PATH = "/api/github-webhook";

export function GitHubIntegrationSection({ disabled }: { disabled?: boolean }) {
  const toast = useToast();
  const { confirm } = useConfirm();
  const [mappings, setMappings] = useState<GitHubUserMapping[]>([]);
  const [original, setOriginal] = useState<GitHubUserMapping[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState<GitHubConnectedAction[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api.githubMappings.list().catch(() => [] as GitHubUserMapping[]),
      api.githubMappings.connectedActions().catch(
        () => [] as GitHubConnectedAction[],
      ),
    ])
      .then(([list, conn]) => {
        if (cancelled) return;
        setMappings(list);
        setOriginal(list);
        setConnected(conn);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "読み込みに失敗");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const webhookUrl = `${window.location.origin}${WEBHOOK_PATH}`;
  const dirty = JSON.stringify(mappings) !== JSON.stringify(original);

  const updateRow = (
    index: number,
    patch: Partial<GitHubUserMapping>,
  ) => {
    setMappings((prev) =>
      prev.map((m, i) => (i === index ? { ...m, ...patch } : m)),
    );
  };

  const removeRow = async (index: number) => {
    const m = mappings[index];
    const ok = await confirm({
      title: "マッピングを削除",
      message: `${m.githubUsername} → ${m.slackUserId} を削除しますか？\n「保存」を押すまで BE には反映されません。`,
      variant: "danger",
      confirmLabel: "削除",
    });
    if (!ok) return;
    setMappings((prev) => prev.filter((_, i) => i !== index));
  };

  const addRow = () => {
    setMappings((prev) => [
      ...prev,
      { githubUsername: "", slackUserId: "", displayName: "" },
    ]);
  };

  const handleSave = async () => {
    // 軽い前検証 (BE と同じルール)
    const seen = new Set<string>();
    for (const m of mappings) {
      const gh = m.githubUsername.trim();
      const sl = m.slackUserId.trim();
      if (!gh || !sl) {
        toast.error("GitHub username と Slack user id は必須です");
        return;
      }
      if (seen.has(gh)) {
        toast.error(`GitHub username が重複しています: ${gh}`);
        return;
      }
      seen.add(gh);
    }
    setSaving(true);
    try {
      const cleaned = mappings.map((m) => ({
        githubUsername: m.githubUsername.trim(),
        slackUserId: m.slackUserId.trim(),
        displayName: m.displayName?.trim() || undefined,
      }));
      const res = await api.githubMappings.save(cleaned);
      toast.success(`保存しました (${res.count} 件)`);
      setOriginal(cleaned);
      setMappings(cleaned);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(webhookUrl);
      toast.success("Webhook URL をコピーしました");
    } catch {
      toast.error("コピーに失敗しました");
    }
  };

  if (loading) return <section style={styles.section}>読み込み中...</section>;
  if (error)
    return (
      <section style={styles.section}>
        <div style={{ color: colors.danger }}>エラー: {error}</div>
      </section>
    );

  return (
    <section style={styles.section}>
      <div style={styles.header}>
        <h2 style={{ margin: 0 }}>GitHub 連携</h2>
      </div>
      <p style={styles.desc}>
        GitHub の pull request webhook を受信して、reviewer 割当 / LGTM / merge
        を PR レビュー board に自動反映します。下記の Webhook URL を GitHub repo
        の Settings → Webhooks に登録してください。
      </p>

      {/* Webhook URL */}
      <div style={{ marginBottom: "0.75rem" }}>
        <div
          style={{
            fontSize: "0.85rem",
            color: colors.textSecondary,
            marginBottom: "0.25rem",
          }}
        >
          Webhook URL (Payload URL に貼り付け)
        </div>
        <div style={styles.urlBox}>
          <span style={{ flex: 1 }}>{webhookUrl}</span>
          <button
            type="button"
            onClick={handleCopy}
            style={styles.secondaryBtn}
            disabled={disabled}
          >
            コピー
          </button>
        </div>
      </div>

      {/* Secret 設定手順 */}
      <details
        style={{
          marginBottom: "0.75rem",
          fontSize: "0.85rem",
          color: colors.textSecondary,
        }}
      >
        <summary style={{ cursor: "pointer" }}>
          Webhook secret の設定手順 (kota 用)
        </summary>
        <pre
          style={{
            background: colors.border,
            padding: "0.5rem",
            borderRadius: "0.25rem",
            fontSize: "0.75rem",
            overflow: "auto",
            marginTop: "0.5rem",
          }}
        >
{`# 1. ランダムな secret を生成
TOKEN=$(openssl rand -hex 32)
echo $TOKEN   # ← GitHub の Secret 欄に貼り付ける用

# 2. Cloudflare Workers に登録
echo $TOKEN | wrangler secret put GITHUB_WEBHOOK_SECRET

# 3. GitHub repo Settings → Webhooks → Add webhook
#    - Payload URL: 上記の Webhook URL
#    - Content type: application/json
#    - Secret: TOKEN
#    - Events: Pull requests, Pull request reviews`}
        </pre>
      </details>

      {/* 連携中の event_action */}
      <div style={{ marginBottom: "0.75rem" }}>
        <div
          style={{
            fontSize: "0.85rem",
            color: colors.textSecondary,
            marginBottom: "0.25rem",
          }}
        >
          現在連携中の PR レビュー action ({connected.length} 件)
        </div>
        {connected.length === 0 ? (
          <div style={{ fontSize: "0.85rem", color: colors.textMuted }}>
            まだ連携対象がありません。PR レビュータブの設定で
            <code> githubRepo </code>
            を設定してください。
          </div>
        ) : (
          <ul style={{ margin: 0, paddingLeft: "1.25rem", fontSize: "0.85rem" }}>
            {connected.map((c) => (
              <li key={c.actionId}>
                <code>{c.githubRepo}</code> → event{" "}
                <code>{c.eventId.slice(0, 8)}</code>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* マッピング table */}
      <div style={{ marginTop: "1rem" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            marginBottom: "0.25rem",
          }}
        >
          <h3 style={{ margin: 0, fontSize: "1rem" }}>
            GitHub ↔ Slack マッピング ({mappings.length} 件)
          </h3>
          <div style={{ marginLeft: "auto", display: "flex", gap: "0.5rem" }}>
            <button
              type="button"
              onClick={addRow}
              style={styles.secondaryBtn}
              disabled={disabled}
            >
              + 追加
            </button>
            <button
              type="button"
              onClick={handleSave}
              style={styles.primaryBtn}
              disabled={disabled || saving || !dirty}
            >
              {saving ? "保存中..." : "保存"}
            </button>
          </div>
        </div>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>GitHub username</th>
              <th style={styles.th}>Slack user id</th>
              <th style={styles.th}>表示名 (任意)</th>
              <th style={{ ...styles.th, width: "4rem" }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {mappings.length === 0 && (
              <tr>
                <td
                  colSpan={4}
                  style={{
                    ...styles.td,
                    color: colors.textMuted,
                    textAlign: "center",
                  }}
                >
                  まだマッピングがありません。「+ 追加」から登録してください。
                </td>
              </tr>
            )}
            {mappings.map((m, i) => (
              <tr key={i}>
                <td style={styles.td}>
                  <input
                    style={styles.input}
                    value={m.githubUsername}
                    onChange={(e) =>
                      updateRow(i, { githubUsername: e.target.value })
                    }
                    placeholder="ko-tarou"
                    disabled={disabled}
                  />
                </td>
                <td style={styles.td}>
                  <input
                    style={styles.input}
                    value={m.slackUserId}
                    onChange={(e) =>
                      updateRow(i, { slackUserId: e.target.value })
                    }
                    placeholder="U01ABCDEFG"
                    disabled={disabled}
                  />
                </td>
                <td style={styles.td}>
                  <input
                    style={styles.input}
                    value={m.displayName ?? ""}
                    onChange={(e) =>
                      updateRow(i, { displayName: e.target.value })
                    }
                    placeholder="(任意) 田中 太郎"
                    disabled={disabled}
                  />
                </td>
                <td style={styles.td}>
                  <button
                    type="button"
                    onClick={() => removeRow(i)}
                    style={styles.dangerBtn}
                    disabled={disabled}
                  >
                    削除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {dirty && (
          <div
            style={{
              fontSize: "0.8rem",
              color: colors.warning ?? colors.textSecondary,
              marginTop: "0.5rem",
            }}
          >
            未保存の変更があります。「保存」を押すまで反映されません。
          </div>
        )}
      </div>
    </section>
  );
}
