import type { ConfigContext, ExpoConfig } from "expo/config";

export default ({ config }: ConfigContext): Partial<ExpoConfig> => {
  if (process.env.EXPO_PUBLIC_KINLILO_LOCATION_HARNESS !== "1") return config;

  return {
    ...config,
    plugins: [
      ...(config.plugins ?? []),
      ["expo-location", {
        isIosBackgroundLocationEnabled: true,
        locationWhenInUsePermission: "Allow Kinlilo to measure location callback timing in the iOS test harness.",
        locationAlwaysAndWhenInUsePermission: "Allow Kinlilo to measure background location callback timing during the iOS test.",
      }],
    ],
  };
};
