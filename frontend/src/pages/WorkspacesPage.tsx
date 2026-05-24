import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type {
  BotBulkInviteResult,
  GmailAccount,
  Workspace,
} from "../types";
import { api, APIError } from "../api";
import { useToast } from "../components/ui/Toast";
import { useConfirm } from "../components/ui/ConfirmDialog";
import { useIsReadOnly } from "../hooks/usePublicMode";
import { useIsMobile } from "../hooks/useIsMobile";
import { colors } from "../styles/tokens";
import { FeedbackSettingsSection } from "../components/feedback/FeedbackSettingsSection";
import { WorkspaceCard } from "./workspaces/WorkspaceCard";
import { GmailAccountsSection } from "./workspaces/GmailAccountsSection";
import { WorkspaceCreateForm } from "./workspaces/WorkspaceCreateForm";

// ADR-0006 / ADR-0007: Slack workspace 管理画面
// - 一覧 / OAuth 1-click インストール / 手動登録 / 削除
// - bot_token / signing_secret は登録時のみ送信し、サーバーは AES-256-GCM で暗号化保存
export function WorkspacesPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const { confirm } = useConfirm();
  const isReadOnly = useIsReadOnly();
  const isMobile = useIsMobile();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showManualForm, setShowManualForm] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [searchParams, setSearchParams] = useSearchParams();
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  // workspace ごとの「bot 一括招待中」フラグ。複数 workspace を同時実行できないよう、
  // 実行中の workspace id を保持して該当 workspace のボタンだけ disabled にする。
  const [bulkInviteLoading, setBulkInviteLoading] = useState<string | null>(
    null,
  );

  // Sprint 26: Gmail OAuth で連携した送信元アカウント一覧。
  // 自動メール送信のため。delete は revoke せず DB から消すだけなので、
  // 残された refresh_token は使えるが BE 側で id を引けないので実害なし。
  const [gmailAccounts, setGmailAccounts] = useState<GmailAccount[]>([]);
  const [gmailInstallLoading, setGmailInstallLoading] = useState(false);

  // OAuth callback redirect (?installed=<team_name>) を検出して成功メッセージを表示
  useEffect(() => {
    const installed = searchParams.get("installed");
    if (!installed) return;
    setSuccessMsg(`「${installed}」を登録しました`);
    // URL からクエリ削除（履歴を汚さないよう replace）
    searchParams.delete("installed");
    setSearchParams(searchParams, { replace: true });
    const t = setTimeout(() => setSuccessMsg(null), 5000);
    return () => clearTimeout(t);
  }, [searchParams, setSearchParams]);

  // Sprint 26: Gmail OAuth callback (?gmail_connected=1&email=<email>) を検出。
  // BE が /workspaces?gmail_connected=1&email=... に redirect してくるため、
  // ここで toast を出して URL をクリーンアップする。
  useEffect(() => {
    if (!searchParams.get("gmail_connected")) return;
    const email = searchParams.get("email") ?? "";
    toast.success(
      email ? `Gmail を連携しました: ${email}` : "Gmail を連携しました",
    );
    searchParams.delete("gmail_connected");
    searchParams.delete("email");
    setSearchParams(searchParams, { replace: true });
    setRefreshKey((k) => k + 1);
    // toast は dep に含めない (毎レンダリングで identity が変わるため無限ループ防止)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, setSearchParams]);

  // Gmail 連携一覧を取得 (refreshKey で workspace と同時にリロード)
  useEffect(() => {
    let cancelled = false;
    api.gmailAccounts
      .list()
      .then((list) => {
        if (!cancelled) setGmailAccounts(list);
      })
      .catch(() => {
        // 失敗は表示しない (権限切れ等でも workspace 一覧は出したいため)
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const handleGmailInstall = async () => {
    setGmailInstallLoading(true);
    try {
      const { authUrl } = await api.gmailAccounts.install();
      window.location.href = authUrl;
    } catch (e) {
      setGmailInstallLoading(false);
      toast.error(
        e instanceof Error ? e.message : "Gmail 連携の開始に失敗しました",
      );
    }
  };

  const handleGmailDelete = async (acc: GmailAccount) => {
    const ok = await confirm({
      title: "Gmail 連携を解除",
      message: `${acc.email} の連携を解除しますか？\nこのアカウントを使う自動送信設定は無効になります。`,
      variant: "danger",
      confirmLabel: "解除",
    });
    if (!ok) return;
    try {
      await api.gmailAccounts.delete(acc.id);
      toast.success("解除しました");
      setRefreshKey((k) => k + 1);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "解除に失敗しました");
    }
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.workspaces
      .list()
      .then((list) => {
        if (!cancelled) {
          setWorkspaces(list);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "読み込みに失敗");
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  // bot を全 channel に一括招待する。private channel への bot 投入が主用途。
  // user OAuth 未認証 workspace は backend が { error: "user_oauth_required" }
  // を 400 で返すため、APIError.body の文字列で識別して再認証ガイドを出す。
  const handleBulkInvite = async (ws: Workspace) => {
    const ok = await confirm({
      title: "bot を一括招待",
      message: `「${ws.name}」の全チャンネルに bot を一括招待します。\nadmin (= OAuth 認証した人) が member の channel のみが対象です。`,
      variant: "danger",
      confirmLabel: "実行",
    });
    if (!ok) return;
    setBulkInviteLoading(ws.id);
    try {
      // Cloudflare Workers の subrequest 上限のため、backend は 1 invocation
      // あたり最大 batchSize 件しか invite を実行しない。nextOffset を辿って
      // 全 channel を処理するまで loop する。
      // 進捗を toast で逐次更新できると親切だが、まずは単純集計で出す。
      let offset = 0;
      let totalChannels = 0;
      let invited = 0;
      let alreadyMember = 0;
      let failed = 0;
      const errors: BotBulkInviteResult["errors"] = [];
      // safety guard: 想定外の無限ループ防止。
      // 4000 channel / 35 batch ≒ 115 iterations が現実的上限。
      const MAX_ITERATIONS = 200;
      let iter = 0;
      while (iter < MAX_ITERATIONS) {
        const res = await api.workspaces.bulkInviteBot(ws.id, { offset });
        totalChannels = res.totalChannels;
        invited += res.invited;
        alreadyMember += res.alreadyMember;
        failed += res.failed;
        errors.push(...res.errors);
        if (res.nextOffset === null) break;
        offset = res.nextOffset;
        iter++;
      }
      if (failed === 0) {
        toast.success(
          `招待完了: 新規 ${invited} / 既存 ${alreadyMember} / 合計 ${totalChannels}`,
        );
      } else {
        toast.warning(
          `一部失敗: 新規 ${invited} / 既存 ${alreadyMember} / 失敗 ${failed}`,
        );
      }
    } catch (e) {
      if (e instanceof APIError && e.body.includes("user_oauth_required")) {
        toast.error(
          "user OAuth 認証が必要です。「+ Slack でインストール」から再認証してください",
        );
      } else {
        toast.error(
          e instanceof Error ? e.message : "bot 一括招待に失敗しました",
        );
      }
    } finally {
      setBulkInviteLoading(null);
    }
  };

  const handleDelete = async (ws: Workspace) => {
    const ok = await confirm({
      message: `ワークスペース「${ws.name}」を削除しますか？\n紐付いたミーティングがある場合は削除できません。`,
      variant: "danger",
      confirmLabel: "削除",
    });
    if (!ok) return;
    try {
      await api.workspaces.delete(ws.id);
      setRefreshKey((k) => k + 1);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "削除に失敗しました");
    }
  };

  if (loading) return <div style={{ padding: "1rem" }}>読み込み中...</div>;
  if (error)
    return (
      <div style={{ padding: "1rem", color: colors.danger }}>エラー: {error}</div>
    );

  // 直前画面（アクション一覧など元いた画面）へ戻る。
  // 直接アクセス等で履歴が無い場合はホームへフォールバック。
  const handleBack = () => {
    if (window.history.length <= 1) navigate("/");
    else navigate(-1);
  };

  return (
    <div style={{ padding: isMobile ? "0.75rem" : "1rem" }}>
      <button
        type="button"
        onClick={handleBack}
        style={{
          color: colors.primary,
          cursor: "pointer",
          padding: "4px 0",
          fontSize: 14,
          marginBottom: 8,
          display: "inline-block",
          background: "none",
          border: "none",
        }}
      >
        &#8592; 元の画面に戻る
      </button>
      <div
        style={{
          display: "flex",
          // mobile はタイトル + Slack ボタンを縦並びにして折り返しを防ぐ
          flexDirection: isMobile ? "column" : "row",
          alignItems: isMobile ? "stretch" : "center",
          marginBottom: "1rem",
          gap: "0.5rem",
        }}
      >
        <h2 style={{ margin: 0, fontSize: isMobile ? "1.15rem" : "1.5rem" }}>
          ワークスペース管理 ({workspaces.length}件)
        </h2>
        <a
          href="/slack/oauth/install"
          style={{
            marginLeft: isMobile ? undefined : "auto",
            background: "#4A154B", // Slack brand purple — keep as-is
            color: colors.textInverse,
            padding: "0.5rem 1rem",
            borderRadius: "0.375rem",
            textDecoration: "none",
            fontWeight: "bold",
            fontSize: "0.95rem",
            textAlign: "center",
            minHeight: 44,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          + Slack でインストール
        </a>
      </div>

      {successMsg && (
        <div
          role="status"
          style={{
            background: colors.success,
            color: colors.textInverse,
            padding: "0.75rem",
            borderRadius: "0.375rem",
            marginBottom: "1rem",
          }}
        >
          {successMsg}
        </div>
      )}

      {workspaces.length === 0 && (
        <div style={{ color: colors.textSecondary }}>
          ワークスペースが登録されていません。「+ Slack でインストール」から追加してください。
        </div>
      )}

      {workspaces.map((ws) => (
        <WorkspaceCard
          key={ws.id}
          ws={ws}
          isReadOnly={isReadOnly}
          bulkInviteLoading={bulkInviteLoading}
          onBulkInvite={handleBulkInvite}
          onDelete={handleDelete}
        />
      ))}

      {/* Sprint 26: Gmail 連携 — 応募者への自動メール送信に使う Gmail アカウント */}
      <GmailAccountsSection
        gmailAccounts={gmailAccounts}
        gmailInstallLoading={gmailInstallLoading}
        isReadOnly={isReadOnly}
        onInstall={handleGmailInstall}
        onDelete={handleGmailDelete}
      />

      {/* 005-feedback: フィードバックウィジェットの通知先と AI 有効化を設定 */}
      <FeedbackSettingsSection
        workspaces={workspaces}
        disabled={isReadOnly}
      />

      {/* 手動登録は fallback として温存 (ADR-0007) — ページ下部に小さく配置 */}
      <div
        style={{
          marginTop: "2rem",
          paddingTop: "1rem",
          borderTop: `1px solid ${colors.border}`,
        }}
      >
        {/* HitoLink DS: 副次アクション = ghost。 */}
        <button
          onClick={() => setShowManualForm(true)}
          className="btn btn-ghost btn-sm"
          style={{
            background: "transparent",
            color: colors.textSecondary,
            border: `1px solid ${colors.borderStrong}`,
            padding: "0.375rem 0.75rem",
            borderRadius: "0.25rem",
            fontSize: "0.875rem",
          }}
        >
          手動登録（上級者向け）
        </button>
        <p
          style={{
            fontSize: "0.75rem",
            color: colors.textMuted,
            marginTop: "0.5rem",
          }}
        >
          通常は「Slack でインストール」を使用してください。OAuth が使えない場合のみ手動登録を利用します。
        </p>
      </div>

      {showManualForm && (
        <WorkspaceCreateForm
          onClose={() => setShowManualForm(false)}
          onCreated={() => {
            setShowManualForm(false);
            setRefreshKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}
