import { request } from "./client";

export const slack = {
  getUserName: (userId: string) =>
    request<{ id: string; name: string }>(`/slack/user/${userId}`),
  getChannelName: (channelId: string) =>
    request<{ id: string; name: string }>(`/slack/channel/${channelId}`),
  getUserNamesBatch: (ids: string[]) =>
    request<{ id: string; name: string }[]>(
      `/slack/users/batch?ids=${ids.join(",")}`,
    ),
  getSlackChannels: (workspaceId?: string) => {
    const qs = workspaceId
      ? `?workspaceId=${encodeURIComponent(workspaceId)}`
      : "";
    return request<{ id: string; name: string }[]>(`/slack/channels${qs}`);
  },
};
