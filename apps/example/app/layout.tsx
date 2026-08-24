import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "../components/shell/AppShell";

export const metadata: Metadata = {
  title: "DeepAgents — Live Chat",
  description: "useDeepAgentsChat end-to-end demo",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-background text-foreground">
        <AppShell crumbs={["Lang-Next.js"]}>{children}</AppShell>
      </body>
    </html>
  );
}
