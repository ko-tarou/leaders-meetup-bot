import type { Context } from "hono";
import type { Env } from "../types/env";

/**
 * DevHub Ops 管理コンソール (curl 不要・ビルド不要の軽量 GUI)。
 *
 * - GET /admin              イベント一覧ダッシュボード (core events)。各 event の
 *                           アクション数 / 参加届数 / 応募数 / TT 有無 + 受付開閉 + 新規作成。
 * - GET /admin/e/:eventId   1 イベントの管理コンソール:
 *                             - イベント情報 (名前編集 / 受付開閉トグル)
 *                             - アクション (有効無効トグル / 追加 / 削除 / SPA 詳細へ)
 *                             - 参加届 (一覧 / 件数 / CSV / 却下 / 削除)
 *                             - 共有リンク (参加届 / 応募 / TT API / TT 編集・作成)
 * - GET /admin/:eventId     タイムテーブル編集 (timetable_events。iOS 配信用・後方互換)。
 *
 * 秘密情報を含まない静的 HTML を Worker から直接返す。保存系は管理トークン
 * (ADMIN_TOKEN) を入力し admin API を叩く。トークンは sessionStorage + React SPA と
 * 同じ localStorage キーの双方に保持し、詳細ボタンから SPA を開くと再入力不要。
 */

const STYLE = `
  :root { font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif; }
  body { margin: 0; padding: 24px; background: #f8fafc; color: #0f172a; max-width: 1080px; }
  a { color: #1d4ed8; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .lede { color: #475569; font-size: 13px; margin: 0 0 16px; }
  .bar { position: sticky; top: 0; background: #f8fafc; padding: 12px 0; display: flex; gap: 8px; align-items: flex-end; flex-wrap: wrap; border-bottom: 1px solid #e2e8f0; z-index: 10; }
  button, .btn { padding: 6px 12px; border: 1px solid #cbd5e1; background: #fff; border-radius: 6px; cursor: pointer; font-size: 13px; text-decoration: none; color: #0f172a; display: inline-block; }
  button.add, .btn.add { border-color: #93c5fd; color: #1d4ed8; }
  button.del { border-color: #fca5a5; color: #b91c1c; }
  button.primary { background: #1d4ed8; color: #fff; border-color: #1d4ed8; }
  select { padding: 5px 7px; border: 1px solid #cbd5e1; border-radius: 5px; font-size: 13px; color: #0f172a; background: #fff; }
  #status { font-size: 13px; font-weight: 600; }
  h2 { font-size: 15px; margin: 0 0 8px; }
  .fld { display: flex; flex-direction: column; font-size: 11px; color: #64748b; gap: 2px; }
  .fld input, .fld textarea { padding: 5px 7px; border: 1px solid #cbd5e1; border-radius: 5px; font-size: 13px; color: #0f172a; font-family: inherit; }
  .fld .ro { padding: 5px 7px; font-size: 13px; color: #0f172a; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
  .tbl { border-collapse: collapse; width: 100%; background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; }
  .tbl th, .tbl td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #eef2f7; font-size: 13px; vertical-align: middle; }
  .tbl th { background: #f1f5f9; font-size: 11px; color: #475569; }
  .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px; margin: 12px 0; }
  .section { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 14px 0; }
  .pill { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid #cbd5e1; }
  .pill.ok { background: #ecfdf5; border-color: #a7f3d0; color: #15803d; }
  .pill.muted { background: #f1f5f9; border-color: #e2e8f0; color: #64748b; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: #64748b; }
  .linkrow { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 6px 0; border-top: 1px dashed #eef2f7; }
  .linkrow:first-child { border-top: none; }
  .llabel { font-size: 12px; color: #475569; min-width: 150px; }
  .lurl { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; background: #f1f5f9; padding: 2px 6px; border-radius: 4px; word-break: break-all; }
  .day { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; margin-bottom: 14px; }
  .day-head { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; margin-bottom: 8px; }
  .item { display: grid; grid-template-columns: 70px 70px 1.6fr 1.2fr 1.2fr 90px auto; gap: 8px; align-items: end; padding: 8px 0; border-top: 1px dashed #e2e8f0; }
  .updated { color: #64748b; font-size: 12px; margin-top: 16px; }
  @media (max-width: 720px) { .item { grid-template-columns: 1fr 1fr; } }
`;

// 一覧・詳細・編集で共有する DOM ヘルパ + トークン管理。String.raw + DOM API で
// 外側テンプレートリテラルとの `${` 衝突を避ける。
const PRELUDE_JS = String.raw`
  var SS_KEY = "tt_admin_token";           // sessionStorage (このコンソール)
  var SPA_KEY = "devhub_ops:admin_token";  // localStorage (React SPA と共有 → deep link で再入力不要)
  var statusEl = document.getElementById("status");
  function setStatus(msg, ok) { if (!statusEl) return; statusEl.textContent = msg; statusEl.style.color = ok ? "#15803d" : "#b91c1c"; }
  function persistToken(v) { if (!v) return; try { sessionStorage.setItem(SS_KEY, v); localStorage.setItem(SPA_KEY, v); } catch (e) {} }
  // token() は読むたびに現在値を永続化する。password manager の autofill は
  // 'input' を発火しないことがあり、input 時のみ保存だと storage が空のまま
  // 別ページ (詳細) へ遷移してトークンを見失う → アクションが出ない不具合になる。
  // 読み取り時保存にすることで、一覧が出た時点で確実に storage へ載る。
  function token() {
    var el0 = document.getElementById("token");
    var v = el0 ? el0.value.trim() : "";
    persistToken(v);
    return v;
  }
  function initToken() {
    var el0 = document.getElementById("token");
    var saved = "";
    try { saved = sessionStorage.getItem(SS_KEY) || localStorage.getItem(SPA_KEY) || ""; } catch (e) {}
    el0.value = saved;
    var save = function () { persistToken(el0.value.trim()); };
    // input / change / blur を全て拾う (autofill 差異に強くする)。
    el0.addEventListener("input", save);
    el0.addEventListener("change", save);
    el0.addEventListener("blur", save);
  }
  function authHeaders(json) {
    var h = { "x-admin-token": token() };
    if (json) h["Content-Type"] = "application/json";
    return h;
  }
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "class") n.className = attrs[k];
      else if (k === "value") n.value = attrs[k];
      else n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }
  function t(s) { return document.createTextNode(s == null ? "" : String(s)); }
  function td(v) { return el("td", null, [t(v)]); }
  function th(v) { return el("th", null, [t(v)]); }
  function badge(text, cls) { return el("span", { class: "pill " + (cls || "") }, [t(text)]); }
  function labeled(text, input) { return el("label", { class: "fld" }, [el("span", null, [text]), input]); }
  function input(value, oninput, placeholder) {
    var i = el("input", { value: value == null ? "" : String(value) });
    if (placeholder) i.placeholder = placeholder;
    if (oninput) i.addEventListener("input", function () { oninput(i.value); });
    return i;
  }
  function jsonFetch(url, opts) {
    return fetch(url, opts).then(function (r) { return r.json().then(function (b) { return { ok: r.ok, status: r.status, body: b }; }).catch(function () { return { ok: r.ok, status: r.status, body: {} }; }); });
  }
  function copyText(text, okMsg) {
    function done() { setStatus(okMsg || "コピーしました", true); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { window.prompt("コピー用テキスト", text); });
    } else { window.prompt("コピー用テキスト", text); }
  }
`;

