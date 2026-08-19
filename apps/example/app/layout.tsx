import type { Metadata } from "next";
import "./globals.css";
import { DemoNav } from "../components/DemoNav";

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
      <body className="bg-gray-50 text-gray-900">
        <DemoNav active="chat" />
        {children}
      </body>
    </html>
  );
}
