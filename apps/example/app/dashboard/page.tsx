import {
  SidebarProvider, SidebarInset,
  Card, CardHeader, CardTitle, CardContent,
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Badge,
} from "@deepagents-nextjs/ui";
import { MessagesSquare, GitBranch, Layers, ListChecks, Bot } from "lucide-react";
import { AppSidebar, type NavGroup } from "../../components/shell/AppSidebar";
import { SiteHeader } from "../../components/shell/SiteHeader";
import { SectionCards, type StatTile } from "../../components/shell/SectionCards";

/**
 * dashboard-01's layout, adapted to primitives this repo owns.
 *
 * Category 1 only: sidebar, collapsible nav, header, breadcrumbs, stat tiles,
 * card grid, table. ZERO npm packages beyond what the primitives already
 * needed. The interactive area chart (recharts) is deferred to rung 4, where a
 * chart has something to plot and where the dependency ejects with the rung.
 *
 * The nav groups below are STATIC placeholder data. #6 replaces them with the
 * rung manifest, grouped by interaction shape — the components are already
 * generic over groups, so that is a data change, not a rewrite.
 */
const GROUPS: NavGroup[] = [
  {
    label: "Conversation",
    items: [
      { title: "langchain", href: "/", icon: MessagesSquare },
      { title: "langgraph", href: "/", icon: GitBranch },
      { title: "deepagents", href: "/", icon: Layers },
    ],
  },
  {
    label: "Runs",
    items: [
      { title: "open-swe", href: "http://localhost:3001", icon: ListChecks, external: true,
        note: "Runs as a separate app on its own origin" },
      { title: "software-developer-agent", href: null, icon: Bot },
    ],
  },
  {
    label: "Harnesses",
    items: [
      { title: "HITL demo", href: "/hitl-demo" },
      { title: "Concurrent", href: "/concurrent-test" },
      { title: "Reconnect", href: "/reconnect-test" },
    ],
  },
];

const TILES: StatTile[] = [
  { label: "Rungs in the ladder", value: "5", footnote: "3 conversation · 2 run" },
  { label: "Runnable from a clean fork", value: "4", delta: "+1", direction: "up", footnote: "rung 4 landed" },
  { label: "Framework ports", value: "3", footnote: "Next · Remix · SvelteKit" },
  { label: "Planned", value: "1", direction: "down", footnote: "rung 5 not vendored" },
];

const RUNGS = [
  { n: 1, id: "langchain", shape: "conversation", state: "implemented" },
  { n: 2, id: "langgraph", shape: "conversation", state: "implemented" },
  { n: 3, id: "deepagents", shape: "conversation", state: "implemented" },
  { n: 4, id: "open-swe", shape: "run", state: "implemented" },
  { n: 5, id: "software-developer-agent", shape: "run", state: "planned" },
];

export default function DashboardPage() {
  return (
    <SidebarProvider>
      <AppSidebar title="Lang-Next.js" groups={GROUPS} />
      <SidebarInset>
        <SiteHeader crumbs={["Dashboard"]} />
        <div className="flex flex-col gap-6 p-6">
          <SectionCards tiles={TILES} />
          <Card>
            <CardHeader>
              <CardTitle>The ladder</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-12">#</TableHead>
                      <TableHead>Rung</TableHead>
                      <TableHead>Shape</TableHead>
                      <TableHead>State</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {RUNGS.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="tabular-nums">{r.n}</TableCell>
                        <TableCell className="font-medium">{r.id}</TableCell>
                        <TableCell>
                          <Badge variant="outline">{r.shape}</Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{r.state}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