// ---- 一覧ダッシュボード (core events) ----
const DASHBOARD_JS = String.raw`
(function () {
  initToken();
  var listEl = document.getElementById("list");
  var statusSel = document.getElementById("statusFilter");
  var TYPE_LABELS = { meetup: "交流会", hackathon: "ハッカソン", project: "プロジェクト", study: "勉強会" };
  function typeLabel(x) { return TYPE_LABELS[x] || x; }

  function render(events) {
    listEl.textContent = "";
    if (!events.length) { listEl.appendChild(el("p", { class: "lede" }, ["イベントがありません。下のフォームから作成してください。"])); return; }
    var table = el("table", { class: "tbl" }, []);
    table.appendChild(el("tr", null, [th("イベント"), th("種別"), th("状態"), th("アクション"), th("参加届"), th("応募"), th("TT"), th("操作")]));
    events.forEach(function (ev) {
      var open = el("a", { href: "/admin/e/" + encodeURIComponent(ev.id), class: "btn add" }, ["開く"]);
      var toggle = el("button", { class: ev.status === "active" ? "del" : "" }, [ev.status === "active" ? "受付終了" : "受付再開"]);
      toggle.addEventListener("click", function () { toggleStatus(ev); });
      table.appendChild(el("tr", null, [
        el("td", null, [el("strong", null, [ev.name])]),
        td(typeLabel(ev.type)),
        el("td", null, [badge(ev.status === "active" ? "受付中" : "終了", ev.status === "active" ? "ok" : "muted")]),
        td(ev.actionsEnabled + "/" + ev.actionCount),
        td(ev.participationCount),
        td(ev.applicationCount),
        td(ev.hasTimetable ? "✓" : ""),
        el("td", null, [open, t(" "), toggle]),
      ]));
    });
    listEl.appendChild(table);
  }

  function load() {
    if (!token()) { setStatus("管理トークンを入力してください", false); return; }
    setStatus("読み込み中...", true);
    var q = statusSel.value === "all" ? "?status=all" : "";
    jsonFetch(location.origin + "/api/orgs/summary" + q, { headers: authHeaders(false) })
      .then(function (res) {
        if (!res.ok) { setStatus("一覧取得失敗 (" + res.status + "): " + (res.body.error || "トークンを確認"), false); return; }
        render(res.body.events);
        setStatus("読み込み完了 (" + res.body.events.length + "件)", true);
      })
      .catch(function (e) { setStatus("取得失敗: " + e, false); });
  }

  function toggleStatus(ev) {
    if (!token()) { setStatus("管理トークンを入力してください", false); return; }
    var next = ev.status === "active" ? "archived" : "active";
    var verb = next === "archived" ? "受付を終了 (アーカイブ)" : "受付を再開";
    if (!confirm("「" + ev.name + "」の" + verb + "しますか？")) return;
    jsonFetch(location.origin + "/api/orgs/" + encodeURIComponent(ev.id), { method: "PUT", headers: authHeaders(true), body: JSON.stringify({ status: next }) })
      .then(function (res) { if (!res.ok) { setStatus("変更失敗 (" + res.status + "): " + (res.body.error || ""), false); return; } setStatus("変更しました", true); load(); })
      .catch(function (e) { setStatus("変更失敗: " + e, false); });
  }

  function createEvent() {
    if (!token()) { setStatus("管理トークンを入力してください", false); return; }
    var body = { type: document.getElementById("new-type").value, name: document.getElementById("new-name").value.trim() };
    if (!body.name) { setStatus("イベント名を入力してください", false); return; }
    jsonFetch(location.origin + "/api/orgs", { method: "POST", headers: authHeaders(true), body: JSON.stringify(body) })
      .then(function (res) { if (!res.ok) { setStatus("作成失敗 (" + res.status + "): " + (res.body.error || ""), false); return; } location.href = "/admin/e/" + encodeURIComponent(res.body.id); })
      .catch(function (e) { setStatus("作成失敗: " + e, false); });
  }

  document.getElementById("reload").addEventListener("click", load);
  statusSel.addEventListener("change", load);
  document.getElementById("create").addEventListener("click", createEvent);
  load();
})();
`;

