import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { NameSplitInput } from "../components/NameSplitInput";
import { useIsMobile } from "../hooks/useIsMobile";
import type {
  ParticipationActivity,
  ParticipationDevRole,
  ParticipationGender,
  ParticipationGrade,
} from "../types";
import { colors } from "../styles/tokens";

// participation-form Phase1 PR3: 参加届 公開フォームページ。
// /participation/:eventId?t=<token>。admin 認証不要 (api.participation の
// 公開3メソッドは publicRequest = admin token 非注入)。
// PublicApplyPage の Layout / Field / inputStyle / 送信 UX を踏襲する。

type Opt<T extends string> = { value: T; label: string };

// フリガナ許可文字: 全角カタカナ・長音符・全角/半角スペース (姓名区切り用)。
// BE の validateSubmission (src/domain/participation/submission.ts) と揃える。
const NAME_KANA_RE = /^[ァ-ヶー　 ]+$/;

const GRADE_OPTS: Opt<ParticipationGrade>[] = [
  { value: "1", label: "1年" },
  { value: "2", label: "2年" },
  { value: "3", label: "3年" },
  { value: "4", label: "4年" },
  { value: "graduate", label: "院生" },
];
const GENDER_OPTS: Opt<ParticipationGender>[] = [
  { value: "male", label: "男性" },
  { value: "female", label: "女性" },
  { value: "other", label: "その他" },
  { value: "prefer_not", label: "回答しない" },
];
const ACTIVITY_OPTS: Opt<ParticipationActivity>[] = [
  { value: "event", label: "イベント運営" },
  { value: "dev", label: "チーム開発" },
  { value: "both", label: "両方" },
];
const DEV_ROLE_OPTS: Opt<ParticipationDevRole>[] = [
  { value: "pm", label: "PM" },
  { value: "frontend", label: "フロントエンド" },
  { value: "backend", label: "バックエンド" },
  { value: "android", label: "Android" },
  { value: "ios", label: "iOS" },
  { value: "infra", label: "インフラ" },
];

