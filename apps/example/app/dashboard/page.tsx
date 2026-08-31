import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Badge,
} from "@deepagents-nextjs/ui";
import { RUNGS } from "@deepagents-nextjs/rungs";
import {
  SectionCards,
  type StatTile,
} from "../../components/shell/SectionCards";

/**
 * dashboard-01's layout, adapted to primitives this repo owns.
 *
 * The shell — sidebar, collapsible nav, header, breadcrumbs — moved to
 * AppShell in the root layout when #6 replaced DemoNav, so this route is now
 * only its content: the stat tiles and the ladder table.
 *
 * The table reads RUNGS from the manifest rather than restating it. It used to
 * carry its own five-row literal, which was a second list of exactly the thing
 * rungs.json exists to be the single authority on — and a second list is only
 * ever right until someone edits one of them.
 */
const rungs = [...RUNGS].sort((a, b) => a.ordinal - b.ordinal);

const TILES: StatTile[] = [
  {
    label: "Rungs in the ladder",
    value: String(rungs.length),
    footnote: `${
      rungs.filter((r) => r.shape === "conversation").length
    } conversation · ${rungs.filter((r) => r.shape === "run").length} run`,
  },
  {
    label: "Implemented",
    value: String(rungs.filter((r) => r.state === "implemented").length),
    footnote: "runnable from a clean fork",
  },
  {
    // TWO TILES BECAUSE THEY ARE TWO FACTS (#424). Present-and-runnable and has-a-front-door
    // were both `state: "implemented"` until now, so this tile could not exist: rung 5 is
    // forkable and has no way in, and one field could not say both. Reading `reach` here is
    // also what keeps it from being decoration — a declared field nothing consults is the
    // shape this repo keeps finding stale.
    label: "Reachable",
    value: String(rungs.filter((r) => r.reach === "referenced").length),
    footnote: "has a front door in this tree",
  },
  {
    label: "Framework ports",
    value: "3",
    footnote: "Next · Remix · SvelteKit",
  },
  {
    label: "Planned",
    value: String(rungs.filter((r) => r.state === "planned").length),
    direction: "down",
    footnote: "declared, not vendored",
  },
];

export default function DashboardPage() {
  return (
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
                {rungs.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="tabular-nums">{r.ordinal}</TableCell>
                    <TableCell className="font-medium">{r.id}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{r.shape}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {r.state}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