// ---- イベント詳細コンソール ----
const DETAIL_JS = String.raw`
(function () {
  initToken();
  var eventId = decodeURIComponent(location.pathname.replace(/^\/admin\/e\//, ""));
  document.getElementById("evid").textContent = eventId;
  var origin = location.origin;
  var current = null;
  var forms = [];

  var ACTION_LABELS = {
    schedule_polling: "日程調整", task_management: "タスク管理", member_welcome: "新メンバー歓迎",
    pr_review_list: "PRレビュー", member_application: "入会応募", weekly_reminder: "週次リマインド",
    attendance_check: "出欠確認", role_management: "ロール管理", member_roster: "名簿",
    morning_standup: "朝会", kejime_tracker: "けじめ", whitelist: "ホワイトリスト",
    goal_reminder: "目標リマインド", tutorial: "チュートリアル", sponsor_application: "スポンサー募集",
    stale_pr_nudge: "PR停滞催促",
  };
  // orgs POST の VALID_TYPES と一致させる (追加できる種別)。
  var ADD_TYPES = ["schedule_polling", "task_management", "member_welcome", "pr_review_list",
    "member_application", "weekly_reminder", "attendance_check", "role_management", "member_roster",
    "morning_standup", "kejime_tracker", "whitelist", "goal_reminder", "tutorial",
    "sponsor_application", "stale_pr_nudge"];
  function actionLabel(x) { return ACTION_LABELS[x] || x; }
  function activityLabel(x) { return ({ event: "イベント", dev: "開発", both: "両方" })[x] || (x || ""); }
  function fmtDate(s) { return s ? String(s).slice(0, 16).replace("T", " ") : ""; }

  function reloadAll() {
    if (!token()) {
      setStatus("管理トークンを入力してください", false);
      // 空セクションを黙って出さず、原因を明示する (トークン未入力 = アクション非表示の主因)。
      var hint = "上の「管理トークン」を入力して「再読み込み」を押してください。";
      document.getElementById("actions").textContent = "";
      document.getElementById("actions").appendChild(el("p", { class: "lede" }, [hint]));
      document.getElementById("forms").textContent = "";
      document.getElementById("forms").appendChild(el("p", { class: "lede" }, [hint]));
      return;
    }
    setStatus("読み込み中...", true);
    loadEvent(); loadActions(); loadForms();
  }

  // ---- イベント情報 ----
  function loadEvent() {
    jsonFetch(origin + "/api/orgs/" + encodeURIComponent(eventId), { headers: authHeaders(false) })
      .then(function (res) {
        if (!res.ok) { setStatus("イベント取得失敗 (" + res.status + "): " + (res.body.error || "トークンを確認"), false); return; }
        current = res.body;
        document.getElementById("m-name").value = current.name;
        document.getElementById("m-type").textContent = current.type;
        renderStatus();
        renderShareLinks();
        checkTimetable();
        setStatus("読み込み完了", true);
      })
      .catch(function (e) { setStatus("取得失敗: " + e, false); });
  }
  function renderStatus() {
    document.getElementById("m-status").textContent = current.status === "active" ? "受付中" : "終了 (アーカイブ)";
    document.getElementById("toggle-status").textContent = current.status === "active" ? "受付終了" : "受付再開";
  }
  function saveName() {
    if (!token()) { setStatus("管理トークンを入力してください", false); return; }
    var name = document.getElementById("m-name").value.trim();
    if (!name) { setStatus("イベント名は必須です", false); return; }
    jsonFetch(origin + "/api/orgs/" + encodeURIComponent(eventId), { method: "PUT", headers: authHeaders(true), body: JSON.stringify({ name: name }) })
      .then(function (res) { if (!res.ok) { setStatus("保存失敗: " + (res.body.error || res.status), false); return; } current = res.body; setStatus("イベント名を保存しました", true); })
      .catch(function (e) { setStatus("保存失敗: " + e, false); });
  }
  function toggleStatus() {
    if (!current || !token()) { setStatus("管理トークンを入力してください", false); return; }
    var next = current.status === "active" ? "archived" : "active";
    if (!confirm((next === "archived" ? "受付を終了 (アーカイブ)" : "受付を再開") + "しますか？")) return;
    jsonFetch(origin + "/api/orgs/" + encodeURIComponent(eventId), { method: "PUT", headers: authHeaders(true), body: JSON.stringify({ status: next }) })
      .then(function (res) { if (!res.ok) { setStatus("変更失敗: " + (res.body.error || res.status), false); return; } current = res.body; renderStatus(); setStatus("変更しました", true); })
      .catch(function (e) { setStatus("変更失敗: " + e, false); });
  }

  // ---- アクション ----
  function loadActions() {
    jsonFetch(origin + "/api/orgs/" + encodeURIComponent(eventId) + "/actions", { headers: authHeaders(false) })
      .then(function (res) {
        var root = document.getElementById("actions"); root.textContent = "";
        if (!res.ok) { root.appendChild(el("p", { class: "lede" }, ["取得失敗: " + (res.body.error || res.status)])); return; }
        var acts = res.body || [];
        // cottage 専用: アプリ表示コンテンツ/タイムテーブル編集ページへの目立つ導線。
        // これらは event_actions ではなく専用エディタなので、ここで明示しないと辿り着けない。
        if (eventId === "cottage") {
          root.appendChild(el("div", { class: "card" }, [
            el("strong", null, ["コテージ アプリの表示内容を編集"]),
            el("p", { class: "lede" }, ["cottage-ios アプリに配信する内容 (催し/レシピ/持ち物/班/集金/会場マップ/タイムテーブル) はここから編集します。"]),
            el("a", { href: "/admin/cottage/content", class: "btn add" }, ["表示コンテンツを編集"]),
            t(" "),
            el("a", { href: "/admin/cottage", class: "btn add" }, ["タイムテーブルを編集"]),
          ]));
        }
        if (!acts.length) { root.appendChild(el("p", { class: "lede" }, ["アクション未登録。下で追加できます。"])); }
        else {
          var table = el("table", { class: "tbl" }, []);
          table.appendChild(el("tr", null, [th("アクション"), th("状態"), th("操作")]));
          acts.forEach(function (a) {
            var toggle = el("button", null, [a.enabled ? "無効化" : "有効化"]);
            toggle.addEventListener("click", function () { setEnabled(a); });
            var openA = el("a", { href: "/events/" + encodeURIComponent(eventId) + "/actions/" + encodeURIComponent(a.actionType), target: "_blank", class: "btn add" }, ["詳細/操作"]);
            var del = el("button", { class: "del" }, ["削除"]);
            del.addEventListener("click", function () { delAction(a); });
            table.appendChild(el("tr", null, [
              el("td", null, [el("strong", null, [actionLabel(a.actionType)]), el("span", { class: "mono" }, [" " + a.actionType])]),
              el("td", null, [badge(a.enabled ? "有効" : "無効", a.enabled ? "ok" : "muted")]),
              el("td", null, [openA, t(" "), toggle, t(" "), del]),
            ]));
          });
          root.appendChild(table);
        }
        renderAddSelect(acts);
      })
      .catch(function (e) { setStatus("アクション取得失敗: " + e, false); });
  }
  function renderAddSelect(existing) {
    var sel = document.getElementById("add-type"); sel.textContent = "";
    var have = {}; existing.forEach(function (a) { have[a.actionType] = 1; });
    var any = false;
    ADD_TYPES.forEach(function (x) { if (have[x]) return; any = true; sel.appendChild(el("option", { value: x }, [actionLabel(x) + " (" + x + ")"])); });
    document.getElementById("add-action").disabled = !any;
    if (!any) sel.appendChild(el("option", { value: "" }, ["すべて登録済み"]));
  }
  function addAction() {
    if (!token()) { setStatus("管理トークンを入力してください", false); return; }
    var type = document.getElementById("add-type").value;
    if (!type) { setStatus("追加できるアクションがありません", false); return; }
    jsonFetch(origin + "/api/orgs/" + encodeURIComponent(eventId) + "/actions", { method: "POST", headers: authHeaders(true), body: JSON.stringify({ actionType: type }) })
      .then(function (res) { if (!res.ok) { setStatus("追加失敗: " + (res.body.error || res.status), false); return; } setStatus("追加しました", true); loadActions(); })
      .catch(function (e) { setStatus("追加失敗: " + e, false); });
  }
  function setEnabled(a) {
    if (!token()) { setStatus("管理トークンを入力してください", false); return; }
    jsonFetch(origin + "/api/orgs/" + encodeURIComponent(eventId) + "/actions/" + encodeURIComponent(a.id), { method: "PUT", headers: authHeaders(true), body: JSON.stringify({ enabled: a.enabled ? 0 : 1 }) })
      .then(function (res) { if (!res.ok) { setStatus("変更失敗: " + (res.body.error || res.status), false); return; } setStatus("変更しました", true); loadActions(); })
      .catch(function (e) { setStatus("変更失敗: " + e, false); });
  }
  function delAction(a) {
    if (!token()) { setStatus("管理トークンを入力してください", false); return; }
    if (!confirm(actionLabel(a.actionType) + " を削除しますか？ (設定も消えます)")) return;
    jsonFetch(origin + "/api/orgs/" + encodeURIComponent(eventId) + "/actions/" + encodeURIComponent(a.id), { method: "DELETE", headers: authHeaders(false) })
      .then(function (res) { if (!res.ok) { setStatus("削除失敗: " + (res.body.error || res.status), false); return; } setStatus("削除しました", true); loadActions(); })
      .catch(function (e) { setStatus("削除失敗: " + e, false); });
  }

  // ---- 参加届 ----
  function loadForms() {
    jsonFetch(origin + "/api/orgs/" + encodeURIComponent(eventId) + "/participation-forms", { headers: authHeaders(false) })
      .then(function (res) {
        var root = document.getElementById("forms"); root.textContent = "";
        if (!res.ok) { root.appendChild(el("p", { class: "lede" }, ["取得失敗: " + (res.body.error || res.status)])); return; }
        forms = res.body || [];
        document.getElementById("form-count").textContent = String(forms.length);
        if (!forms.length) { root.appendChild(el("p", { class: "lede" }, ["参加届はまだありません。"])); return; }
        var table = el("table", { class: "tbl" }, []);
        table.appendChild(el("tr", null, [th("提出"), th("氏名"), th("メール"), th("学年"), th("希望"), th("状態"), th("操作")]));
        forms.forEach(function (f) {
          var reject = el("button", null, [f.status === "rejected" ? "却下解除" : "却下"]);
          reject.addEventListener("click", function () { setFormStatus(f); });
          var del = el("button", { class: "del" }, ["削除"]);
          del.addEventListener("click", function () { delForm(f); });
          table.appendChild(el("tr", null, [
            td(fmtDate(f.submittedAt)), td(f.name), td(f.email), td(f.grade || ""),
            td(activityLabel(f.desiredActivity)),
            el("td", null, [badge(f.status === "rejected" ? "却下" : "提出", f.status === "rejected" ? "muted" : "ok")]),
            el("td", null, [reject, t(" "), del]),
          ]));
        });
        root.appendChild(table);
      })
      .catch(function (e) { setStatus("参加届取得失敗: " + e, false); });
  }
  function setFormStatus(f) {
    if (!token()) { setStatus("管理トークンを入力してください", false); return; }
    var next = f.status === "rejected" ? "submitted" : "rejected";
    jsonFetch(origin + "/api/orgs/" + encodeURIComponent(eventId) + "/participation-forms/" + encodeURIComponent(f.id), { method: "PATCH", headers: authHeaders(true), body: JSON.stringify({ status: next }) })
      .then(function (res) { if (!res.ok) { setStatus("変更失敗: " + (res.body.error || res.status), false); return; } setStatus("変更しました", true); loadForms(); })
      .catch(function (e) { setStatus("変更失敗: " + e, false); });
  }
  function delForm(f) {
    if (!token()) { setStatus("管理トークンを入力してください", false); return; }
    if (!confirm(f.name + " の参加届を削除しますか？")) return;
    jsonFetch(origin + "/api/orgs/" + encodeURIComponent(eventId) + "/participation-forms/" + encodeURIComponent(f.id), { method: "DELETE", headers: authHeaders(false) })
      .then(function (res) { if (!res.ok) { setStatus("削除失敗: " + (res.body.error || res.status), false); return; } setStatus("削除しました", true); loadForms(); })
      .catch(function (e) { setStatus("削除失敗: " + e, false); });
  }
  function exportCsv() {
    if (!forms.length) { setStatus("エクスポートするデータがありません", false); return; }
    var cols = ["submittedAt", "name", "nameKana", "email", "studentId", "department", "grade", "gender", "desiredActivity", "devRoles", "otherAffiliations", "hasAllergy", "allergyDetail", "status", "slackName", "slackUserId"];
    var lines = [cols.join(",")];
    forms.forEach(function (f) {
      lines.push(cols.map(function (c) {
        var v = f[c];
        if (Array.isArray(v)) v = v.join("|");
        if (v == null) v = "";
        return '"' + String(v).replace(/"/g, '""') + '"';
      }).join(","));
    });
    var csv = "﻿" + lines.join("\r\n");
    var blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    var url = URL.createObjectURL(blob);
    var a = el("a", { href: url, download: "participation_" + eventId + ".csv" }, []);
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setStatus("CSV をダウンロードしました (" + forms.length + "件)", true);
  }

  // ---- 共有リンク ----
  function renderShareLinks() {
    var root = document.getElementById("links"); root.textContent = "";
    function linkRow(label, url) {
      var open = el("a", { href: url, target: "_blank", class: "btn add" }, ["開く"]);
      var copy = el("button", null, ["コピー"]);
      copy.addEventListener("click", function () { copyText(url, "URLをコピーしました"); });
      return el("div", { class: "linkrow" }, [el("span", { class: "llabel" }, [label]), el("code", { class: "lurl" }, [url]), open, t(" "), copy]);
    }
    root.appendChild(linkRow("参加届フォーム (公開)", origin + "/participation/" + encodeURIComponent(eventId)));
    root.appendChild(linkRow("応募フォーム (公開)", origin + "/apply/" + encodeURIComponent(eventId)));
    root.appendChild(linkRow("タイムテーブルAPI (iOS)", origin + "/api/events/" + encodeURIComponent(eventId) + "/timetable"));
    // cottage 専用: アプリ表示コンテンツ編集ページ (催し/レシピ/持ち物/班/集金/会場マップ) への導線。
    if (eventId === "cottage") {
      root.appendChild(linkRow("コテージ アプリ表示コンテンツ編集", origin + "/admin/cottage/content"));
    }
  }
  function checkTimetable() {
    jsonFetch(origin + "/api/events/" + encodeURIComponent(eventId) + "/timetable", { headers: { Accept: "application/json" } })
      .then(function (res) {
        var wrap = document.getElementById("tt-action"); wrap.textContent = "";
        if (res.ok) {
          wrap.appendChild(el("a", { href: "/admin/" + encodeURIComponent(eventId), class: "btn add" }, ["タイムテーブルを編集"]));
        } else {
          var b = el("button", { class: "add" }, ["タイムテーブルを作成"]);
          b.addEventListener("click", createTimetable);
          wrap.appendChild(b);
          wrap.appendChild(el("span", { class: "mono" }, [" 未作成"]));
        }
      });
  }
  function createTimetable() {
    if (!token()) { setStatus("管理トークンを入力してください", false); return; }
    jsonFetch(origin + "/api/events", { method: "POST", headers: authHeaders(true), body: JSON.stringify({ id: eventId, name: current ? current.name : eventId }) })
      .then(function (res) { if (!res.ok) { setStatus("TT作成失敗: " + (res.body.error || res.status) + " (id が [a-z0-9-] のみか確認)", false); return; } location.href = "/admin/" + encodeURIComponent(eventId); })
      .catch(function (e) { setStatus("TT作成失敗: " + e, false); });
  }

  document.getElementById("reload").addEventListener("click", reloadAll);
  document.getElementById("save-name").addEventListener("click", saveName);
  document.getElementById("toggle-status").addEventListener("click", toggleStatus);
  document.getElementById("add-action").addEventListener("click", addAction);
  document.getElementById("csv").addEventListener("click", exportCsv);
  reloadAll();
})();
`;