export function ParticipationFormPage() {
  const { eventId } = useParams<{ eventId: string }>();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("t") ?? "";
  const isMobile = useIsMobile();

  const [eventName, setEventName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 苗字/名前を分割入力。送信時に半角スペース結合で既存 `name` カラムに詰める。
  const [familyName, setFamilyName] = useState("");
  const [givenName, setGivenName] = useState("");
  // フリガナ (全角カタカナ)。名簿の name_kana へ転記不要にするため収集する。
  const [nameKana, setNameKana] = useState("");
  const [slackName, setSlackName] = useState("");
  const [studentId, setStudentId] = useState("");
  const [department, setDepartment] = useState("");
  const [grade, setGrade] = useState<ParticipationGrade | "">("");
  const [email, setEmail] = useState("");
  // 名簿 Slack 連携強化 PR2: 任意の Slack メアド。
  // 入力されていれば BE が users.lookupByEmail で Slack user を自動解決し、
  // 表示名変更があっても名簿が更新され続ける (PR1 で BE 側基盤実装済み)。
  const [slackEmail, setSlackEmail] = useState("");
  const [gender, setGender] = useState<ParticipationGender | "">("");
  const [hasAllergy, setHasAllergy] = useState(false);
  const [allergyDetail, setAllergyDetail] = useState("");
  const [otherAffiliations, setOtherAffiliations] = useState("");
  const [activity, setActivity] = useState<ParticipationActivity | "">("");
  const [devRoles, setDevRoles] = useState<ParticipationDevRole[]>([]);

  const wantsDev = activity === "dev" || activity === "both";

  // マウント時に event 取得 + (token あれば) prefill を1回だけ適用する。
  // prefill が空 {} の場合は空文字で上書きせず初期値のまま (既存入力を消さない)。
  useEffect(() => {
    if (!eventId) {
      setLoading(false);
      setNotFound(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const ev = await api.participation.event(eventId);
        if (cancelled) return;
        setEventName(ev.name);
      } catch {
        if (cancelled) return;
        setNotFound(true);
        setLoading(false);
        return;
      }
      if (token) {
        try {
          const pf = await api.participation.prefill(eventId, token);
          if (cancelled) return;
          if (pf.name) {
            // 既存 name (半角/全角スペース区切りの可能性) を分割して
            // 姓/名フィールドに復元する。区切りが無い場合は姓に全文を入れる。
            const parts = pf.name.trim().split(/[\s　]+/);
            if (parts.length >= 2) {
              setFamilyName(parts[0]);
              setGivenName(parts.slice(1).join(" "));
            } else {
              setFamilyName(pf.name.trim());
            }
          }
          if (pf.email) setEmail(pf.email);
          if (pf.studentId) setStudentId(pf.studentId);
        } catch {
          // prefill 失敗は致命的でない (未prefillで通常表示)
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [eventId, token]);

  const toggleRole = (role: ParticipationDevRole) =>
    setDevRoles((prev) =>
      prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role],
    );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedFamilyName = familyName.trim();
    const trimmedGivenName = givenName.trim();
    const trimmedNameKana = nameKana.trim();
    if (
      !trimmedFamilyName ||
      !trimmedGivenName ||
      !trimmedNameKana ||
      !slackName.trim() ||
      !studentId.trim() ||
      !department.trim()
    ) {
      setError("姓・名・フリガナ・Slack 表示名・学籍番号・学科は必須です");
      return;
    }
    if (!NAME_KANA_RE.test(trimmedNameKana)) {
      setError("フリガナは全角カタカナで入力してください");
      return;
    }
    if (!grade) return setError("学年を選択してください");
    if (!email.trim()) return setError("メールアドレスを入力してください");
    // 連絡先メールは Gmail 指定。形式チェックとドメイン完全一致を 1 本の正規表現で行う
    // (大文字小文字問わず・"gmail.com" 単体や偽装ドメインも弾く)。サーバ側
    // (validateSubmission / isGmailAddress) でも同じ検証を行う (最終防御はサーバ)。
    if (!/^[^\s@]+@gmail\.com$/i.test(email.trim())) {
      return setError("Gmail アドレスを入力してください（@gmail.com のみ利用できます）");
    }
    // 名簿 Slack 連携強化 PR2: slackEmail は任意。入力された場合のみ形式チェック。
    // 空文字は未指定扱いで送信 body から省く (下記 submit 呼び出しを参照)。
    const trimmedSlackEmail = slackEmail.trim();
    if (
      trimmedSlackEmail !== "" &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedSlackEmail)
    ) {
      return setError("Slack メールアドレスの形式が正しくありません");
    }
    if (!activity) return setError("希望する活動を選択してください");
    if (wantsDev && devRoles.length === 0) {
      return setError("希望役職を1つ以上選択してください");
    }
    // 既存の `name` カラムに合わせて半角スペース結合で BE に送る。
    // 送信 body の形式は維持 (BE / DB スキーマは無変更)。
    const name = `${trimmedFamilyName} ${trimmedGivenName}`;
    setError(null);
    setSubmitting(true);
    try {
      const res = await api.participation.submit(eventId!, {
        token: token || undefined,
        name,
        nameKana: trimmedNameKana,
        slackName: slackName.trim(),
        studentId: studentId.trim(),
        department: department.trim(),
        grade,
        email: email.trim(),
        // 空文字なら省く (= undefined) ことで BE 側で null として扱われ、
        // PR1 の lookupByEmail 経路がスキップされる。
        slackEmail: trimmedSlackEmail || undefined,
        gender: gender || undefined,
        hasAllergy,
        allergyDetail:
          hasAllergy && allergyDetail.trim() ? allergyDetail.trim() : undefined,
        otherAffiliations: otherAffiliations.trim() || undefined,
        desiredActivity: activity,
        devRoles: wantsDev ? devRoles : [],
      });
      if (!res.ok) throw new Error(res.error ?? "送信に失敗しました");
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "送信に失敗しました");
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <Layout>
        <div style={{ color: colors.textSecondary }}>読み込み中...</div>
      </Layout>
    );
  }
  if (notFound) {
    return (
      <Layout>
        <div style={centerNoticeStyle}>フォームが見つかりません</div>
      </Layout>
    );
  }
  if (done) {
    return (
      <Layout>
        <div style={{ textAlign: "center", padding: "3rem 1rem" }}>
          <h1 style={{ marginTop: 0, fontSize: "1.5rem" }}>
            参加届を受け付けました
          </h1>
          <p style={{ color: colors.textSecondary }}>
            ご記入ありがとうございました。
          </p>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <h1 style={{ margin: "0 0 0.5rem", fontSize: isMobile ? "1.25rem" : "1.5rem" }}>
        {eventName} 参加届
      </h1>
      <p style={{ color: colors.textSecondary, marginBottom: "1.5rem" }}>
        以下のフォームにご記入のうえ送信してください。
      </p>

      {error && (
        <div role="alert" style={errorBoxStyle}>
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <SectionTitle>基本情報</SectionTitle>
        <NameSplitInput
          label="名前 *"
          familyName={familyName}
          givenName={givenName}
          onFamilyNameChange={setFamilyName}
          onGivenNameChange={setGivenName}
        />
        <Field
          label="フリガナ *"
          hint="全角カタカナで入力してください（例: ヤマダ タロウ）"
        >
          <input
            type="text"
            value={nameKana}
            onChange={(e) => setNameKana(e.target.value)}
            required
            maxLength={100}
            placeholder="例: ヤマダ タロウ"
            style={inputStyle}
          />
        </Field>
        <Field
          label="Slack 表示名 *"
          hint="Slack に表示されている名前（例: 山田太郎）。ロール自動割当に使用します"
        >
          <input
            type="text"
            value={slackName}
            onChange={(e) => setSlackName(e.target.value)}
            required
            maxLength={100}
            style={inputStyle}
          />
        </Field>
        <Field label="学籍番号 *">
          <input
            type="text"
            value={studentId}
            onChange={(e) => setStudentId(e.target.value)}
            required
            maxLength={50}
            style={inputStyle}
          />
        </Field>
        <Field label="学科 *">
          <input
            type="text"
            value={department}
            onChange={(e) => setDepartment(e.target.value)}
            required
            maxLength={100}
            style={inputStyle}
          />
        </Field>
        <SelectField
          label="学年 *"
          value={grade}
          opts={GRADE_OPTS}
          required
          onChange={setGrade}
        />
        <Field
          label="Gmail アドレス *"
          hint="連絡先は Gmail 指定です（末尾が @gmail.com のメールアドレス）"
        >
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            placeholder="例: yamada@gmail.com"
            maxLength={200}
            style={inputStyle}
          />
        </Field>
        <Field
          label="Slack に登録しているメールアドレス"
          hint="Slack の表示名が変わっても自動で名簿が更新されます"
        >
          <input
            type="email"
            value={slackEmail}
            onChange={(e) => setSlackEmail(e.target.value)}
            placeholder="例: hanako@example.com"
            maxLength={200}
            style={inputStyle}
          />
        </Field>
        <SelectField
          label="性別"
          value={gender}
          opts={GENDER_OPTS}
          onChange={setGender}
        />
        <Field label="アレルギーの有無">
          <div style={radioRow}>
            <label style={choiceLabel}>
              <input
                type="radio"
                name="hasAllergy"
                checked={!hasAllergy}
                onChange={() => setHasAllergy(false)}
              />
              <span>無</span>
            </label>
            <label style={choiceLabel}>
              <input
                type="radio"
                name="hasAllergy"
                checked={hasAllergy}
                onChange={() => setHasAllergy(true)}
              />
              <span>有</span>
            </label>
          </div>
        </Field>
        {hasAllergy && (
          <Field label="アレルギーの詳細">
            <textarea
              value={allergyDetail}
              onChange={(e) => setAllergyDetail(e.target.value)}
              maxLength={500}
              rows={3}
              style={inputStyle}
            />
          </Field>
        )}

        <SectionTitle>所属・活動状況</SectionTitle>
        <Field
          label="他の所属（任意）"
          hint="プロジェクト/サークル/委員会/部活など"
        >
          <textarea
            value={otherAffiliations}
            onChange={(e) => setOtherAffiliations(e.target.value)}
            maxLength={500}
            rows={3}
            style={inputStyle}
          />
        </Field>
        <Field label="希望する活動 *">
          <div style={{ display: "grid", gap: "0.5rem" }}>
            {ACTIVITY_OPTS.map((o) => (
              <label key={o.value} style={choiceLabel}>
                <input
                  type="radio"
                  name="activity"
                  value={o.value}
                  checked={activity === o.value}
                  onChange={() => setActivity(o.value)}
                />
                <span>{o.label}</span>
              </label>
            ))}
          </div>
        </Field>

        {wantsDev && (
          <>
            <SectionTitle>開発チーム希望者の追加項目</SectionTitle>
            <Field label="希望役職 *" hint="1つ以上選択してください">
              <div style={{ display: "grid", gap: "0.5rem" }}>
                {DEV_ROLE_OPTS.map((o) => (
                  <label key={o.value} style={choiceLabel}>
                    <input
                      type="checkbox"
                      checked={devRoles.includes(o.value)}
                      onChange={() => toggleRole(o.value)}
                    />
                    <span>{o.label}</span>
                  </label>
                ))}
              </div>
            </Field>
          </>
        )}

        <button
          type="submit"
          disabled={
            submitting || !familyName.trim() || !givenName.trim()
          }
          style={{
            background:
              submitting || !familyName.trim() || !givenName.trim()
                ? colors.primarySubtle
                : colors.primary,
            color: colors.textInverse,
            // mobile では tap しやすく、画面下まで広げる
            padding: isMobile ? "0.875rem 1rem" : "0.75rem 2rem",
            width: isMobile ? "100%" : undefined,
            border: "none",
            borderRadius: "0.375rem",
            fontSize: "1rem",
            cursor:
              submitting || !familyName.trim() || !givenName.trim()
                ? "not-allowed"
                : "pointer",
            fontWeight: "bold",
            minHeight: 44,
          }}
        >
          {submitting ? "送信中..." : "参加届を送信"}
        </button>
      </form>
    </Layout>
  );
}

function SelectField<T extends string>({
  label,
  value,
  opts,
  required,
  onChange,
}: {
  label: string;
  value: T | "";
  opts: Opt<T>[];
  required?: boolean;
  onChange: (v: T | "") => void;
}) {
  return (
    <Field label={label}>
      <select
        value={value}
        required={required}
        onChange={(e) => onChange(e.target.value as T | "")}
        style={inputStyle}
      >
        <option value="">選択してください</option>
        {opts.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

function Layout({ children }: { children: React.ReactNode }) {
  const isMobile = useIsMobile();
  return (
    <div
      style={{
        maxWidth: 720,
        margin: "0 auto",
        // mobile では左右余白を狭めて入力欄を広く確保する
        padding: isMobile ? "1.25rem 0.875rem" : "2rem 1rem",
        fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
        color: colors.text,
      }}
    >
      {children}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2
      style={{
        fontSize: "1.05rem",
        margin: "1.5rem 0 0.75rem",
        paddingBottom: "0.25rem",
        borderBottom: `1px solid ${colors.border}`,
      }}
    >
      {children}
    </h2>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: "1rem" }}>
      <label
        style={{
          display: "block",
          marginBottom: "0.25rem",
          fontWeight: "bold",
          fontSize: "0.875rem",
        }}
      >
        {label}
      </label>
      {hint && (
        <p
          style={{
            fontSize: "0.8rem",
            color: colors.textSecondary,
            margin: "0 0 0.375rem",
          }}
        >
          {hint}
        </p>
      )}
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.5rem",
  border: `1px solid ${colors.borderStrong}`,
  borderRadius: "0.375rem",
  fontSize: "1rem",
  fontFamily: "inherit",
  boxSizing: "border-box",
};

const radioRow: React.CSSProperties = { display: "flex", gap: "1.5rem" };

const choiceLabel: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  cursor: "pointer",
  fontSize: "0.95rem",
};

const errorBoxStyle: React.CSSProperties = {
  padding: "0.75rem",
  background: colors.dangerSubtle,
  color: colors.danger,
  borderRadius: "0.375rem",
  marginBottom: "1rem",
  fontSize: "0.9rem",
};

const centerNoticeStyle: React.CSSProperties = {
  padding: "2rem",
  textAlign: "center",
  color: colors.danger,
};
