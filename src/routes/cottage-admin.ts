import type { Context } from "hono";
import type { Env } from "../types/env";

/**
 * コテージ タイムテーブル 管理用 簡易編集画面。
 *
 * curl を使わずに day / item を追加・編集・削除できる単一 HTML ページ。
 * - GET /cottage-admin で配信 (HTML のみ・秘密情報を含まないので認証不要)。
 * - ページ内で管理トークン (ADMIN_TOKEN) を入力し、公開 GET で読み込み、
 *   admin PUT /api/cottage/timetable で保存する。
 * - React ビルド (public/) には手を入れず、Worker から直接 HTML を返す独立ページ。
 *
 * iOS 配信契約 (GET /api/cottage/timetable) は一切変更しない。
 */

// 埋め込みクライアント JS。テンプレートリテラル/`${`を使わず DOM API で組み立て、
// TS 側テンプレートリテラルとのエスケープ衝突を避ける。
const CLIENT_JS = String.raw`
(function () {
  var api = location.origin + "/api/cottage/timetable";
  var model = { trip: { title: "", startDate: "", endDate: "" }, days: [] };
  var statusEl = document.getElementById("status");
  var updatedEl = document.getElementById("updated");

  function setStatus(msg, ok) {
    statusEl.textContent = msg;
    statusEl.style.color = ok ? "#15803d" : "#b91c1c";
  }

  function token() {
    return document.getElementById("token").value.trim();
  }

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "class") n.className = attrs[k];
      else if (k === "value") n.value = attrs[k];
      else n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) {
      n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return n;
  }

  function labeled(text, input) {
    return el("label", { class: "fld" }, [el("span", null, [text]), input]);
  }

  function input(value, oninput, placeholder) {
    var i = el("input", { value: value || "" });
    if (placeholder) i.placeholder = placeholder;
    i.addEventListener("input", function () { oninput(i.value); });
    return i;
  }

  function render() {
    document.getElementById("trip-title").value = model.trip.title;
    document.getElementById("trip-start").value = model.trip.startDate;
    document.getElementById("trip-end").value = model.trip.endDate;

    var root = document.getElementById("days");
    root.textContent = "";
    model.days.forEach(function (day, di) {
      var head = el("div", { class: "day-head" }, [
        labeled("Day", input(String(day.day), function (v) { day.day = parseInt(v, 10) || 0; }, "1")),
        labeled("日付", input(day.date, function (v) { day.date = v; }, "YYYY-MM-DD")),
        el("button", { class: "del" }, ["この日を削除"])
      ]);
      head.querySelector(".del").addEventListener("click", function () {
        model.days.splice(di, 1); render();
      });

      var itemsWrap = el("div", { class: "items" }, []);
      (day.items || []).forEach(function (it, ii) {
        var row = el("div", { class: "item" }, [
          labeled("開始", input(it.start, function (v) { it.start = v; }, "HH:mm")),
          labeled("終了", input(it.end, function (v) { it.end = v; }, "HH:mm")),
          labeled("内容", input(it.title, function (v) { it.title = v; }, "タイトル")),
          labeled("場所", input(it.location, function (v) { it.location = v; }, "")),
          labeled("メモ", input(it.note, function (v) { it.note = v; }, "")),
          labeled("id", input(it.id, function (v) { it.id = v; }, "")),
          el("button", { class: "del" }, ["削除"])
        ]);
        row.querySelector(".del").addEventListener("click", function () {
          day.items.splice(ii, 1); render();
        });
        itemsWrap.appendChild(row);
      });

      var addItem = el("button", { class: "add" }, ["＋ 項目を追加"]);
      addItem.addEventListener("click", function () {
        if (!day.items) day.items = [];
        var n = day.items.length + 1;
        day.items.push({ id: "d" + day.day + "-" + n, start: "", end: "", title: "", location: "", note: "" });
        render();
      });

      root.appendChild(el("section", { class: "day" }, [head, itemsWrap, addItem]));
    });
  }

  function collect() {
    model.trip.title = document.getElementById("trip-title").value;
    model.trip.startDate = document.getElementById("trip-start").value;
    model.trip.endDate = document.getElementById("trip-end").value;
    return { trip: model.trip, days: model.days };
  }

  function load() {
    setStatus("読み込み中...", true);
    fetch(api, { headers: { "Accept": "application/json" } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        model = { trip: d.trip, days: d.days };
        updatedEl.textContent = "現在の updatedAt: " + (d.updatedAt || "(なし)");
        render();
        setStatus("読み込み完了", true);
      })
      .catch(function (e) { setStatus("読み込み失敗: " + e, false); });
  }

  function save() {
    if (!token()) { setStatus("管理トークンを入力してください", false); return; }
    setStatus("保存中...", true);
    fetch(api, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-admin-token": token() },
      body: JSON.stringify(collect())
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, status: r.status, body: b }; }); })
      .then(function (res) {
        if (!res.ok) { setStatus("保存失敗 (" + res.status + "): " + (res.body.error || ""), false); return; }
        updatedEl.textContent = "現在の updatedAt: " + res.body.updatedAt;
        setStatus("保存しました。iOS へ反映されます。", true);
      })
      .catch(function (e) { setStatus("保存失敗: " + e, false); });
  }

  document.getElementById("load").addEventListener("click", load);
  document.getElementById("save").addEventListener("click", save);
  document.getElementById("add-day").addEventListener("click", function () {
    var n = model.days.length + 1;
    model.days.push({ day: n, date: "", items: [] });
    render();
  });

  load();
})();
`;