// ---- タイムテーブル編集ページ (timetable_events / iOS 配信・後方互換) ----
const EDITOR_JS = String.raw`
(function () {
  initToken();
  var id = decodeURIComponent(location.pathname.replace(/^\/admin\//, ""));
  document.getElementById("evid").textContent = id;
  document.getElementById("backlink").href = "/admin/e/" + encodeURIComponent(id);
  var apiBase = location.origin + "/api/events";
  var meta = { name: "", startDate: "", endDate: "", description: "" };
  var days = [];
  var updatedEl = document.getElementById("updated");

  function bindMeta() {
    document.getElementById("m-name").value = meta.name;
    document.getElementById("m-start").value = meta.startDate;
    document.getElementById("m-end").value = meta.endDate;
    document.getElementById("m-desc").value = meta.description;
  }

  function renderDays() {
    var root = document.getElementById("days");
    root.textContent = "";
    days.forEach(function (day, di) {
      var head = el("div", { class: "day-head" }, [
        labeled("Day", input(String(day.day), function (v) { day.day = parseInt(v, 10) || 0; }, "1")),
        labeled("日付", input(day.date, function (v) { day.date = v; }, "YYYY-MM-DD")),
        el("button", { class: "del" }, ["この日を削除"])
      ]);
      head.querySelector(".del").addEventListener("click", function () { days.splice(di, 1); renderDays(); });

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
        row.querySelector(".del").addEventListener("click", function () { day.items.splice(ii, 1); renderDays(); });
        itemsWrap.appendChild(row);
      });

      var addItem = el("button", { class: "add" }, ["＋ 項目を追加"]);
      addItem.addEventListener("click", function () {
        if (!day.items) day.items = [];
        var n = day.items.length + 1;
        day.items.push({ id: "d" + day.day + "-" + n, start: "", end: "", title: "", location: "", note: "" });
        renderDays();
      });
      root.appendChild(el("section", { class: "day" }, [head, itemsWrap, addItem]));
    });
  }

  function collect() {
    return {
      name: document.getElementById("m-name").value.trim(),
      startDate: document.getElementById("m-start").value.trim(),
      endDate: document.getElementById("m-end").value.trim(),
      description: document.getElementById("m-desc").value,
      days: days
    };
  }

  function load() {
    setStatus("読み込み中...", true);
    jsonFetch(apiBase + "/" + id + "/timetable", { headers: { "Accept": "application/json" } })
      .then(function (res) {
        if (!res.ok) { setStatus("読み込み失敗 (" + res.status + "): " + (res.body.error || ""), false); return; }
        meta = { name: res.body.name, startDate: res.body.startDate, endDate: res.body.endDate, description: res.body.description };
        days = res.body.days || [];
        updatedEl.textContent = "現在の updatedAt: " + (res.body.updatedAt || "(なし)");
        bindMeta(); renderDays();
        setStatus("読み込み完了", true);
      })
      .catch(function (e) { setStatus("読み込み失敗: " + e, false); });
  }

  function save() {
    if (!token()) { setStatus("管理トークンを入力してください", false); return; }
    var body = collect();
    if (!body.name) { setStatus("イベント名は必須です", false); return; }
    setStatus("保存中...", true);
    jsonFetch(apiBase + "/" + id, { method: "PUT", headers: authHeaders(true), body: JSON.stringify(body) })
      .then(function (res) {
        if (!res.ok) { setStatus("保存失敗 (" + res.status + "): " + (res.body.error || ""), false); return; }
        updatedEl.textContent = "現在の updatedAt: " + res.body.updatedAt;
        setStatus("保存しました。配信に反映されます。", true);
      })
      .catch(function (e) { setStatus("保存失敗: " + e, false); });
  }

  function removeEvent() {
    if (!token()) { setStatus("管理トークンを入力してください", false); return; }
    if (!confirm("このタイムテーブル (" + id + ") を削除しますか？")) return;
    jsonFetch(apiBase + "/" + id, { method: "DELETE", headers: authHeaders(false) })
      .then(function (res) {
        if (!res.ok) { setStatus("削除失敗 (" + res.status + "): " + (res.body.error || ""), false); return; }
        location.href = "/admin/e/" + encodeURIComponent(id);
      })
      .catch(function (e) { setStatus("削除失敗: " + e, false); });
  }

  document.getElementById("reload").addEventListener("click", load);
  document.getElementById("save").addEventListener("click", save);
  document.getElementById("delete").addEventListener("click", removeEvent);
  document.getElementById("add-day").addEventListener("click", function () {
    days.push({ day: days.length + 1, date: "", items: [] });
    renderDays();
  });
  load();
})();
`;

