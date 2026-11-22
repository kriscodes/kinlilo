import { expoClient } from "@better-auth/expo/client";
import { createCircleClient } from "@kinlilo/contracts";
import { createAuthClient } from "better-auth/react";
import * as SecureStore from "expo-secure-store";

const baseURL = process.env.EXPO_PUBLIC_API_URL ?? "http://127.0.0.1:4311";
export function supportsLocationUploads() {
  try {
    const url = new URL(baseURL);
    return url.protocol === "https:"
      || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  } catch {
    return false;
  }
}

export const auth = createAuthClient({
  baseURL,
  plugins: [expoClient({ scheme: "kinlilo", storagePrefix: "kinlilo", cookiePrefix: "kinlilo", storage: SecureStore })],
});

export const api = createCircleClient({
  baseUrl: baseURL,
  credentials: "omit",
  headers: async () => ({ Cookie: await auth.getCookie(), "X-Kinlilo-Client": "mobile" }),
});