const PAGE_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>コテージ タイムテーブル編集</title>
<style>
  :root { font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif; }
  body { margin: 0; padding: 24px; background: #f8fafc; color: #0f172a; max-width: 980px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .lede { color: #475569; font-size: 13px; margin: 0 0 16px; }
  .bar { position: sticky; top: 0; background: #f8fafc; padding: 12px 0; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; border-bottom: 1px solid #e2e8f0; z-index: 10; }
  .bar input { padding: 6px 8px; }
  button { padding: 6px 12px; border: 1px solid #cbd5e1; background: #fff; border-radius: 6px; cursor: pointer; font-size: 13px; }
  button.add { border-color: #93c5fd; color: #1d4ed8; }
  button.del { border-color: #fca5a5; color: #b91c1c; }
  #load, #save { background: #1d4ed8; color: #fff; border-color: #1d4ed8; }
  #status { font-size: 13px; font-weight: 600; }
  h2 { font-size: 15px; margin: 20px 0 8px; }
  .fld { display: flex; flex-direction: column; font-size: 11px; color: #64748b; gap: 2px; }
  .fld input { padding: 5px 7px; border: 1px solid #cbd5e1; border-radius: 5px; font-size: 13px; color: #0f172a; }
  #trip { display: flex; gap: 10px; flex-wrap: wrap; }
  .day { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; margin-bottom: 14px; }
  .day-head { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; margin-bottom: 8px; }
  .item { display: grid; grid-template-columns: 70px 70px 1.6fr 1.2fr 1.2fr 90px auto; gap: 8px; align-items: end; padding: 8px 0; border-top: 1px dashed #e2e8f0; }
  .updated { color: #64748b; font-size: 12px; margin-top: 16px; }
  @media (max-width: 720px) { .item { grid-template-columns: 1fr 1fr; } }
</style>
</head>
<body>
<h1>コテージ タイムテーブル編集</h1>
<p class="lede">iOS アプリ (cottage-ios) へ配信するタイムテーブルを編集します。保存には管理トークンが必要です。配信契約は変わりません。</p>
<div class="bar">
  <label class="fld"><span>管理トークン</span><input id="token" type="password" placeholder="ADMIN_TOKEN" /></label>
  <button id="load">再読み込み</button>
  <button id="save">保存</button>
  <span id="status"></span>
</div>
<h2>旅行情報</h2>
<section id="trip">
  <label class="fld"><span>タイトル</span><input id="trip-title" /></label>
  <label class="fld"><span>開始日</span><input id="trip-start" placeholder="YYYY-MM-DD" /></label>
  <label class="fld"><span>終了日</span><input id="trip-end" placeholder="YYYY-MM-DD" /></label>
</section>
<h2>日程</h2>
<div id="days"></div>
<button id="add-day" class="add">＋ 日を追加</button>
<p class="updated" id="updated"></p>
<script>${CLIENT_JS}</script>
</body>
</html>`;

export function cottageAdminPage(c: Context<{ Bindings: Env }>) {
  return c.html(PAGE_HTML);
}
