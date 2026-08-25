import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Badge,
} from "@deepagents-nextjs/ui";
import { TrendingUp, TrendingDown } from "lucide-react";

export type StatTile = {
  label: string;
  value: string;
  delta?: string;
  direction?: "up" | "down";
  footnote?: string;
};

/**
 * dashboard-01's stat-tile row, adapted. Pure primitives — no new dependencies.
 *
 * Rung-agnostic by construction: it takes tiles as data and names no rung's
 * concepts. A caller decides whether a tile counts runs, threads, or tokens.
 */
export function SectionCards({ tiles }: { tiles: StatTile[] }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {tiles.map((t) => {
        const Trend = t.direction === "down" ? TrendingDown : TrendingUp;
        return (
          <Card key={t.label}>
            <CardHeader className="pb-2">
              <CardDescription>{t.label}</CardDescription>
              <CardTitle className="text-2xl tabular-nums">{t.value}</CardTitle>
            </CardHeader>
            <CardContent className="flex items-center gap-2 pt-0">
              {t.delta ? (
                <Badge variant="outline" className="gap-1">
                  <Trend className="size-3" aria-hidden="true" />
                  {t.delta}
                </Badge>
              ) : null}
              {t.footnote ? (
                <span className="text-muted-foreground text-xs">
                  {t.footnote}
                </span>
              ) : null}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
