import "./globals.css";
import { DemoNav } from "../components/DemoNav";

export const metadata = {
  title: "Lang-Next.js",
  description:
    "DeepAgents + LangGraph/LangChain chat and OpenSWE queue, one app",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[#0a0a0b] text-neutral-200">
        <DemoNav />
        {children}
      </body>
    </html>
  );
}
