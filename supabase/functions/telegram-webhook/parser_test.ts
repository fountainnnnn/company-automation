import { assertEquals } from "jsr:@std/assert";
import { looksLikeTimesheet, parseTimesheet } from "./parser.ts";

const TODAY = "2026-08-14";
const TZ = "Asia/Singapore";

const parse = (text: string, today = TODAY) => parseTimesheet(text, today, TZ);

Deno.test("real supervisor message", () => {
  const ts = parse([
    "12/08 Team 3 Jurong",
    "(101 - 8)",
    "(102 - 8.5)",
    "(103 - MC)",
    "104 - off",
    "105-8",
  ].join("\n"));

  assertEquals(ts.workDate, "2026-08-12");
  assertEquals(ts.teamNumber, "3");
  assertEquals(ts.location, "Jurong");
  assertEquals(ts.unparsed, []);
  assertEquals(ts.entries, [
    { workerCode: "101", hours: 8, absenceReason: null, role: "worker" },
    { workerCode: "102", hours: 8.5, absenceReason: null, role: "worker" },
    { workerCode: "103", hours: null, absenceReason: "MC", role: "worker" },
    { workerCode: "104", hours: null, absenceReason: "off", role: "worker" },
    { workerCode: "105", hours: 8, absenceReason: null, role: "worker" },
  ]);
});

Deno.test("header variant: T3", () => {
  const ts = parse("14/08 T3 Tuas\n101 - 8\n102 - 8");
  assertEquals(ts.teamNumber, "3");
  assertEquals(ts.location, "Tuas");
  assertEquals(ts.entries.length, 2);
});

Deno.test("header variant: team3 lowercase, no space", () => {
  const ts = parse("13/08 team3 Woodlands\n101 - 8");
  assertEquals(ts.teamNumber, "3");
  assertEquals(ts.location, "Woodlands");
});

Deno.test("header variant: no location", () => {
  const ts = parse("12/08 Team 3\n101 - 8");
  assertEquals(ts.workDate, "2026-08-12");
  assertEquals(ts.teamNumber, "3");
  assertEquals(ts.location, null);
});

Deno.test("header variant: ISO date", () => {
  const ts = parse("2026-08-01 Team 7 Changi\n101 - 8");
  assertEquals(ts.workDate, "2026-08-01");
  assertEquals(ts.teamNumber, "7");
  assertEquals(ts.location, "Changi");
});

Deno.test("header variant: today / yesterday", () => {
  assertEquals(parse("today Team 1\n101 - 8").workDate, TODAY);
  assertEquals(parse("Yesterday Team 1\n101 - 8").workDate, "2026-08-13");
});

Deno.test("header split across lines", () => {
  const ts = parse("12/08\nTeam 3\nJurong West\n101 - 8");
  assertEquals(ts.workDate, "2026-08-12");
  assertEquals(ts.teamNumber, "3");
  assertEquals(ts.location, "Jurong West");
  assertEquals(ts.unparsed, []);
});

Deno.test("team on a later line still applies", () => {
  const ts = parse("101 - 8\n102 - 8\nTeam 4");
  assertEquals(ts.teamNumber, "4");
  assertEquals(ts.entries.length, 2);
});

Deno.test("no year: DD/MM picks the nearest year", () => {
  // 31/12 reported on 2 Jan means last December, not next December
  assertEquals(parse("31/12 Team 1\n101 - 8", "2027-01-02").workDate, "2026-12-31");
  assertEquals(parse("02/01 Team 1\n101 - 8", "2026-12-30").workDate, "2027-01-02");
});

Deno.test("two-digit year maps to 2000+", () => {
  assertEquals(parse("12/08/25 Team 1\n101 - 8").workDate, "2025-08-12");
  assertEquals(parse("12/08/2024 Team 1\n101 - 8").workDate, "2024-08-12");
});

Deno.test("DD-MM header is not read as an entry", () => {
  const ts = parse("12-08 Team 3 Jurong\n101 - 8");
  assertEquals(ts.workDate, "2026-08-12");
  assertEquals(ts.entries.length, 1);
});

Deno.test("no spaces around the separator", () => {
  const ts = parse("Team 2\n105-8\n106-8.5");
  assertEquals(ts.entries[0], {
    workerCode: "105",
    hours: 8,
    absenceReason: null,
    role: "worker",
  });
  assertEquals(ts.entries[1].hours, 8.5);
});

Deno.test("hour suffixes and comma decimals", () => {
  const ts = parse([
    "Team 1",
    "101 - 8hrs",
    "102 - 8 hours",
    "103 - 8.5 hr",
    "104 - 8,5",
    "105 - 7h",
  ].join("\n"));
  assertEquals(ts.entries.map((e) => e.hours), [8, 8, 8.5, 8.5, 7]);
  assertEquals(ts.unparsed, []);
});

