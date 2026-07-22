// Phase4-2: 旧 frontend/src/api.ts (1010 行) をドメイン別ファイルに分割した
// re-export バレル。各メソッドの実装・エンドポイント・method・body・headers・
// APIError throw 条件・getAdminToken 注入 は一字一句不変で、`api` 集約オブジェクト
// の構造と公開面 (全 export) をこのバレルで完全維持する。既存の `from "../api"` /
// `from "./api"` 等の import は moduleResolution=bundler の directory index 解決で
// 無改変のまま動く。
import { events } from "./events";
import { feedback, appSettings } from "./feedback";
import { gmailAccounts } from "./gmail";
import { drive } from "./drive";
import { interviewers } from "./interviewers";
import { meetings } from "./meetings";
import { participation } from "./participation";
import { prReviews } from "./pr-reviews";
import { publicTokens, roles } from "./roles";
import { roster } from "./roster";
import { slack } from "./slack";
import { tasks } from "./tasks";
import { gantt } from "./gantt";
import { applications } from "./applications";
import { sponsor } from "./sponsor";
import { workspaces } from "./workspaces";
import { broadcast } from "./broadcast";

export {
  APIError,
  clearAdminToken,
  getAdminToken,
  publicRequest,
  setAdminToken,
} from "./client";

export const api = {
  ...meetings,
  ...slack,
  events,
  tasks,
  gantt,
  prReviews,
  applications,
  sponsor,
  participation,
  interviewers,
  roles,
  roster,
  publicTokens,
  workspaces,
  gmailAccounts,
  drive,
  appSettings,
  feedback,
  broadcast,
};
