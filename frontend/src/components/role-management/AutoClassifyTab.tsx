import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type {
  ClassifyPreviewResponse,
  EventAction,
  RoleCategory,
  SlackRole,
} from "../../types";
import { api } from "../../api";
import { useToast } from "../ui/Toast";
import { useConfirm } from "../ui/ConfirmDialog";
import { colors } from "../../styles/tokens";

// 自動分類タブ (naming-rule auto classification)。
// フロー: classify-preview で全員抽出 → 4 分類 + 名簿ゲートを一覧表示 →
// 各人のカテゴリロールを付け外し (複数可) → 運営/スポンサーは名簿ゲート →
// 「同期」で招待。運営配下の詳細ロール (チーム/学年) は「ロール」タブで調整する。

const CATEGORY_ORDER: RoleCategory[] = [
  "participant",
  "staff",
  "sponsor",
  "judge",
];
const CATEGORY_LABELS: Record<RoleCategory, string> = {
  participant: "参加者",
  staff: "運営",
  sponsor: "スポンサー",
  judge: "審査員",
};
// 誤爆招待を防ぐため名簿照合ゲートが必要なカテゴリ。
const GATED: ReadonlySet<RoleCategory> = new Set<RoleCategory>([
  "staff",
  "sponsor",
]);

// 自動割り当ての計画 (pure)。誰をどのカテゴリに追加するか + スキップ理由の件数。
// フィードバック UI とロジックを分離してテストしやすくする。
export type AutoAssignPlan = {
  perCategory: Record<RoleCategory, string[]>;
  added: number;
  // gated (運営/スポンサー) で名簿不一致のため除外した数。
  skippedReview: number;
  // 既に割当済みでスキップした数。
  skippedExisting: number;
  // 分類できた (カテゴリが付いた) メンバー総数。
  classifiedTotal: number;
};

export function computeAutoAssignPlan(
  members: ReadonlyArray<{
    id: string;
    category: RoleCategory | null;
    needsReview: boolean;
  }>,
  membership: Record<RoleCategory, ReadonlySet<string>>,
): AutoAssignPlan {
  const perCategory: Record<RoleCategory, string[]> = {
    participant: [],
    staff: [],
    sponsor: [],
    judge: [],
  };
  let skippedReview = 0;
  let skippedExisting = 0;
  let classifiedTotal = 0;
  for (const m of members) {
    if (m.category === null) continue;
    classifiedTotal += 1;
    const cat = m.category;
    if (GATED.has(cat) && m.needsReview) {
      skippedReview += 1;
      continue;
    }
    if (membership[cat].has(m.id)) {
      skippedExisting += 1;
      continue;
    }
    perCategory[cat].push(m.id);
  }
  const added = CATEGORY_ORDER.reduce(
    (n, c) => n + perCategory[c].length,
    0,
  );
  return { perCategory, added, skippedReview, skippedExisting, classifiedTotal };
}

type ApplyResult = AutoAssignPlan & { error: string | null };

type Props = { eventId: string; action: EventAction };

