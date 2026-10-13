/** A recording fetch stub for the conversations tests: fake token, canned JSON, no network. */
import { createClient, type AccountClient } from "../../src/accounts.ts";

/** One request the stub saw. */
export interface Sent {
  method: string;
  url: URL;
  version: string | null;
}

/** Answers a request with a JSON body. */
export type Responder = (url: URL) => unknown;

/** Build a primary-account client whose fetch records each request and answers with `respond`. */
export function stubClient(respond: Responder): {
  client: AccountClient;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  const client = createClient({
    account: "primary",
    token: "pit-test",
    allowWrites: true,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      sent.push({
        method: request.method,
        url,
        version: request.headers.get("Version"),
      });
      return Response.json(respond(url));
    },
  });
  return { client, sent };
}
