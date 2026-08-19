export const dynamic = "force-dynamic";

// In-memory counter for the chat demo tools (increment / get_counter).
// Resets on server restart.
let counter = 0;

export function GET(): Response {
  return Response.json({ counter });
}

export function POST(): Response {
  counter++;
  return Response.json({ counter });
}