Deno.test("hours above 24 are rejected, not clamped", () => {
  const ts = parse("Team 1\n101 - 30\n102 - 8");
  assertEquals(ts.entries.length, 1);
  assertEquals(ts.entries[0].workerCode, "102");
  assertEquals(ts.unparsed, ["101 - 30"]);
});

Deno.test("role detection alongside hours", () => {
  const ts = parse("Team 1\n101 - 8 driver\n102 - 8.5 welder\n103 - 8 supervisor");
  assertEquals(ts.entries[0], {
    workerCode: "101",
    hours: 8,
    absenceReason: null,
    role: "driver",
  });
  assertEquals(ts.entries[1].role, "welder");
  assertEquals(ts.entries[1].hours, 8.5);
  assertEquals(ts.entries[2].role, "supervisor");
});

Deno.test("role detection alongside an absence", () => {
  const ts = parse("Team 1\n101 - MC driver\n102 - off foreman");
  assertEquals(ts.entries[0], {
    workerCode: "101",
    hours: null,
    absenceReason: "MC",
    role: "driver",
  });
  assertEquals(ts.entries[1], {
    workerCode: "102",
    hours: null,
    absenceReason: "off",
    role: "supervisor",
  });
});

Deno.test("a role word alone stays an absence reason", () => {
  const ts = parse("Team 1\n101 - driver\n102 - 8");
  assertEquals(ts.entries[0].hours, null);
  assertEquals(ts.entries[0].absenceReason, "driver");
  assertEquals(ts.entries[0].role, "driver");
});

Deno.test("absence reasons keep their original casing", () => {
  const ts = parse("Team 1\n101 - AL\n102 - no show\n103 - Sick leave");
  assertEquals(ts.entries.map((e) => e.absenceReason), ["AL", "no show", "Sick leave"]);
});

Deno.test("duplicate worker codes: last one wins", () => {
  const ts = parse("Team 1\n101 - 8\n102 - 8\n101 - MC");
  assertEquals(ts.entries.length, 2);
  assertEquals(ts.entries[0], {
    workerCode: "101",
    hours: null,
    absenceReason: "MC",
    role: "worker",
  });
});

Deno.test("worker codes are uppercased", () => {
  assertEquals(parse("Team 1\na12 - 8\nb13 - 8").entries.map((e) => e.workerCode), [
    "A12",
    "B13",
  ]);
});

Deno.test("semicolon-separated single line", () => {
  const ts = parse("12/08 Team 3 Jurong; 101 - 8; 102 - MC; 103-8.5");
  assertEquals(ts.workDate, "2026-08-12");
  assertEquals(ts.teamNumber, "3");
  assertEquals(ts.location, "Jurong");
  assertEquals(ts.entries.length, 3);
  assertEquals(ts.entries[1].absenceReason, "MC");
});

Deno.test("unreadable lines are surfaced, never dropped", () => {
  const ts = parse("Team 1\n101 - 8\n102 - 8\nbring the crane tomorrow");
  assertEquals(ts.entries.length, 2);
  assertEquals(ts.unparsed, ["bring the crane tomorrow"]);
});

Deno.test("a normal sentence is not a timesheet", () => {
  const text = "Can you send me the photos from the Jurong site please";
  assertEquals(parse(text).entries.length, 0);
  assertEquals(looksLikeTimesheet(text), false);
});

Deno.test("looksLikeTimesheet needs two entry-shaped lines", () => {
  assertEquals(looksLikeTimesheet("12/08 Team 3\n101 - 8\n102 - 8"), true);
  assertEquals(looksLikeTimesheet("101 - 8"), false);
  assertEquals(looksLikeTimesheet("Team 3\n101 - 8"), false);
  assertEquals(looksLikeTimesheet("101 - 8; 102 - MC"), true);
  assertEquals(looksLikeTimesheet("hello there\nhow are you"), false);
});

Deno.test("empty input", () => {
  assertEquals(parse(""), {
    workDate: null,
    teamNumber: null,
    location: null,
    entries: [],
    unparsed: [],
  });
});

Deno.test("a worked time range is surfaced, never stored as an absence", () => {
  const r = parseTimesheet(
    [
      "02/08 T1 Woodlands",
      "W103 - 8",
      "W106 - 8am-5pm",
      "W107 - 0800-1700",
      "W108 - 8 to 5",
      "W109 - AL",
    ].join("\n"),
    "2026-08-03",
    "Asia/Singapore",
  );
  // only the real hours and the real absence survive
  assertEquals(r.entries.map((e) => e.workerCode), ["W103", "W109"]);
  assertEquals(r.entries[1].absenceReason, "AL");
  // the three shift ranges come back for the supervisor to restate
  assertEquals(r.unparsed.length, 3);
});
