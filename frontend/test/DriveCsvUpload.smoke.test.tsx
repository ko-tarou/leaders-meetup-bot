import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DriveBrowserSection } from "../src/pages/workspaces/DriveBrowserSection";

// C) Drive CSV アップロードパネル smoke。
// - フォルダ一覧 (/drive/list) を取得し picker に出す
// - CSV を選んで「Drive にアップロード」-> POST /drive/upload (asGoogleSheet:true)
// - 完了後に作成された Sheet の webViewLink リンクを表示する

type FetchCall = { url: string; method: string; body?: string };

function installFetchSpy(): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string"
        ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      const body = init?.body == null ? undefined : String(init.body);
      calls.push({ url, method, body });

      if (url.includes("/drive/list")) {
        return new Response(
          JSON.stringify({
            files: [
              { id: "f1", name: "候補リスト", mimeType: "application/vnd.google-apps.folder", isFolder: true },
              { id: "x1", name: "memo.txt", mimeType: "text/plain", isFolder: false },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/drive/upload")) {
        return new Response(
          JSON.stringify({
            id: "sheet1", name: "list.csv",
            mimeType: "application/vnd.google-apps.spreadsheet",
            webViewLink: "https://docs.google.com/spreadsheets/d/sheet1/edit",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("DriveCsvUploadPanel smoke (C)", () => {
  it("CSV を選んでアップロード -> POST /drive/upload(asGoogleSheet) + webViewLink 表示", async () => {
    const calls = installFetchSpy();
    const user = userEvent.setup();
    render(<DriveBrowserSection />);

    // パネルは常時表示。フォルダ picker にフォルダ名が出る。
    expect(await screen.findByText("Drive に CSV をアップロード")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "候補リスト" })).toBeInTheDocument();
    });
    // ファイル (フォルダではない memo.txt) は picker に出ない。
    expect(screen.queryByRole("option", { name: "memo.txt" })).toBeNull();

    const fileInput = screen.getByLabelText("アップロードする CSV ファイル");
    const csv = new File(["a,b\n1,2\n"], "list.csv", { type: "text/csv" });
    await user.upload(fileInput as HTMLInputElement, csv);

    await user.click(screen.getByRole("button", { name: /Drive にアップロード/ }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url.includes("/drive/upload"));
      expect(post).toBeDefined();
      const parsed = JSON.parse(post!.body!);
      expect(parsed.name).toBe("list.csv");
      expect(parsed.asGoogleSheet).toBe(true);
      expect(parsed.content).toContain("a,b");
    });

    const link = await screen.findByRole("link", { name: /スプレッドシートを開く/ });
    expect(link).toHaveAttribute(
      "href",
      "https://docs.google.com/spreadsheets/d/sheet1/edit",
    );
  });

  it("フォルダ未選択ならアップロード body に parentId を含めない", async () => {
    const calls = installFetchSpy();
    const user = userEvent.setup();
    render(<DriveBrowserSection />);
    await screen.findByText("Drive に CSV をアップロード");

    const fileInput = screen.getByLabelText("アップロードする CSV ファイル");
    const csv = new File(["x\n"], "list.csv", { type: "text/csv" });
    await user.upload(fileInput as HTMLInputElement, csv);
    await user.click(screen.getByRole("button", { name: /Drive にアップロード/ }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url.includes("/drive/upload"));
      expect(post).toBeDefined();
      const parsed = JSON.parse(post!.body!);
      expect(parsed.parentId).toBeUndefined();
    });
  });
});
