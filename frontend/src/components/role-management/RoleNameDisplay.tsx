import { useEffect, useState } from "react";
import { api } from "../../api";
import { colors } from "../../styles/tokens";

// 003 PR8: config.roleId だけからロール名を取得して表示する read-only コンポーネント。
//
// - props.roleId が null/undefined/空文字 → 「未設定」
// - GET /api/roles/:roleId 成功 → "勉強会チーム (ID: xxxxxxxx-...)"
// - 失敗 (404 / network) → "ID: <id> (名前取得失敗)" を warning 色で
//
// FE 内部では role は ID 管理のまま (config を書き換えない / API メソッドは getRoleByGlobalId)
// UI 上だけ「ロール名」を表示するのが本コンポーネントの責務。

type Props = { roleId: string | null | undefined };

type State =
  | { kind: "loading" }
  | { kind: "ok"; name: string }
  | { kind: "missing" }
  | { kind: "fail" };

export function RoleNameDisplay({ roleId }: Props) {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    if (!roleId || !roleId.trim()) {
      setState({ kind: "missing" });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    api.roles
      .getRoleByGlobalId(roleId)
      .then((res) => {
        if (cancelled) return;
        if (!res) setState({ kind: "fail" });
        else setState({ kind: "ok", name: res.name });
      })
      .catch(() => {
        if (cancelled) return;
        setState({ kind: "fail" });
      });
    return () => {
      cancelled = true;
    };
  }, [roleId]);

  if (state.kind === "missing") {
    return <span style={{ color: colors.textMuted }}>未設定</span>;
  }
  if (state.kind === "loading") {
    return <span style={{ color: colors.textMuted }}>取得中...</span>;
  }
  if (state.kind === "fail") {
    return (
      <span style={{ color: colors.warning }} aria-label="ロール名取得失敗">
        ID: {roleId} (名前取得失敗)
      </span>
    );
  }
  return (
    <span>
      <strong style={{ color: colors.text }}>{state.name}</strong>
      <span style={{ color: colors.textMuted, marginLeft: "0.5rem", fontSize: "0.8rem" }}>
        (ID: {roleId})
      </span>
    </span>
  );
}
