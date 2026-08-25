import "./globals.css";
import { AppShell } from "../components/shell/AppShell";

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
      {/*
       * Theme tokens, where this previously carried a raw hex canvas and a
       * fixed neutral text colour. That pair was a private theme the design
       * system could not reach: df-theme-check passes on it because it
       * redefines no token — it simply bypasses them — which is the exact
       * hole check-palette.mjs was written to cover, and the reason this app
       * is its one excluded path.
       *
       * The viewport unit is gone too. AppShell locks the shell to the
       * viewport, so nothing below it needs one.
       */}
      <body className="bg-background text-foreground">
        <AppShell crumbs={["Lang-Next.js"]}>{children}</AppShell>
      </body>
    </html>
  );
}
