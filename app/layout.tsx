import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DataWowsight",
  description: "Natural-language analytics for read-only databases",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
