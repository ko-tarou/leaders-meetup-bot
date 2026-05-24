// Phase4-7 純抽出: WorkspacesPage の「Gmail 連携」section を子化。
// Sprint 26: 応募者への自動メール送信に使う Gmail アカウント管理。
// データ所有・副作用は親 (gmailAccounts / refreshKey / confirm)。本子は
// 描画と install/delete の委譲のみ。マークアップ・style は一字一句不変。
import type { GmailAccount } from "../../types";
import { useIsMobile } from "../../hooks/useIsMobile";
import { colors } from "../../styles/tokens";
import { GmailWatcherEditor } from "../../components/GmailWatcherEditor";

export function GmailAccountsSection({
  gmailAccounts,
  gmailInstallLoading,
  isReadOnly,
  onInstall,
  onDelete,
}: {
  gmailAccounts: GmailAccount[];
  gmailInstallLoading: boolean;
  isReadOnly: boolean;
  onInstall: () => void;
  onDelete: (acc: GmailAccount) => void;
}) {
  const isMobile = useIsMobile();
  return (
    <section
      style={{
        marginTop: "2rem",
        paddingTop: "1rem",
        borderTop: `1px solid ${colors.border}`,
      }}
    >
      <div
        style={{
          display: "flex",
          // mobile はタイトル + ボタンを縦並び (横並びだとボタンが見切れる)
          flexDirection: isMobile ? "column" : "row",
          alignItems: isMobile ? "stretch" : "center",
          marginBottom: "0.5rem",
          gap: "0.5rem",
        }}
      >
        <h2 style={{ margin: 0, fontSize: isMobile ? "1.05rem" : undefined }}>
          Gmail 連携 ({gmailAccounts.length}件)
        </h2>
        <button
          onClick={onInstall}
          disabled={isReadOnly || gmailInstallLoading}
          style={{
            marginLeft: isMobile ? undefined : "auto",
            background: colors.primary,
            color: colors.textInverse,
            border: "none",
            padding: "0.5rem 1rem",
            borderRadius: "0.375rem",
            fontWeight: "bold",
            fontSize: "0.95rem",
            cursor:
              isReadOnly || gmailInstallLoading ? "not-allowed" : "pointer",
            minHeight: 44,
          }}
        >
          {gmailInstallLoading ? "遷移中..." : "+ Gmail を連携"}
        </button>
      </div>
      <p
        style={{
          fontSize: "0.85rem",
          color: colors.textSecondary,
          marginTop: 0,
          marginBottom: "0.75rem",
        }}
      >
        応募者への自動メール送信に使う Gmail アカウントを連携します。連携後、メールタブの「自動送信設定」から有効化してください。
      </p>

      {gmailAccounts.length === 0 ? (
        <div style={{ color: colors.textSecondary }}>
          未連携です。「+ Gmail を連携」から OAuth 認証を行ってください。
        </div>
      ) : (
        gmailAccounts.map((acc) => (
          <div
            key={acc.id}
            style={{
              border: `1px solid ${colors.border}`,
              borderRadius: "0.375rem",
              padding: "0.75rem",
              marginBottom: "0.5rem",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: isMobile ? "stretch" : "center",
                flexDirection: isMobile ? "column" : "row",
                gap: isMobile ? "0.5rem" : 0,
              }}
            >
              <div style={{ flex: 1, wordBreak: "break-all" }}>
                <strong>{acc.email}</strong>
                <div
                  style={{
                    fontSize: "0.75rem",
                    color: colors.textSecondary,
                  }}
                >
                  連携日: {new Date(acc.createdAt).toLocaleString("ja-JP")}
                </div>
              </div>
              <button
                onClick={() => onDelete(acc)}
                disabled={isReadOnly}
                style={{
                  background: colors.danger,
                  color: colors.textInverse,
                  padding: "0.4rem 0.9rem",
                  borderRadius: "0.25rem",
                  border: "none",
                  minHeight: 40,
                  // mobile では全幅でタップしやすく
                  width: isMobile ? "100%" : undefined,
                }}
              >
                解除
              </button>
            </div>
            {/* 005-gmail-watcher: メール監視設定 (展開式) */}
            <GmailWatcherEditor account={acc} />
          </div>
        ))
      )}
    </section>
  );
}
