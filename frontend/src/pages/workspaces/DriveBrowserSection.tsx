// 案7 Google Drive 閲覧ビュー。
// gmail_accounts の OAuth credential を再利用し、Drive の中身をアプリ上で閲覧する。
// フォルダ一覧 -> クリックで中に入る -> ファイルクリックで中身 (テキスト/CSV/プレビュー)。
//
// 既存連携アカウントは drive.readonly scope 不足のため、初回は 403 scope_missing。
// その場合は上の Gmail 連携の「+ Gmail を連携」から 1 回 再同意すれば解消する。
import { useEffect, useState, useCallback } from "react";
import { api, APIError } from "../../api";
import type { DriveFile, DriveFileContent } from "../../api/drive";
import { colors } from "../../styles/tokens";
import { useIsMobile } from "../../hooks/useIsMobile";

type Crumb = { id: string; name: string };

const ROOT: Crumb = { id: "root", name: "マイドライブ" };

function formatSize(size?: string): string {
  if (!size) return "";
  const n = Number(size);
  if (!Number.isFinite(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** APIError から、ユーザー向けに分かりやすい文言を作る。 */
function errorMessage(e: unknown): string {
  if (e instanceof APIError) {
    try {
      const body = JSON.parse(e.body) as { error?: string; message?: string };
      if (body.error === "scope_missing") {
        return "Drive スコープが未許可です。上の「Gmail 連携」の「+ Gmail を連携」から 1 回 再同意してください。";
      }
      if (body.error === "no_connected_account") {
        return "Google アカウントが未連携です。上の「Gmail 連携」から連携してください。";
      }
      if (body.error === "ambiguous_account") {
        return "連携アカウントが複数あります (現状は単一アカウント前提です)。";
      }
      return body.message ?? e.message;
    } catch {
      return e.message;
    }
  }
  return String(e);
}

export function DriveBrowserSection() {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState<Crumb[]>([ROOT]);
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | undefined>();
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  // ファイルプレビュー (モーダル相当のインライン表示)
  const [selected, setSelected] = useState<DriveFile | null>(null);
  const [content, setContent] = useState<DriveFileContent | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);

  const current = path[path.length - 1];

  const loadList = useCallback(
    async (folderId: string, pageToken?: string) => {
      setListLoading(true);
      setListError(null);
      try {
        const res = await api.drive.list({ folderId, pageToken });
        setFiles((prev) => (pageToken ? [...prev, ...res.files] : res.files));
        setNextPageToken(res.nextPageToken);
      } catch (e) {
        setListError(errorMessage(e));
        if (!pageToken) setFiles([]);
      } finally {
        setListLoading(false);
      }
    },
    [],
  );

  // open 時 + フォルダ移動時に一覧を読む。
  useEffect(() => {
    if (!open) return;
    loadList(current.id);
    // current.id を依存に: パンくず移動で再読込。
  }, [open, current.id, loadList]);

  function enterFolder(f: DriveFile) {
    setSelected(null);
    setContent(null);
    setPath((p) => [...p, { id: f.id, name: f.name }]);
  }

  function goToCrumb(idx: number) {
    setSelected(null);
    setContent(null);
    setPath((p) => p.slice(0, idx + 1));
  }

  async function openFile(f: DriveFile) {
    setSelected(f);
    setContent(null);
    setContentError(null);
    setContentLoading(true);
    try {
      const c = await api.drive.fileContent(f.id);
      setContent(c);
    } catch (e) {
      setContentError(errorMessage(e));
    } finally {
      setContentLoading(false);
    }
  }

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
          flexDirection: isMobile ? "column" : "row",
          alignItems: isMobile ? "stretch" : "center",
          marginBottom: "0.5rem",
          gap: "0.5rem",
        }}
      >
        <h2 style={{ margin: 0, fontSize: isMobile ? "1.05rem" : undefined }}>
          Google Drive 閲覧
        </h2>
        <button
          onClick={() => setOpen((o) => !o)}
          style={{
            marginLeft: isMobile ? undefined : "auto",
            background: open ? "transparent" : colors.primary,
            color: open ? colors.textSecondary : colors.textInverse,
            border: open ? `1px solid ${colors.borderStrong}` : "none",
            padding: "0.5rem 1rem",
            borderRadius: "0.375rem",
            fontWeight: "bold",
            fontSize: "0.95rem",
            cursor: "pointer",
            minHeight: 44,
          }}
        >
          {open ? "閉じる" : "Drive を開く"}
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
        連携した Google アカウントの Drive を閲覧します (read-only)。フォルダをクリックで中に入り、ファイルをクリックで中身を表示します。初回は Drive スコープの再同意が 1 回必要です。
      </p>

      {open && (
        <div
          style={{
            border: `1px solid ${colors.border}`,
            borderRadius: "0.5rem",
            overflow: "hidden",
          }}
        >
          {/* パンくず */}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "0.25rem",
              padding: "0.5rem 0.75rem",
              background: colors.surface,
              borderBottom: `1px solid ${colors.border}`,
              fontSize: "0.85rem",
            }}
          >
            {path.map((c, i) => (
              <span key={c.id} style={{ display: "inline-flex", alignItems: "center" }}>
                {i > 0 && <span style={{ color: colors.textMuted, margin: "0 0.25rem" }}>/</span>}
                <button
                  onClick={() => goToCrumb(i)}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: i === path.length - 1 ? colors.text : colors.primary,
                    cursor: "pointer",
                    padding: "0.15rem 0.25rem",
                    fontWeight: i === path.length - 1 ? "bold" : "normal",
                    fontSize: "0.85rem",
                  }}
                >
                  {c.name}
                </button>
              </span>
            ))}
            <button
              onClick={() => loadList(current.id)}
              disabled={listLoading}
              title="再読込"
              style={{
                marginLeft: "auto",
                background: "transparent",
                border: `1px solid ${colors.borderStrong}`,
                borderRadius: "0.25rem",
                color: colors.textSecondary,
                cursor: listLoading ? "not-allowed" : "pointer",
                padding: "0.15rem 0.5rem",
                fontSize: "0.8rem",
              }}
            >
              再読込
            </button>
          </div>

          {/* 一覧 */}
          <div>
            {listError && (
              <div style={{ padding: "0.75rem", color: colors.danger, fontSize: "0.85rem" }}>
                {listError}
              </div>
            )}
            {!listError && files.length === 0 && !listLoading && (
              <div style={{ padding: "0.75rem", color: colors.textSecondary, fontSize: "0.85rem" }}>
                このフォルダは空です。
              </div>
            )}
            {files.map((f) => (
              <div
                key={f.id}
                role="button"
                tabIndex={0}
                onClick={() => (f.isFolder ? enterFolder(f) : openFile(f))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    f.isFolder ? enterFolder(f) : openFile(f);
                  }
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.6rem",
                  padding: "0.55rem 0.75rem",
                  borderBottom: `1px solid ${colors.border}`,
                  cursor: "pointer",
                  background: selected?.id === f.id ? colors.surface : undefined,
                }}
              >
                <span style={{ fontSize: "1.1rem", width: "1.4rem", textAlign: "center" }}>
                  {f.isFolder ? "📁" : "📄"}
                </span>
                <span style={{ flex: 1, wordBreak: "break-all", fontSize: "0.9rem" }}>
                  {f.name}
                </span>
                <span style={{ fontSize: "0.75rem", color: colors.textMuted, whiteSpace: "nowrap" }}>
                  {f.isFolder ? "" : formatSize(f.size)}
                </span>
              </div>
            ))}
            {listLoading && (
              <div style={{ padding: "0.75rem", color: colors.textSecondary, fontSize: "0.85rem" }}>
                読み込み中...
              </div>
            )}
            {nextPageToken && !listLoading && (
              <button
                onClick={() => loadList(current.id, nextPageToken)}
                style={{
                  display: "block",
                  width: "100%",
                  background: "transparent",
                  border: "none",
                  borderTop: `1px solid ${colors.border}`,
                  color: colors.primary,
                  cursor: "pointer",
                  padding: "0.6rem",
                  fontSize: "0.85rem",
                }}
              >
                さらに読み込む
              </button>
            )}
          </div>

          {/* ファイルプレビュー */}
          {selected && !selected.isFolder && (
            <div
              style={{
                borderTop: `2px solid ${colors.border}`,
                padding: "0.75rem",
                background: colors.surface,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  marginBottom: "0.5rem",
                }}
              >
                <strong style={{ flex: 1, wordBreak: "break-all", fontSize: "0.9rem" }}>
                  {selected.name}
                </strong>
                {selected.webViewLink && (
                  <a
                    href={selected.webViewLink}
                    target="_blank"
                    rel="noreferrer"
                    style={{ fontSize: "0.8rem", color: colors.primary }}
                  >
                    Drive で開く
                  </a>
                )}
                <button
                  onClick={() => {
                    setSelected(null);
                    setContent(null);
                  }}
                  style={{
                    background: "transparent",
                    border: `1px solid ${colors.borderStrong}`,
                    borderRadius: "0.25rem",
                    color: colors.textSecondary,
                    cursor: "pointer",
                    padding: "0.15rem 0.5rem",
                    fontSize: "0.8rem",
                  }}
                >
                  閉じる
                </button>
              </div>

              {contentLoading && (
                <div style={{ color: colors.textSecondary, fontSize: "0.85rem" }}>
                  読み込み中...
                </div>
              )}
              {contentError && (
                <div style={{ color: colors.danger, fontSize: "0.85rem" }}>{contentError}</div>
              )}
              {content && content.kind === "binary" && (
                <div style={{ color: colors.textSecondary, fontSize: "0.85rem" }}>
                  このファイル ({content.contentType}) はアプリ上でプレビューできません。
                  {selected.webViewLink ? "「Drive で開く」から確認してください。" : ""}
                </div>
              )}
              {content && content.kind === "text" && (
                <>
                  {content.truncated && (
                    <div
                      style={{
                        color: colors.textMuted,
                        fontSize: "0.75rem",
                        marginBottom: "0.25rem",
                      }}
                    >
                      ファイルが大きいため先頭のみ表示しています。
                    </div>
                  )}
                  <pre
                    style={{
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      maxHeight: "24rem",
                      overflow: "auto",
                      background: colors.surface,
                      border: `1px solid ${colors.border}`,
                      borderRadius: "0.375rem",
                      padding: "0.6rem",
                      margin: 0,
                      fontSize: "0.8rem",
                    }}
                  >
                    {content.text}
                  </pre>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
