import type { GmailWatcherRule } from "../../types";
import {
  DEFAULT_REPLY_BODY,
  DEFAULT_REPLY_SUBJECT,
  REPLY_PLACEHOLDERS,
} from "./parsers";
import { styles } from "./styles";

// Phase4-6: GmailWatcherEditor.tsx から純抽出した子コンポーネント。
// JSX / state / 副作用 / 文言 / props インターフェースは一字一句不変。
// 元の責務コメントは下記の通り (移動のみ)。

// === Sprint 27: AutoReply UI section ===
//
// rule.autoReply の編集 UI。
//   - 「自動返信を有効化」チェック (toggle)
//   - 件名 (input) / 本文 (textarea) + placeholder ヘルプ
// チェック OFF にした瞬間に subject/body を消したくないので、enabled だけ
// false にして subject/body は draft に残す (再 ON で復帰)。

type AutoReplySectionProps = {
  rule: GmailWatcherRule;
  disabled: boolean;
  onChange: (patch: Partial<GmailWatcherRule>) => void;
};

export function AutoReplySection({
  rule,
  disabled,
  onChange,
}: AutoReplySectionProps) {
  const autoReply = rule.autoReply ?? {
    enabled: false,
    subject: "",
    body: "",
  };

  const toggleEnabled = (on: boolean) => {
    if (on) {
      // 初回 ON 時にデフォルト雛形を入れる (subject/body 両方空のときのみ)。
      const subject = autoReply.subject.trim()
        ? autoReply.subject
        : DEFAULT_REPLY_SUBJECT;
      const body = autoReply.body.trim()
        ? autoReply.body
        : DEFAULT_REPLY_BODY;
      onChange({ autoReply: { enabled: true, subject, body } });
    } else {
      onChange({
        autoReply: {
          enabled: false,
          subject: autoReply.subject,
          body: autoReply.body,
        },
      });
    }
  };

  return (
    <div style={styles.autoReplySection}>
      <div style={styles.sectionHeader}>
        <span style={styles.label}>自動返信</span>
        <span style={styles.metaSmall}>
          有効化すると、通知に「自動返信を送る」ボタンが付きます。ボタン押下時に
          Gmail から元メールへ返信します。
        </span>
      </div>
      <label style={styles.toggleRow}>
        <input
          type="checkbox"
          checked={autoReply.enabled}
          disabled={disabled}
          onChange={(e) => toggleEnabled(e.target.checked)}
        />
        <span>自動返信を有効化</span>
      </label>

      {autoReply.enabled && (
        <>
          <div style={{ ...styles.field, marginTop: "0.5rem" }}>
            <label style={styles.label}>件名</label>
            <input
              value={autoReply.subject}
              onChange={(e) =>
                onChange({
                  autoReply: { ...autoReply, subject: e.target.value },
                })
              }
              disabled={disabled}
              placeholder={DEFAULT_REPLY_SUBJECT}
              style={styles.input}
            />
            <div style={styles.metaSmall}>
              「Re: 」は送信時に自動で前置されます。
            </div>
          </div>

          <div style={styles.field}>
            <label style={styles.label}>本文</label>
            <textarea
              value={autoReply.body}
              onChange={(e) =>
                onChange({
                  autoReply: { ...autoReply, body: e.target.value },
                })
              }
              rows={8}
              disabled={disabled}
              placeholder={DEFAULT_REPLY_BODY}
              style={styles.textarea}
            />
            <div style={styles.placeholderList}>
              {REPLY_PLACEHOLDERS.map((p) => (
                <div key={p.key} style={styles.placeholderRow}>
                  <code style={styles.placeholderKey}>{`{${p.key}}`}</code>
                  <span style={styles.placeholderDesc}>{p.desc}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
