import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "Kinlilo · Circles",
  description: "Private family circles.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
