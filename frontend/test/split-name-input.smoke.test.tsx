import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { PublicApplyPage } from "../src/pages/PublicApplyPage";
import { ParticipationFormPage } from "../src/pages/ParticipationFormPage";

// feature/split-name-input スモーク。応募/参加届の両公開フォームについて
// 1) 「姓」「名」の 2 input が aria-label で個別に取得できる (UI 分割の番人)
// 2) 参加届の送信時に `${姓.trim()} ${名.trim()}` 結合で BE に name が渡る
//    (既存 `name` カラム形式の維持 = BE/DB 無変更の番人)
const EV = "ev1";

function stubFetch(captured?: { value: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const json = (b: unknown) =>
        new Response(JSON.stringify(b), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      if (url.endsWith(`/api/apply/${EV}/event`))
        return json({ id: EV, name: "テストイベント", type: "project" });
      if (url.endsWith(`/api/apply/${EV}/availability`))
        return json({
          enabled: true,
          leaderAvailableSlots: ["2099-01-01T03:00:00.000Z"],
        });
      if (url.endsWith(`/api/participation/${EV}/event`))
        return json({ id: EV, name: "テストイベント", type: "project" });
      if (url.endsWith(`/api/participation/${EV}`) && init?.method === "POST") {
        if (captured) captured.value = JSON.parse(String(init.body));
        return json({ ok: true, id: "pf-1" });
      }
      return json({});
    }),
  );
}

describe("split-name-input スモーク", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("応募フォーム: 姓/名の 2 input が render される", async () => {
    stubFetch();
    render(
      <MemoryRouter initialEntries={[`/apply/${EV}`]}>
        <Routes>
          <Route path="/apply/:eventId" element={<PublicApplyPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole("textbox", { name: "姓" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "名" })).toBeInTheDocument();
  });

  it("参加届: 姓/名は半角スペース結合で name として送信される", async () => {
    const captured: { value: unknown } = { value: null };
    stubFetch(captured);
    render(
      <MemoryRouter initialEntries={[`/participation/${EV}`]}>
        <Routes>
          <Route
            path="/participation/:eventId"
            element={<ParticipationFormPage />}
          />
        </Routes>
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    await user.type(await screen.findByRole("textbox", { name: "姓" }), "  山田  ");
    await user.type(screen.getByRole("textbox", { name: "名" }), "  太郎  ");
    // Field は label/input が分離されているため textbox 全件取得で順に埋める。
    // 0=姓, 1=名, 2=フリガナ, 3=slackName, 4=studentId, 5=department, 6=email, 7=slackEmail (任意)
    const tb = screen.getAllByRole("textbox");
    await user.type(tb[2], "ヤマダ タロウ"); // フリガナ (全角カタカナ・必須)
    await user.type(tb[3], "yamada");
    await user.type(tb[4], "1 EP 1 - 1");
    await user.type(tb[5], "情報");
    await user.selectOptions(screen.getAllByRole("combobox")[0], "1");
    await user.type(tb[6], "test@example.com");
    await user.click(screen.getByRole("radio", { name: "イベント運営" }));
    await user.click(screen.getByRole("button", { name: /参加届を送信/ }));
    await waitFor(() => expect(captured.value).not.toBeNull());
    expect((captured.value as { name: string }).name).toBe("山田 太郎");
    // 名簿 Slack 連携強化 PR2: slackEmail 未入力時は body に含めない (省略=undefined)
    // ことで、JSON.stringify 後に key が落ちる = BE 側で従来通り null 扱いとなる。
    expect("slackEmail" in (captured.value as Record<string, unknown>)).toBe(false);
  });

  it("参加届: slackEmail を入力すると POST body に含まれる", async () => {
    // 名簿 Slack 連携強化 PR2: 任意項目の slackEmail を入力した場合、
    // 送信 body に trim 済みの値が含まれることを担保する。
    const captured: { value: unknown } = { value: null };
    stubFetch(captured);
    render(
      <MemoryRouter initialEntries={[`/participation/${EV}`]}>
        <Routes>
          <Route
            path="/participation/:eventId"
            element={<ParticipationFormPage />}
          />
        </Routes>
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    await user.type(await screen.findByRole("textbox", { name: "姓" }), "山田");
    await user.type(screen.getByRole("textbox", { name: "名" }), "花子");
    // 0=姓, 1=名, 2=フリガナ, 3=slackName, 4=studentId, 5=department, 6=email, 7=slackEmail
    const tb = screen.getAllByRole("textbox");
    await user.type(tb[2], "ヤマダ ハナコ"); // フリガナ (全角カタカナ・必須)
    await user.type(tb[3], "hanako");
    await user.type(tb[4], "1 EP 1 - 2");
    await user.type(tb[5], "情報");
    await user.selectOptions(screen.getAllByRole("combobox")[0], "1");
    await user.type(tb[6], "school@example.com");
    await user.type(tb[7], "  hanako@example.com  ");
    await user.click(screen.getByRole("radio", { name: "イベント運営" }));
    await user.click(screen.getByRole("button", { name: /参加届を送信/ }));
    await waitFor(() => expect(captured.value).not.toBeNull());
    expect((captured.value as { slackEmail: string }).slackEmail).toBe(
      "hanako@example.com",
    );
  });
});
