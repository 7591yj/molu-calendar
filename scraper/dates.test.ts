import { describe, expect, test } from "vitest";
import { findTime, parseRange, publicationDay, toValue } from "./dates.ts";

const ref = "2026-09-29";
const values = (phrase: string, reference = ref) => {
  const range = parseRange(phrase, reference);
  return (
    range && {
      start: toValue(range.start),
      end: range.end && toValue(range.end),
      afterMaintenance: !!range.start.afterMaintenance,
      openEnd: range.openEnd,
    }
  );
};

describe("Korean clocks", () => {
  test("noon, midnight, 반 and 24-hour forms", () => {
    for (const [text, time] of [
      ["오전 12시", "00:00"],
      ["오후 12시", "12:00"],
      ["낮 2시", "14:00"],
      ["밤 12시", "24:00"],
      ["새벽 4시", "04:00"],
      ["오후 1시 반", "13:30"],
      ["23:59", "23:59"],
    ] as const)
      expect(findTime(text)?.time, text).toBe(time);
  });

  test("ignores durations and seasons", () => {
    expect(findTime("12시간 동안")).toBeNull();
    expect(findTime("시즌 11")).toBeNull();
  });
});

describe("ranges", () => {
  test("same-day maintenance with an implied end date", () => {
    expect(
      values("9월 29일(화) 오전 11시 ~ 오후 2시 (한국 시간 기준)"),
    ).toEqual({
      start: "2026-09-29T11:00:00+09:00",
      end: "2026-09-29T14:00:00+09:00",
      afterMaintenance: false,
      openEnd: undefined,
    });
  });

  test("after maintenance", () => {
    expect(
      values("9월 29일(화) 점검 후 ~ 10월 6일(화) 오전 10시 59분"),
    ).toMatchObject({
      start: "2026-09-29",
      end: "2026-10-06T10:59:00+09:00",
      afterMaintenance: true,
    });
  });

  test("table cells joined across lines, with a dangling separator", () => {
    expect(
      values(
        "7월 22일(수) 오전 11시 ~\n8월 18일(화) 오전 3시 59분",
        "2026-07-21",
      ),
    ).toMatchObject({
      start: "2026-07-22T11:00:00+09:00",
      end: "2026-08-18T03:59:00+09:00",
    });
    expect(
      values(
        "8월 19일 (수) 오전 11시\n~ 9월 15일(화) 오전 3시 59분",
        "2026-08-18",
      ),
    ).toMatchObject({
      start: "2026-08-19T11:00:00+09:00",
      end: "2026-09-15T03:59:00+09:00",
    });
  });

  test("daily opening hours do not become the end time", () => {
    expect(
      values("11월 7일(토) ~ 11월 8일(일) / 오전 10시 ~ 오후 6시"),
    ).toMatchObject({ start: "2026-11-07", end: "2026-11-08" });
  });

  test("date-only start with a timed end", () => {
    expect(
      values("9월 22일(화) ~ 10월 5일(월) 오후 11시 59분", "2026-09-21"),
    ).toMatchObject({
      start: "2026-09-22",
      end: "2026-10-05T23:59:00+09:00",
    });
  });

  test("explicit and inferred years, including New Year", () => {
    expect(values("2027년 6월 30일(수) 오후 11시 59분")?.start).toBe(
      "2027-06-30T23:59:00+09:00",
    );
    expect(
      values(
        "12월 28일(월) 오전 4시 ~ 1월 4일(월) 오전 3시 59분",
        "2026-12-20",
      ),
    ).toMatchObject({
      start: "2026-12-28T04:00:00+09:00",
      end: "2027-01-04T03:59:00+09:00",
    });
    expect(
      values("1월 2일(토) 오전 4시 ~ 1월 4일(월) 오전 3시 59분", "2026-12-30")
        ?.start,
    ).toBe("2027-01-02T04:00:00+09:00");
  });

  test("open endings", () => {
    expect(values("9월 15일(화) 점검 후 ~ 별도 안내 시까지")).toMatchObject({
      start: "2026-09-15",
      openEnd: "별도 안내 시까지",
    });
    expect(
      values("8월 1일(토) ~ 헌혈 기념품 소진 시까지", "2026-07-31"),
    ).toMatchObject({ start: "2026-08-01", openEnd: "소진 시까지" });
    expect(
      values("5월 26일(화) 오전 10시 ~ 헌혈 기념품 소진 시", "2026-05-26"),
    ).toMatchObject({
      start: "2026-05-26T10:00:00+09:00",
      openEnd: "소진 시까지",
    });
    expect(
      values("6월 18일(목) 오전 10시 ~ 별도 안내 시까지", "2026-06-17")
        ?.openEnd,
    ).toBe("별도 안내 시까지");
  });

  test("부터 … 까지 and title deadlines", () => {
    expect(values("11월 7일(토)부터 11월 8일(일)까지")).toMatchObject({
      start: "2026-11-07",
      end: "2026-11-08",
    });
    expect(values("~10/9 23:59", "2026-10-02")).toMatchObject({
      start: "2026-10-09T23:59:00+09:00",
      end: undefined,
    });
    expect(
      parseRange("점검 종료 후 ~ 10월 6일(화) 오후 11시 59분까지", ref),
    ).toMatchObject({
      endOnly: true,
      start: { day: "2026-10-06", time: "23:59" },
    });
  });

  test("rejects impossible dates and prose without dates", () => {
    expect(values("2월 30일 ~ 3월 1일")).toBeNull();
    expect(values("점검 시간 동안 게임 접속 불가")).toBeNull();
  });

  test("publication day is computed in KST", () => {
    expect(publicationDay(Date.parse("2026-12-31T15:30:00Z") / 1000)).toBe(
      "2027-01-01",
    );
  });
});
