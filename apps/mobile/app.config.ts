import type { ConfigContext, ExpoConfig } from "expo/config";

export default ({ config }: ConfigContext): Partial<ExpoConfig> => {
  const harness = process.env.EXPO_PUBLIC_KINLILO_LOCATION_HARNESS === "1";

  return {
    ...config,
    plugins: [
      ...(config.plugins ?? []),
      ["expo-sqlite", { ios: { useSQLCipher: true } }],
      [
        "expo-location",
        {
          isIosBackgroundLocationEnabled: true,
          locationWhenInUsePermission: harness
            ? "Allow Kinlilo to use your location for circle sharing or the iOS test harness."
            : "Allow Kinlilo to collect your location when you turn on circle sharing.",
          locationAlwaysAndWhenInUsePermission:
            "Allow Kinlilo to collect location in the background while you have sharing turned on.",
        },
      ],
    ],
  };
};