// ---- コテージ表示コンテンツ編集ページ (cottage_content / iOS 配信) ----
// 8 セクション (旅行概要 / 催し / レシピ / 持ち物 / 班 / 集金 / 版一覧 / 会場マップ)
// を 1 ドキュメントとして編集し、PUT /api/cottage/content で丸ごと保存する。
// 文字列配列 (メモ・材料・手順・コツ・メンバー等) は 1 行 1 項目の textarea で編集。
const COTTAGE_CONTENT_JS = String.raw`
(function () {
  initToken();
  var api = location.origin + "/api/cottage/content";
  var content = null;
  var updatedEl = document.getElementById("updated");

  // 1 行 1 項目の textarea (文字列配列 <-> 複数行)。
  function ta(value, onchange) {
    var n = el("textarea", { rows: String(Math.max(2, (value || []).length + 1)) });
    n.value = (value || []).join("\n");
    n.addEventListener("input", function () {
      onchange(n.value.split("\n").map(function (s) { return s.trim(); }).filter(function (s) { return s !== ""; }));
    });
    return n;
  }
  function numInput(value, onchange, ph) {
    var i = input(value == null ? "" : String(value), function (v) {
      onchange(v.trim() === "" ? null : (parseInt(v, 10) || 0));
    }, ph);
    i.setAttribute("inputmode", "numeric");
    return i;
  }
  function delBtn(onclick) {
    var b = el("button", { class: "del" }, ["削除"]);
    b.addEventListener("click", onclick);
    return b;
  }
  function addBtn(label, onclick) {
    var b = el("button", { class: "add" }, [label]);
    b.addEventListener("click", onclick);
    return b;
  }
  function card(children) { return el("div", { class: "day" }, children); }

  function renderTrip() {
    var tr = content.trip;
    var root = document.getElementById("sec-trip"); root.textContent = "";
    root.appendChild(el("div", { class: "row" }, [
      labeled("タイトル", input(tr.title, function (v) { tr.title = v; })),
      labeled("場所", input(tr.location, function (v) { tr.location = v; })),
      labeled("開始日", input(tr.startDate, function (v) { tr.startDate = v; }, "YYYY-MM-DD")),
      labeled("終了日", input(tr.endDate, function (v) { tr.endDate = v; }, "YYYY-MM-DD")),
      labeled("泊数", numInput(tr.nights, function (v) { tr.nights = v || 0; })),
      labeled("参加人数", numInput(tr.participantCount, function (v) { tr.participantCount = v || 0; }))
    ]));
    root.appendChild(labeled("メモ (1行1項目)", ta(tr.notes, function (v) { tr.notes = v; })));
  }

  function renderActivities() {
    var root = document.getElementById("sec-activities"); root.textContent = "";
    content.activities.forEach(function (a, i) {
      root.appendChild(card([
        el("div", { class: "row" }, [
          labeled("id", input(a.id, function (v) { a.id = v; })),
          labeled("名前", input(a.name, function (v) { a.name = v; })),
          labeled("絵文字", input(a.emoji, function (v) { a.emoji = v; })),
          labeled("場所", input(a.location, function (v) { a.location = v || null; })),
          delBtn(function () { content.activities.splice(i, 1); renderActivities(); })
        ]),
        labeled("概要", input(a.summary, function (v) { a.summary = v; })),
        labeled("説明", input(a.description, function (v) { a.description = v; })),
        labeled("持ち物/コツ (1行1項目)", ta(a.tips, function (v) { a.tips = v; }))
      ]));
    });
    root.appendChild(addBtn("＋ 催しを追加", function () {
      content.activities.push({ id: "act-" + Date.now().toString(36), name: "", emoji: "", summary: "", description: "", location: null, tips: [] });
      renderActivities();
    }));
  }

  function renderRecipes() {
    var root = document.getElementById("sec-recipes"); root.textContent = "";
    content.recipes.forEach(function (r, i) {
      root.appendChild(card([
        el("div", { class: "row" }, [
          labeled("id", input(r.id, function (v) { r.id = v; })),
          labeled("名前", input(r.name, function (v) { r.name = v; })),
          labeled("絵文字", input(r.emoji, function (v) { r.emoji = v; })),
          labeled("分類", input(r.category, function (v) { r.category = v; })),
          labeled("分量", input(r.servings, function (v) { r.servings = v; })),
          labeled("時間", input(r.time, function (v) { r.time = v; })),
          delBtn(function () { content.recipes.splice(i, 1); renderRecipes(); })
        ]),
        labeled("材料 (1行1項目)", ta(r.ingredients, function (v) { r.ingredients = v; })),
        labeled("手順 (1行1項目)", ta(r.steps, function (v) { r.steps = v; })),
        labeled("コツ (1行1項目)", ta(r.tips, function (v) { r.tips = v; }))
      ]));
    });
    root.appendChild(addBtn("＋ レシピを追加", function () {
      content.recipes.push({ id: "recipe-" + Date.now().toString(36), name: "", emoji: "", category: "", servings: "", time: "", ingredients: [], steps: [], tips: [] });
      renderRecipes();
    }));
  }

  function renderPacking() {
    var root = document.getElementById("sec-packing"); root.textContent = "";
    content.packing.forEach(function (p, i) {
      root.appendChild(el("div", { class: "row" }, [
        labeled("id", input(p.id, function (v) { p.id = v; })),
        labeled("項目", input(p.label, function (v) { p.label = v; })),
        labeled("カテゴリ", input(p.category, function (v) { p.category = v; })),
        delBtn(function () { content.packing.splice(i, 1); renderPacking(); })
      ]));
    });
    root.appendChild(addBtn("＋ 持ち物を追加", function () {
      content.packing.push({ id: "p-" + Date.now().toString(36), label: "", category: "" });
      renderPacking();
    }));
  }

  function renderGroups() {
    var root = document.getElementById("sec-groups"); root.textContent = "";
    content.groups.forEach(function (g, i) {
      root.appendChild(card([
        el("div", { class: "row" }, [
          labeled("id", input(g.id, function (v) { g.id = v; })),
          labeled("班名", input(g.name, function (v) { g.name = v; })),
          labeled("車", input(g.car, function (v) { g.car = v || null; })),
          labeled("運転手", input(g.driver, function (v) { g.driver = v || null; })),
          delBtn(function () { content.groups.splice(i, 1); renderGroups(); })
        ]),
        labeled("メンバー (1行1名)", ta(g.members, function (v) { g.members = v; }))
      ]));
    });
    root.appendChild(addBtn("＋ 班を追加", function () {
      content.groups.push({ id: "g-" + Date.now().toString(36), name: "", car: null, driver: null, members: [] });
      renderGroups();
    }));
  }

  function renderCollection() {
    var root = document.getElementById("sec-collection"); root.textContent = "";
    root.appendChild(labeled("PayPay 受け取りリンク", input(content.collection.payPayURL, function (v) { content.collection.payPayURL = v; })));
    content.collection.items.forEach(function (c0, i) {
      var kindSel = el("select", null, [
        el("option", { value: "perPerson" }, ["1人あたり固定"]),
        el("option", { value: "shared" }, ["割り勘"]),
        el("option", { value: "unknown" }, ["未確定"])
      ]);
      kindSel.value = c0.kind;
      kindSel.addEventListener("change", function () { c0.kind = kindSel.value; });
      root.appendChild(el("div", { class: "row" }, [
        labeled("id", input(c0.id, function (v) { c0.id = v; })),
        labeled("項目", input(c0.label, function (v) { c0.label = v; })),
        labeled("詳細", input(c0.detail, function (v) { c0.detail = v || null; })),
        labeled("種別", kindSel),
        labeled("金額", numInput(c0.amount, function (v) { c0.amount = v || 0; })),
        labeled("上限(任意)", numInput(c0.amountMax, function (v) { c0.amountMax = v; })),
        delBtn(function () { content.collection.items.splice(i, 1); renderCollection(); })
      ]));
    });
    root.appendChild(addBtn("＋ 集金項目を追加", function () {
      content.collection.items.push({ id: "c-" + Date.now().toString(36), label: "", detail: null, kind: "perPerson", amount: 0, amountMax: null });
      renderCollection();
    }));
  }

  function renderVersions() {
    var root = document.getElementById("sec-versions"); root.textContent = "";
    content.versions.forEach(function (v0, i) {
      var cur = el("input", { type: "checkbox" });
      cur.checked = v0.isCurrent === true;
      cur.addEventListener("change", function () { v0.isCurrent = cur.checked; });
      root.appendChild(card([
        el("div", { class: "row" }, [
          labeled("id", input(v0.id, function (v) { v0.id = v; })),
          labeled("版", input(v0.version, function (v) { v0.version = v; })),
          labeled("日付", input(v0.date, function (v) { v0.date = v; }, "YYYY-MM-DD")),
          labeled("現行", cur),
          delBtn(function () { content.versions.splice(i, 1); renderVersions(); })
        ]),
        labeled("変更点 (1行1項目)", ta(v0.changes, function (v) { v0.changes = v; }))
      ]));
    });
    root.appendChild(addBtn("＋ 版を追加", function () {
      content.versions.push({ id: "v-" + Date.now().toString(36), version: "", date: "", changes: [], isCurrent: false });
      renderVersions();
    }));
  }

  function renderVenue() {
    var root = document.getElementById("sec-venue"); root.textContent = "";
    root.appendChild(el("div", { class: "row" }, [
      labeled("中心 緯度", input(content.venue.centerLat, function (v) { content.venue.centerLat = parseFloat(v) || 0; })),
      labeled("中心 経度", input(content.venue.centerLon, function (v) { content.venue.centerLon = parseFloat(v) || 0; }))
    ]));
    content.venue.features.forEach(function (f, i) {
      var off = el("input", { type: "checkbox" });
      off.checked = f.offsite === true;
      off.addEventListener("change", function () { f.offsite = off.checked; });
      root.appendChild(el("div", { class: "row" }, [
        labeled("id", input(f.id, function (v) { f.id = v; })),
        labeled("名称", input(f.name, function (v) { f.name = v; })),
        labeled("アイコン", input(f.icon, function (v) { f.icon = v; })),
        labeled("メモ", input(f.note, function (v) { f.note = v || null; })),
        labeled("緯度", input(f.lat, function (v) { f.lat = parseFloat(v) || 0; })),
        labeled("経度", input(f.lon, function (v) { f.lon = parseFloat(v) || 0; })),
        labeled("場外", off),
        delBtn(function () { content.venue.features.splice(i, 1); renderVenue(); })
      ]));
    });
    root.appendChild(addBtn("＋ 地点を追加", function () {
      content.venue.features.push({ id: "vf-" + Date.now().toString(36), name: "", icon: "mappin", note: null, lat: content.venue.centerLat, lon: content.venue.centerLon, offsite: false });
      renderVenue();
    }));
  }

  function renderAll() {
    renderTrip(); renderActivities(); renderRecipes(); renderPacking();
    renderGroups(); renderCollection(); renderVersions(); renderVenue();
  }

  function load() {
    setStatus("読み込み中...", true);
    jsonFetch(api, { headers: { Accept: "application/json" } })
      .then(function (res) {
        if (!res.ok) { setStatus("読み込み失敗 (" + res.status + "): " + (res.body.error || ""), false); return; }
        content = res.body;
        updatedEl.textContent = "現在の updatedAt: " + (content.updatedAt || "(なし)");
        renderAll();
        setStatus("読み込み完了", true);
      })
      .catch(function (e) { setStatus("読み込み失敗: " + e, false); });
  }

  function save() {
    if (!token()) { setStatus("管理トークンを入力してください", false); return; }
    if (!content) { setStatus("先に読み込んでください", false); return; }
    setStatus("保存中...", true);
    jsonFetch(api, { method: "PUT", headers: authHeaders(true), body: JSON.stringify(content) })
      .then(function (res) {
        if (!res.ok) { setStatus("保存失敗 (" + res.status + "): " + (res.body.error || ""), false); return; }
        content = res.body;
        updatedEl.textContent = "現在の updatedAt: " + res.body.updatedAt;
        setStatus("保存しました。アプリに反映されます。", true);
      })
      .catch(function (e) { setStatus("保存失敗: " + e, false); });
  }

  document.getElementById("reload").addEventListener("click", load);
  document.getElementById("save").addEventListener("click", save);
  load();
})();
`;

