import { request } from "./client";

// 案7 Google Drive 閲覧 API クライアント。
// gmail_accounts の OAuth credential を再利用する read-only Drive ブラウザ。
// 既存連携アカウントは drive.readonly scope 不足のため、初回は 403 scope_missing が
// 返る。その場合は Gmail 連携の「+ Gmail を連携」(= /google-oauth/install) から
// 1 回 再同意すれば解消する。

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  iconLink?: string;
  modifiedTime?: string;
  size?: string;
  parents?: string[];
  webViewLink?: string;
  isFolder: boolean;
};

export type DriveListResult = {
  files: DriveFile[];
  nextPageToken?: string;
};

export type DriveFileContent = {
  kind: "text" | "binary";
  text?: string;
  contentType: string;
  truncated: boolean;
};

function qs(params: Record<string, string | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") sp.set(k, v);
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export const drive = {
  /** フォルダ直下の一覧。folderId 省略時はマイドライブ root。 */
  list: (opts: { folderId?: string; pageToken?: string } = {}) =>
    request<DriveListResult>(
      `/drive/list${qs({ folderId: opts.folderId, pageToken: opts.pageToken })}`,
    ),
  /** ファイルのメタデータ。 */
  fileMeta: (id: string) => request<DriveFile>(`/drive/file/${encodeURIComponent(id)}`),
  /** ファイル内容 (Google ネイティブは export / テキストは get media)。 */
  fileContent: (id: string) =>
    request<DriveFileContent>(`/drive/file/${encodeURIComponent(id)}/content`),
};
