/** Available phone numbers and the pure pattern filter. */
import { describe, test } from "node:test";
import { expect } from "expect";

import { createClient } from "../src/accounts.ts";
import { HighLevelShapeError } from "../src/crm/shape.ts";
import { filterNumbers, listAvailableNumbers } from "../src/phone-numbers.ts";

function fake(reply: unknown) {
  const seen: { call: string; version: string | null }[] = [];
  const client = createClient({
    account: "primary",
    token: "pit-test",
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      seen.push({
        call: `${request.method} ${url.pathname}${url.search}`,
        version: request.headers.get("Version"),
      });
      return Response.json(reply);
    },
  });
  return { client, seen, loc: client.locationId };
}

const OFFER = {
  numbers: [
    {
      phoneNumber: "+16315550100",
      friendlyName: "(631) 555-0100",
      capabilities: { MMS: true, SMS: true, voice: false },
    },
    { phoneNumber: "+15165550199" },
  ],
};

describe("listAvailableNumbers", () => {
  test("asks for the location's numbers and parses capabilities", async () => {
    const { client, seen, loc } = fake(OFFER);
    const numbers = await listAvailableNumbers(client, {
      areaCode: "631",
      contains: "555",
    });
    expect(numbers).toEqual([
      {
        number: "+16315550100",
        friendlyName: "(631) 555-0100",
        capabilities: ["MMS", "SMS"],
      },
      { number: "+15165550199" },
    ]);
    expect(seen).toEqual([
      {
        call: `GET /phone-system/numbers/location/${loc}/available?countryCode=US&firstPart=631&anywhere=555`,
        version: "2021-07-28",
      },
    ]);
  });

  test("sends the suffix, number types and capability flags", async () => {
    const { client, seen, loc } = fake({ numbers: [] });
    await listAvailableNumbers(client, {
      areaCode: "631",
      endsWith: "78324",
      numberTypes: ["local", "mobile"],
      smsEnabled: true,
      mmsEnabled: true,
      voiceEnabled: false,
    });
    expect(seen[0]?.call).toBe(
      `GET /phone-system/numbers/location/${loc}/available?countryCode=US&firstPart=631` +
        "&lastPart=78324&numberTypes=local%2Cmobile&smsEnabled=true&mmsEnabled=true&voiceEnabled=false",
    );
  });

  test("carries locality and the monthly price", async () => {
    const { client } = fake({
      numbers: [
        { phoneNumber: "+16315578324", locality: "Hauppauge", price: { price: 1.15 } },
      ],
    });
    expect(await listAvailableNumbers(client)).toEqual([
      { number: "+16315578324", locality: "Hauppauge", price: 1.15 },
    ]);
  });

  test("limit keeps the first n", async () => {
    const { client } = fake(OFFER);
    const numbers = await listAvailableNumbers(client, { countryCode: "CA", limit: 1 });
    expect(numbers.map((n) => n.number)).toEqual(["+16315550100"]);
  });

  test("an entry without phoneNumber is a shape error", async () => {
    const { client } = fake({ numbers: [{ friendlyName: "x" }] });
    await expect(listAvailableNumbers(client)).rejects.toThrow(HighLevelShapeError);
  });
});

describe("filterNumbers", () => {
  const numbers = [
    { number: "+16315578324" },
    { number: "+15165578324" },
    { number: "+12125578324" },
    { number: "+16315578325" },
  ];

  test("keeps only the area codes that really end with the suffix", () => {
    expect(
      filterNumbers(numbers, { endsWith: "78324", areaCodes: ["631", "516"] }),
    ).toEqual([{ number: "+16315578324" }, { number: "+15165578324" }]);
  });

  test("an empty filter keeps everything", () => {
    expect(filterNumbers(numbers, {})).toEqual(numbers);
  });
});
