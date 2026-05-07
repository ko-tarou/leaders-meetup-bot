import { useNavigate, useParams } from "react-router-dom";
import { MeetingDetail } from "../components/MeetingDetail";
import { colors } from "../styles/tokens";

// /meetings/:meetingId — 既存 MeetingDetail を URL 直アクセス可能にするラッパー
export function MeetingDetailPage() {
  const { meetingId } = useParams<{ meetingId: string }>();
  const navigate = useNavigate();

  if (!meetingId) {
    return <p style={{ color: colors.textMuted }}>ミーティングが見つかりません</p>;
  }

  return (
    <MeetingDetail meetingId={meetingId} onBack={() => navigate(-1)} />
  );
}
