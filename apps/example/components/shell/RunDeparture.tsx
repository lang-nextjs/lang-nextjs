import { rungHref, type Rung } from "@deepagents-nextjs/rungs";
import { rungNote } from "../../lib/shell/nav";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Badge,
  Button,
  Separator,
} from "@deepagents-nextjs/ui";
import { ExternalLink, Ban } from "lucide-react";

/**
 * The `run` shape, as this app hosts it: a DEPARTURE, not an embedded run list.
 *
 * This is the whole point of routing by shape rather than swapping tabs. A run
 * rung has a different information architecture — list to detail, durable run
 * ids, joining a run started elsewhere, a parent stream plus N children
 * discovered at runtime. None of that is a variation on a chat composer, and
 * apps/example does not host it: rung 4 is a separate app on its own origin.
 *
 * Rendering a handoff here is the CORRECT behaviour, not a placeholder. #29
 * (db2c3f1) deliberately deleted the embedded Open SWE rung from this app;
 * rebuilding a run list here to make the two branches look symmetrical would
 * undo a merged PR. The asymmetry is the design.
 */
export function RunDeparture({ rung }: { rung: Rung }) {
  const href = rungHref(rung, {
    NEXT_PUBLIC_QUEUE_URL: process.env.NEXT_PUBLIC_QUEUE_URL,
  });
  const unavailable = href === null;

  return (
    <div className="p-6">
      <Card className="max-w-2xl">
        <CardHeader>
          <div className="flex items-center gap-2">
            <CardTitle>{rung.id}</CardTitle>
            <Badge variant="outline">rung {rung.ordinal}</Badge>
            <Badge variant="outline">{rung.shape}</Badge>
          </div>
          <CardDescription>
            {/*
             * ASK THE RULE, DO NOT RESTATE IT (#483). This was its own copy of
             * "not present in this repo", shown for ANY rung with no href — so
             * it said the false thing about software-developer-agent (state
             * "implemented", reach "vendored", 248 files) even after #424 fixed
             * the same sentence in nav.ts. A rule living in one place and
             * repeated in another is only fixed where someone looked.
             */}
            {unavailable
              ? rungNote(rung, href)
              : "This rung runs as a separate app, on its own origin."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-muted-foreground text-sm">
            A <code>run</code> rung manages asynchronous runs: you dispatch a
            run and reconnect to it later, and a single run is carried by a
            parent stream plus however many child streams appear while it
            executes. That is a different surface from the conversation rungs,
            not a different tab on the same one — which is why this app routes
            you out rather than embedding it.
          </p>
          <Separator />
          {unavailable ? (
            <div className="text-muted-foreground flex items-center gap-2 text-sm">
              <Ban className="size-4 shrink-0" aria-hidden="true" />
              <span>
                No target to send you to. This rung is{" "}
                <strong>{rung.state}</strong>.
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <Button asChild>
                <a href={href} rel="noreferrer">
                  Open {rung.id}
                  <ExternalLink className="size-4" aria-hidden="true" />
                </a>
              </Button>
              <span className="text-muted-foreground text-xs break-all">
                {href}
              </span>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