const COTTAGE_CONTENT_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>コテージ表示コンテンツ編集</title><style>${STYLE}
  .row .fld textarea { min-width: 260px; }
  h2 { margin-top: 22px; }
</style></head>
<body>
<p class="lede"><a href="/admin/e/cottage">← このイベントの管理へ</a> ・ <a href="/admin/cottage">タイムテーブル編集</a></p>
<h1>コテージ表示コンテンツ編集</h1>
<p class="lede">cottage-ios アプリが表示するタイムテーブル以外の全コンテンツを編集します。保存すると公開 API (GET /api/cottage/content) 経由でアプリに反映されます。保存には管理トークンが必要です。</p>
<div class="bar">
  <label class="fld"><span>管理トークン</span><input id="token" type="password" placeholder="ADMIN_TOKEN" /></label>
  <button id="reload">再読み込み</button>
  <button id="save" class="primary">保存</button>
  <span id="status"></span>
</div>
<h2>旅行概要</h2><div class="section" id="sec-trip"></div>
<h2>催し (アクティビティ)</h2><div class="section" id="sec-activities"></div>
<h2>レシピ (食事)</h2><div class="section" id="sec-recipes"></div>
<h2>持ち物</h2><div class="section" id="sec-packing"></div>
<h2>班</h2><div class="section" id="sec-groups"></div>
<h2>集金</h2><div class="section" id="sec-collection"></div>
<h2>版一覧</h2><div class="section" id="sec-versions"></div>
<h2>会場マップ</h2><div class="section" id="sec-venue"></div>
<p class="updated" id="updated"></p>
<script>${PRELUDE_JS}${COTTAGE_CONTENT_JS}</script>
</body></html>`;

const LIST_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>イベント管理コンソール</title><style>${STYLE}</style></head>
<body>
<h1>イベント管理コンソール</h1>
<p class="lede">DevHub Ops の全イベントと、各イベントで使える機能 (アクション) ・参加届をここから操作します。保存には管理トークンが必要です。</p>
<div class="bar">
  <label class="fld"><span>管理トークン</span><input id="token" type="password" placeholder="ADMIN_TOKEN" /></label>
  <label class="fld"><span>表示</span><select id="statusFilter"><option value="active">受付中のみ</option><option value="all">すべて (終了含む)</option></select></label>
  <button id="reload">再読み込み</button>
  <span id="status"></span>
</div>
<h2>イベント一覧</h2>
<div id="list"></div>
<h2>新規イベント作成</h2>
<div class="card">
  <div class="row">
    <label class="fld"><span>種別</span><select id="new-type"><option value="meetup">交流会</option><option value="hackathon">ハッカソン</option><option value="project">プロジェクト</option></select></label>
    <label class="fld"><span>イベント名</span><input id="new-name" placeholder="例: 新歓ミートアップ" /></label>
    <button id="create" class="primary">作成して開く</button>
  </div>
</div>
<script>${PRELUDE_JS}${DASHBOARD_JS}</script>
</body></html>`;

