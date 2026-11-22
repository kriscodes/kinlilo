import { z } from "zod";

export const circleId = z.uuid();
export const createCircle = z.object({ name: z.string().trim().min(1).max(60) }).strict();
export const acceptInvite = z.object({
  code: z.string().trim().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();

export type CircleRole = "owner" | "member";
export type Circle = {
  id: string;
  name: string;
  role: CircleRole;
  memberCount: number;
};
export type CircleMember = { id: string; name: string; role: CircleRole };
export type CircleDetails = Circle & { members: CircleMember[] };
export type CircleInvite = { code: string; expiresAt: string };

type RequestOptions = {
  baseUrl: string;
  credentials?: RequestCredentials;
  headers?: () => HeadersInit | Promise<HeadersInit>;
};

export function createCircleClient({ baseUrl, credentials, headers }: RequestOptions) {
  async function request<T>(path: string, method = "GET", body?: object): Promise<T> {
    const requestHeaders = new Headers(await headers?.());
    if (body) requestHeaders.set("Content-Type", "application/json");
    const response = await fetch(baseUrl + "/v1" + path, {
      method,
      credentials,
      headers: requestHeaders,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(result?.error?.message ?? "Unable to connect to Kinlilo. Try again.");
    }
    return result as T;
  }

  return {
    list: () => request<{ circles: Circle[] }>("/circles"),
    get: (id: string) => request<CircleDetails>("/circles/" + encodeURIComponent(id)),
    create: (name: string) => request<Circle>("/circles", "POST", { name }),
    invite: (id: string) => request<CircleInvite>(
      "/circles/" + encodeURIComponent(id) + "/invites", "POST", {},
    ),
    join: (code: string) => request<Circle>("/circles/join", "POST", { code }),
    leave: (id: string) => request<{ ok: true }>(
      "/circles/" + encodeURIComponent(id) + "/leave", "POST", {},
    ),
  };
}