export function AutoClassifyTab({ eventId, action }: Props) {
  const toast = useToast();
  const { confirm } = useConfirm();
  const [preview, setPreview] = useState<ClassifyPreviewResponse | null>(null);
  const [roles, setRoles] = useState<SlackRole[] | null>(null);
  // カテゴリ root ロール id (name 一致で解決)。未 seed なら欠ける。
  const [membership, setMembership] = useState<Record<
    RoleCategory,
    Set<string>
  > | null>(null);
  const [error, setError] = useState<string | null>(null);
  // classify-preview (Slack 抽出) だけの失敗。roles/seed とは独立に扱い、
  // 抽出できなくてもロール初期化などは操作できるようにする (親切設計)。
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  // 「自動割り当てを適用」の結果 (成功/空/エラーを明示する永続バナー)。
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);

  // name -> カテゴリ root role の対応。
  const categoryRole = useMemo(() => {
    const m = new Map<RoleCategory, SlackRole>();
    for (const cat of CATEGORY_ORDER) {
      const found = (roles ?? []).find(
        (r) => r.name === CATEGORY_LABELS[cat] && r.parentRoleId === null,
      );
      if (found) m.set(cat, found);
    }
    return m;
  }, [roles]);

  const allCategoryRolesExist = categoryRole.size === CATEGORY_ORDER.length;

  // ロール一覧 + カテゴリ membership (Slack 不要・常に読める)。
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setRoles(null);
    setMembership(null);
    (async () => {
      try {
        const rolesList = await api.roles.list(eventId, action.id);
        if (cancelled) return;
        setRoles(Array.isArray(rolesList) ? rolesList : []);
        const map: Record<RoleCategory, Set<string>> = {
          participant: new Set(),
          staff: new Set(),
          sponsor: new Set(),
          judge: new Set(),
        };
        await Promise.all(
          CATEGORY_ORDER.map(async (cat) => {
            const role = (rolesList as SlackRole[]).find(
              (r) => r.name === CATEGORY_LABELS[cat] && r.parentRoleId === null,
            );
            if (!role) return;
            const rows = await api.roles.getMembers(eventId, action.id, role.id);
            for (const row of rows) map[cat].add(row.slackUserId);
          }),
        );
        if (cancelled) return;
        setMembership(map);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "読み込みに失敗しました");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [eventId, action.id, refreshKey]);

  // classify-preview (Slack users.list 抽出)。失敗しても page 全体は止めない。
  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setPreviewError(null);
    api.roles
      .classifyPreview(eventId, action.id)
      .then((prev) => {
        if (!cancelled) setPreview(prev);
      })
      .catch((e) => {
        if (!cancelled)
          setPreviewError(e instanceof Error ? e.message : "抽出に失敗しました");
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, action.id, refreshKey]);

  const reload = () => setRefreshKey((k) => k + 1);

  const handleSeed = async () => {
    setBusy(true);
    try {
      const res = await api.roles.seedDefaultRoles(eventId, action.id);
      toast.success(
        `ロールを初期化しました (作成 ${res.created.length} / 既存 ${res.skipped.length})`,
      );
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "初期化に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  // カテゴリのチェックを付け外し。運営/スポンサーで名簿不一致 (needsReview) の
  // 人を追加するときは確認を挟む (誤爆防止のゲート)。
  const toggleCategory = async (
    memberId: string,
    cat: RoleCategory,
    checked: boolean,
    needsReview: boolean,
  ) => {
    const role = categoryRole.get(cat);
    if (!role) {
      toast.error(`「${CATEGORY_LABELS[cat]}」ロールが未作成です。先に初期化してください`);
      return;
    }
    if (checked && GATED.has(cat) && needsReview) {
      const ok = await confirm({
        message: `この人は名簿に見つかりません。「${CATEGORY_LABELS[cat]}」に本当に追加しますか？(誤爆の可能性)`,
        variant: "danger",
        confirmLabel: "追加する",
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      if (checked) {
        await api.roles.addMembers(eventId, action.id, role.id, [memberId]);
      } else {
        await api.roles.removeMember(eventId, action.id, role.id, memberId);
      }
      setMembership((cur) => {
        if (!cur) return cur;
        const next = { ...cur, [cat]: new Set(cur[cat]) };
        if (checked) next[cat].add(memberId);
        else next[cat].delete(memberId);
        return next;
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "更新に失敗しました";
      toast.error(
        /not in parent/i.test(msg)
          ? "親ロールに含まれないため追加できません"
          : msg,
      );
    } finally {
      setBusy(false);
    }
  };

  // 自動割り当て: 分類済みメンバーを対応カテゴリへ一括追加。
  // gated (運営/スポンサー) は needsReview を除外し安全側に倒す。
  const handleApplyAuto = async () => {
    if (!preview || !membership) return;
    if (!allCategoryRolesExist) {
      toast.error("先に「ロールを初期化」してください");
      return;
    }
    setBusy(true);
    setApplyResult(null);
    // 計画を先に立てる (pure)。誰を追加するか + スキップ理由を確定させる。
    const plan = computeAutoAssignPlan(preview.members, membership);
    // 反映は local state を直接更新する (reload せず = 画面が「分類中」に戻って
    // トーストが消える / 何も起きてないように見える現象を防ぐ)。
    const next: Record<RoleCategory, Set<string>> = {
      participant: new Set(membership.participant),
      staff: new Set(membership.staff),
      sponsor: new Set(membership.sponsor),
      judge: new Set(membership.judge),
    };
    try {
      for (const cat of CATEGORY_ORDER) {
        const role = categoryRole.get(cat);
        if (!role) continue;
        const targets = plan.perCategory[cat];
        if (targets.length === 0) continue;
        await api.roles.addMembers(eventId, action.id, role.id, targets);
        for (const id of targets) next[cat].add(id);
      }
      setMembership(next);
      setApplyResult({ ...plan, error: null });
      if (plan.added > 0) {
        toast.success(`${plan.added} 人に割り当てました`);
      } else {
        toast.success("追加対象はありませんでした");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "自動割り当てに失敗しました";
      // 途中まで成功した分は local state に反映しておく。
      setMembership(next);
      setApplyResult({ ...plan, error: msg });
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };

  const handleSync = async () => {
    const ok = await confirm({
      message:
        "現在のロール割り当てを Slack チャンネルに反映 (招待/退出) します。よろしいですか？",
      confirmLabel: "同期する",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await api.roles.sync(eventId, action.id);
      toast.success(
        `同期完了: 招待 ${res.invited} / 退出 ${res.kicked} / エラー ${res.errors.length}`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "同期に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <div style={s.errorBox} data-testid="auto-classify-error">
        エラー: {error}
      </div>
    );
  }
  if (roles === null || membership === null) {
    return <div style={s.hint}>読み込み中...</div>;
  }

  return (
    <div data-testid="auto-classify-tab">
      <div style={s.headerRow}>
        <h3 style={{ margin: 0, fontSize: "1.05rem" }}>自動分類</h3>
        <button onClick={reload} disabled={busy} style={s.secondaryBtn}>
          再読み込み
        </button>
      </div>

      {!allCategoryRolesExist && (
        <div style={s.warn}>
          4 カテゴリのロール (参加者/運営/スポンサー/審査員) が未作成です。
          <button
            onClick={handleSeed}
            disabled={busy}
            style={{ ...s.primaryBtn, marginLeft: "0.5rem" }}
            data-testid="seed-roles-btn"
          >
            ロールを初期化
          </button>
        </div>
      )}

      {previewError && (
        <div style={s.errorBox} data-testid="preview-error">
          <div style={{ fontWeight: 600 }}>
            ワークスペースメンバーを抽出できませんでした: {previewError}
          </div>
          <div style={{ ...s.meta, marginTop: "0.25rem" }}>
            考えられる原因: Slack の <code>users:read</code> 権限 (スコープ) が
            未付与、またはワークスペース未設定です。Slack App でスコープを付与し
            再インストールしてください。ロールの初期化や手動割り当ては下でそのまま
            行えます。
          </div>
        </div>
      )}

      {preview && !preview.rosterActionFound && (
        <div style={s.warn}>
          名簿 (member_roster) が空/未作成です。運営・スポンサーは全員が「要確認」
          になります。「名簿」タブから名簿を投入すると誤爆判定が精度化します。
        </div>
      )}

      {preview === null && !previewError && (
        <div style={s.hint}>ワークスペースメンバーを分類中...</div>
      )}

      {preview && (
        <>
          <div style={s.summaryRow} data-testid="classify-summary">
            <span style={s.badge} data-testid="summary-total">
              抽出 {preview.summary.total}
            </span>
            {CATEGORY_ORDER.map((cat) => (
              <span key={cat} style={s.badge}>
                {CATEGORY_LABELS[cat]} {preview.summary.byCategory[cat]}
              </span>
            ))}
            <span style={s.badge}>未分類 {preview.summary.unclassified}</span>
            <span
              style={{ ...s.badge, ...s.badgeWarn }}
              data-testid="summary-review"
            >
              要確認 {preview.summary.needsReview}
            </span>
          </div>

          {preview.summary.total === 0 && (
            <div style={s.warn} data-testid="empty-extract">
              ワークスペースから抽出できたメンバーが 0 人です。Slack の{" "}
              <code>users:read</code>{" "}
              権限が未付与か、対象ワークスペースにメンバーがいない可能性があります。
            </div>
          )}

          <div style={{ display: "flex", gap: "0.5rem", margin: "0.75rem 0" }}>
            <button
              onClick={handleApplyAuto}
              disabled={busy || !allCategoryRolesExist}
              style={s.primaryBtn}
              data-testid="apply-auto-btn"
            >
              {busy ? "適用中..." : "自動割り当てを適用 (名簿ゲート)"}
            </button>
            <button
              onClick={handleSync}
              disabled={busy}
              style={s.secondaryBtn}
              data-testid="sync-btn"
            >
              確定して招待 (同期)
            </button>
          </div>

          {applyResult && (
            <div
              style={
                applyResult.error
                  ? s.errorBox
                  : applyResult.added > 0
                    ? s.successBox
                    : s.warn
              }
              data-testid="apply-result"
            >
              {applyResult.error ? (
                <span>自動割り当てエラー: {applyResult.error}</span>
              ) : applyResult.added > 0 ? (
                <span>
                  {applyResult.added} 人に割り当てました (
                  {CATEGORY_ORDER.filter(
                    (c) => applyResult.perCategory[c].length > 0,
                  )
                    .map(
                      (c) =>
                        `${CATEGORY_LABELS[c]} ${applyResult.perCategory[c].length}`,
                    )
                    .join(" / ")}
                  )。既存 {applyResult.skippedExisting} 人は重複スキップ、要確認{" "}
                  {applyResult.skippedReview} 人は名簿ゲートで除外しました。
                </span>
              ) : (
                <span>
                  追加した人はいませんでした。分類済 {applyResult.classifiedTotal}{" "}
                  人 (既存 {applyResult.skippedExisting} / 要確認除外{" "}
                  {applyResult.skippedReview})。抽出が 0 人の場合は Slack{" "}
                  <code>users:read</code> 権限をご確認ください。
                </span>
              )}
            </div>
          )}

          <div style={s.tableWrap}>
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={s.th}>メンバー</th>
                  <th style={s.th}>自動判定</th>
                  {CATEGORY_ORDER.map((cat) => (
                    <th key={cat} style={s.thCenter}>
                      {CATEGORY_LABELS[cat]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.members.map((m) => (
              <tr
                key={m.id}
                style={m.needsReview ? s.rowReview : undefined}
                data-testid={`member-row-${m.id}`}
              >
                <td style={s.td}>
                  <div style={{ fontWeight: 500 }}>{m.displayName}</div>
                  {m.inRoster ? (
                    <span style={s.metaOk}>名簿一致</span>
                  ) : (
                    <span style={s.meta}>名簿なし</span>
                  )}
                </td>
                <td style={s.td}>
                  {m.categoryLabel ? (
                    <span style={s.tag}>{m.categoryLabel}</span>
                  ) : (
                    <span style={s.meta}>未分類</span>
                  )}
                  {m.needsReview && (
                    <span
                      style={s.reviewBadge}
                      data-testid={`needs-review-${m.id}`}
                    >
                      要確認
                    </span>
                  )}
                </td>
                {CATEGORY_ORDER.map((cat) => (
                  <td key={cat} style={s.tdCenter}>
                    <input
                      type="checkbox"
                      checked={membership[cat].has(m.id)}
                      disabled={busy || !categoryRole.get(cat)}
                      onChange={(e) =>
                        toggleCategory(m.id, cat, e.target.checked, m.needsReview)
                      }
                      data-testid={`cat-${cat}-${m.id}`}
                      aria-label={`${m.displayName} を ${CATEGORY_LABELS[cat]} に割り当て`}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

          <p style={{ ...s.meta, marginTop: "1rem" }}>
            運営配下の詳細ロール (運営統括 / チーム / 学年) の割り当ては「ロール」
            タブで調整してください。行の網掛けは「(運営)/(スポンサー) を名乗るが
            名簿にいない」誤爆候補です。
          </p>
        </>
      )}
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  headerRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: "0.75rem",
  },
  warn: {
    padding: "0.75rem",
    marginBottom: "0.75rem",
    color: colors.warning,
    background: colors.warningSubtle,
    borderRadius: "0.25rem",
    fontSize: "0.875rem",
  },
  errorBox: {
    padding: "0.75rem",
    color: colors.danger,
    background: colors.dangerSubtle,
    borderRadius: "0.375rem",
    fontSize: "0.875rem",
  },
  successBox: {
    padding: "0.75rem",
    color: colors.success,
    background: colors.successSubtle,
    borderRadius: "0.375rem",
    fontSize: "0.875rem",
  },
  hint: {
    padding: "1rem",
    color: colors.textSecondary,
    textAlign: "center",
    fontSize: "0.875rem",
  },
  summaryRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: "0.375rem",
    marginBottom: "0.25rem",
  },
  badge: {
    padding: "0.125rem 0.5rem",
    background: colors.primarySubtle,
    color: colors.primaryHover,
    borderRadius: "0.25rem",
    fontSize: "0.75rem",
    fontWeight: 500,
  },
  badgeWarn: {
    background: colors.warningSubtle,
    color: colors.warning,
  },
  primaryBtn: {
    background: colors.primary,
    color: colors.textInverse,
    border: "none",
    padding: "0.5rem 1rem",
    borderRadius: "0.25rem",
    cursor: "pointer",
    fontSize: "0.875rem",
  },
  secondaryBtn: {
    padding: "0.5rem 1rem",
    border: `1px solid ${colors.borderStrong}`,
    background: colors.background,
    color: colors.text,
    borderRadius: "0.25rem",
    cursor: "pointer",
    fontSize: "0.875rem",
  },
  tableWrap: {
    overflowX: "auto",
    border: `1px solid ${colors.border}`,
    borderRadius: "0.375rem",
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: "0.8125rem",
  },
  th: {
    textAlign: "left",
    padding: "0.5rem 0.75rem",
    borderBottom: `1px solid ${colors.border}`,
    background: colors.surface,
    whiteSpace: "nowrap",
  },
  thCenter: {
    textAlign: "center",
    padding: "0.5rem 0.5rem",
    borderBottom: `1px solid ${colors.border}`,
    background: colors.surface,
    whiteSpace: "nowrap",
  },
  td: {
    padding: "0.5rem 0.75rem",
    borderBottom: `1px solid ${colors.border}`,
    verticalAlign: "top",
  },
  tdCenter: {
    padding: "0.5rem",
    borderBottom: `1px solid ${colors.border}`,
    textAlign: "center",
  },
  rowReview: {
    background: colors.warningSubtle,
  },
  meta: {
    fontSize: "0.75rem",
    color: colors.textSecondary,
  },
  metaOk: {
    fontSize: "0.75rem",
    color: colors.primaryHover,
  },
  tag: {
    padding: "0.0625rem 0.375rem",
    background: colors.primarySubtle,
    color: colors.primaryHover,
    borderRadius: "0.25rem",
    fontSize: "0.75rem",
  },
  reviewBadge: {
    marginLeft: "0.375rem",
    padding: "0.0625rem 0.375rem",
    background: colors.danger,
    color: colors.textInverse,
    borderRadius: "0.25rem",
    fontSize: "0.6875rem",
    fontWeight: 600,
  },
};