const DETAIL_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>イベント管理</title><style>${STYLE}</style></head>
<body>
<p class="lede"><a href="/admin">← イベント一覧へ</a></p>
<h1>イベント管理: <span id="evid" class="mono"></span></h1>
<div class="bar">
  <label class="fld"><span>管理トークン</span><input id="token" type="password" placeholder="ADMIN_TOKEN" /></label>
  <button id="reload">再読み込み</button>
  <span id="status"></span>
</div>

<div class="section">
  <h2>イベント情報</h2>
  <div class="row">
    <label class="fld"><span>名前</span><input id="m-name" /></label>
    <div class="fld"><span>種別</span><div id="m-type" class="ro mono"></div></div>
    <div class="fld"><span>状態</span><div id="m-status" class="ro"></div></div>
    <button id="save-name" class="primary">名前を保存</button>
    <button id="toggle-status">受付終了</button>
  </div>
</div>

<div class="section">
  <h2>アクション (この Bot 機能)</h2>
  <p class="lede">有効/無効の切替・詳細操作 (新規タブで SPA を開く) ・追加・削除ができます。</p>
  <div id="actions"></div>
  <div class="row" style="margin-top:8px">
    <label class="fld"><span>アクションを追加</span><select id="add-type"></select></label>
    <button id="add-action" class="add">＋ 追加</button>
  </div>
</div>

<div class="section">
  <h2>参加届 (<span id="form-count">0</span>件)</h2>
  <div class="row" style="margin-bottom:8px"><button id="csv" class="add">CSV エクスポート</button></div>
  <div id="forms"></div>
</div>

<div class="section">
  <h2>共有リンク</h2>
  <div id="links"></div>
  <div class="linkrow"><span class="llabel">タイムテーブル</span><span id="tt-action"></span></div>
</div>
<script>${PRELUDE_JS}${DETAIL_JS}</script>
</body></html>`;

const EDITOR_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>タイムテーブル編集</title><style>${STYLE}</style></head>
<body>
<p class="lede"><a id="backlink" href="/admin">← このイベントの管理へ</a> ・ <a href="/admin/cottage/content">コテージ表示コンテンツ編集 (cottage のみ)</a></p>
<h1>タイムテーブル編集: <span id="evid"></span></h1>
<p class="lede">iOS などへ配信するタイムテーブルを編集します。保存には管理トークンが必要です。</p>
<div class="bar">
  <label class="fld"><span>管理トークン</span><input id="token" type="password" placeholder="ADMIN_TOKEN" /></label>
  <button id="reload">再読み込み</button>
  <button id="save" class="primary">保存</button>
  <button id="delete" class="del">タイムテーブル削除</button>
  <span id="status"></span>
</div>
<h2>タイムテーブル情報</h2>
<div class="row">
  <label class="fld"><span>名前</span><input id="m-name" /></label>
  <label class="fld"><span>開始日</span><input id="m-start" placeholder="YYYY-MM-DD" /></label>
  <label class="fld"><span>終了日</span><input id="m-end" placeholder="YYYY-MM-DD" /></label>
  <label class="fld"><span>説明</span><input id="m-desc" /></label>
</div>
<h2>日程</h2>
<div id="days"></div>
<button id="add-day" class="add">＋ 日を追加</button>
<p class="updated" id="updated"></p>
<script>${PRELUDE_JS}${EDITOR_JS}</script>
</body></html>`;

export function adminListPage(c: Context<{ Bindings: Env }>) {
  return c.html(LIST_HTML);
}

export function adminEventDetailPage(c: Context<{ Bindings: Env }>) {
  return c.html(DETAIL_HTML);
}

export function adminEventPage(c: Context<{ Bindings: Env }>) {
  return c.html(EDITOR_HTML);
}

export function adminCottageContentPage(c: Context<{ Bindings: Env }>) {
  return c.html(COTTAGE_CONTENT_HTML);
}
